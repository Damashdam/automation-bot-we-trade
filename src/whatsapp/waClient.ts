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

/**
 * System Chromium in Docker makes sendMessage/page.evaluate hang.
 * Default: let Puppeteer use its bundled Chrome (installed in Docker build).
 * Override only with WA_CHROME_PATH or WA_USE_SYSTEM_CHROMIUM=true.
 */
function resolveChromePath(): string | undefined {
  if (process.env.WA_CHROME_PATH) return process.env.WA_CHROME_PATH;
  if (process.env.WA_USE_SYSTEM_CHROMIUM === 'true') {
    return process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
  }
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  // Linux/Railway: undefined → Puppeteer bundled Chrome
  return undefined;
}

const chromePath = resolveChromePath();

const phoneDigits = (process.env.WHATSAPP_PHONE_NUMBER || '').replace(/\D/g, '');
const usePairing =
  process.env.WA_USE_PAIRING_CODE === 'true' && phoneDigits.length >= 10;

fs.mkdirSync(SESSION_DIR, { recursive: true });

logger.info('WhatsApp browser', {
  headless,
  executablePath: chromePath || '(puppeteer bundled Chrome)',
});

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
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
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
    await new Promise((r) => setTimeout(r, 400));
    const native = await captureNativeQrImage();
    if (native) {
      fs.writeFileSync(QR_PNG, native);
      latestQrDataUrl = `data:image/png;base64,${native.toString('base64')}`;
      logger.warn('WhatsApp QR ready — open /wa-qr in browser (do NOT scan Railway log ASCII)');
      return;
    }

    latestQrDataUrl = await QRCode.toDataURL(qr, {
      width: 512,
      margin: 2,
      errorCorrectionLevel: 'M',
    });
    await QRCode.toFile(QR_PNG, qr, { width: 512, margin: 2, errorCorrectionLevel: 'M' });
    logger.warn('WhatsApp QR ready (generated) — open /wa-qr in browser');
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
  // Brief settle so WA Web finishes wiring send APIs
  setTimeout(() => {
    ready = true;
    clearQrArtifacts();
    logger.info('WhatsApp client ready');
  }, 5_000);
});

client.on('auth_failure', (msg) => {
  ready = false;
  clearQrArtifacts();
  logger.error('WhatsApp auth failed', { msg });
});

function clearSessionFiles(): void {
  const archive = path.join(DATA_DIR, 'wa-session.tar.gz');
  try {
    if (fs.existsSync(SESSION_DIR)) fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    if (fs.existsSync(archive)) fs.unlinkSync(archive);
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  } catch (err) {
    logger.warn('Could not clear WA session files', { error: (err as Error).message });
  }
}

let reinitTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReinit(delayMs: number): void {
  if (reinitTimer) clearTimeout(reinitTimer);
  reinitTimer = setTimeout(() => {
    client.initialize().catch((err: Error) => {
      logger.error('WhatsApp re-init failed', { error: err.message });
    });
  }, delayMs);
}

client.on('disconnected', (reason) => {
  ready = false;
  const why = String(reason);
  if (why === 'LOGOUT') {
    // Mac/old session rejected by WhatsApp — must scan QR on Railway (same browser as runtime)
    logger.error(
      'WhatsApp LOGOUT — cleared invalid session. Open /wa-qr and scan from Business Linked devices',
    );
    clearSessionFiles();
    clearQrArtifacts();
    scheduleReinit(3_000);
    return;
  }
  logger.warn('WhatsApp disconnected — reconnecting in 8s', { reason: why });
  scheduleReinit(8_000);
});

if (usePairing) {
  logger.info('WhatsApp auth: pairing-code mode', { phone: phoneDigits });
} else {
  logger.info('WhatsApp auth: QR / existing session');
}

export default client;
