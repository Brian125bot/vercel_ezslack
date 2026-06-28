import app from '../server.js';
import { runMigrations } from '../src/server/storage/migrations.js';

let migrationsPromise: Promise<void> | null = null;

// Lazy migration runner for Vercel serverless environment
app.use((req, res, next) => {
  if (!migrationsPromise && process.env.DATABASE_URL) {
    migrationsPromise = runMigrations().catch(err => {
      console.error('[Vercel Boot] Lazy database migrations failed:', err);
      migrationsPromise = null; // Reset promise to retry on next request
    });
  }

  if (migrationsPromise) {
    migrationsPromise.then(() => next()).catch(() => next());
  } else {
    next();
  }
});

export default app;
