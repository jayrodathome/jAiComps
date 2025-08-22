#############################
# Build stage (installs deps)
#############################
FROM node:20 as build
WORKDIR /app
COPY package*.json ./
RUN set -eux; \
    if [ -f package-lock.json ]; then \
        (npm ci --omit=dev || npm install --omit=dev); \
    else \
        npm install --omit=dev; \
    fi; \
    npm cache clean --force >/dev/null 2>&1 || true
COPY . .

#############################
# Runtime stage (smaller, Debian slim)
#############################
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production \
        PORT=8080
 # Add tini for proper signal handling
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh
# For debugging startup issues keep root; later we can drop to node
# USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/start.sh"]
