
const express = require('express');
// const fetch = require('node-fetch');
const { GoogleAuth } = require('google-auth-library');
const { validateRequest } = require('twilio').validateRequest;
const { CloudTasksClient } = require('@google-cloud/tasks');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const twilio = require('twilio');

require('dotenv').config();

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

if (!ACCOUNT_SID || !AUTH_TOKEN) {
    console.error('Missing Twilio credentials in environment. Worker will not function.');
}

let twilioClient;
if (ACCOUNT_SID && AUTH_TOKEN) {
    twilioClient = twilio(ACCOUNT_SID, AUTH_TOKEN);
}


const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const client = new CloudTasksClient();
const firestore = new Firestore({
  projectId: process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
  databaseId: process.env.GCP_FIRESTORE_ID
});

const TASK_REFERENCES_COLLECTION = process.env.TASK_REFERENCES_COLLECTION || 'conversation_task_references';

function taskReferenceDoc(conversationId) {
  return firestore.collection(TASK_REFERENCES_COLLECTION).doc(conversationId);
}

// Middleware to verify Twilio signature
function verifyTwilioSignature(req, res, next) {
  const twilioSignature = req.headers['x-twilio-signature'];
  const url = process.env.PUBLIC_URL || `https://${req.headers.host}${req.originalUrl}`;
  const params = req.body;
  const valid = validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    twilioSignature,
    url,
    params
  );
  if (!valid) {
    return res.status(403).send('Invalid Twilio signature');
  }
  next();
}


async function test() {
  const auth = new GoogleAuth();
  const client = await auth.getIdTokenClient('https://YOUR_CLOUD_RUN_URL');
  const headers = await client.getRequestHeaders();
  console.log(headers);
}


app.post('/update-timer',
  // verifyTwilioSignature, 
  async (req, res) => {

    /*
            conversationId: conversationId,
            timeoutSec: Number(timeoutSec),
            numberTo: numberTo,
            target: context.SCHEDULING_SERVICE_URL+'/run-survey',
            flowSid: context.SURVEY_FLOW_SID,
            numberFrom: context.SURVEY_FROM_NUMBER
    */

    try {
      const { conversationId, timeoutSec, serviceSid, target, flowSid, numberFrom } = req.body;
      if (!conversationId || timeoutSec === undefined || timeoutSec === null || !target || !flowSid || !numberFrom) {
        return res.status(400).send('Missing required parameters');
      }

      const timeoutSecNumber = Number(timeoutSec);
      if (!Number.isFinite(timeoutSecNumber) || timeoutSecNumber < 0) {
        return res.status(400).send('Invalid timeoutSec');
      }


      console.log(`Timer triggered for conversationId: ${conversationId}`);




      const payload = {
        conversationsSid: conversationId,
        serviceSid: serviceSid,
        flowSid: flowSid
      };


      // Construct the fully qualified queue name.
      const project = process.env.GCP_PROJECT;
      const queue = process.env.GCP_QUEUE;
      const location = process.env.GCP_LOCATION;
      const parent = client.queuePath(project, location, queue);

      const refDoc = taskReferenceDoc(conversationId);
      const existing = await refDoc.get();
      const existingTaskName = existing.exists ? existing.data()?.taskName : undefined;
      if (existingTaskName) {
        try {
          await client.deleteTask({ name: existingTaskName });
          console.log(`Deleted previous task ${existingTaskName}`);
        } catch (err) {
          const code = err?.code;
          if (code === 5) {
            console.log(`Previous task not found (already deleted/executed): ${existingTaskName}`);
          } else {
            throw err;
          }
        }
      }


      const task = {
        httpRequest: {
          headers: {
            'Content-Type': 'application/json', // Set content type to ensure compatibility your application's request parsing
          },
          httpMethod: 'POST',
          url: target,
        }
      };
      // 'Task name must be formatted: "projects/<PROJECT_ID>/locations/<LOCATION_ID>/queues/<QUEUE_ID>/tasks/<TASK_ID>".'


      if (payload) {
        task.httpRequest.body = Buffer.from(JSON.stringify(payload)).toString('base64');
      }

      task.scheduleTime = {
        seconds: Math.floor(Date.now() / 1000) + Math.floor(timeoutSecNumber),
      };

      // Send create task request.
      console.log('Sending task:');
      console.log(task);
      const request = { parent: parent, task: task };
      const [response] = await client.createTask(request);
      console.log(`Created task ${response.name}`);

      await refDoc.set(
        {
          taskName: response.name,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );


      return res.status(200).send('Timer received');
    } catch (err) {
      console.error('Failed to update timer:', err);
      return res.status(500).send('Failed to update timer');
    }




  });


app.post('/run-survey', async (req, res) => {
  const { conversationId, numberTo, numberFrom, flowSid } = req.body;
  if (!conversationId || !numberTo || !numberFrom || !flowSid) {
    return res.status(400).send('Missing params');
  }

  console.log(`Running survey for conversationId: ${conversationId}, 
    numberTo: ${numberTo}, 
    numberFrom: ${numberFrom}, 
    flowSid: ${flowSid}`);
  
  // Initialize Twilio client if not already initialized
  const conversation = await twilioClient.conversations.v1
    .services(process.env.TWILIO_CONVERSATIONS_SERVICE_SID)
    .conversations(conversationId)
    .fetch();
  
  const attributes = JSON.parse(conversation.attributes || '{}');
  const mode = attributes.mode;
  console.log(`Read Attributes: ${attributes}, Mode:${mode}`, );
  
  // When survey starts, set MODE to SURVEY
  const newAttributes = { ...attributes, mode: 'survey' };
  await twilioClient.conversations.v1
    .services(process.env.TWILIO_CONVERSATIONS_SERVICE_SID)
    .conversations(conversationId)
    .update({ attributes: JSON.stringify(newAttributes) });

  

  // Get ID token for Cloud Run service-to-service authentication
  const auth = new GoogleAuth();
  const targetAudience = process.env.GCP_AGENT_URL; // The URL of the receiving Cloud Run service
  const client = await auth.getIdTokenClient(targetAudience);
  const headers =  (await client.getRequestHeaders());
  const idToken = headers.get('authorization');


  const tokenOnly = idToken.replace('Bearer ', '');
  console.log('tokenOnly', tokenOnly);


  const messageResponse = await fetch(`${process.env.GCP_AGENT_URL}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': headers.get('authorization')
    },
    body: JSON.stringify({
      "app_name": "meal_mmc",
      "user_id": `user_${conversationId}`,
      "session_id": `session_${conversationId}`,
      "new_message": {
        "role": "user",
        "parts": [{
          "text": `userId:${conversationId}`
        }]
      },
      "streaming": false
    })
  });

  if (!messageResponse.ok) {
    const errorText = await messageResponse.text();
    console.error('Failed to send start_survey message:', errorText);
    return res.status(500).send('Failed to send start_survey message');
  } 
  console.log('message reply:', messageResponse);

  const botMessages = await messageResponse.json() 
  const filteredMessages = botMessages.filter(
      msg => msg.content && Array.isArray(msg.content.parts) && msg.content.parts[0]?.text
  )
  let textToSend = '';
  filteredMessages.forEach(element => {
    textToSend += element.content.parts[0].text + '\n';
  });
  
  console.log('Final text to send to Twilio conversation:', textToSend);
  return 
  // const botResponse = await messageResponse.json();
  // const botMessage = botResponse?.choices?.[0]?.message?.content;

  //
  if (botMessage) {
    console.log('Bot response:', botMessage);
    await twilioClient.conversations.v1
      .services(process.env.TWILIO_CONVERSATIONS_SERVICE_SID)
      .conversations(conversationId)
      .messages.create({
        author: 'ADK Bot', // Or a more appropriate author name
        body: botMessage
      });
    console.log('Bot message added to Twilio conversation.');
  } else {
    console.warn('ADK Bot response did not contain a message:', botResponse);
  }

  return res.status(200).send('Survey execution started and bot message processed.');



  // Check that there is a task that should be running
  const refDoc = taskReferenceDoc(conversationId);
  const existing = await refDoc.get();
  const existingTaskName = existing.exists ? existing.data()?.taskName.split('/').pop() : undefined;
  if (!existingTaskName) {
    console.log(`No Firestore task reference found for conversationId ${conversationId}`);
    return res.status(200).send('No task reference found');
  }

  // Check that the task name matches
  if (existingTaskName !== executingTaskName) {
    console.log(
      `Stored vs Executing task name mismatch. Stored=${existingTaskName} Executing=${executingTaskName}`
    );
    return res.status(200).send('Stored vs Executing task name mismatch');
  } 


});

app.post('/reply-survey', verifyTwilioSignature, async (req, res) => {
  const { ConversationSid, Body } = req.body; // Twilio's incoming webhook typically sends ConversationSid and Body
  const conversationId = ConversationSid;
  const userMessage = Body;

  if (!conversationId || !userMessage) {
    return res.status(400).send('Missing conversationId or message body');
  }

  console.log(`Received reply for conversationId: ${conversationId}, message: ${userMessage}`);

  try {
    // Forward user message to ADK bot
    const messageResponse = await fetch(`${process.env.GCP_AGENT_URL}/run_sse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        "app_name": "meal_mmc", // Assuming the same app_name as in run-survey
        "user_id": `user_${conversationId}`,
        "session_id": `session_${conversationId}`,
        "new_message": {
          "role": "user",
          "parts": [{
            "text": userMessage
          }]
        },
        "streaming": false
      })
    });

    if (!messageResponse.ok) {
      const errorText = await messageResponse.text();
      console.error('Failed to forward message to ADK bot:', errorText);
      return res.status(500).send('Failed to process message with ADK bot');
    }

    const botResponse = await messageResponse.json();
    const botMessage = botResponse?.choices?.[0]?.message?.content;

    if (botMessage) {
      console.log('ADK Bot reply:', botMessage);
      // Add bot's reply to Twilio conversation
      await twilioClient.conversations.v1
        .services(process.env.TWILIO_CONVERSATIONS_SERVICE_SID)
        .conversations(conversationId)
        .messages.create({
          author: 'ADK Bot', // Or a more appropriate author name
          body: botMessage
        });
      console.log('Bot reply added to Twilio conversation.');
    } else {
      console.warn('ADK Bot response did not contain a message:', botResponse);
    }

    return res.status(200).send('Message processed successfully');

  } catch (err) {
    console.error('Error processing reply-survey:', err);
    return res.status(500).send('Internal server error');
  }
});

app.listen(8080, () => {
  console.log('Update-timer listening on port 8080');
});
