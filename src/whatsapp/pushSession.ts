/**
 * Pack local Chrome-linked WhatsApp session and upload to Railway.
 *
 * Usage:
 *   WA_UPLOAD_TOKEN=your-secret npm run wa:push-session
 */
import 'dotenv/config';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { packSessionToTarGz, SESSION_ARCHIVE, SESSION_MARKER } from './sessionArchive';

function pack(): void {
  if (!fs.existsSync(SESSION_MARKER)) {
    console.error('No local session. Link once locally first:');
    console.error('  WA_HEADLESS=false npm run wa:test');
    console.error('Scan the Chrome WINDOW (not any PNG file), then re-run this.');
    process.exit(1);
  }

  packSessionToTarGz(SESSION_ARCHIVE);
  const mb = (fs.statSync(SESSION_ARCHIVE).size / 1024 / 1024).toFixed(1);
  console.log(`Packed ${SESSION_ARCHIVE} (${mb} MB)`);
}

function uploadWithCurl(urlBase: string, token: string): void {
  const target = `${urlBase.replace(/\/$/, '')}/wa-session-upload`;
  console.log(`Uploading to ${target} …`);
  try {
    const out = execFileSync(
      'curl',
      [
        '-sS',
        '-f',
        '--max-time',
        '300',
        '-X',
        'POST',
        '-H',
        `X-Upload-Token: ${token}`,
        '-H',
        'Content-Type: application/gzip',
        '--data-binary',
        `@${SESSION_ARCHIVE}`,
        target,
      ],
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
    );
    console.log('Upload OK:', out.trim());
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer; stdout?: Buffer; message?: string };
    const detail = [e.stdout?.toString(), e.stderr?.toString(), e.message].filter(Boolean).join('\n');
    throw new Error(`Upload failed.\n${detail}\n\nCheck: WA_UPLOAD_TOKEN on Railway matches, and Volume is /app/data`);
  }
}

function main(): void {
  const botUrl =
    process.env.WA_BOT_URL?.trim() ||
    'https://automation-bot-we-trade-production.up.railway.app';
  const token = process.env.WA_UPLOAD_TOKEN?.trim();
  if (!token) {
    console.error('Set WA_UPLOAD_TOKEN (same value as in Railway Variables).');
    process.exit(1);
  }

  pack();
  uploadWithCurl(botUrl, token);
  console.log('Done. Watch Railway logs for "WhatsApp client ready" (not QR).');
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
