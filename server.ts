import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { router as apiRoutes } from "./src/server/routes.js";

dotenv.config();

const app = express();
const PORT = 3000;

// Security: Expose minimal server information
app.disable('x-powered-by');

// Security: Set HTTP Security Headers
// Note: Content Security Policy is disabled to avoid breaking Vite's inline scripts in dev
app.use(helmet({
  contentSecurityPolicy: false,
}));

// Security: Cross-Origin Resource Sharing (CORS)
app.use(cors({
  origin: process.env.APP_URL || "*",
  methods: ["GET", "POST"]
}));

// Security: Global API Rate Limiting to prevent DoS attacks
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 2000, 
  message: "Too many requests from this IP, please try again after 15 minutes",
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api", apiLimiter);

// Preserve raw buffer body for Slack signature verify using custom JSON parser verify hook
// Security: Enforce explicit payload limit (2MB)
app.use(express.json({
  limit: '2mb',
  verify: (req: any, res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));

// Mount API routes
app.use('/api', apiRoutes);

// Configure Vite middleware or static paths based on environment
async function initServer() {
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

  // Bind to port 3000 and 0.0.0.0 exclusively
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Fullstack Server Ready] Slack backend API serving on http://0.0.0.0:${PORT}`);
  });
}

initServer();
