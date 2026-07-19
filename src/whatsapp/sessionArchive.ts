import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import logger from '../utils/logger';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
export const SESSION_DIR = path.join(DATA_DIR, 'wa-session');
export const SESSION_MARKER = path.join(SESSION_DIR, 'session');

/** Extract a wa-session.tar.gz into DATA_DIR (replaces existing session). */
export function restoreSessionFromTarGz(archivePath: string): void {
  if (!fs.existsSync(archivePath)) {
    throw new Error(`Archive not found: ${archivePath}`);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(SESSION_DIR)) {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  }
  execSync(`tar -xzf "${archivePath}" -C "${DATA_DIR}"`, { stdio: 'pipe' });
  if (!fs.existsSync(SESSION_MARKER)) {
    throw new Error('Archive did not contain wa-session/session');
  }
  logger.info('WhatsApp session restored from archive', { archivePath });
}
