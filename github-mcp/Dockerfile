FROM node:22-alpine

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci && npm cache clean --force
COPY src ./src
RUN npm run build

EXPOSE 8000
ENTRYPOINT ["node", "dist/server.js"]
