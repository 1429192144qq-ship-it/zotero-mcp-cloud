# Stage 1: Build
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: Runtime
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install --no-save supergateway@4.1.0
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["./node_modules/.bin/supergateway", "--stdio", "node dist/index.js", "--outputTransport", "streamableHttp", "--stateful", "--sessionTimeout", "60000", "--port", "3000", "--streamableHttpPath", "/mcp"]
