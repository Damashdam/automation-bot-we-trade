import fs from 'fs';
import path from 'path';
import logger from './utils/logger';

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));

/**
 * Bootstrap files into DATA_DIR from Railway Variables when the volume is empty.
 * - X_COOKIES_BASE64: base64 of data/x-cookies.json
 */
export function bootstrapDataFromEnv(): void {
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
}
