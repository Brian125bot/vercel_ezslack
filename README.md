# 🧠 Dynamic Gemini Slack AI Agent Backend

[![Engine](https://img.shields.io/badge/Gemini-3.1--Flash--Lite%20%7C%203.5--Flash-blueviolet?style=flat-square&logo=google)](https://ai.google.dev/)
[![Platform](https://img.shields.io/badge/Runtime-Node.js%20%7C%20Express-green?style=flat-square&logo=node.js)](https://nodejs.org/)
[![Deploy](https://img.shields.io/badge/Deploy-Cloud%20Run-blue?style=flat-square&logo=google-cloud)](https://cloud.google.com/run)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

An enterprise-ready, secure, and hot-swappable **Slack AI Agent Backend** powered by **Express.js** and the **Google Gen AI SDK**. This agent incorporates dynamic runtime intent classification, multi-turn threaded memory persistence, and an interactive real-time telemetry dashboard.

Designed specifically to run under the strict timeout requirements of Slack API infrastructures, the backend features an **asynchronous non-blocking double-queue architecture** to decouple initial event ingestion from complex multi-step generative cognition.

---

## 🚀 Key Architectural Capabilities

### 1. 🔄 Live Multi-Cognition Selector
Switch your agent's brain at runtime without a single line of code redeployment or container restart:
* **Gemini 3.1 Flash Lite**: Extra rapid, ultra-low latency, and cost-efficient. Perfect for simple conversational chitchat or high-volume messaging pipelines.
* **Gemini 3.5 Flash**: Outstanding intelligence-to-speed ratio with superior reasoning capabilities.
* **Gemini 2.5 & 2.0 Flash**: High-stability foundation logic models for general structured tasks.

### 2. ⚡ Non-Blocking 3-Second Responders
Slack expects an HTTP `200 OK` handshake response within **3 seconds** of firing an event, failing which it cancels the transaction and fires retry surges. This backend instantly validates cryptographic signatures, registers the job ID, and issues a standard response inside of ~15ms. It then leverages NodeJS `setImmediate` to execute the model loop, intent classification, and API routing concurrently in the background.

### 3. 🧠 Dynamic Intent Classifier (LLM-in-the-Loop)
Every incoming message is analyzed in real-time by the active model engine to determine target intent. The agent classifies intents into specialized robust categories to dictate the action workflow. For more technical implementation details, see our stable [Intent Routing Guide](./docs/intent-routing.md).

* `direct_reply`: Conversational pleasantries and standard Q&A.
* `durable_task`: Multi-step goals, reminders, and advanced project operations requiring background tracking.
* `status_query`: Interrogation of active goals and workflow outcomes.
* `approval_response`: Live validation or rejection of multi-step tools.
* `unsafe_or_unsupported`: Strict boundary classification for destructive actions.

### 4. 🗄️ Durable SQL Agent Core & Runtime (Phase 2)
The backend shift from lightweight scripting to a robust cloud-native **Agent Runtime Loop** backed by PostgreSQL (`CLOUD_SQL_CONNECTION_NAME` or `DATABASE_URL`). 
Multi-step task intents automatically generate structured:
* **Goals & Plans**: Decomposes complex instructions into bounded ordered steps.
* **Executor & Verifier**: Sequentially processes goals through a tool registry, followed by a verification step guaranteeing intended outcomes were actually met.
* **Policy & Approvals**: Intercepts actions based on predefined risk levels (`read`, `draft`, `internal_write`, `external_write`). Explicit approvals requested for external writes and destructive operations safely blocked.
* **Full Audit Trail**: A complete, replayable timeline of goal, plan, tool execution and status updates viewable seamlessly in the Dashboard UI.

### 5. ⚙️ Worker & Queue Invariants
The background task queue separates rapid incoming Slack webhooks from complex, longer-running background planning, execution, and verification loops. It ensures scalability and high availability:
* **Queue Claim Pattern**: Atomic database row reservation using `FOR UPDATE SKIP LOCKED` to support safe parallel queue claims across multiple instances.
* **Lease TTL**: Claims are locked for `300 seconds` (5 minutes) during model loop runs to prevent concurrent executions.
* **Stale-Recovery**: Auto-cleanup via `recoverStaleClaims()` runs at the beginning of each polling cycle, recovering runs with expired leases.
* **Concurrency Limit**: Standard configuration restricts work to `maxConcurrent = 2` runs per container.
* **Polling Interval**: Checked every `2 seconds` (`2000` ms) for freshly queued executions.
* **Database State Check**: The background worker is strictly initialized and starts only when the database is available.
* **Migration Version**: Built on version `2` of the idempotent SQL schema.

### 6. 🧵 Stateful Conversation Thread Memory
Maintains up to the last 20 conversational turns per unique thread context (dynamically keyed on channel/thread hash values) so interactions feel natural, context-aware, and continuous.

---

## 📊 Dashboard Telemetry Interface

The companion management UI gives you absolute control over your live agentic ecosystem:
- **Model Control Panel**: Toggle live model switches on the fly.
- **Agent Runs & SQL Trace**: Navigate and drill-down into durable agent goal logs inside an integrated trace UI (if SQL is mounted).
- **Cognition Latency Tracking**: View granular millisecond statistics for each background task.
- **Pipeline Event Logs**: Track cryptographic signature states, resolved conversation keys, and dynamic class confidence rates.
- **Simulator Gateway**: Test agent responses through a mock environment before publishing to a live Slack channel.

---

## 📅 Roadmap & Progress

For detailed tracking of feature implementations, improvements, and architectural milestones, please see the [CHANGELOG.md](./CHANGELOG.md) outlining completed deliverables (such as intent-level routing) and the immediate scope roadmap (such as async worker queues and semantic verifiers).

---

## 🛠️ Tech Stack & Structure

* **Language**: TypeScript (NodeJS LTS)
* **Framework**: Express.js
* **AI Engine**: `@google/genai` (Google Gen AI SDK)
* **Build System**: Vite (Frontend React) & `tsx` / `esbuild` (Backend CJS Bundle integration)

```text
├── server.ts              # Express backend server with asynchronous Gemini queueing
├── src/
│   ├── App.tsx            # React Dashboard with monitoring and simulator
│   ├── main.tsx           # Entry React mounting node
│   ├── index.css          # Tailwind CSS global styles stylesheet
│   └── server/
│       ├── agent/         # Agent runtime loop (intent, orchestrator, planner, executor, verifier)
│       ├── storage/       # Durable PostgreSQL persistence (schema, store, migrations)
│       └── tools/         # Strongly-typed tools (memory, slack, task)
├── slack-manifest.json    # Copy-pasteable Slack App Manifest specification
├── metadata.json          # Applet permission constraints
├── Dockerfile             # Multi-stage Docker build for containerized deployments
├── .dockerignore          # Docker build exclusion rules
└── .env.example           # Reference environment configurations
```

---

## 🐳 Deployment Options (Google Cloud Run)

This repository is built to offer maximum flexibility for cloud-native zero-downtime deployment. It supports natively deploying to Google Cloud Run utilizing either source-based Buildpacks or the included structural Dockerfile.

### Option 1: Cloud Buildpacks (Source Deployment)
Rely on Google's native buildpacks to infer your Node.js runtime and handle optimized containerization automatically.
```bash
gcloud run deploy slack-ai-agent \
  --source . \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars="GEMINI_API_KEY=...,SLACK_BOT_TOKEN=...,SLACK_SIGNING_SECRET=...,DASHBOARD_PASSWORD=..."
```

### Option 2: Custom Multi-Stage Dockerfile
If you prefer deterministic control over image sizing, dependency pruning, and layer caching, you can compile leveraging the custom two-stage `Dockerfile` included in the repository. The provided Dockerfile uses an Alpine Linux base to heavily optimize footprint (~20MB target).

```bash
# Build the Docker image locally
docker build -t gcr.io/YOUR_PROJECT_ID/slack-ai-agent .

# Push the image to GCP Container Registry
docker push gcr.io/YOUR_PROJECT_ID/slack-ai-agent

# Deploy the image to Cloud Run
gcloud run deploy slack-ai-agent \
  --image gcr.io/YOUR_PROJECT_ID/slack-ai-agent \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars="GEMINI_API_KEY=...,SLACK_BOT_TOKEN=...,SLACK_SIGNING_SECRET=...,DASHBOARD_PASSWORD=..."
```

### Option 3: Automated CI/CD (Google Cloud Build)
This repository includes a pre-configured [cloudbuild.yaml](file:///home/creetacticalgenius/projects/slackcloud/cloudbuild.yaml) file to orchestrate continuous integration and delivery. Pushes to the `main` branch can automatically trigger build pipelines via GCP Cloud Build.

The automated pipeline performs the following steps:
1. **Build**: Compiles a production-ready container using the multi-stage `Dockerfile` built with Node 22 (required for `@google-cloud/cloud-sql-connector` engine requirements).
2. **Push SHA Tag**: Pushes the image tagged with the corresponding git commit SHA.
3. **Push Latest Tag**: Publishes the same image with the `:latest` tag for rapid cache resolution and general fallback.
4. **Deploy**: Executes `gcloud run deploy` to cleanly update the active revision on Cloud Run in the `us-west1` region.

To manually trigger a build using the configured trigger on Google Cloud:
```bash
gcloud builds triggers run <TRIGGER_ID> \
  --branch=main \
  --project=<PROJECT_ID>
```

> [!NOTE]
> **Stale Annotation Resolution:** If your service was originally created using a source-based or AI Studio deployment tool, it may carry a conflicting `run.googleapis.com/sources` annotation. The deployment step uses `gcloud run deploy` (rather than `gcloud run services update`) to cleanly replace the revision specifications, resolving stale source metadata conflicts.

---

## ⚙️ Quick Start Installation

### 1. Populate Environment Variables
Create a `.env` file in the root workspace (see `.env.example` as a template):

```env
# Gemini API Key (Generate one via Google AI Studio)
GEMINI_API_KEY=your_gemini_api_key_here

# Slack Cryptography Integration (Retrieve these from Slack Developer Console)
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-slack-signing-secret

# Administrative Dashboard Password
DASHBOARD_PASSWORD=set_your_secure_password
```

### 2. Install & Start Development Servers

```bash
# Install package dependencies
npm install

# Boot development environment
npm run dev
```

The active web server serves the Live Administrative Dashboard on `http://localhost:3000`.

---

## 📝 Slack Configuration Walkthrough

1. Navigate to the [Slack API Console](https://api.slack.com/apps).
2. Click **Create New App** -> select **From an App Manifest**.
3. Choose your workspace, then copy-paste the contents of the `slack-manifest.json` file inside the workspace.
4. Replace the `request_url` value (under `settings.event_subscriptions`) with your production URL:
   `https://your-domain.com/api/slack/events`
5. Click **Install to Workspace** and authorize.
6. Copy the **Signing Secret** and **Bot User OAuth Token** and insert them into your server environment fields.

---

## 🧪 Testing and Simulation

No Slack workspace configured yet? No problem! Use the integrated **Pipeline Simulator Panel**:
1. Open the dashboard in your browser.
2. Select the **Event Pipeline Simulator** tab.
3. Formulate custom channel names, message prompts, and simulated credentials.
4. Hit **Trigger Pipeline Handler** and watch the stateful backend queue process the jobs, show real-time logs, calculate classification confidence, and render the exact Slack-formatted markdown response in real-time.
