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
import { DATA_DIR, SESSION_MARKER } from './sessionArchive';

const OUT = path.join(DATA_DIR, 'wa-session.tar.gz');

function main(): void {
  if (!fs.existsSync(SESSION_MARKER)) {
    console.error('No local session. Link once with Chrome window:');
    console.error('  WA_HEADLESS=false npm run wa:test');
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
