---
name: cloud-run-deployment
description: Modifies and prepares web application projects (Node.js/TypeScript, Python, Go) for containerized deployment on Google Cloud Run. Handles Dockerfile compilation, PORT environment binding, Cloud Build configuration, and GCP Secret Manager mounting.
---

# Cloud Run Deployment & Modification Skill

Use this skill when modifying, containerizing, or preparing an application to run on Google Cloud Run. Google Cloud Run is a fully managed serverless platform that automatically scales your stateless containers.

---

## 1. Core Principles & Prerequisites

When adapting any project for Cloud Run, verify and modify the codebase according to these six pillars:

### A. Port & Host Binding
- **Host Binding**: The application must bind to interface `0.0.0.0` (all network interfaces), NOT `127.0.0.1` or `localhost`. Binding to `localhost` makes the application unreachable from the Cloud Run ingress proxy.
- **Port Binding**: Respect the `PORT` environment variable injected by Cloud Run. Do not hardcode a specific port without checking `PORT` first.
  - **Node.js**: `const PORT = parseInt(process.env.PORT || "8080", 10);`
  - **Python**: `port = int(os.environ.get("PORT", 8080))`
  - **Go**: `port := os.Getenv("PORT"); if port == "" { port = "8080" }`

### B. Lightweight Containerization (Multi-stage Builds)
- Always use **multi-stage builds** to compile assets in a build environment and copy only the runtime artifacts into a lean production image. This reduces image size, speeds up deployments, and limits security exposure.
- Use official alpine or slim base images (e.g., `node:22-alpine`, `python:3.11-slim`, `gcr.io/distroless/static-debian12`).
- Never run containers as `root` in production. Always switch to a non-privileged user (e.g., `USER node` for Node/Alpine, or create a custom system user for other languages).

### C. Graceful Shutdown & Request Draining
- Cloud Run sends a `SIGTERM` signal to a container instance before terminating it due to scaling down or a new deployment.
- The application **must** intercept `SIGTERM` and `SIGINT` signals, stop accepting new connections, finish handling active requests (request draining), and close database/cache client pools before exiting.
- Add a 2–5 second artificial delay during `SIGTERM` handling to allow the Cloud Run load balancer to stop routing new traffic to the instance before exiting.

### D. Production Environment Variables & Secrets
- **Never hardcode secrets** (API keys, database credentials, private tokens) in source code, Dockerfiles, or CI/CD files.
- **Local Config**: Keep `.env` files exclusively for local development; add them to `.gitignore` and `.dockerignore`.
- **Cloud Config**: Utilize **Google Cloud Secret Manager** to securely manage credentials. Mount secrets as environment variables or files directly to the Cloud Run service container at runtime.
  - Command reference: `gcloud run deploy --set-secrets="DATABASE_URL=db-url-secret:latest"`

### E. CI/CD Integration (Cloud Build)
- Automate linting, unit testing, Docker builds (pushing to Google Artifact Registry), and deployment using a structured `cloudbuild.yaml` file.
- Prefer Artifact Registry (`${_REGION}-docker.pkg.dev/$PROJECT_ID/...`) over deprecated Container Registry (`gcr.io/...`).

---

## 2. Step-by-Step Modification Checklist

Follow these steps when preparing a codebase for deployment:

### Step 1: Audit and Update Port Binding
Locate the main entrypoint file of the application (e.g., `server.ts`, `app.py`, `main.go`).
Verify that the server start/listen block uses `process.env.PORT` (or equivalent) and binds to `0.0.0.0`.
*Example modification for Express:*
```typescript
const PORT = parseInt(process.env.PORT || "8080", 10);
const HOST = "0.0.0.0";

const server = app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
```

### Step 2: Implement Graceful Shutdown
Add signal handlers to gracefully clean up dependencies:
*Example modification for Node.js:*
```typescript
async function gracefulShutdown(signal: string) {
  console.log(`[${signal}] Graceful shutdown initiated...`);
  
  if (server) {
    server.close(() => {
      console.log('[Shutdown] HTTP server closed.');
    });
  }
  
  // Wait short buffer for connections to drain
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Close DB connections here (e.g., db.close() or pgPool.end())
  console.log('[Shutdown] Completed. Exiting.');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

### Step 3: Create `.dockerignore`
Write a `.dockerignore` file in the root directory to optimize build speed and security. Include:
```
node_modules
npm-debug.log
.git
.env
.env.local
dist
build
Dockerfile
cloudbuild.yaml
tests
```

### Step 4: Write/Verify `Dockerfile`
Choose the appropriate Dockerfile template based on the project's language stack. Use a multi-stage approach:
1. **Build stage**: Install all dependencies (including devDependencies), compile code (TypeScript to JS, go build, etc.), and build web assets.
2. **Production stage**: Install only runtime/production dependencies, copy built assets, define non-root user, expose the target port, and set the entry point command.
*(Use reference templates located in this skill's `resources/` directory).*

### Step 5: Configure `cloudbuild.yaml`
Provide a `cloudbuild.yaml` file for automated deployment.
- Define parameters in `substitutions` (such as `_REGION`, `_IMAGE`, `_SERVICE_NAME`).
- Include steps for:
  1. Dependencies linting and static analysis.
  2. Running unit tests.
  3. Docker build and tagging (using Artifact Registry).
  4. Docker push.
  5. `gcloud run deploy` with appropriate parameters.

### Step 6: Validate the Configuration
Run syntax checking tools (e.g. `npm run lint`, `dockerfile_lint`) to verify configuration files are correct.

---

## 3. Secret Manager & Cloud SQL Setup Reference

### Securing Database Credentials (Cloud SQL)
When connecting a Cloud Run service to a Cloud SQL PostgreSQL or MySQL instance, configure the connection securely using the Cloud SQL Auth Proxy connector built into Cloud Run:
1. Enable the **Cloud SQL Admin API** in the GCP Project.
2. Ensure the Cloud Run Service Account has the **Cloud SQL Client** role (`roles/cloudsql.client`).
3. Deploy the service with the Cloud SQL connection flag:
   ```bash
   gcloud run deploy my-service \
     --add-cloudsql-instances=PROJECT-ID:REGION:INSTANCE-NAME \
     --set-secrets="DATABASE_URL=my-db-secret:latest"
   ```
4. Within your database connection configuration, use the UNIX socket path provided by Cloud Run instead of IP addresses:
   - PostgreSQL Unix Socket: `/cloudsql/PROJECT-ID:REGION:INSTANCE-NAME/.s.PGSQL.5432`
   - MySQL Unix Socket: `/cloudsql/PROJECT-ID:REGION:INSTANCE-NAME`
