# Stage 1: Build stage
FROM node:22-slim AS builder
WORKDIR /app

# Copy package files for installing dependencies
COPY package*.json ./

# Install all dependencies (including devDependencies)
RUN npm ci

# Copy the rest of the application files
COPY . .

# Build the frontend and backend bundles
RUN npm run build

# Prune development dependencies to keep production node_modules minimal
RUN npm prune --omit=dev


# Stage 2: Production runtime stage
FROM node:22-slim
WORKDIR /app

# Install curl for the container healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Copy build artifacts and production dependencies from builder
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.env.example ./.env.example

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Configure non-root user 'node' (built into node:22-slim)
RUN chown -R node:node /app
USER node

# Expose the application port
EXPOSE 3000

# Container healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3000}/api/health || exit 1

# Start command
CMD ["node", "dist/server.cjs"]
