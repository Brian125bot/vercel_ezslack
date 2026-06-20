import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { router as apiRoutes } from "./src/server/routes.js";
import { runMigrations } from "./src/server/storage/migrations.js";
import { startWorker, stopWorker } from "./src/server/agent/worker.js";
import { startScheduler, stopScheduler } from "./src/server/agent/scheduler.js";
import { closeDb } from "./src/server/storage/db.js";

dotenv.config();

const app = express();
app.set('trust proxy', 1);
const PORT = 3000;

// Security: Expose minimal server information
app.disable('x-powered-by');

// Security: Set HTTP Security Headers
app.use(helmet({
  contentSecurityPolicy: false,
}));

// Security: Cross-Origin Resource Sharing (CORS)
app.use(cors({
  origin: process.env.APP_URL || (process.env.NODE_ENV === 'production' ? false : '*'),
  methods: ["GET", "POST"]
}));

// Security: Global API Rate Limiting to prevent DoS attacks
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000, 
  message: "Too many requests from this IP, please try again after 15 minutes",
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, default: true }
});
app.use("/api", apiLimiter);

// Preserve raw buffer body for Slack signature verify
app.use(express.json({
  limit: '2mb',
  verify: (req: any, res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));

// Slack interactivity sends URL-encoded payloads
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Mount API routes
app.use('/api', apiRoutes);

// ── W4-D: Graceful shutdown ──
let server: ReturnType<typeof app.listen> | null = null;

async function gracefulShutdown(signal: string) {
  console.log(`\n[${signal}] Graceful shutdown initiated...`);
  stopWorker();
  stopScheduler();

  if (server) {
    server.close(() => {
      console.log('[Shutdown] HTTP server closed.');
    });
  }

  // Give in-flight requests a moment to drain
  await new Promise(resolve => setTimeout(resolve, 2000));

  await closeDb();
  console.log('[Shutdown] Database connections closed. Exiting.');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Configure Vite middleware or static paths based on environment
async function initServer() {
  // Security: Refuse to start in production without required secrets
  if (process.env.NODE_ENV === 'production') {
    const missingSecrets: string[] = [];
    if (!process.env.SLACK_SIGNING_SECRET?.trim()) missingSecrets.push('SLACK_SIGNING_SECRET');
    if (!process.env.DASHBOARD_PASSWORD?.trim()) missingSecrets.push('DASHBOARD_PASSWORD');
    if (missingSecrets.length > 0) {
      console.error(`\n[FATAL] Production startup blocked: missing required secrets: ${missingSecrets.join(', ')}`);
      console.error('[FATAL] Set these environment variables before deploying. Refusing to bind with permissive fallbacks.\n');
      process.exit(1);
    }
  }

  try {
    if (process.env.DATABASE_URL || process.env.CLOUD_SQL_CONNECTION_NAME || process.env.SQL_HOST) {
      await runMigrations();
      startWorker();
      startScheduler(); // W4-A: Start the scheduled triggers poller
    } else {
      console.log('No SQL configuration found (DATABASE_URL / CLOUD_SQL_CONNECTION_NAME / SQL_HOST). Skipping database migrations.');
    }
  } catch (err) {
    console.error('Failed to run database migrations:', err);
  }

  if (process.env.NODE_ENV !== "production") {
    console.log(`[Vite Dev] Hosting express full-stack server with Vite middleware mode...`);
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log(`[Express Prod] Hosting statically compiled UI bundle...`);
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Fullstack Server Ready] Slack backend API serving on http://0.0.0.0:${PORT}`);
  });
}

initServer();
