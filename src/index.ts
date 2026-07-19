import 'dotenv/config';
import cron from 'node-cron';
import { runMonitorJob } from './jobs/monitorXProfile';
import { startCallbackHandler } from './telegram/callbackHandler';
import waClient from './whatsapp/waClient';
import { startHealthServer } from './healthServer';
import logger from './utils/logger';

const IS_TEST = process.argv.includes('--test');
const CHECK_INTERVAL = Math.max(1, parseInt(process.env.CHECK_INTERVAL_MINUTES || '5', 10));

async function main(): Promise<void> {
  logger.info('WeTrade News Bot initialising', {
    mode: IS_TEST ? 'test' : 'live',
    checkIntervalMinutes: CHECK_INTERVAL,
    targets: (process.env.TARGET_X_USERNAMES || process.env.TARGET_X_USERNAME || 'StockMKTNewz').split(',').map(u => u.trim()),
  });

  if (IS_TEST) {
    logger.info('Test mode: fetching posts and printing generated messages — nothing will be sent');
    await runMonitorJob(true);
    logger.info('Test run complete. Exiting.');
    process.exit(0);
  }

  startHealthServer();

  waClient.initialize().catch((err: Error) => {
    logger.error('WhatsApp init failed', { error: err.message });
  });

  startCallbackHandler().catch((err: Error) => {
    logger.error('Callback handler crashed', { error: err.message });
  });

  // Run once immediately on startup so we don't wait for the first cron tick
  await runMonitorJob();

  const cronExpression = `*/${CHECK_INTERVAL} * * * *`;
  logger.info('Scheduling recurring monitor job', { cron: cronExpression });

  cron.schedule(cronExpression, async () => {
    await runMonitorJob();
  });

  logger.info('Bot is running — press Ctrl+C to stop');
}

main().catch((err: Error) => {
  logger.error('Fatal startup error', { error: err.message, stack: err.stack });
  process.exit(1);
});
