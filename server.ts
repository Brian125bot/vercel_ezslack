import express from "express";
import path from "path";

import dotenv from "dotenv";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { router as apiRoutes } from "./src/server/routes.js";
import { runMigrations } from "./src/server/storage/migrations.js";
import { closeDb } from "./src/server/storage/db.js";
import { KvRateLimitStore } from "./src/server/rateLimitStore.js";
import { validateEnv } from "./src/server/env.js";

dotenv.config();
validateEnv();

const app = express();
app.set('trust proxy', 1);
const PORT = parseInt(process.env.PORT || '3000');

// Security: Redirect HTTP to HTTPS in production (behind proxy)
if (process.env.DISABLE_HTTPS_REDIRECT !== '1' && process.env.NODE_ENV === 'production') {
  let safeHost: string | null = null;
  try {
    if (process.env.APP_URL) {
      safeHost = new URL(process.env.APP_URL).host;
    }
  } catch (err) {
    console.warn('[Security] Invalid APP_URL for HTTPS redirect fallback');
  }

  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] === 'http') {
      if (!safeHost) {
        return res.status(400).send('Bad Request');
      }
      res.redirect(301, `https://${safeHost}${req.originalUrl}`);
    } else {
      next();
    }
  });
}

// Security: Set HTTP Security Headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws://localhost:3000", "ws://0.0.0.0:3000"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      ...(process.env.NODE_ENV === 'production' && { upgradeInsecureRequests: [] }),
    },
  },
  xFrameOptions: { action: 'deny' },
  strictTransportSecurity: process.env.NODE_ENV === 'production'
    ? { maxAge: 31536000, includeSubDomains: true, preload: true }
    : false,
}));

// Security: Cross-Origin Resource Sharing (CORS)
app.use(cors({
  origin: process.env.APP_URL || (process.env.NODE_ENV === 'production' ? false : '*'),
  methods: ["GET", "POST"]
}));

// Security: Global API Rate Limiting to prevent DoS attacks.
// Uses Vercel KV (Upstash Redis) when configured so the counter is shared
// across all serverless instances; falls back to per-process memory otherwise.
let apiLimiterStore: import('express-rate-limit').Store | undefined;
if (process.env.NODE_ENV === 'production' && (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL)) {
  try {
    apiLimiterStore = new KvRateLimitStore();
  } catch (err) {
    console.warn('[RateLimit] Falling back to in-memory store:', err);
  }
}

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  store: apiLimiterStore, // undefined => default MemoryStore (dev / in-memory)
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
app.use(express.urlencoded({
  extended: true,
  limit: '2mb',
  verify: (req: any, res, buf) => {
    if (!req.rawBody) {
      req.rawBody = Buffer.from(buf);
    }
  }
}));

// Lazy migration runner for Vercel serverless environment
let vercelMigrationsPromise: Promise<void> | null = null;
app.use((req, res, next) => {
  if (process.env.VERCEL === '1' && !vercelMigrationsPromise && process.env.DATABASE_URL) {
    vercelMigrationsPromise = runMigrations().catch(err => {
      console.error('[Vercel Boot] Lazy database migrations failed:', err);
      vercelMigrationsPromise = null; // Reset promise to retry on next request
    });
  }

  if (vercelMigrationsPromise) {
    vercelMigrationsPromise.then(() => next()).catch(() => next());
  } else {
    next();
  }
});

// Mount API routes
app.use('/api', apiRoutes);

let server: ReturnType<typeof app.listen> | null = null;

// Configure Vite middleware or static paths based on environment
async function initServer() {
  // Validate critical environment variables first, before any async work.
  // This ensures fail-hard behavior if required vars are missing/invalid on all platforms
  // including Vercel, preventing silent security failures.
  validateEnv();

  try {
    if (process.env.DATABASE_URL || process.env.CLOUD_SQL_CONNECTION_NAME || process.env.SQL_HOST) {
      await runMigrations();
    } else {
      console.log('No SQL configuration found (DATABASE_URL / CLOUD_SQL_CONNECTION_NAME / SQL_HOST). Skipping database migrations.');
    }
  } catch (err) {
    console.error('Failed to run database migrations:', err);
  }

  if (process.env.NODE_ENV !== "production") {
    console.log(`[Vite Dev] Hosting express full-stack server with Vite middleware mode...`);
    const { createServer: createViteServer } = await import("vite");
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

  if (process.env.VERCEL !== '1') {
    server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`[Fullstack Server Ready] Slack backend API serving on http://0.0.0.0:${PORT}`);
    });
  }
}

if (process.env.VERCEL !== '1') {
  initServer().catch((err) => {
    console.error('[FATAL] Server startup failed:', err);
    process.exit(1);
  });
} else {
  console.log('[Vercel] Exporting Express app for serverless functions');
}

export default app;
