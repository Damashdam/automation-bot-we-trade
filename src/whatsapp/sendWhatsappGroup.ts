import { MessageMedia } from 'whatsapp-web.js';
import client, { isClientReady } from './waClient';
import logger from '../utils/logger';

const GROUP_NAME = process.env.WHATSAPP_GROUP_NAME || '';
const GROUP_ID = (process.env.WHATSAPP_GROUP_ID || '').trim();
const GROUP_INVITE_URL =
  process.env.WHATSAPP_GROUP_INVITE_URL ||
  'https://chat.whatsapp.com/JUDZ3Tz9cdXKzx9y96s0Y1?s=cl&p=i&ilr=0';

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

function inviteCodeFromUrl(url: string): string | null {
  const m = url.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
  return m?.[1] ?? null;
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

/** Warm the group chat in WA Store — without this, sendMessage often hangs forever. */
async function warmGroupChat(chatId: string): Promise<void> {
  const code = inviteCodeFromUrl(GROUP_INVITE_URL);
  if (code) {
    try {
      await withTimeout(client.getInviteInfo(code), 12_000, 'getInviteInfo');
    } catch (err) {
      logger.warn('getInviteInfo warm failed', { error: errDetail(err) });
    }
    try {
      const joined = await withTimeout(client.acceptInvite(code), 15_000, 'acceptInvite');
      logger.info('Group warm via acceptInvite', { joined });
    } catch (err) {
      logger.warn('acceptInvite warm failed (often OK if already member)', {
        error: errDetail(err),
      });
    }
  }

  try {
    const page = (client as unknown as { pupPage?: { evaluate: Function } }).pupPage;
    if (page) {
      await withTimeout(
        page.evaluate(async (id: string) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const w = window as any;
          if (w.WWebJS?.getChat) {
            await w.WWebJS.getChat(id, { getAsModel: false });
          }
        }, chatId),
        12_000,
        'getChat warm',
      );
    }
  } catch (err) {
    logger.warn('getChat warm failed', { error: errDetail(err) });
  }
}

async function resolveGroupChatId(): Promise<string | null> {
  if (GROUP_ID) return GROUP_ID;

  const code = inviteCodeFromUrl(GROUP_INVITE_URL);
  if (code) {
    try {
      const info = (await withTimeout(client.getInviteInfo(code), 15_000, 'getInviteInfo')) as {
        id?: string | { _serialized?: string };
      };
      const id =
        typeof info?.id === 'string' ? info.id : info?.id?._serialized ?? null;
      if (id) return id;
    } catch (err) {
      logger.warn('Could not resolve group from invite', { error: errDetail(err) });
    }
  }

  if (GROUP_NAME) {
    logger.error('Set WHATSAPP_GROUP_ID in Railway — required for reliable sends', {
      groupName: GROUP_NAME,
    });
  }
  return null;
}

const SAFE_SEND_OPTS = {
  sendSeen: false,
  linkPreview: false,
} as const;

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

async function sendOnce(chatId: string, text: string, mediaUrl?: string): Promise<void> {
  if (mediaUrl) {
    try {
      const media = await withTimeout(
        MessageMedia.fromUrl(mediaUrl, { unsafeMime: true }),
        20_000,
        'MessageMedia.fromUrl',
      );
      await withTimeout(
        client.sendMessage(chatId, media, {
          ...SAFE_SEND_OPTS,
          caption: text,
        }),
        30_000,
        'sendMessage media',
      );
      return;
    } catch (mediaErr) {
      logger.warn('Media send failed — falling back to text', {
        error: errDetail(mediaErr),
      });
    }
  }

  try {
    await withTimeout(
      client.sendMessage(chatId, text, { ...SAFE_SEND_OPTS }),
      30_000,
      'sendMessage text',
    );
  } catch (err) {
    logger.warn('client.sendMessage failed — trying page evaluate send', {
      error: errDetail(err),
    });
    await sendViaPage(chatId, text);
  }
}

export async function sendToWhatsappGroup(text: string, mediaUrl?: string): Promise<WaGroupSendResult> {
  if (process.env.DRY_RUN === 'true') {
    logger.info('DRY RUN — would send to WhatsApp group', {
      group: GROUP_NAME,
      preview: text.slice(0, 80),
    });
    return { success: true };
  }

  if (!GROUP_NAME && !GROUP_ID && !GROUP_INVITE_URL) {
    throw new Error('Missing WHATSAPP_GROUP_NAME / WHATSAPP_GROUP_ID / invite URL');
  }

  if (!(await waitForReady())) {
    logger.warn('WhatsApp client not ready — skipping group send');
    return { success: false, error: 'WhatsApp client not ready' };
  }

  const textForGroup = text
    .replace(/^🕐[^\n]*\n\n/, '')
    .replace(/https:\/\/www\.wetrade-il\.com\/home2\n?/g, '')
    .replace(/לא המלצה לפעולה/, `${GROUP_INVITE_URL}\nלא המלצה לפעולה`);

  try {
    const chatId = await resolveGroupChatId();
    if (!chatId) {
      return {
        success: false,
        error: 'Missing WHATSAPP_GROUP_ID (or invite) on Railway',
      };
    }

    logger.info('Sending to WhatsApp group…', { chatId, group: GROUP_NAME });
    await warmGroupChat(chatId);

    try {
      await sendOnce(chatId, textForGroup, mediaUrl);
    } catch (firstErr) {
      logger.warn('WhatsApp send failed — retrying text-only via page', {
        error: errDetail(firstErr),
        chatId,
      });
      await new Promise((r) => setTimeout(r, 2_000));
      await sendViaPage(chatId, textForGroup);
    }

    logger.info('Message sent to WhatsApp group', {
      group: GROUP_NAME || chatId,
      chatId,
    });
    return { success: true };
  } catch (err) {
    const detail = errDetail(err);
    logger.error('Failed to send to WhatsApp group', { error: detail });
    return { success: false, error: detail };
  }
}
