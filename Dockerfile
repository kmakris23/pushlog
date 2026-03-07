FROM node:20-alpine

# Install git (needed for diff commands)
RUN apk add --no-cache git

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

# GitHub Actions overrides the container working directory to /github/workspace,
# so use absolute paths for the action code and expose dependencies via NODE_PATH.
ENV NODE_PATH=/app/node_modules

COPY . .

ENTRYPOINT ["node", "/app/src/index.js"]
