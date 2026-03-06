FROM node:20-alpine

# Install git (needed for diff commands)
RUN apk add --no-cache git

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

# GitHub Actions mounts the repo at /github/workspace and runs from there,
# so Node.js won't find modules installed in /app. Set NODE_PATH so it can.
ENV NODE_PATH=/app/node_modules

COPY . .

ENTRYPOINT ["node", "src/index.js"]
