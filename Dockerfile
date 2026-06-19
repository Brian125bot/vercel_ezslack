# ==========================================
# STAGE 1: Build and Compile Assets
# ==========================================
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Copy package management descriptors
COPY package*.json ./

# Install all dependencies (including devDependencies required for compilation)
RUN npm ci

# Copy the remaining application source files
COPY . .

# Run the unified build script (vite assets + esbuild server bundle)
RUN npm run build


# ==========================================
# STAGE 2: Lightweight Production Runtime
# ==========================================
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

# Set production context
ENV NODE_ENV=production

# Copy configuration and manifest structures
COPY package*.json ./
COPY slack-manifest.json ./

# Install only production-tier dependencies to minimize image footprint
RUN npm ci --only=production

# Copy compiled target assets from the build stage pipeline
COPY --from=builder /usr/src/app/dist ./dist

# Standard Cloud Run ingress targets port 3000
EXPOSE 3000

# Start compiled CommonJS background server
CMD ["npm", "run", "start"]
