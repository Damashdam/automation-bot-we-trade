import axios, { AxiosError } from 'axios';
import logger from '../utils/logger';

export interface SendResult {
  success: boolean;
  messageId?: number;
  error?: string;
}

function apiUrl(method: string): string {
  return `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
}

export async function sendTelegramMessage(message: string, mediaUrl?: string, postId?: string): Promise<SendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (process.env.DRY_RUN === 'true') {
    const imageNote = mediaUrl ? `\n[IMAGE: ${mediaUrl}]` : '';
    logger.info(
      'DRY RUN — Telegram message that would be sent:\n' +
      '─'.repeat(50) + '\n' +
      message + imageNote + '\n' +
      '─'.repeat(50)
    );
    return { success: true, messageId: 0 };
  }

  if (!token || !chatId) {
    throw new Error('Missing Telegram credentials: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID');
  }

  const replyMarkup = {
    inline_keyboard: [[
      { text: '✅ אישור', callback_data: `approve:${postId ?? 'unknown'}` },
      { text: '✏️ עריכה', callback_data: `edit:${postId ?? 'unknown'}` },
    ]],
  };

  try {
    let response;

    if (mediaUrl) {
      response = await axios.post(apiUrl('sendPhoto'), {
        chat_id: chatId,
        photo: mediaUrl,
        caption: message,
        parse_mode: 'Markdown',
        reply_markup: replyMarkup,
      }, { timeout: 12_000 });
    } else {
      response = await axios.post(apiUrl('sendMessage'), {
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        reply_markup: replyMarkup,
      }, { timeout: 12_000 });
    }

    const msgId: number = (response.data as { result?: { message_id?: number } })?.result?.message_id ?? 0;
    logger.info('Telegram message sent', { messageId: msgId, hasImage: !!mediaUrl });
    return { success: true, messageId: msgId };
  } catch (err) {
    const detail =
      err instanceof AxiosError
        ? `HTTP ${err.response?.status}: ${JSON.stringify(err.response?.data)}`
        : (err as Error).message;
    logger.error('Failed to send Telegram message', { error: detail });
    return { success: false, error: detail };
  }
}
