import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import logger from './utils/logger';
import { DATA_DIR, SESSION_MARKER, restoreSessionFromTarGz } from './whatsapp/sessionArchive';

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`Download failed HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    });
    req.on('error', (err) => {
      try {
        fs.unlinkSync(dest);
      } catch {
        /* ignore */
      }
      reject(err);
    });
  });
}

async function bootstrapWaSessionFromUrl(): Promise<void> {
  const url = process.env.WA_SESSION_URL?.trim();
  if (!url) return;

  const force = process.env.WA_SESSION_FORCE === 'true';
  if (fs.existsSync(SESSION_MARKER) && !force) {
    logger.info('WhatsApp session already present — skip WA_SESSION_URL');
    return;
  }

  const tmp = path.join(DATA_DIR, 'wa-session-download.tar.gz');
  try {
    logger.info('Downloading WhatsApp session from WA_SESSION_URL…');
    await downloadFile(url, tmp);
    restoreSessionFromTarGz(tmp);
  } catch (err) {
    logger.error('Failed to bootstrap WA session from URL', {
      error: (err as Error).message,
    });
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Bootstrap files into DATA_DIR from Railway Variables when the volume is empty.
 * - X_COOKIES_BASE64: base64 of data/x-cookies.json
 * - WA_SESSION_URL: URL to wa-session.tar.gz (from npm run wa:pack-session)
 */
export async function bootstrapDataFromEnv(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const cookiesPath = path.join(DATA_DIR, 'x-cookies.json');
  const b64 = process.env.X_COOKIES_BASE64?.trim();

  if (b64 && !fs.existsSync(cookiesPath)) {
    try {
      const json = Buffer.from(b64, 'base64').toString('utf8');
      JSON.parse(json); // validate
      fs.writeFileSync(cookiesPath, json, 'utf8');
      logger.info('Wrote x-cookies.json from X_COOKIES_BASE64');
    } catch (err) {
      logger.error('Failed to bootstrap x-cookies from X_COOKIES_BASE64', {
        error: (err as Error).message,
      });
    }
  } else if (!fs.existsSync(cookiesPath)) {
    logger.warn('No x-cookies.json yet — set X_COOKIES_BASE64 in Railway or upload the file to /app/data');
  }

  await bootstrapWaSessionFromUrl();
}
