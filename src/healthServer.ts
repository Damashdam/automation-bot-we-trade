import http from 'http';
import fs from 'fs';
import logger from './utils/logger';
import { isClientReady, getQrPngPath, getLatestQrDataUrl } from './whatsapp/waClient';

/**
 * Tiny HTTP server for Railway healthchecks + first-time WA QR viewing.
 */
export function startHealthServer(): void {
  const port = parseInt(process.env.PORT || '8080', 10);

  const server = http.createServer((req, res) => {
    const url = req.url || '/';

    if (url === '/health' || url === '/') {
      const body = JSON.stringify({
        ok: true,
        whatsappReady: isClientReady(),
        uptimeSec: Math.floor(process.uptime()),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    if (url === '/wa-qr' || url === '/wa-qr.png') {
      const pngPath = getQrPngPath();
      if (fs.existsSync(pngPath)) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        fs.createReadStream(pngPath).pipe(res);
        return;
      }
      const dataUrl = getLatestQrDataUrl();
      if (dataUrl) {
        const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(Buffer.from(b64, 'base64'));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('No QR available (already linked, or not generated yet)');
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, () => {
    logger.info('Health server listening', { port, health: '/health', qr: '/wa-qr' });
  });
}
