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

# Copy full source code into image
COPY . .

# Install dependencies and build native bindings + CSS assets
RUN npm ci

# Default container host binding
ENV HOST=0.0.0.0

# Start the application server
CMD ["npm", "start"]
