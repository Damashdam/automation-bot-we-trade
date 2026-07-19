/**
 * Pack local Chrome-linked WhatsApp session and upload to Railway.
 *
 * Prereq: local session works (WA_HEADLESS=false npm run wa:test once).
 * Railway: set WA_UPLOAD_TOKEN to any long secret.
 *
 * Usage:
 *   WA_BOT_URL=https://automation-bot-we-trade-production.up.railway.app \
 *   WA_UPLOAD_TOKEN=your-secret \
 *   npm run wa:push-session
 */
import 'dotenv/config';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { DATA_DIR, SESSION_MARKER } from './sessionArchive';

const OUT = path.join(DATA_DIR, 'wa-session.tar.gz');

function pack(): void {
  if (!fs.existsSync(SESSION_MARKER)) {
    console.error('No local session. Link once locally first:');
    console.error('  WA_HEADLESS=false npm run wa:test');
    console.error('Scan the Chrome WINDOW (not any PNG file), then re-run this.');
    process.exit(1);
  }

  const excludes = [
    '--exclude=**/Cache',
    '--exclude=**/Code Cache',
    '--exclude=**/GPUCache',
    '--exclude=**/Service Worker',
    '--exclude=**/blob_storage',
    '--exclude=**/GraphiteDawnCache',
    '--exclude=**/BrowserMetrics*',
    '--exclude=**/Crashpad',
  ].join(' ');

  execSync(`tar ${excludes} -czf "${OUT}" -C "${DATA_DIR}" wa-session`, { stdio: 'inherit' });
  console.log(`Packed ${OUT} (${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB)`);
}

function upload(urlBase: string, token: string): Promise<void> {
  const target = new URL('/wa-session-upload', urlBase.replace(/\/$/, ''));
  const body = fs.readFileSync(OUT);
  const lib = target.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        method: 'POST',
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname,
        headers: {
          'Content-Type': 'application/gzip',
          'Content-Length': body.length,
          'X-Upload-Token': token,
        },
        timeout: 600_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            console.log('Upload OK:', text);
            resolve();
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${text}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main(): Promise<void> {
  const botUrl =
    process.env.WA_BOT_URL?.trim() ||
    'https://automation-bot-we-trade-production.up.railway.app';
  const token = process.env.WA_UPLOAD_TOKEN?.trim();
  if (!token) {
    console.error('Set WA_UPLOAD_TOKEN (same value as in Railway Variables).');
    process.exit(1);
  }

  pack();
  console.log(`Uploading to ${botUrl}/wa-session-upload …`);
  await upload(botUrl, token);
  console.log('Done. Watch Railway logs for "WhatsApp client ready" after restart.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
