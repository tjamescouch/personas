FROM node:20-alpine
WORKDIR /app

COPY package.json ./
COPY src/ ./src/
COPY ellie/ ./ellie/
COPY owl/ ./owl/

EXPOSE 3100
CMD ["node", "src/server.mjs"]
