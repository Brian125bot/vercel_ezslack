# Repository Guidelines

## Project Structure & Module Organization

This is a full-stack TypeScript Slack AI agent. `server.ts` starts Express, mounts API routes under `/api`, and serves Vite middleware in development or `dist/` in production. Backend logic lives in `src/server/`: `routes.ts` handles dashboard and Slack webhook endpoints, `ai.ts` contains Gemini calls, `auth.ts` handles dashboard auth, and `state.ts` stores in-memory runtime state. The React dashboard is in `src/App.tsx`, with focused UI pieces in `src/components/`. Shared types are in `src/types.ts`, global styles in `src/index.css`, AI Studio assets under `assets/`, and Slack app configuration in `slack-manifest.json`.

## Build, Test, and Development Commands

- `npm install`: install dependencies.
- `npm run dev`: run the Express/Vite development server on port `3000`.
- `npm run build`: build the Vite frontend and bundle `server.ts` to `dist/server.cjs`.
- `npm run start`: run the production bundle from `dist/server.cjs`.
- `npm run lint`: run TypeScript checking with `tsc --noEmit`.
- `npm run clean`: remove generated `dist` output and `server.js`.

There is currently no test script in `package.json`.

## Coding Style & Naming Conventions

Use TypeScript with ES modules and React JSX. Vite aliases `@/` to the repository root. Follow the existing style: two-space JSON indentation, component files in PascalCase such as `ModelControlCard.tsx`, server modules in lowercase names such as `routes.ts`, and explicit exported helpers for shared server state. TypeScript is configured with `moduleResolution: "bundler"`, `isolatedModules`, `allowJs`, and `noEmit`; `npm run lint` is the enforced type-checking gate.

## Testing Guidelines

No automated test framework or coverage threshold is defined. For changes today, run `npm run lint` and manually exercise the dashboard simulator at `http://localhost:3000` via `npm run dev`. When adding tests, add the runner and scripts to `package.json`, then document the command here.

## Commit & Pull Request Guidelines

Recent history uses plain messages and Conventional Commit-style prefixes, for example `feat(auth): add password protection to admin endpoints`, `chore: update application title to agt-db`, and `Initial commit`. Prefer concise imperative messages, using `feat(...)`, `fix(...)`, or `chore` when a scope is clear. Pull requests should describe backend/API changes, dashboard UI changes, required environment variables, and any Slack manifest or Cloud Run deployment impact. Include screenshots for visible dashboard changes.

## Security & Configuration Tips

Use `.env.example` as the local configuration reference. Keep real `GEMINI_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and dashboard passwords out of git. Slack webhook changes must preserve raw request body handling in `server.ts`, because signature verification depends on it.
