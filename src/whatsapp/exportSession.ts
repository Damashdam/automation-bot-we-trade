/**
 * Pack local WhatsApp LocalAuth session for Railway bootstrap via WA_SESSION_URL.
 *
 * Usage: npm run wa:pack-session
 * Output: data/wa-session.tar.gz (upload somewhere private, set WA_SESSION_URL)
 */
import 'dotenv/config';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const SESSION_DIR = path.join(DATA_DIR, 'wa-session');
const OUT = path.join(DATA_DIR, 'wa-session.tar.gz');

function main(): void {
  if (!fs.existsSync(path.join(SESSION_DIR, 'session'))) {
    console.error('No local session at', SESSION_DIR);
    console.error('Run locally first: WA_HEADLESS=false npm run wa:test  — scan the Chrome window QR once.');
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
  const mb = (fs.statSync(OUT).size / (1024 * 1024)).toFixed(1);
  console.log(`\nPacked ${OUT} (${mb} MB)`);
  console.log('1) Upload this file to a private URL you control (or temporary host).');
  console.log('2) Railway Variable: WA_SESSION_URL=<that url>');
  console.log('3) On Railway volume, delete old /app/data/wa-session if QR was stuck, then redeploy.');
  console.log('4) Remove WA_SESSION_URL after first successful "WhatsApp client ready" (security).');
}

main();
