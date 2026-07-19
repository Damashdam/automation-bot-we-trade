import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import logger from '../utils/logger';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
export const SESSION_DIR = path.join(DATA_DIR, 'wa-session');
export const SESSION_MARKER = path.join(SESSION_DIR, 'session');
export const SESSION_ARCHIVE = path.join(DATA_DIR, 'wa-session.tar.gz');

/**
 * Pack only auth-critical Chromium files (~2–5 MB) so Railway upload doesn't hang.
 * Full profile is ~200MB and often fails over HTTP.
 */
export function packSessionToTarGz(outPath: string = SESSION_ARCHIVE): string {
  if (!fs.existsSync(SESSION_MARKER)) {
    throw new Error(`No session at ${SESSION_MARKER}`);
  }

  const staging = path.join(DATA_DIR, '.wa-session-pack');
  const stagedSession = path.join(staging, 'wa-session', 'session');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(stagedSession, { recursive: true });

  const srcRoot = SESSION_MARKER;
  const include = [
    'Local State',
    'Last Version',
    path.join('Default', 'IndexedDB'),
    path.join('Default', 'Local Storage'),
    path.join('Default', 'Session Storage'),
    path.join('Default', 'Cookies'),
    path.join('Default', 'Cookies-journal'),
    path.join('Default', 'Preferences'),
    path.join('Default', 'Secure Preferences'),
    path.join('Default', 'Network Persistent State'),
  ];

  for (const rel of include) {
    const from = path.join(srcRoot, rel);
    if (!fs.existsSync(from)) continue;
    const to = path.join(stagedSession, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    execFileSync('cp', ['-R', from, to], { stdio: 'pipe' });
  }

  // Drop huge IndexedDB blob dirs if present (auth lives in leveldb)
  const dropBlobs = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        if (name.endsWith('.indexeddb.blob')) fs.rmSync(p, { recursive: true, force: true });
        else dropBlobs(p);
      }
    }
  };
  dropBlobs(stagedSession);

  execFileSync('tar', ['-czf', outPath, '-C', staging, 'wa-session'], { stdio: 'inherit' });
  fs.rmSync(staging, { recursive: true, force: true });
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
