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

async function listGroupsFromStore(): Promise<Array<{ name: string; id: string }>> {
  const page = (client as unknown as { pupPage?: { evaluate: Function } }).pupPage;
  if (!page) return [];

  try {
    return (await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      const out: Array<{ name: string; id: string }> = [];

      try {
        if (w.WWebJS?.getChats) {
          // sync path may not exist; ignore
        }
      } catch {
        /* ignore */
      }

      const models = w.Store?.Chat?.getModelsArray?.() ?? [];
      for (const c of models) {
        if (!c?.isGroup) continue;
        const name = c.name || c.formattedTitle || '';
        const id = c.id?._serialized || c.id?.toString?.() || '';
        if (id) out.push({ name, id });
      }
      return out;
    })) as Array<{ name: string; id: string }>;
  } catch {
    return [];
  }
}

async function waitForGroups(timeoutMs = 25_000): Promise<Array<{ name: string; id: string }>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const groups = await listGroupsFromStore();
    if (groups.length > 0) return groups;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return listGroupsFromStore();
}

async function ensureJoinedViaInvite(): Promise<string | null> {
  const code = inviteCodeFromUrl(GROUP_INVITE_URL);
  if (!code) return null;

  try {
    const info = (await client.getInviteInfo(code)) as {
      id?: string | { _serialized?: string };
      subject?: string;
    };
    logger.info('WhatsApp invite info', {
      subject: info?.subject,
      id: typeof info?.id === 'string' ? info.id : info?.id?._serialized,
    });
  } catch (err) {
    logger.warn('getInviteInfo failed', { error: errDetail(err) });
  }

  try {
    const joinedId = await client.acceptInvite(code);
    logger.info('Joined / opened group via invite', { joinedId });
    return typeof joinedId === 'string' ? joinedId : null;
  } catch (err) {
    // Already a member often throws — try to recover id from invite info / store
    logger.warn('acceptInvite failed (may already be a member)', { error: errDetail(err) });
    return null;
  }
}

async function resolveGroupChatId(): Promise<string | null> {
  // Prefer fixed id — avoids re-joining via invite on every send
  if (GROUP_ID) return GROUP_ID;

  let groups = await waitForGroups(20_000);
  let hit = groups.find((g) => g.name === GROUP_NAME);
  if (hit) {
    logger.info('Resolved WhatsApp group id — add to .env as WHATSAPP_GROUP_ID', hit);
    return hit.id;
  }

  // Invite join only as last-resort bootstrap (once). Prefer setting WHATSAPP_GROUP_ID.
  logger.warn('Group not in Store — one-time invite bootstrap (set WHATSAPP_GROUP_ID to skip)', {
    wanted: GROUP_NAME,
    seen: groups.map((g) => g.name),
  });
  const joinedId = await ensureJoinedViaInvite();
  if (joinedId) return joinedId;

  await new Promise((r) => setTimeout(r, 3_000));
  groups = await waitForGroups(15_000);
  hit =
    groups.find((g) => g.name === GROUP_NAME) ||
    groups.find(
      (g) =>
        g.name.includes('עדכונים') ||
        g.name.replace(/\s/g, '') === GROUP_NAME.replace(/\s/g, ''),
    );
  if (hit) {
    logger.info('Resolved WhatsApp group id — add to .env as WHATSAPP_GROUP_ID', hit);
    return hit.id;
  }

  logger.error('WhatsApp group not found', {
    wanted: GROUP_NAME,
    available: groups.map((g) => g.name),
  });
  return null;
}

const SAFE_SEND_OPTS = {
  sendSeen: false,
  linkPreview: false,
} as const;

async function sendViaPage(chatId: string, text: string): Promise<void> {
  const page = (client as unknown as { pupPage?: { evaluate: Function } }).pupPage;
  if (!page) throw new Error('WhatsApp pupPage not available');

  const result = (await page.evaluate(
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
  )) as { ok: boolean; error?: string | null };

  if (!result?.ok) {
    throw new Error(result?.error || 'sendViaPage failed');
  }
}

async function sendOnce(chatId: string, text: string, mediaUrl?: string): Promise<void> {
  if (mediaUrl) {
    try {
      const media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
      await client.sendMessage(chatId, media, {
        ...SAFE_SEND_OPTS,
        caption: text,
      });
      return;
    } catch (mediaErr) {
      logger.warn('Media send failed — falling back to text', {
        error: errDetail(mediaErr),
      });
    }
  }

  try {
    await client.sendMessage(chatId, text, { ...SAFE_SEND_OPTS });
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

  await new Promise((r) => setTimeout(r, 1_500));

  const textForGroup = text
    .replace(/^🕐[^\n]*\n\n/, '')
    .replace(/https:\/\/www\.wetrade-il\.com\/home2\n?/g, '')
    .replace(/לא המלצה לפעולה/, `${GROUP_INVITE_URL}\nלא המלצה לפעולה`);

  try {
    const chatId = await resolveGroupChatId();
    if (!chatId) {
      return {
        success: false,
        error:
          `Group "${GROUP_NAME}" not found. Make sure the linked WhatsApp Business number is IN the group, then retry.`,
      };
    }

    try {
      await sendOnce(chatId, textForGroup, mediaUrl);
    } catch (firstErr) {
      logger.warn('WhatsApp send failed — retrying text-only via page', {
        error: errDetail(firstErr),
        chatId,
      });
      await new Promise((r) => setTimeout(r, 2_500));
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
