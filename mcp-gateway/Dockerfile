FROM node:22-alpine

RUN npm install -g @brightdata/mcp supergateway && npm cache clean --force

# Fix missing prompts.js in @brightdata/mcp package (packaging bug)
RUN echo 'export default [];' > /usr/local/lib/node_modules/@brightdata/mcp/prompts.js

WORKDIR /app
COPY auth-proxy.js /app/auth-proxy.js
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["/entrypoint.sh"]
