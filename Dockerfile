FROM node:22-bookworm-slim

# System Chromium only for Playwright scrape.
# WhatsApp uses Puppeteer-bundled Chrome (system Chromium hangs sendMessage).
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
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libasound2 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

ENV WA_HEADLESS=true \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=false \
    PUPPETEER_CACHE_DIR=/app/.cache/puppeteer \
    DATA_DIR=/app/data \
    PORT=8080

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci \
    && npx puppeteer browsers install chrome

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc \
    && npm prune --omit=dev

ENV NODE_ENV=production

RUN mkdir -p /app/data /app/logs \
    && chown -R node:node /app

COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
