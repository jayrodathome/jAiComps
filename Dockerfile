# Use the official Node.js runtime as the base image
FROM node:18-alpine

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install the application dependencies
RUN npm ci --only=production

# Copy the application code
COPY . .

# Create a non-root user to run the application
RUN groupadd -r appuser && useradd -r -g appuser appuser
RUN chown -R appuser:appuser /app
USER appuser

# Expose the port the app runs on
EXPOSE 8080

# Set environment variable for production
ENV NODE_ENV=production
ENV PORT=8080

# Define the command to run the application
CMD ["npm", "start"]
