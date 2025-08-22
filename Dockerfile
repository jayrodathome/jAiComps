FROM node:20-alpine AS base
WORKDIR /usr/src/app

# Install production dependencies first (leverages Docker layer cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

ENV NODE_ENV=production \
    PORT=8080

# Cloud Run will send traffic to $PORT
EXPOSE 8080

# Start the server (server.js already respects $PORT)
CMD ["node", "server.js"]
