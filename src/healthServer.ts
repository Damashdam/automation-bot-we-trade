import http from 'http';
import fs from 'fs';
import logger from './utils/logger';
import {
  isClientReady,
  getQrPngPath,
  getLatestQrDataUrl,
  getLatestPairingCode,
  getLastQrAt,
} from './whatsapp/waClient';

const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
};

/**
 * Tiny HTTP server for Railway healthchecks + first-time WA QR viewing.
 */
export function startHealthServer(): void {
  const port = parseInt(process.env.PORT || '8080', 10);

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

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
