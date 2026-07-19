#!/bin/sh
set -e

# Railway volume mounts as root; make /app/data writable then run the app.
mkdir -p /app/data /app/logs
chown -R node:node /app/data /app/logs 2>/dev/null || true
chmod -R u+rwX /app/data /app/logs 2>/dev/null || true

# Prefer non-root; fall back to root if runuser unavailable.
if command -v runuser >/dev/null 2>&1; then
  exec runuser -u node -- node --disable-warning=ExperimentalWarning dist/index.js
fi

exec node --disable-warning=ExperimentalWarning dist/index.js
