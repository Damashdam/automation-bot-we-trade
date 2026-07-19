/**
 * WhatsApp delivery module.
 * Supports Meta WhatsApp Cloud API (default) and Twilio as an alternative.
 * Set WHATSAPP_PROVIDER in .env to switch between them.
 */

import axios, { AxiosError } from 'axios';
import logger from '../utils/logger';

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// ─── Meta WhatsApp Cloud API ────────────────────────────────────────────────

async function sendViaMeta(message: string, mediaUrl?: string): Promise<SendResult> {
  const token = process.env.WHATSAPP_API_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const toNumber = process.env.TARGET_WHATSAPP_NUMBER;

  if (!token || !phoneNumberId || !toNumber) {
    throw new Error(
      'Missing Meta WhatsApp credentials: WHATSAPP_API_TOKEN, WHATSAPP_PHONE_NUMBER_ID, TARGET_WHATSAPP_NUMBER'
    );
  }

  const body = mediaUrl
    ? { messaging_product: 'whatsapp', to: toNumber, type: 'image', image: { link: mediaUrl, caption: message } }
    : { messaging_product: 'whatsapp', to: toNumber, type: 'text', text: { body: message, preview_url: false } };

  const response = await axios.post(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    body,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 12_000,
    }
  );

  const messageId: string = (response.data as { messages?: Array<{ id: string }> })?.messages?.[0]?.id ?? '';
  return { success: true, messageId };
}

// ─── Twilio WhatsApp ─────────────────────────────────────────────────────────

async function sendViaTwilio(message: string, mediaUrl?: string): Promise<SendResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const to = process.env.TARGET_WHATSAPP_NUMBER;

  if (!accountSid || !authToken || !from || !to) {
    throw new Error(
      'Missing Twilio credentials: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM, TARGET_WHATSAPP_NUMBER'
    );
  }

  const params = new URLSearchParams({
    From: `whatsapp:${from}`,
    To: `whatsapp:+${to.replace(/^\+/, '')}`,
    Body: message,
    ...(mediaUrl ? { MediaUrl0: mediaUrl } : {}),
  });

  const response = await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    params,
    {
      auth: { username: accountSid, password: authToken },
      timeout: 12_000,
    }
  );

  const sid: string = (response.data as { sid?: string })?.sid ?? '';
  return { success: true, messageId: sid };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function sendWhatsappMessage(message: string, mediaUrl?: string): Promise<SendResult> {
  if (process.env.DRY_RUN === 'true') {
    const imageNote = mediaUrl ? `\n[IMAGE: ${mediaUrl}]` : '';
    logger.info('DRY RUN — message that would be sent:\n' + '─'.repeat(50) + '\n' + message + imageNote + '\n' + '─'.repeat(50));
    return { success: true, messageId: 'dry-run' };
  }

  const provider = (process.env.WHATSAPP_PROVIDER || 'meta').toLowerCase();

  try {
    let result: SendResult;

    if (provider === 'twilio') {
      result = await sendViaTwilio(message, mediaUrl);
    } else {
      result = await sendViaMeta(message, mediaUrl);
    }

    logger.info('WhatsApp message sent', { provider, messageId: result.messageId });
    return result;
  } catch (err) {
    const detail =
      err instanceof AxiosError
        ? `HTTP ${err.response?.status}: ${JSON.stringify(err.response?.data)}`
        : (err as Error).message;

    logger.error('Failed to send WhatsApp message', { provider, error: detail });
    return { success: false, error: detail };
  }
}
