import axios, { AxiosError } from 'axios';
import { getPost, markChatSent, savePost } from '../db/database';
import { sendChatMessage } from '../wetrade/sendChatMessage';
import { sendToWhatsappGroup } from '../whatsapp/sendWhatsappGroup';
import logger from '../utils/logger';

/** Text from Telegram message when DB row is missing (redeploy / multi-instance). */
function textFromTelegramMessage(msg: TgMessage): string {
  const raw = (msg.caption ?? msg.text ?? '').trim();
  return raw
    .replace(/\n\n✅ _פורסם לצ'אט_$/u, '')
    .replace(/\n\n✅ _פורסם לצ׳אט_$/u, '')
    .trim();
}

function apiUrl(method: string): string {
  return `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function answerCallback(callbackQueryId: string, text?: string): Promise<void> {
  await axios.post(apiUrl('answerCallbackQuery'), {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  }, { timeout: 8_000 }).catch(() => {/* best-effort */});
}

async function markMessageApproved(chatId: number, messageId: number, originalText: string): Promise<void> {
  try {
    await axios.post(apiUrl('editMessageText'), {
      chat_id: chatId,
      message_id: messageId,
      text: originalText + '\n\n✅ _פורסם לצ\'אט_',
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [] },
    }, { timeout: 8_000 });
  } catch {
    // Photo messages can't use editMessageText — remove button only
    try {
      await axios.post(apiUrl('editMessageReplyMarkup'), {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      }, { timeout: 8_000 });
    } catch { /* best-effort */ }
  }
}

async function sendSimpleMessage(chatId: number, text: string): Promise<void> {
  await axios.post(apiUrl('sendMessage'), {
    chat_id: chatId,
    text,
  }, { timeout: 8_000 }).catch(() => {/* best-effort */});
}

async function sendImageChoiceKeyboard(chatId: number, postId: string): Promise<void> {
  await axios.post(apiUrl('sendMessage'), {
    chat_id: chatId,
    text: '📸 האם לצרף תמונה לעדכון?',
    reply_markup: {
      inline_keyboard: [[
        { text: '📷 כן, שלח תמונה', callback_data: `img_want:${postId}` },
        { text: '✅ פרסם ככה', callback_data: `img_skip:${postId}` },
      ]],
    },
  }, { timeout: 8_000 }).catch(() => {/* best-effort */});
}

async function removeKeyboard(chatId: number, messageId: number): Promise<void> {
  await axios.post(apiUrl('editMessageReplyMarkup'), {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  }, { timeout: 8_000 }).catch(() => {/* best-effort */});
}

async function getTelegramFileUrl(fileId: string): Promise<string | null> {
  try {
    const resp = await axios.get(apiUrl('getFile'), {
      params: { file_id: fileId },
      timeout: 8_000,
    });
    const filePath = (resp.data as { result?: { file_path?: string } })?.result?.file_path;
    if (!filePath) return null;
    return `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;
  } catch {
    return null;
  }
}

async function publishPost(
  postId: string,
  text: string,
  mediaUrl: string | undefined,
  chatId: number,
  originalMessageId: number,
  originalMessageText: string,
): Promise<void> {
  const result = await sendChatMessage(text, mediaUrl);

  if (result.success) {
    markChatSent(postId);
    logger.info('Post published to WeTrade chat', { postId });

    const waResult = await sendToWhatsappGroup(text, mediaUrl);
    if (waResult.success) {
      logger.info('Post also sent to WhatsApp group', { postId });
    } else {
      logger.error('WhatsApp group send failed', { postId, error: waResult.error });
    }

    await markMessageApproved(chatId, originalMessageId, originalMessageText);
    if (waResult.success) {
      await sendSimpleMessage(chatId, '✅ פורסם לצ\'אט ולוואצאפ!');
    } else {
      await sendSimpleMessage(
        chatId,
        `✅ פורסם לצ\'אט\n⚠️ וואטסאפ נכשל: ${waResult.error ?? 'לא מוכן'}\n(בדקו /health → whatsappReady)`,
      );
    }
  } else {
    logger.error('Chat post failed', { postId, error: result.error });
    await sendSimpleMessage(chatId, '❌ שגיאה בפרסום: ' + (result.error ?? 'שגיאה לא ידועה'));
  }
}

const processing = new Set<string>();

// Per-chat edit flow state machine
type ChatState =
  | { stage: 'await_text'; postId: string; originalMessageId: number; originalMessageText: string }
  | { stage: 'await_image_choice'; postId: string; editedText: string; originalMessageId: number; originalMessageText: string }
  | { stage: 'await_photo'; postId: string; editedText: string; originalMessageId: number; originalMessageText: string };

const chatStates = new Map<number, ChatState>();

interface PhotoSize { file_id: string; width: number; height: number }

interface TgMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  caption?: string;
  photo?: PhotoSize[];
}

interface CallbackQuery {
  id: string;
  data: string;
  message?: TgMessage;
}

interface Update {
  update_id: number;
  callback_query?: CallbackQuery;
  message?: TgMessage;
}

export async function startCallbackHandler(): Promise<void> {
  let offset: number | undefined;
  logger.info('Telegram callback handler started — waiting for approvals');

  while (true) {
    try {
      const resp = await axios.get(apiUrl('getUpdates'), {
        params: {
          ...(offset !== undefined ? { offset } : {}),
          timeout: 30,
          allowed_updates: JSON.stringify(['callback_query', 'message']),
        },
        timeout: 35_000,
      });

      const updates = (resp.data as { result: Update[] }).result;

      for (const update of updates) {
        offset = update.update_id + 1;

        // ── Incoming message from user ──────────────────────────────────────
        if (update.message) {
          const msg = update.message;
          const state = chatStates.get(msg.chat.id);

          // Step 1: waiting for edited text
          if (state?.stage === 'await_text' && msg.text) {
            chatStates.set(msg.chat.id, {
              stage: 'await_image_choice',
              postId: state.postId,
              editedText: msg.text,
              originalMessageId: state.originalMessageId,
              originalMessageText: state.originalMessageText,
            });
            await sendImageChoiceKeyboard(msg.chat.id, state.postId);
            continue;
          }

          // Step 3 (optional): waiting for photo
          if (state?.stage === 'await_photo' && msg.photo) {
            chatStates.delete(msg.chat.id);
            const largest = msg.photo[msg.photo.length - 1];
            const fileUrl = await getTelegramFileUrl(largest.file_id);

            if (processing.has(state.postId)) {
              await sendSimpleMessage(msg.chat.id, 'מעבד...');
              continue;
            }
            processing.add(state.postId);
            try {
              await publishPost(
                state.postId,
                state.editedText,
                fileUrl ?? undefined,
                msg.chat.id,
                state.originalMessageId,
                state.originalMessageText,
              );
            } finally {
              processing.delete(state.postId);
            }
            continue;
          }

          continue;
        }

        // ── Callback query ──────────────────────────────────────────────────
        const cq = update.callback_query;
        if (!cq?.data) continue;

        // ── img_skip: publish without image ────────────────────────────────
        if (cq.data.startsWith('img_skip:')) {
          const postId = cq.data.slice('img_skip:'.length);
          const state = cq.message ? chatStates.get(cq.message.chat.id) : undefined;

          if (state?.stage === 'await_image_choice' && state.postId === postId) {
            chatStates.delete(cq.message!.chat.id);
            await answerCallback(cq.id, 'מפרסם...');
            if (cq.message) await removeKeyboard(cq.message.chat.id, cq.message.message_id);

            if (!processing.has(postId)) {
              processing.add(postId);
              try {
                await publishPost(postId, state.editedText, undefined, cq.message!.chat.id, state.originalMessageId, state.originalMessageText);
              } finally {
                processing.delete(postId);
              }
            }
          } else {
            await answerCallback(cq.id);
          }
          continue;
        }

        // ── img_want: transition to waiting for photo ───────────────────────
        if (cq.data.startsWith('img_want:')) {
          const postId = cq.data.slice('img_want:'.length);
          const state = cq.message ? chatStates.get(cq.message.chat.id) : undefined;

          if (state?.stage === 'await_image_choice' && state.postId === postId) {
            chatStates.set(cq.message!.chat.id, {
              stage: 'await_photo',
              postId: state.postId,
              editedText: state.editedText,
              originalMessageId: state.originalMessageId,
              originalMessageText: state.originalMessageText,
            });
            if (cq.message) await removeKeyboard(cq.message.chat.id, cq.message.message_id);
            await sendSimpleMessage(cq.message!.chat.id, '📷 שלח עכשיו את התמונה:');
          }
          await answerCallback(cq.id);
          continue;
        }

        // ── ✏️ Edit button ──────────────────────────────────────────────────
        if (cq.data.startsWith('edit:')) {
          const postId = cq.data.slice('edit:'.length);
          const post = getPost(postId);

          if (!post?.generated_message) {
            await answerCallback(cq.id, 'שגיאה: פוסט לא נמצא');
            continue;
          }
          if (post.chat_sent) {
            await answerCallback(cq.id, 'כבר פורסם ✓');
            continue;
          }
          if (cq.message) {
            chatStates.set(cq.message.chat.id, {
              stage: 'await_text',
              postId,
              originalMessageId: cq.message.message_id,
              originalMessageText: cq.message.text ?? cq.message.caption ?? '',
            });
            await sendSimpleMessage(cq.message.chat.id, '✏️ כתוב את הטקסט המתוקן ושלח אותו:');
          }
          await answerCallback(cq.id);
          continue;
        }

        // ── ✅ Approve button ───────────────────────────────────────────────
        if (!cq.data.startsWith('approve:')) continue;

        const postId = cq.data.slice('approve:'.length);

        if (processing.has(postId)) {
          await answerCallback(cq.id, 'מעבד...');
          continue;
        }

        const post = getPost(postId);

        if (post?.chat_sent) {
          await answerCallback(cq.id, 'כבר פורסם ✓');
          continue;
        }

        const fromTg = cq.message ? textFromTelegramMessage(cq.message) : '';
        const messageText = post?.generated_message || fromTg;

        if (!messageText) {
          logger.warn('Approval received but post not found', { postId });
          await answerCallback(cq.id, 'שגיאה: פוסט לא נמצא');
          continue;
        }

        if (!post?.generated_message && fromTg) {
          logger.warn('Post missing in DB — using Telegram message text', { postId });
          savePost({
            post_id: postId,
            post_url: `https://x.com/i/status/${postId}`,
            original_text: fromTg,
            generated_message: fromTg,
            media_url: null,
            sent_to_whatsapp: false,
          });
        }

        processing.add(postId);
        await answerCallback(cq.id, 'מפרסם...');
        try {
          if (cq.message) {
            const original = cq.message.text ?? cq.message.caption ?? '';
            // Prefer photo URL from Telegram only if we have DB media; else undefined
            await publishPost(
              postId,
              messageText,
              post?.media_url ?? undefined,
              cq.message.chat.id,
              cq.message.message_id,
              original,
            );
          }
        } finally {
          processing.delete(postId);
        }
      }
    } catch (err) {
      const isNetworkErr = err instanceof AxiosError && !err.response;
      const detail = err instanceof AxiosError
        ? err.response
          ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
          : `Network error: ${err.message}`
        : (err as Error).message;
      if (isNetworkErr) {
        logger.warn('Callback handler: connection lost — retrying in 5s');
      } else if (err instanceof AxiosError && err.response?.status === 404) {
        logger.error(
          'Telegram 404 — TELEGRAM_BOT_TOKEN is invalid/missing in Railway Variables. Fix token and redeploy.',
        );
        await new Promise<void>((r) => setTimeout(r, 30_000));
        continue;
      } else {
        logger.error('Callback handler error', { error: detail });
      }
      await new Promise<void>((r) => setTimeout(r, 5_000));
    }
  }
}
