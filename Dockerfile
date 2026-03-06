FROM node:20-alpine

# Install git (needed for diff commands)
RUN apk add --no-cache git

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENTRYPOINT ["node", "src/index.js"]
