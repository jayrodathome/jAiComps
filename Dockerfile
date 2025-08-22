FROM node:20-alpine AS base
WORKDIR /usr/src/app

# Copy lock + manifest and install production deps. Fallback to npm install if npm ci unsupported.
COPY package*.json ./
RUN set -eux; \
    if [ -f package-lock.json ]; then \
        (npm ci --omit=dev || npm install --omit=dev); \
    else \
        npm install --omit=dev; \
    fi; \
    npm cache clean --force >/dev/null 2>&1 || true

# Copy application source
COPY . .

ENV NODE_ENV=production \
        PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
