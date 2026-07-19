import { fetchLatestPosts, ScrapedPost } from '../scraper/xScraper';
import { generateHebrewUpdate } from '../ai/generateHebrewUpdate';
import { sendTelegramMessage } from '../telegram/sendTelegramMessage';
import { isPostProcessed, savePost, updatePostStatus } from '../db/database';
import logger from '../utils/logger';

const INTER_POST_DELAY_MS = 3_000; // avoid hammering OpenAI/WhatsApp in quick succession

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processPost(post: ScrapedPost, testMode: boolean): Promise<void> {
  logger.info('Processing new relevant post', {
    post_id: post.post_id,
    preview: post.text.slice(0, 80),
  });

  const hebrewMessage = await generateHebrewUpdate(post.text, post.timestamp);

  if (testMode) {
    console.log('\n' + '═'.repeat(60));
    console.log('SOURCE POST:');
    console.log(post.text);
    console.log('─'.repeat(60));
    console.log('GENERATED WHATSAPP MESSAGE:');
    console.log(hebrewMessage);
    console.log('═'.repeat(60) + '\n');

    savePost({
      post_id: post.post_id,
      post_url: post.post_url,
      original_text: post.text,
      generated_message: hebrewMessage,
      sent_to_whatsapp: false,
    });
    return;
  }

  savePost({
    post_id: post.post_id,
    post_url: post.post_url,
    original_text: post.text,
    generated_message: hebrewMessage,
    media_url: post.media_url ?? null,
    sent_to_whatsapp: false,
  });

  const result = await sendTelegramMessage(hebrewMessage, post.media_url, post.post_id);

  if (result.success) {
    updatePostStatus(post.post_id, hebrewMessage, true);
    logger.info('Post sent to Telegram — awaiting approval', { post_id: post.post_id });
  } else {
    logger.error('Telegram send failed — post saved but not sent', {
      post_id: post.post_id,
      error: result.error,
    });
  }
}

export async function runMonitorJob(testMode = false): Promise<void> {
  const label = testMode ? 'TEST' : 'LIVE';
  logger.info(`Monitor job started [${label}]`);

  let posts: ScrapedPost[];
  try {
    posts = await fetchLatestPosts();
  } catch (err) {
    logger.error('Scraper threw an unexpected error', { error: (err as Error).message });
    return;
  }

  if (posts.length === 0) {
    logger.warn('No posts fetched — all sources unavailable or account has no posts');
    return;
  }

  logger.info(`Evaluating ${posts.length} fetched posts`);

  let newCount = 0;

  for (const post of posts) {
    // Dedup check
    if (isPostProcessed(post.post_id)) {
      logger.debug('Already processed — skipping', { post_id: post.post_id });
      continue;
    }
    newCount++;

    try {
      await processPost(post, testMode);
    } catch (err) {
      logger.error('Error processing post — continuing with next', {
        post_id: post.post_id,
        error: (err as Error).message,
      });
    }

    // Small courtesy delay between posts
    await sleep(INTER_POST_DELAY_MS);
  }

  logger.info(`Monitor job finished`, { newPosts: newCount });
}
