FROM node:22-bookworm-slim

# Chromium + deps for whatsapp-web.js (puppeteer) and Playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-sandbox \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    curl \
    git \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

ENV WA_HEADLESS=true \
    CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    DATA_DIR=/app/data \
    PORT=8080

WORKDIR /app

COPY package.json package-lock.json ./
# Need devDependencies (@types/*, typescript) for tsc
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc \
    && npm prune --omit=dev

ENV NODE_ENV=production

RUN mkdir -p /app/data /app/logs \
    && chown -R node:node /app

COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Start as root so entrypoint can chown the Railway volume, then drop to node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
