import { MessageMedia } from 'whatsapp-web.js';
import client, { isClientReady } from './waClient';
import logger from '../utils/logger';

const GROUP_NAME = (process.env.WHATSAPP_GROUP_NAME || '').trim();
const GROUP_ID = (process.env.WHATSAPP_GROUP_ID || '').trim();
const GROUP_INVITE_URL = (
  process.env.WHATSAPP_GROUP_INVITE_URL ||
  'https://chat.whatsapp.com/JUDZ3Tz9cdXKzx9y96s0Y1?s=cl&p=i&ilr=0'
).trim();

export interface WaGroupSendResult {
  success: boolean;
  error?: string;
}

function errDetail(err: unknown): string {
  if (err instanceof Error) {
    const base = err.message || err.name || String(err);
    const stack = err.stack ? ` | ${err.stack.split('\n')[1]?.trim()}` : '';
    return base + stack;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function waitForReady(timeoutMs = 45_000): Promise<boolean> {
  if (isClientReady()) return true;
  const interval = 1_000;
  let elapsed = 0;
  while (elapsed < timeoutMs) {
    await new Promise((r) => setTimeout(r, interval));
    elapsed += interval;
    if (isClientReady()) return true;
  }
  return false;
}

const SAFE_SEND_OPTS = {
  sendSeen: false,
  linkPreview: false,
} as const;

/**
 * Send via raw WhatsApp Store — avoids wwebjs helpers that hang when Store sync is empty.
 */
async function sendViaStore(chatId: string, text: string): Promise<void> {
  const page = (client as unknown as { pupPage?: { evaluate: Function } }).pupPage;
  if (!page) throw new Error('WhatsApp pupPage not available');

  const result = (await withTimeout(
    page.evaluate(
      async (id: string, body: string) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const w = window as any;
          const chat =
            w.Store?.Chat?.get?.(id) ||
            w.Store?.Chat?.get?.(w.Store?.WidFactory?.createWid?.(id));
          if (!chat) {
            // Create a chat model stub for known group id (same approach as opening by id)
            try {
              const wid = w.Store?.WidFactory?.createWid?.(id);
              if (wid && w.Store?.Chat?.find) {
                const found = await w.Store.Chat.find(wid);
                if (found) {
                  await w.Store.SendMessage.sendTextMsgToChat(found, body);
                  return { ok: true };
                }
              }
            } catch (e) {
              return {
                ok: false,
                error: e instanceof Error ? e.message : String(e),
              };
            }
            return { ok: false, error: 'chat_not_in_store' };
          }
          if (w.Store?.SendMessage?.sendTextMsgToChat) {
            await w.Store.SendMessage.sendTextMsgToChat(chat, body);
            return { ok: true };
          }
          if (w.WWebJS?.sendMessage) {
            await w.WWebJS.sendMessage(chat, body, { linkPreview: false });
            return { ok: true };
          }
          return { ok: false, error: 'no_send_api' };
        } catch (e) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      },
      chatId,
      text,
    ),
    20_000,
    'sendViaStore',
  )) as { ok: boolean; error?: string };

  if (!result?.ok) {
    throw new Error(result?.error || 'sendViaStore failed');
  }
}

async function sendViaPage(chatId: string, text: string): Promise<void> {
  const page = (client as unknown as { pupPage?: { evaluate: Function } }).pupPage;
  if (!page) throw new Error('WhatsApp pupPage not available');

  const result = (await withTimeout(
    page.evaluate(
      async (id: string, body: string) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const w = window as any;
          if (!w.WWebJS?.getChat || !w.WWebJS?.sendMessage) {
            return { ok: false, error: 'WWebJS_missing' };
          }
          const chat = await w.WWebJS.getChat(id, { getAsModel: false });
          if (!chat) return { ok: false, error: 'chat_not_found' };
          const msg = await w.WWebJS.sendMessage(chat, body, { linkPreview: false });
          return { ok: !!msg, error: msg ? null : 'send_returned_empty' };
        } catch (e) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      },
      chatId,
      text,
    ),
    25_000,
    'sendViaPage',
  )) as { ok: boolean; error?: string | null };

  if (!result?.ok) {
    throw new Error(result?.error || 'sendViaPage failed');
  }
}

async function sendText(chatId: string, text: string): Promise<void> {
  // 1) Direct API (worked locally with GROUP_ID)
  try {
    await withTimeout(
      client.sendMessage(chatId, text, { ...SAFE_SEND_OPTS }),
      20_000,
      'sendMessage',
    );
    return;
  } catch (err) {
    logger.warn('sendMessage failed', { error: errDetail(err) });
  }

  // 2) Store path
  try {
    await sendViaStore(chatId, text);
    return;
  } catch (err) {
    logger.warn('sendViaStore failed', { error: errDetail(err) });
  }

  // 3) WWebJS helpers
  await sendViaPage(chatId, text);
}

async function sendOnce(chatId: string, text: string, mediaUrl?: string): Promise<void> {
  if (mediaUrl) {
    try {
      const media = await withTimeout(
        MessageMedia.fromUrl(mediaUrl, { unsafeMime: true }),
        15_000,
        'MessageMedia.fromUrl',
      );
      await withTimeout(
        client.sendMessage(chatId, media, {
          ...SAFE_SEND_OPTS,
          caption: text,
        }),
        25_000,
        'sendMessage media',
      );
      return;
    } catch (mediaErr) {
      logger.warn('Media send failed — falling back to text', {
        error: errDetail(mediaErr),
      });
    }
  }

  await sendText(chatId, text);
}

export async function sendToWhatsappGroup(text: string, mediaUrl?: string): Promise<WaGroupSendResult> {
  if (process.env.DRY_RUN === 'true') {
    logger.info('DRY RUN — would send to WhatsApp group', {
      group: GROUP_NAME,
      preview: text.slice(0, 80),
    });
    return { success: true };
  }

  if (!GROUP_ID && !GROUP_NAME && !GROUP_INVITE_URL) {
    throw new Error('Missing WHATSAPP_GROUP_NAME / WHATSAPP_GROUP_ID / invite URL');
  }

  if (!(await waitForReady())) {
    logger.warn('WhatsApp client not ready — skipping group send');
    return { success: false, error: 'WhatsApp client not ready' };
  }

  if (!GROUP_ID) {
    return {
      success: false,
      error: 'Missing WHATSAPP_GROUP_ID on Railway (required)',
    };
  }

  const textForGroup = text
    .replace(/^🕐[^\n]*\n\n/, '')
    .replace(/https:\/\/www\.wetrade-il\.com\/home2\n?/g, '')
    .replace(/לא המלצה לפעולה/, `${GROUP_INVITE_URL}\nלא המלצה לפעולה`);

  try {
    // No invite/getChat warm — those hang when Store sync is empty on Railway.
    logger.info('Sending to WhatsApp group…', { chatId: GROUP_ID, group: GROUP_NAME });
    await sendOnce(GROUP_ID, textForGroup, mediaUrl);
    logger.info('Message sent to WhatsApp group', {
      group: GROUP_NAME || GROUP_ID,
      chatId: GROUP_ID,
    });
    return { success: true };
  } catch (err) {
    const detail = errDetail(err);
    logger.error('Failed to send to WhatsApp group', { error: detail });
    return { success: false, error: detail };
  }
}
