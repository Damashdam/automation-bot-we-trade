import http from 'http';
import fs from 'fs';
import path from 'path';
import logger from './utils/logger';
import {
  isClientReady,
  getQrPngPath,
  getLatestQrDataUrl,
  getLatestPairingCode,
  getLastQrAt,
} from './whatsapp/waClient';
import { DATA_DIR, restoreSessionFromTarGz } from './whatsapp/sessionArchive';

const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
};

const MAX_UPLOAD_BYTES = 120 * 1024 * 1024;

function uploadTokenOk(header: string | string[] | undefined): boolean {
  const sent = (Array.isArray(header) ? header[0] : header)?.trim();
  if (!sent) return false;
  const allowed = [process.env.WA_UPLOAD_TOKEN, process.env.TELEGRAM_BOT_TOKEN]
    .map((v) => v?.trim())
    .filter((v): v is string => Boolean(v));
  return allowed.includes(sent);
}

function handleSessionUpload(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!uploadTokenOk(req.headers['x-upload-token'])) {
    logger.warn('WA session upload rejected — bad token (use WA_UPLOAD_TOKEN or TELEGRAM_BOT_TOKEN)');
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized — X-Upload-Token must match WA_UPLOAD_TOKEN or TELEGRAM_BOT_TOKEN');
    return;
  }

  logger.info('WA session upload started', {
    contentLength: req.headers['content-length'] || 'unknown',
  });

  const tmp = path.join(DATA_DIR, 'wa-session-upload.tar.gz');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const ws = fs.createWriteStream(tmp);
  let size = 0;
  let settled = false;

  const fail = (code: number, msg: string) => {
    if (settled) return;
    settled = true;
    try {
      ws.destroy();
    } catch {
      /* ignore */
    }
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    if (!res.headersSent) {
      res.writeHead(code, { 'Content-Type': 'text/plain' });
      res.end(msg);
    }
  };

  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) {
      fail(413, 'Upload too large');
      req.destroy();
    }
  });

  req.on('aborted', () => {
    logger.warn('WA session upload aborted by client');
    fail(400, 'Upload aborted');
  });

  req.pipe(ws);

  ws.on('finish', () => {
    if (settled) return;
    settled = true;
    try {
      logger.info('WA session upload received', { bytes: size });
      // Keep archive on volume so next boots can restore even if LocalAuth folder is wiped
      fs.copyFileSync(tmp, path.join(DATA_DIR, 'wa-session.tar.gz'));
      restoreSessionFromTarGz(tmp);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          message: 'Session saved on volume — process will restart',
          bytes: size,
          dataDir: DATA_DIR,
        }),
      );
      logger.info('WA session uploaded — kept wa-session.tar.gz on DATA_DIR, exiting for re-init');
      setTimeout(() => process.exit(0), 500);
    } catch (err) {
      logger.error('WA session upload extract failed', { error: (err as Error).message });
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Extract failed: ' + (err as Error).message);
      }
    }
  });

  ws.on('error', (err) => {
    logger.error('WA session upload write failed', { error: err.message });
    fail(500, err.message);
  });
}

/**
 * Tiny HTTP server for Railway healthchecks + session upload (no QR required).
 */
export function startHealthServer(): void {
  const port = parseInt(process.env.PORT || '8080', 10);

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (url === '/wa-session-upload' && req.method === 'POST') {
      handleSessionUpload(req, res);
      return;
    }

    if (url === '/health' || url === '/') {
      const body = JSON.stringify({
        ok: true,
        whatsappReady: isClientReady(),
        hasQr: Boolean(getLatestQrDataUrl()),
        hasPairingCode: Boolean(getLatestPairingCode()),
        qrAgeSec: getLastQrAt() ? Math.floor((Date.now() - getLastQrAt()) / 1000) : null,
        uptimeSec: Math.floor(process.uptime()),
      });
      res.writeHead(200, { 'Content-Type': 'application/json', ...NO_CACHE });
      res.end(body);
      return;
    }

    if (url === '/wa-qr') {
      if (isClientReady()) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...NO_CACHE });
        res.end(
          '<!doctype html><html><body style="font-family:sans-serif;padding:2rem">' +
            '<h1>WhatsApp already linked ✓</h1>' +
            '<p>No QR needed.</p></body></html>',
        );
        return;
      }

      const dataUrl = getLatestQrDataUrl();
      const pairing = getLatestPairingCode();
      const ageSec = getLastQrAt() ? Math.floor((Date.now() - getLastQrAt()) / 1000) : null;
      const stale = ageSec !== null && ageSec > 25;

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...NO_CACHE });
      res.end(`<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="refresh" content="4" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WhatsApp link</title>
  <style>
    body { font-family: system-ui, sans-serif; text-align: center; padding: 1.5rem; background: #0f1419; color: #e7e9ea; }
    img { width: min(320px, 90vw); height: auto; background: #fff; padding: 12px; border-radius: 8px; }
    .code { font-size: 2.5rem; letter-spacing: 0.35rem; font-weight: 700; color: #00ba7c; }
    .warn { color: #f4212e; font-weight: 600; }
    .ok { color: #00ba7c; }
    p { opacity: 0.85; max-width: 28rem; margin: 0.75rem auto; }
  </style>
</head>
<body>
  <h1>חיבור WhatsApp לבוט</h1>
  ${
    pairing
      ? `<p>קוד צימוד (אם מופיע באפליקציה):</p><p class="code">${pairing}</p>`
      : ''
  }
  ${
    dataUrl
      ? `<img src="${dataUrl}" alt="WhatsApp QR" />
         <p class="${stale ? 'warn' : 'ok'}">${stale ? 'QR ישן — מתרענן…' : `סרוק עכשיו (${ageSec ?? 0} שנ׳)`}</p>
         <p><b>Business → מכשירים מקושרים → קישור מכשיר → סריקת מצלמה</b><br/>לא צריך מספר צימוד. הדף מתרענן לבד.</p>`
      : `<p>אין QR עדיין…</p>
         <p>אם יש סשן מקומי שעובד: הרץ <code>npm run wa:pack-session</code> והגדר <code>WA_SESSION_URL</code>.</p>`
  }
</body>
</html>`);
      return;
    }

    if (url === '/wa-qr.png') {
      if (isClientReady()) {
        res.writeHead(404, { 'Content-Type': 'text/plain', ...NO_CACHE });
        res.end('Already linked');
        return;
      }

      const dataUrl = getLatestQrDataUrl();
      if (dataUrl) {
        const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        res.writeHead(200, { 'Content-Type': 'image/png', ...NO_CACHE });
        res.end(Buffer.from(b64, 'base64'));
        return;
      }

      const pngPath = getQrPngPath();
      if (fs.existsSync(pngPath)) {
        const age = Date.now() - fs.statSync(pngPath).mtimeMs;
        if (age < 30_000) {
          res.writeHead(200, { 'Content-Type': 'image/png', ...NO_CACHE });
          fs.createReadStream(pngPath).pipe(res);
          return;
        }
      }

      res.writeHead(404, { 'Content-Type': 'text/plain', ...NO_CACHE });
      res.end('No fresh QR yet');
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, () => {
    logger.info('Health server listening', { port, health: '/health', qr: '/wa-qr' });
  });
}
