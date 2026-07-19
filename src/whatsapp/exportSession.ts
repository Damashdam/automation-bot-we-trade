/**
 * Pack local WhatsApp LocalAuth session.
 * Usage: npm run wa:pack-session
 */
import 'dotenv/config';
import fs from 'fs';
import { packSessionToTarGz, SESSION_ARCHIVE, SESSION_MARKER } from './sessionArchive';

function main(): void {
  if (!fs.existsSync(SESSION_MARKER)) {
    console.error('No local session. Link once with Chrome window:');
    console.error('  WA_HEADLESS=false npm run wa:test');
    process.exit(1);
  }

  packSessionToTarGz(SESSION_ARCHIVE);
  const mb = (fs.statSync(SESSION_ARCHIVE).size / (1024 * 1024)).toFixed(1);
  console.log(`\nPacked ${SESSION_ARCHIVE} (${mb} MB)`);
  console.log('Prefer: WA_UPLOAD_TOKEN=... npm run wa:push-session');
}

main();
