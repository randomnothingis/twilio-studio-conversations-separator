// Function 2: Worker Service (Pub/Sub Subscriber & Twilio Cleanup)
// Is triggered by Pub/Sub, polls Twilio Studio status, and deletes webhooks.
require('dotenv').config();

const express = require('express');
const twilio = require('twilio');
const app = express();

app.use(express.json()); 


const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_POLL_TIMEOUT_MS = 15000; // 15 seconds max polling time

if (!ACCOUNT_SID || !AUTH_TOKEN) {
    console.error('Missing Twilio credentials in environment. Worker will not function.');
}


let twilioClient;
if (ACCOUNT_SID && AUTH_TOKEN) {
    twilioClient = twilio(ACCOUNT_SID, AUTH_TOKEN);
}

/**
 * Polling function to check Twilio Studio Execution Status
 * @param {string} flowSid - The SID of the Studio Flow (not used currently but could be logged).
 * @param {string} executionSid - The SID of the Studio Execution.
 * @returns {Promise<boolean>} True if the execution completed, false otherwise (e.g., timeout).
 */
async function pollStudioExecution(flowSid, executionSid) {
    const startTime = Date.now();
    const endTime = startTime + TWILIO_POLL_TIMEOUT_MS;

    console.log(`Starting poll for execution ${executionSid}. Max time: ${TWILIO_POLL_TIMEOUT_MS}ms`);

    while (Date.now() < endTime) {
        try {
            const execution = await twilioClient.studio.v2.flows(flowSid).executions(executionSid).fetch();
            
            const status = execution.status.toLowerCase();
            console.log(`[${(Date.now() - startTime) / 1000}s] Execution status: ${status}`);


            if (status == 'ended') {
                console.log(`Execution ${executionSid} completed with status: ${status}. Stopping poll.`);
                return true;
            }

        } catch (error) {
            console.error(`Error fetching execution ${executionSid}:`, error.message);
        }
        
        // Wait 1 second before polling again
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.warn(`Polling for execution ${executionSid} timed out after ${TWILIO_POLL_TIMEOUT_MS}ms.`);
    return false;
}

/**
 * Deletes the Studio-related webhooks from the conversation using the user-provided logic.
 * @param {string} conversationSid - The SID of the conversation.
 */
async function deleteStudioWebhooks(conversationSid) {
    if (!twilioClient) {
        throw new Error('Twilio client is not initialized due to missing credentials.');
    }

    try {
        console.log(`Fetching webhooks for conversation ${conversationSid}`);

        const webhooks = await twilioClient.conversations.v1
            .conversations(conversationSid)
            .webhooks.list();

        // Filter Studio webhooks
        const studioWebhooks = webhooks.filter(
            (entry) => entry.target === 'studio'
        );

        if (studioWebhooks.length === 0) {
            console.log('No Studio webhooks found. Deletion complete.');
            return;
        }

        console.log(`Found ${studioWebhooks.length} Studio webhook(s). Removing...`);

        // Remove all studio webhooks
        for (const webhook of studioWebhooks) {
            console.log(`Removing webhook SID: ${webhook.sid}`);
            await twilioClient.conversations.v1
                .conversations(conversationSid)
                .webhooks(webhook.sid)
                .remove();
            console.log(`Removed webhook SID: ${webhook.sid}`);
        }

        console.log('All Studio webhooks removed successfully.');
    } catch (error) {
        console.error('Error while deleting Studio webhooks:', error);
        throw new Error('Webhook deletion failed. This will trigger a Pub/Sub retry.');
    }
}


// Worker service endpoint (listens for Pub/Sub push messages)
app.post('/', async (req, res) => {
    // Return 200/204 only on success to signal Pub/Sub to stop retrying.
    // Return anything else (e.g., 500) to tell Pub/Sub to retry the message.
    
    if (!req.body || !req.body.message || !req.body.message.data) {
        console.error('Invalid Pub/Sub message format.');
        return res.status(400).send('Invalid Pub/Sub message.');
    }
    
    try {
        // Pub/Sub push messages are Base64 encoded
        const pubSubMessage = JSON.parse(
            Buffer.from(req.body.message.data, 'base64').toString()
        );

        const { flowSid, executionSid, conversationSid } = pubSubMessage;
        
        console.log(`\n--- Worker received task for Conversation: ${conversationSid}, Execution: ${executionSid} ---`);

        if (!twilioClient) {
            console.error('CRITICAL: Twilio client not initialized. Cannot proceed.');
            return res.status(500).send('Server misconfiguration: Missing Twilio credentials.');
        }

        // 1. Poll the Studio execution status
        const executionCompleted = await pollStudioExecution(flowSid, executionSid);
        
        if (executionCompleted) {
            console.log('Execution completed or failed. Proceeding to delete webhooks.');
        } else {
            // Execution timed out after 15s, but we still proceed with cleanup
            console.warn('Execution polling timed out (15s). Proceeding to delete webhooks anyway to clean up stale resources.');
        }
        
        // 2. Delete the webhooks
        await deleteStudioWebhooks(conversationSid);
        
        console.log('Task fully completed. Acknowledging message.');
        
        // Success: Respond 204 or 200 to acknowledge the message and stop retries
        return res.status(204).send();

    } catch (error) {
        // If any step in the try block fails (e.g., webhook deletion), this catches it.
        console.error('FATAL ERROR during task processing. Pub/Sub will retry:', error);
        
        // Failure: Return 500 to signal Pub/Sub to retry the message later
        return res.status(500).send('Task failed. Pub/Sub will retry.');
    }
});

// Health check endpoint
app.get('/healthz', (req, res) => {
    res.status(200).send('Worker operational (Pub/Sub Subscriber).');
});

// Start the server
const port = parseInt(process.env.PORT) || 8081;
app.listen(port, () => {
    console.log(`Worker service started on port ${port}`);
});
