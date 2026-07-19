import 'dotenv/config';
import { Client, LocalAuth } from 'whatsapp-web.js';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import logger from '../utils/logger';

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const SESSION_DIR = path.join(DATA_DIR, 'wa-session');
const QR_PNG = path.join(DATA_DIR, 'wa-qr.png');

const headless =
  process.env.WA_HEADLESS !== undefined
    ? process.env.WA_HEADLESS === 'true'
    : process.env.NODE_ENV === 'production';

const chromePath =
  process.env.CHROME_PATH ||
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : undefined);

fs.mkdirSync(SESSION_DIR, { recursive: true });

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: {
    headless,
    ...(chromePath ? { executablePath: chromePath } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      ...(headless ? ['--single-process'] : []),
    ],
  },
});

let ready = false;
let lastQrAt = 0;
let latestQrDataUrl: string | null = null;

export function isClientReady(): boolean {
  return ready;
}

export function getLatestQrDataUrl(): string | null {
  return latestQrDataUrl;
}

export function getQrPngPath(): string {
  return QR_PNG;
}

client.on('qr', async (qr) => {
  const now = Date.now();
  if (now - lastQrAt < 20_000) return;
  lastQrAt = now;

  try {
    await QRCode.toFile(QR_PNG, qr, { width: 512, margin: 2 });
    latestQrDataUrl = await QRCode.toDataURL(qr, { width: 512, margin: 2 });
    logger.warn('WhatsApp QR ready — scan from Business Linked devices');
    logger.warn(`QR also at ${QR_PNG} (and /wa-qr on health server if enabled)`);
  } catch (err) {
    logger.warn('Could not write QR PNG', { error: (err as Error).message });
  }
});

client.on('authenticated', () => {
  latestQrDataUrl = null;
  logger.info('WhatsApp authenticated');
});

client.on('ready', () => {
  ready = true;
  latestQrDataUrl = null;
  logger.info('WhatsApp client ready');
});

client.on('auth_failure', (msg) => {
  ready = false;
  logger.error('WhatsApp auth failed', { msg });
});

client.on('disconnected', (reason) => {
  ready = false;
  logger.warn('WhatsApp disconnected — reconnecting in 8s', { reason: String(reason) });
  setTimeout(() => {
    client.initialize().catch((err: Error) => {
      logger.error('WhatsApp reconnect failed', { error: err.message });
    });
  }, 8_000);
});

export default client;
