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

const phoneDigits = (process.env.WHATSAPP_PHONE_NUMBER || '').replace(/\D/g, '');
const usePairing =
  process.env.WA_USE_PAIRING_CODE === 'true' && phoneDigits.length >= 10;

fs.mkdirSync(SESSION_DIR, { recursive: true });

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  ...(usePairing
    ? {
        pairWithPhoneNumber: {
          phoneNumber: phoneDigits,
          showNotification: true,
          intervalMs: 180_000,
        },
      }
    : {}),
  puppeteer: {
    headless,
    ...(chromePath ? { executablePath: chromePath } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      // Do NOT use --single-process: hangs Chromium on Railway and blocks /health
    ],
  },
});

let ready = false;
let latestQrDataUrl: string | null = null;
let latestPairingCode: string | null = null;
let lastQrAt = 0;

export function isClientReady(): boolean {
  return ready;
}

export function getLatestQrDataUrl(): string | null {
  return latestQrDataUrl;
}

export function getLatestPairingCode(): string | null {
  return latestPairingCode;
}

export function getQrPngPath(): string {
  return QR_PNG;
}

export function getLastQrAt(): number {
  return lastQrAt;
}

function clearQrArtifacts(): void {
  latestQrDataUrl = null;
  latestPairingCode = null;
  try {
    if (fs.existsSync(QR_PNG)) fs.unlinkSync(QR_PNG);
  } catch {
    /* ignore */
  }
}

/** Prefer WhatsApp Web's own canvas (same as local Chrome window) — not log ASCII. */
async function captureNativeQrImage(): Promise<Buffer | null> {
  const page = (client as unknown as { pupPage?: { $: Function; waitForSelector: Function } }).pupPage;
  if (!page) return null;
  try {
    await page.waitForSelector('canvas', { timeout: 8_000 });
    const canvas = await page.$('canvas');
    if (!canvas) return null;
    const buf = (await canvas.screenshot({ type: 'png' })) as Buffer;
    return buf?.length ? buf : null;
  } catch {
    return null;
  }
}

client.on('qr', async (qr) => {
  lastQrAt = Date.now();
  ready = false;

  try {
    // Small delay so WhatsApp paints the canvas
    await new Promise((r) => setTimeout(r, 400));
    const native = await captureNativeQrImage();
    if (native) {
      fs.writeFileSync(QR_PNG, native);
      latestQrDataUrl = `data:image/png;base64,${native.toString('base64')}`;
      logger.warn('WhatsApp QR ready — open /wa-qr in browser (do NOT scan Railway log ASCII)');
      return;
    }

    // Fallback encode if canvas not found yet
    latestQrDataUrl = await QRCode.toDataURL(qr, {
      width: 512,
      margin: 2,
      errorCorrectionLevel: 'M',
    });
    await QRCode.toFile(QR_PNG, qr, { width: 512, margin: 2, errorCorrectionLevel: 'M' });
    logger.warn(
      'WhatsApp QR ready (generated) — open /wa-qr in browser. Ignore ASCII/logs — they wrap and break scan.',
    );
  } catch (err) {
    logger.warn('Could not render QR', { error: (err as Error).message });
  }
});

client.on('code', (code: string) => {
  latestPairingCode = code;
  logger.warn(`WhatsApp PAIRING CODE: ${code}`);
});

client.on('authenticated', () => {
  clearQrArtifacts();
  logger.info('WhatsApp authenticated');
});

client.on('ready', () => {
  ready = true;
  clearQrArtifacts();
  logger.info('WhatsApp client ready');
});

client.on('auth_failure', (msg) => {
  ready = false;
  clearQrArtifacts();
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

if (usePairing) {
  logger.info('WhatsApp auth: pairing-code mode', { phone: phoneDigits });
} else {
  logger.info('WhatsApp auth: QR / existing session');
}

export default client;
