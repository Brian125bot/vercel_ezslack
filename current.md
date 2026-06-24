# Current Project State Orientation

## Overview

This is an **enterprise-grade Slack AI Agent Backend** - a sophisticated, production-ready AI assistant platform that powers intelligent automation within Slack workspaces. Built with modern technologies and designed for reliability, security, and scalability, it represents a complete solution for deploying AI agents in enterprise environments.

---

## Project Identity

**Name:** slack-ez-cloud  
**Version:** Current in active development (latest: v3.1.0)  
**License:** MIT  
**Status:** Production-ready with comprehensive test coverage

### Core Mission
To provide a secure, reliable, and intelligent AI agent platform that enhances Slack workspace productivity through automated task execution, natural language understanding, and seamless integration with external services.

---

## Current Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      SLACK WORKSPACE                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ @mentions     │  │ Direct Msgs  │  │ Channel Messages         │ │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                              │ HTTPS POST
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    EXPRESS.JS SERVER (Cloud Run)                    │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ POST /api/slack/events ──► Verify Signature (HMAC-SHA256)   │   │
│  │       │                     Dedup (event_id + client_msg_id)│   │
│  │       │                     ACK 200 OK (<15ms)              │   │
│  │       │                                                     │   │
│  │       └──► Intent Classification (Heuristic + LLM)          │   │
│  │               │                                             │   │
│  │    ┌──────────┼──────────────────────────────────────┐     │   │
│  │    │          │                                      │     │   │
│  │    ▼          ▼                                      ▼     │   │
│  │ direct_reply  durable_task                status_query      │   │
│  │ approval_response  cancel_or_update                        │   │
│  │                                                           │   │
│  │    └──► Google Cloud Tasks ──► Webhook ──► Agent Loop     │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ React Dashboard (Real-time Monitoring)                       │   │
│  │ Model Control Panel | Agent Runs | SQL Trace | Simulator   │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    DATA LAYER (PostgreSQL Cloud SQL)                 │
│  goals → plans → runs → steps → tool_calls | memory_records       │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Architectural Components

#### 1. **Express Server** (`server.ts`)
- **Port:** 3000 (configurable)
- **Security:** Helmet, CORS, Rate limiting
- **Middleware:** JSON parsing with raw body preservation
- **Graceful Shutdown:** Handles SIGTERM/SIGINT signals
- **Lifecycle:** Database migrations → worker/scheduler stubs initialized → HTTP listener

#### 2. **Intent Classification System** (`src/server/agent/intent.ts`)
Six distinct intent categories:

| Intent | Handler | Description |
|--------|---------|-------------|
| `direct_reply` | DB-less conversational reply | Immediate responses without database |
| `durable_task` | Goal → Run → Plan → Execute | Full task execution with persistence |
| `status_query` | Goal/run queries | Status updates on existing tasks |
| `approval_response` | Pending approval resolution | Resume/cancel based on user decisions |
| `cancel_or_update` | Plan mutation | Modify or cancel active tasks |
| `unsafe_or_unsupported` | Refusal handling | Safety fallbacks for risky requests |

#### 3. **Agent Pipeline** (`src/server/agent/`)
Complete closed-loop system with verification:

```
Plan → Execute → Verify → Replan (if needed)
```

- **Planner:** Gemini AI with structured output
- **Executor:** Tool/generate/note step execution
- **Verifier:** Rule-based + semantic verification
- **Reporter:** Action-aware Slack summaries

#### 4. **Tool System** (`src/server/tools/`)
Modular tool registry with conditional adapters:

- **Core Tools:** Slack replies, memory management, task recording
- **External Adapters:** GitHub Issues, Email webhooks
- **Risk Governance:** Policy gates for external writes
- **Approval Flow:** Block Kit buttons for human oversight

---

## Technology Stack

### Backend
- **Runtime:** Node.js 22 (ES2022)
- **Framework:** Express.js 4.21.2
- **Language:** TypeScript 5.8 (strict mode)
- **AI:** Google Gemini 2.5/3.5 Flash
- **Database:** PostgreSQL (Cloud SQL)
- **Testing:** Vitest 3.2.4

### Frontend
- **Framework:** React 19.0.1
- **Build:** Vite 6.2.3
- **Styling:** Tailwind CSS 4.1.14
- **Animations:** Motion 12.23.24
- **Icons:** Lucide React

### Infrastructure
- **Deployment:** Google Cloud Run
- **CI/CD:** Cloud Build
- **Container:** Docker (multi-stage Node 22 Alpine)
- **Security:** Helmet, express-rate-limit

### Development Tools
- **Build:** esbuild (server bundling)
- **Linting:** TypeScript compiler (`tsc --noEmit`)
- **Formatting:** Prettier + ESLint

---

## Project Structure

```
slackcloud/
├── server.ts                          # Express entry point, graceful shutdown
├── src/
│   ├── App.tsx                        # React Dashboard UI (77KB)
│   ├── main.tsx                       # React entry
│   ├── index.css                      # Tailwind CSS
│   ├── types.ts                       # Shared frontend/backend types
│   └── server/
│       ├── routes.ts                  # All API routes + Slack signature verify
│       ├── auth.ts                    # Dashboard password auth middleware
│       ├── state.ts                   # In-memory logs, model selection, dedup sets
│       ├── ai.ts                      # Gemini SDK wrapper
│       ├── agent/
│       │   ├── orchestrator.ts        # Pipeline entry point
│       │   ├── intent.ts              # Heuristic + LLM intent classifier
│       │   ├── handlers/             # Intent-specific handlers
│       │   ├── planner.ts            # Gemini plan generation
│       │   ├── executor.ts           # Step execution
│       │   ├── verifier.ts           # Rule-based verification
│       │   ├── semanticVerifier.ts   # LLM-based verification
│       │   ├── loop.ts               # Closed loop system
│       │   ├── worker.ts             # Webhook execution handler (formerly queue poller)
│       │   ├── scheduler.ts          # Scheduled trigger processor (formerly trigger poller)
│       │   ├── taskClient.ts         # Google Cloud Tasks client wrapper
│       │   └── policy.ts             # Risk-level policy gate
│       ├── storage/
│       │   ├── schema.ts             # Migration SQL definitions
│       │   ├── migrations.ts         # Migration runner
│       │   └── agentStore.ts         # All DB queries
│       └── tools/
│           ├── registry.ts           # Tool registry
│           ├── slack.ts              # Slack reply + Block Kit
│           ├── memory.ts             # Memory read/write
│           └── adapters/             # External tool adapters
├── tests/                            # 72 test cases, 8 suites
├── docs/                             # Documentation
├── assets/                           # Static assets
├── package.json                      # Dependencies and scripts
├── tsconfig.json                     # TypeScript configuration
├── vite.config.ts                    # Vite build config
├── vitest.config.ts                  # Test configuration
├── Dockerfile                        # Multi-stage container build
├── cloudbuild.yaml                   # CI/CD pipeline
└── slack-manifest.json               # Slack App Manifest
```

---

## Current Features & Capabilities

### 1. **Production-Ready Security**
- HMAC-SHA256 signature verification for Slack webhooks
- Rate limiting (2000 requests per 15 minutes)
- CORS configuration with environment-based origins
- Helmet security headers
- Dashboard password protection
- Secret detection and redaction in outputs

### 2. **Intelligent Task Execution**
- Multi-step goal decomposition
- Automatic plan generation with Gemini AI
- Tool execution with retry logic
- Parallel execution support
- Deferral detection (time-delayed tasks)

### 3. **External Integrations**
- **GitHub:** Issue creation via API
- **Email:** Webhook-based notifications
- **Dynamic Loading:** Adapters activate only when environment variables are set

### 4. **Real-Time Dashboard**
- Model control panel for runtime switching
- Agent run history with SQL trace viewing
- Pipeline event logs with signature verification
- Simulator for testing without live Slack

### 5. **Comprehensive Testing**
- **8 Test Suites:** Intent, Policy, Sanitize, Verifier, Reporter, Deferral, Loop, Migration
- **72 Test Cases:** High coverage with Vitest
- **CI/CD Integration:** Automated testing before deployment

### 6. **Scalability Features**
- Google Cloud Tasks integration for serverless, resource-efficient background execution
- Native retry, backoff, and concurrency management by Google Cloud Tasks
- FOR UPDATE SKIP LOCKED as a concurrency fallback for synchronous paths
- Graceful shutdown handling

---

## Configuration & Environment

### Required Variables
```bash
GEMINI_API_KEY=your_gemini_key
SLACK_BOT_TOKEN=xoxb-your-slack-token
SLACK_SIGNING_SECRET=your-signing-secret
DASHBOARD_PASSWORD=secure-admin-password
```

### Optional & Cloud Tasks Variables
```bash
APP_URL=https://your-app.run.app                      # Required for Cloud Tasks webhook routing
GCP_PROJECT_ID=your-gcp-project-id                    # Required for Google Cloud Tasks integration
GCP_LOCATION=us-west1                                 # Optional, default: us-west1
CLOUD_TASKS_QUEUE_NAME=slack-agent-queue              # Optional, default: slack-agent-queue
INTERNAL_API_SECRET=your-internal-secret              # Required for authenticating internal webhooks
GITHUB_TOKEN=ghp_your_github_token                    # Optional, enables GitHub Issue adapter
EMAIL_WEBHOOK_URL=https://your-webhook.com            # Optional, enables Email adapter
DATABASE_URL=postgresql://user:pass@host:port/db      # Optional database params
CLOUD_SQL_CONNECTION_NAME=project:region:instance     # Optional Cloud SQL param
```

### Database Schema
Nine core tables:
- `agent_goals` - User objectives
- `agent_plans` - Versioned execution plans
- `agent_runs` - Execution attempts
- `agent_steps` - Ordered steps
- `tool_calls` - Execution records
- `approval_requests` - Pending approvals
- `memory_records` - Long-term memory
- `audit_events` - Action timeline
- `scheduled_triggers` - Deferred executions

---

## Development Workflow

### Getting Started
```bash
# 1. Clone and install
git clone <repo-url>
cd slackcloud
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your credentials

# 3. Start development server
npm run dev
# Dashboard at http://localhost:3000
```

### Development Commands
```bash
npm run dev          # Start development server
npm run build        # Build production bundle
npm run start        # Run production server
npm run lint         # Type checking (tsc --noEmit)
npm run test         # Run test suite
npm run clean        # Remove build artifacts
```

### Code Quality
- TypeScript strict mode enforced
- Prettier for formatting
- ESLint for linting
- `npm run lint` is the CI gate

---

## Testing & Quality Assurance

### Test Suites
| Suite | File | Cases | Description |
|-------|------|:-----:|-------------|
| Intent Classification | `intent.test.ts` | 11 | Heuristic patterns for 6 intent categories |
| Policy Gate | `policy.test.ts` | 6 | Risk-level-based allow/deny decisions |
| Secret Sanitization | `sanitize.test.ts` | 11 | Token/password/key detection |
| Rule Verifier | `verifier.test.ts` | 6 | Post-execution verification |
| Action Reporter | `reporter.test.ts` | 8 | Structured Slack reports |
| Deferral Detection | `deferral.test.ts` | 17 | Time-deferred pattern matching |
| Agent Loop | `loop.test.ts` | 4 | Full closed-loop integration |
| Migration | `migration.test.ts` | 9 | Static SQL analysis |

### Running Tests
```bash
npm test              # Single run
npm run test:watch    # Watch mode
npm run test:coverage # With coverage
```

---

## Deployment & Operations

### Cloud Build Pipeline (`cloudbuild.yaml`)
1. **Install:** `npm ci`
2. **Lint:** `npm run lint`
3. **Test:** `npm test`
4. **Build:** Docker multi-stage build
5. **Push:** `gcr.io/[PROJECT]/slack-ai-agent`
6. **Deploy:** Cloud Run (us-west1)

### Docker Configuration
- **Base Image:** Node.js 22 Alpine
- **Multi-stage:** Build + Production
- **Security:** Non-root user, minimal attack surface
- **Port:** 3000 (configurable via PORT env)

### Cloud Run Configuration
- **Platform:** Fully managed
- **Scaling:** 0-10 instances
- **Memory:** 2GB limit
- **CPU:** 1000m limit
- **Authentication:** Unauthenticated (Slack webhooks)

### Production Hardening
- Refuses to start without required secrets
- Graceful shutdown on SIGTERM/SIGINT
- Database connection pooling
- 2-second drain timeout for in-flight requests

---

## Monitoring & Observability

### Dashboard Features
- **Model Control:** Runtime switching between Gemini models
- **Run History:** Browse all agent executions
- **SQL Trace:** Drill into goal → plan → steps → tool calls
- **Event Logs:** Signature verification, intent classification
- **Simulator:** Test webhook without live Slack

### Health Check
```bash
GET /api/health
# Returns: { status: 'ok', uptime: N }
```

### Metrics
- Request latency tracking
- Error rate monitoring
- Resource utilization
- Agent performance metrics

---

## Current Status & Roadmap

### Completed Milestones
✅ **v2.0.0:** Trust & correctness, agent loop foundation  
✅ **v2.1.0:** CI/CD pipeline, Node 22, repo cleanup  
✅ **v3.0.0:** Real-world actions, autonomy & hardening  
✅ **v3.1.0:** Final gaps: deferral, plan mutation, loop tests  
✅ **v5.0.0:** Google Cloud Tasks migration, error boundary hardening, and reporting resilience

### Current Capabilities
✅ Production-ready deployment  
✅ Enterprise-grade security  
✅ Comprehensive test coverage  
✅ Real-time monitoring dashboard  
✅ External service integration  
✅ Graceful failure handling  

### Future Enhancements (Phase 3.0)
🚀 Multi-strategy planning engine  
🚀 Advanced multi-agent collaboration  
🚀 Dynamic resource management  
🚀 Enhanced feedback integration  

---

## Quick Reference

### API Endpoints
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/slack/events` | Slack Events API |
| POST | `/api/slack/interactivity` | Block Kit buttons |
| GET | `/api/health` | Health check |
| GET | `/api/status` | System status |
| POST | `/api/model/select` | Switch AI model |
| GET | `/api/agent/runs` | List runs |
| GET | `/api/agent/runs/:id` | Run details |
| GET | `/api/agent/memory` | Search memory |
| GET | `/api/agent/audit` | Audit events |
| POST | `/api/internal/worker/execute` | Internal Cloud Tasks webhook for executing runs (auth required) |
| POST | `/api/internal/scheduler/poll` | Internal Cloud Tasks/Scheduler webhook for scheduled triggers (auth required) |

### Key Components
- **Server:** `server.ts`
- **Routes:** `src/server/routes.ts`
- **Agent Loop:** `src/server/agent/loop.ts`
- **Intent:** `src/server/agent/intent.ts`
- **Tools:** `src/server/tools/registry.ts`
- **Storage:** `src/server/storage/agentStore.ts`
- **Dashboard:** `src/App.tsx`

---

## Documentation Index

- **README.md:** Complete project documentation
- **AGENTS.md:** Repository guidelines
- **docs/intent-routing.md:** Intent classification spec
- **CHANGELOG.md:** Version history
- **.env.example:** Environment template
- **phase3.0.md:** Future enhancements plan

---

## Summary

This is a **mature, production-ready AI agent platform** that successfully balances sophisticated AI capabilities with enterprise-grade reliability and security. The architecture demonstrates:

1. **Reliability:** Graceful shutdowns, retry logic, and error recovery
2. **Security:** Multiple layers of protection from authentication to secret redaction
3. **Scalability:** Stateless design with concurrent instance safety
4. **Maintainability:** Clean architecture with comprehensive testing
5. **Extensibility:** Modular tool system with dynamic adapter loading

The project represents a complete solution for enterprise AI automation in Slack, ready for production deployment with ongoing enhancements planned for Phase 3.0 and beyond.