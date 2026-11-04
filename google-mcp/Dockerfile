FROM node:22-alpine
WORKDIR /app

# Install dependencies
COPY package.json tsconfig.json ./
RUN npm install && npm cache clean --force

# Compile TypeScript → dist/
COPY src/ ./src/
RUN npm run build

# Copy the plain-JS auth proxy (no compilation needed — already valid JS/TS compiled)
# entrypoint starts both processes
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["/entrypoint.sh"]
