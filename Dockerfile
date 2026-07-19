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

ENV NODE_ENV=production \
    WA_HEADLESS=true \
    CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    DATA_DIR=/app/data \
    PORT=8080

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Playwright browsers not needed if we point to system Chromium;
# still install the node package (already in npm ci).
COPY tsconfig.json ./
COPY src ./src
RUN npm install typescript --no-save && npx tsc && npm uninstall typescript

RUN mkdir -p /app/data /app/logs \
    && chown -R node:node /app

USER node

EXPOSE 8080
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
