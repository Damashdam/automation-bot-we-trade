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
  authTimeoutMs: 45_000,
  qrMaxRetries: 0,
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
let everAuthenticated = false;
let latestQrDataUrl: string | null = null;
let latestPairingCode: string | null = null;
let lastQrAt = 0;
/** Absolute clock: reset only on QR / ready / recover — NOT on loading_screen. */
let noLinkSince = Date.now();
let recovering = false;
let watchdogStarted = false;

function noteLinkedOrQr(): void {
  noLinkSince = Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function isClientReady(): boolean {
  return ready;
}

type PupPage = {
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
  waitForFunction: (
    fn: string | (() => boolean),
    opts?: { timeout?: number },
  ) => Promise<unknown>;
};

function getPupPage(): PupPage | undefined {
  return (client as unknown as { pupPage?: PupPage }).pupPage;
}

/** True when WhatsApp Web page has wwebjs send APIs injected. */
export async function probeWWebJS(): Promise<boolean> {
  const page = getPupPage();
  if (!page) return false;
  try {
    return await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      return typeof w.WWebJS?.sendMessage === 'function' && typeof w.WWebJS?.getChat === 'function';
    });
  } catch {
    return false;
  }
}

/**
 * Ensure send APIs exist. Waits for inject; re-runs Client.inject() only after
 * we were authenticated (never during QR / cold boot — that blocks QR).
 */
export async function ensureClientSendable(timeoutMs = 45_000): Promise<boolean> {
  if (await probeWWebJS()) {
    ready = true;
    return true;
  }

  const page = getPupPage();
  if (!page) {
    ready = false;
    return false;
  }

  const waitUntil = Date.now() + timeoutMs;
  while (Date.now() < waitUntil) {
    if (await probeWWebJS()) {
      ready = true;
      return true;
    }
    await sleep(800);
  }

  if (!everAuthenticated) {
    ready = false;
    return false;
  }

  logger.warn('WWebJS missing — re-injecting WhatsApp store helpers');
  try {
    await (client as unknown as { inject: () => Promise<void> }).inject();
  } catch (err) {
    logger.warn('WhatsApp re-inject failed', { error: (err as Error).message });
  }

  const reinjectUntil = Date.now() + Math.min(20_000, timeoutMs);
  while (Date.now() < reinjectUntil) {
    if (await probeWWebJS()) {
      ready = true;
      clearQrArtifacts();
      logger.info('WhatsApp WWebJS restored — send ready');
      return true;
    }
    await sleep(800);
  }

  ready = false;
  logger.error('WhatsApp WWebJS still missing after re-inject');
  return false;
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
  noteLinkedOrQr();

  try {
    await sleep(400);
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
  noteLinkedOrQr();
  logger.warn(`WhatsApp PAIRING CODE: ${code}`);
});

client.on('authenticated', () => {
  everAuthenticated = true;
  clearQrArtifacts();
  logger.info('WhatsApp authenticated');
});

client.on('loading_screen', (percent: number | string) => {
  // Do NOT reset stuck timer — loading can loop forever on a dead session
  logger.info('WhatsApp loading', { percent });
});

client.on('ready', () => {
  everAuthenticated = true;
  noteLinkedOrQr();
  // Soft settle only — do NOT call inject() here (blocks / races QR & boot)
  setTimeout(() => {
    void (async () => {
      for (let i = 0; i < 20; i++) {
        if (await probeWWebJS()) {
          ready = true;
          clearQrArtifacts();
          logger.info('WhatsApp client ready');
          return;
        }
        await sleep(1_000);
      }
      ready = false;
      logger.error('WhatsApp ready event but WWebJS not available');
    })();
  }, 2_000);
});

client.on('auth_failure', (msg) => {
  ready = false;
  clearQrArtifacts();
  logger.error('WhatsApp auth failed', { msg });
  void hardRecover(true, 5_000);
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
    void hardRecover(false, 0);
  }, delayMs);
}

async function initWithTimeout(ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      client.initialize(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`initialize timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function hardRecover(clearSession: boolean, delayMs: number): Promise<void> {
  if (recovering) return;
  recovering = true;
  ready = false;
  try {
    if (delayMs > 0) await sleep(delayMs);
    logger.warn('WhatsApp hard recover', { clearSession });
    try {
      await Promise.race([client.destroy(), sleep(10_000)]);
    } catch {
      /* ignore */
    }
    if (clearSession) {
      clearSessionFiles();
      everAuthenticated = false;
    }
    clearQrArtifacts();
    noLinkSince = Date.now();
    await initWithTimeout(60_000);
  } catch (err) {
    logger.error('WhatsApp hard recover failed', { error: (err as Error).message });
    try {
      await Promise.race([client.destroy(), sleep(5_000)]);
    } catch {
      /* ignore */
    }
    if (clearSession) clearSessionFiles();
    scheduleReinit(12_000);
  } finally {
    recovering = false;
  }
}

client.on('disconnected', (reason) => {
  ready = false;
  const why = String(reason);
  if (why === 'LOGOUT') {
    // Mac/old session rejected by WhatsApp — must scan QR on Railway (same browser as runtime)
    logger.error(
      'WhatsApp LOGOUT — cleared invalid session. Open /wa-qr and scan from Business Linked devices',
    );
    void hardRecover(true, 3_000);
    return;
  }
  logger.warn('WhatsApp disconnected — reconnecting in 8s', { reason: why });
  scheduleReinit(8_000);
});

/** Manual relink: clear session + restart Chromium (token-protected HTTP). */
export async function forceWhatsAppRelink(): Promise<{ ok: boolean; error?: string }> {
  try {
    await hardRecover(true, 0);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function getWhatsAppDiag(): {
  recovering: boolean;
  noLinkSec: number;
  hasSessionDir: boolean;
} {
  return {
    recovering,
    noLinkSec: Math.floor((Date.now() - noLinkSince) / 1000),
    hasSessionDir: fs.existsSync(path.join(SESSION_DIR, 'session')),
  };
}

/**
 * If Chromium boots into a dead session (no ready, no QR), clear and re-link.
 */
export function startWhatsAppWatchdog(): void {
  if (watchdogStarted) return;
  watchdogStarted = true;
  noLinkSince = Date.now();

  setInterval(() => {
    void (async () => {
      if (recovering || ready) return;
      if (latestQrDataUrl || latestPairingCode) return; // waiting for user scan
      // Absolute 60s without QR/ready — ignore loading_screen chatter
      if (Date.now() - noLinkSince < 60_000) return;

      logger.error(
        'WhatsApp stuck with no ready/QR for 60s — clearing session so /wa-qr can appear',
      );
      await hardRecover(true, 0);
    })();
  }, 10_000);
}

if (usePairing) {
  logger.info('WhatsApp auth: pairing-code mode', { phone: phoneDigits });
} else {
  logger.info('WhatsApp auth: QR / existing session');
}

export default client;
