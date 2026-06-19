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
Every incoming message is analyzed in real-time by the active model engine to determine target intent. The agent classifies intents with confidence scores into specialized categories:
* `GENERAL_CHITCHAT`: Conversational pleasantries.
* `TECH_SUPPORT`: IT, codebase inquiries, or network issues.
* `TASKS_AND_TODO`: Project milestones, checklists, and assignments.
* `DATA_ANALYTICS`: SQL queries, metric dumps, or log summaries.
* `ADMIN_ALERT`: System breaches, security concerns, or failovers.

### 4. 🧵 Stateful Conversation Thread Memory
Maintains up to the last 20 conversational turns per unique thread context (dynamically keyed on channel/thread hash values) so interactions feel natural, context-aware, and continuous.

---

## 📊 Dashboard Telemetry Interface

The companion management UI gives you absolute control over your live agentic ecosystem:
- **Model Control Panel**: Toggle live model switches on the fly.
- **Cognition Latency Tracking**: View granular millisecond statistics for each background task.
- **Pipeline Event Logs**: Track cryptographic signature states, resolved conversation keys, and dynamic class confidence rates.
- **Simulator Gateway**: Test agent responses through a mock environment before publishing to a live Slack channel.

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
│   └── index.css          # Tailwind CSS global styles stylesheet
├── slack-manifest.json    # Copy-pasteable Slack App Manifest specification
├── metadata.json          # Applet permission constraints
└── .env.example           # Reference environment configurations
```

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
