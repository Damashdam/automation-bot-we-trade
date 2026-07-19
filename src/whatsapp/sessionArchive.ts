import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import logger from '../utils/logger';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
export const SESSION_DIR = path.join(DATA_DIR, 'wa-session');
export const SESSION_MARKER = path.join(SESSION_DIR, 'session');
export const SESSION_ARCHIVE = path.join(DATA_DIR, 'wa-session.tar.gz');

const TAR_EXCLUDES = [
  '--exclude=**/Cache',
  '--exclude=**/Code Cache',
  '--exclude=**/GPUCache',
  '--exclude=**/Service Worker',
  '--exclude=**/blob_storage',
  '--exclude=**/GraphiteDawnCache',
  '--exclude=**/BrowserMetrics*',
  '--exclude=**/Crashpad',
  '--exclude=**/*.indexeddb.blob',
  '--exclude=**/DawnWebGPUCache',
  '--exclude=**/ShaderCache',
  '--exclude=**/GrShaderCache',
  '--exclude=**/OnDeviceHeadSuggestModel',
  '--exclude=**/Safe Browsing',
  '--exclude=**/WasmTtsEngine',
  '--exclude=**/ZxcvbnData',
  '--exclude=**/MEIPreload',
  '--exclude=**/FileTypePolicies',
  '--exclude=**/CertificateRevocation',
  '--exclude=**/PrivacySandbox*',
  '--exclude=**/FirstPartySets*',
  '--exclude=**/SafetyTips',
  '--exclude=**/TranslateKit',
  '--exclude=**/AutofillAiModelCache',
  '--exclude=**/Component Extension Crx*',
];

/** Pack session (~15–25 MB) with caches stripped — full LocalAuth profile, uploadable via curl. */
export function packSessionToTarGz(outPath: string = SESSION_ARCHIVE): string {
  if (!fs.existsSync(SESSION_MARKER)) {
    throw new Error(`No session at ${SESSION_MARKER}`);
  }
  execFileSync(
    'tar',
    [...TAR_EXCLUDES, '-czf', outPath, '-C', DATA_DIR, 'wa-session'],
    { stdio: 'inherit' },
  );
  return outPath;
}

/** Extract a wa-session.tar.gz into DATA_DIR (replaces existing session). */
export function restoreSessionFromTarGz(archivePath: string): void {
  if (!fs.existsSync(archivePath)) {
    throw new Error(`Archive not found: ${archivePath}`);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(SESSION_DIR)) {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  }
  execFileSync('tar', ['-xzf', archivePath, '-C', DATA_DIR], { stdio: 'pipe' });
  if (!fs.existsSync(SESSION_MARKER)) {
    throw new Error('Archive did not contain wa-session/session');
  }
  logger.info('WhatsApp session restored from archive', { archivePath });
}

export function logDataDirStatus(): void {
  const cookies = path.join(DATA_DIR, 'x-cookies.json');
  let sessionEntries = 0;
  try {
    if (fs.existsSync(SESSION_MARKER)) {
      sessionEntries = fs.readdirSync(SESSION_MARKER).length;
    }
  } catch {
    /* ignore */
  }
  logger.info('DATA_DIR status', {
    dataDir: DATA_DIR,
    hasCookies: fs.existsSync(cookies),
    hasSession: fs.existsSync(SESSION_MARKER),
    sessionEntries,
    hasSessionArchive: fs.existsSync(SESSION_ARCHIVE),
    archiveBytes: fs.existsSync(SESSION_ARCHIVE) ? fs.statSync(SESSION_ARCHIVE).size : 0,
  });
  if (!fs.existsSync(SESSION_MARKER) && !fs.existsSync(SESSION_ARCHIVE)) {
    logger.warn(
      'No WhatsApp session on disk — attach Railway Volume to /app/data, then run: npm run wa:push-session',
    );
  }
}
