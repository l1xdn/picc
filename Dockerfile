# Use Node.js 22 LTS slim image
FROM node:22-slim

# Set working directory
WORKDIR /app

# Install build tools required for native C++ modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files first to leverage layer caching
COPY package*.json ./

# Install node dependencies
RUN npm ci

# Copy full application code
COPY . .

# Compile Tailwind CSS output
RUN npm run build:css

# Default container host binding
ENV HOST=0.0.0.0

# Start the application server
CMD ["npm", "start"]
