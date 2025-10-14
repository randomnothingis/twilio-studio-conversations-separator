// Function 1: Notifier Service (Twilio Webhook Receiver & Pub/Sub Publisher)
// Receives an HTTP POST request, publishes to Pub/Sub, and responds immediately 200 OK.
require('dotenv').config();

const express = require('express');
const { PubSub } = require('@google-cloud/pubsub');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));


const STUDIO_TOPIC_NAME = process.env.STUDIO_TOPIC_NAME;

if (!STUDIO_TOPIC_NAME) {
    console.error("STUDIO_TOPIC_NAME environment variable is required.");
}

// Initialize Pub/Sub Client. Credentials are automatically inferred by Cloud Run.
const pubSubClient = new PubSub();


app.post('/', async (req, res) => {
     
     const { 
        flowSid,
        executionSid, 
        conversationSid, 
    } = req.body;

    if (!flowSid || !executionSid || !conversationSid) {
        console.error('Missing required SIDs in Twilio payload. Notifying failure, but responding 200 to Twilio.', req.body);
        // Important: Always respond 200 OK to Twilio to prevent retries of invalid requests
        return res.status(200).send('Missing required SIDs. Aborting task delegation.');
    }

    const payload = {
        flowSid: flowSid,
        executionSid: executionSid,
        conversationSid: conversationSid
    };

    try {
        const dataBuffer = Buffer.from(JSON.stringify(payload));

        // Publish the message to the topic
        const messageId = await pubSubClient.topic(STUDIO_TOPIC_NAME).publishMessage({data: dataBuffer});

        console.log(`Task published to Pub/Sub. Message ID: ${messageId}`);

        // Respond immediately to Twilio (Critical for preventing timeouts)
        res.status(200).send('Task accepted and delegated to worker via Pub/Sub.');

    } catch (error) {
        console.error('Error publishing to Pub/Sub:', error);
        // Respond 200 OK to Twilio, but log a severe internal error
        res.status(200).send('Internal error while publishing task. Check service logs for Pub/Sub failure.');
    }
});

// Health check endpoint
app.get('/healthz', (req, res) => {
    res.status(200).send('Notifier operational (Twilio Receiver).');
});

// Start the server
const port = parseInt(process.env.PORT) || 8080;
app.listen(port, () => {
    console.log(`Notifier service started on port ${port}`);
    console.log(`Pub/Sub Topic configured: ${STUDIO_TOPIC_NAME}`);
});
