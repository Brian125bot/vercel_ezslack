import express from "express";
import path from "path";

import dotenv from "dotenv";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { router as apiRoutes } from "./src/server/routes.js";
import { requireDurableDependencies, isRedisRequired } from "./src/server/storage/readiness.js";
import { DurableStateError } from "./src/server/storage/errors.js";
import { closeDb } from "./src/server/storage/db.js";
import { KvRateLimitStore } from "./src/server/rateLimitStore.js";
import { validateEnv } from "./src/server/env.js";

dotenv.config();
validateEnv();

if (process.env.NODE_ENV === 'production') {
  try {
    new URL(process.env.APP_URL || '');
  } catch {
    throw new Error('APP_URL must be a valid URL in production for HTTPS redirect security');
  }
}

const app = express();
app.set('trust proxy', true);
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
let apiLimiterStore: import('express-rate-limit').Store | undefined;
if (isRedisRequired() || (process.env.NODE_ENV === 'production' && (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL))) {
  apiLimiterStore = new KvRateLimitStore();
}

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  store: apiLimiterStore, // KvRateLimitStore in strict/production mode
  message: "Too many requests from this IP, please try again after 15 minutes",
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, trustProxy: false, default: true }
});

app.use("/api", (req, res, next) => {
  apiLimiter(req, res, (err: any) => {
    if (err) {
      if (err instanceof DurableStateError || err?.name === 'DurableStateError') {
        return res.status(err.status || 503).json({
          error: 'Service temporarily unavailable due to storage outage.'
        });
      }
      return next(err);
    }
    next();
  });
});

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

const readinessBypassPaths = new Set(['/health', '/readiness']);

// Every other API route is fail-closed: the request reaches route and agent code
// only after the shared durable readiness gate has completed successfully.
app.use('/api', async (req, res, next) => {
  if (readinessBypassPaths.has(req.path)) {
    return next();
  }

  try {
    await requireDurableDependencies();
    return next();
  } catch (err: any) {
    const isDurable = err instanceof DurableStateError || err?.name === 'DurableStateError';
    const isSlackIngress = req.path === '/slack/events' || req.path.startsWith('/slack/events');
    if (isDurable && isSlackIngress) {
      console.error('[Ingress] Persistence unavailable, failing closed for Slack retry', { operation: (err as any).operation || (err as any).code || 'unknown', error: err.message });
      res.set('Retry-After', '5');
      return res.status(503).json({ error: 'persistence_unavailable', retry_after: 5 });
    }
    return res.status(isDurable ? (err.status || 503) : 503).json({
      error: 'Service temporarily unavailable due to storage outage.'
    });
  }
});

// Mount API routes
app.use('/api', apiRoutes);

let server: ReturnType<typeof app.listen> | null = null;

async function initServer() {
  validateEnv();
  await requireDurableDependencies();

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
  initServer().catch(() => {
    console.error('[FATAL] Server startup failed.');
    process.exit(1);
  });
} else {
  console.log('[Vercel] Exporting Express app for serverless functions');
}

export default app;