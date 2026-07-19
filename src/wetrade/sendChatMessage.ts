import axios, { AxiosError } from 'axios';
import logger from '../utils/logger';

const BASE_URL = (process.env.WETRADE_BASE_URL || 'https://www.wetrade-il.com').replace(/\/$/, '');

async function imageUrlToBase64(url: string): Promise<string | null> {
  try {
    const resp = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 10_000 });
    const mime = (resp.headers['content-type'] as string | undefined) || 'image/jpeg';
    const b64 = Buffer.from(resp.data).toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch {
    logger.warn('Could not download image for chat post', { url });
    return null;
  }
}

export interface ChatSendResult {
  success: boolean;
  error?: string;
}

export async function sendChatMessage(text: string, mediaUrl?: string): Promise<ChatSendResult> {
  if (process.env.DRY_RUN === 'true') {
    logger.info('DRY RUN — would post to WeTrade chat', { preview: text.slice(0, 80) });
    return { success: true };
  }

  const apiKey = process.env.WETRADE_API_KEY;
  if (!apiKey) {
    throw new Error('Missing WETRADE_API_KEY in .env');
  }

  try {
    // Strip timestamp header and Telegram markdown asterisks before posting to site
    const textForSite = text
      .replace(/^🕐[^\n]*\n\n/, '')
      .replace(/\*/g, '')
      .replace(/https:\/\/www\.wetrade-il\.com\/home2\n?/g, '');

    const body: Record<string, string> = { text: textForSite };
    if (mediaUrl) {
      const imageData = await imageUrlToBase64(mediaUrl);
      if (imageData) body.imageData = imageData;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await axios.post(`${BASE_URL}/api/chat/messages`, body, {
          headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
          timeout: 35_000,
        });
        logger.info('Message posted to WeTrade chat');
        return { success: true };
      } catch (err) {
        const isNetworkErr = err instanceof AxiosError && !err.response;
        if (isNetworkErr && attempt < 3) {
          logger.warn(`Chat post attempt ${attempt} failed (network) — retrying...`);
          await new Promise(r => setTimeout(r, 3_000));
          continue;
        }
        const detail = err instanceof AxiosError
          ? err.response
            ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
            : `Network error: ${err.message}`
          : (err as Error).message;
        logger.error('Failed to post to WeTrade chat', { error: detail });
        return { success: false, error: detail };
      }
    }
    return { success: false, error: 'Max retries exceeded' };
  } catch (err) {
    logger.error('Unexpected error in sendChatMessage', { error: (err as Error).message });
    return { success: false, error: (err as Error).message };
  }
}
