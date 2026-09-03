FROM node:20-slim AS base
WORKDIR /app

# Install tsx globally for running TypeScript directly
RUN npm install -g tsx

# Copy dependency manifests
COPY package.json package-lock.json* ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./

# Create data directory for config, credentials, and session state.
# Mount a volume here so configuration survives container rebuilds.
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3001
ENV BLAXIN_DATA_DIR=/app/data

EXPOSE 3001

# Use tsx to run TypeScript directly (avoids build step complexity)
CMD ["tsx", "src/index.ts"]
