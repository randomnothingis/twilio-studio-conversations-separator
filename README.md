
# Removing Twilio Studio webhook from Twilio Conversation

Using Google Cloud Pub/Sub and Cloud Run (NodeJS).


## Architecture
- Notifier Service (Cloud Run): Receives a Request from Studio, extracts execution details (flowSid, executionSid, conversationSid), publishes them to a Pub/Sub topic, and responds with 200 OK for the Studio flow to continue (and end).
- Worker Service (Cloud Run): Is configured as a Pub/Sub Push Subscriber. It is triggered by the message, polls the Twilio Studio Execution status until it's ended (or times out 15s) and then deletes the necessary webhooks.
- Pub/Sub Topic: holds task message.


## 1. Local Setup
Prerequisites
1. Node.js installed.
2. A valid Twilio Account SID and Auth Token.

Install dependencies (root and subdirectories):
```
npm install # for root dev dependencies (like concurrently)
cd notifier && npm install && cd ..
cd worker && npm install && cd ..
```



## Testing locally

1. Copy and rename `.env.example` to `.env` in the root dir and fill your Twilio credentials

2. Start both services with one command:
`npm run start:local`

This will automatically run both services in two separate windows/streams, as defined in the root package.json.


### Testing the Worker Logic (locally)
To test the worker, you must manually generate a Pub/Sub message payload. The Pub/Sub push message format requires the actual payload to be Base64 encoded inside the data field.

1. Find **Studio Flow SID**, **Execution SID** and a **Conversation SID** from your Twilio console.

2. Generate base64 encoded data:

Replace SIDs with your test values
```
echo '{"flowSid":"FWXX", "executionSid":"FNXX","conversationSid":"CHXX"}' | base64

# Example output:
eyJleGVjdXRpb25TaWQiOiJGTlhYIiwiZmxvd1NpZCI6IkZXWFgiLCJjb252ZXJzYXRpb25TaWQiOiJDSFhYIn0=
```


3. Create a file named test-data.json in your project root with the final structure (using your generated Base64 string):
```
{
    "message": {
        "data": "eyJleGVjdXRpb25TaWQiOiJGTlhYIiwiZmxvd1NpZCI6IkZXWFgiLCJjb252ZXJzYXRpb25TaWQiOiJDSFhYIn0=",
        "messageId": "simulated-pubsub-id-123"
    }
}
```

3. Send the payload to the server running locally:
```curl -X POST http://localhost:8081 -H "Content-type: application/json" -d @./test-data.json```





## Deployment (GCP Cloud Run)
To deploy it, we start from the back:
1. First we deploy the worker (that one that polls studio and removes the webhook).
2. Then we create the subscription topic.
3. Then we deploy the notifier (receives requests from Studio)
4. Finaly we configure the Studio.

### Step 1: Deploy Worker Service
The Worker service runs the cleanup job.

NOTE: We run it from the ROOT directory of the project and point the source to the worker subdirectory.
```
# Replace <SERVICE_NAME_WORKER> and <REGION>
gcloud run deploy <SERVICE_NAME_WORKER> \
  --source worker \
  --region <REGION> \
  --allow-unauthenticated \
  --set-env-vars TWILIO_ACCOUNT_SID="ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",TWILIO_AUTH_TOKEN="<YOUR_AUTH_TOKEN>"
```

Note the Service URL of the deployed Worker service (e.g., https://worker-xxxxx.run.app). <- We'll need this in the next step.


### Step 2. Create Pub/Sub Topic and subscription
1. In your Google Cloud Project, create a new Pub/Sub topic "studio-cleanup-tasks" or whatever you've set in the env vars.
2. Crete a new Pub/Sub subscription, setting delivery type to Push andn pointing to the Worker's URL, path `/`:
(e.g., https://worker-xxxxx.run.app/)


### Step 3: Deploy Notifier Service
The Notifier service receives the initial Twilio request.

Same as before, except now we point to the **notifier** directory and set different env vars.
```
# Replace <SERVICE_NAME_NOTIFIER>, <REGION>
gcloud run deploy <SERVICE_NAME_NOTIFIER> \
  --source notifier \
  --region <REGION> \
  --allow-unauthenticated \
  --set-env-vars STUDIO_TOPIC_NAME="studio-cleanup-tasks"
```

Note the Service URL of the Notifier. We'll use it in Studio to send our request to.


### Step 4: Configure Twilio Webhook
Configure your Twilio Studio Flow with the node "Send HTTP request" to send POST data url encoded or JSON and include the following params:
- `flowSid`:
- `executionSid`:
- `conversationSid`:


## Todo
- Add authentication/twilio signature checking