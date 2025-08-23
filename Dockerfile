#############################
# Build stage (installs deps)
#############################
FROM node:20 AS build
WORKDIR /app
# Install production dependencies first (leverages Docker layer cache when src changes)
COPY package*.json ./
RUN set -eux; \
    npm ci --omit=dev || npm install --omit=dev; \
    npm cache clean --force >/dev/null 2>&1 || true
# Copy only source we need
COPY . .

#############################
# Runtime stage (smaller, Debian slim)
#############################
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
        PORT=8080 \
        NODE_OPTIONS="--enable-source-maps"
# Add tini for proper signal handling then remove apt lists
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
