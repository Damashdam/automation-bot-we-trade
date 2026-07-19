import 'dotenv/config';
import cron from 'node-cron';
import { runMonitorJob } from './jobs/monitorXProfile';
import { startCallbackHandler } from './telegram/callbackHandler';
import waClient, { startWhatsAppWatchdog } from './whatsapp/waClient';
import { startHealthServer } from './healthServer';
import { bootstrapDataFromEnv } from './bootstrapData';
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

  await bootstrapDataFromEnv();
  // Health first so Railway probes stay up while Chromium boots
  startHealthServer();

  startCallbackHandler().catch((err: Error) => {
    logger.error('Callback handler crashed', { error: err.message });
  });

  // Init WhatsApp before the first scrape storm (Chromium needs CPU/RAM)
  startWhatsAppWatchdog();
  try {
    await Promise.race([
      waClient.initialize(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('WhatsApp initialize timed out after 90s')), 90_000),
      ),
    ]);
  } catch (err) {
    logger.error('WhatsApp init failed — watchdog will clear session & retry', {
      error: (err as Error).message,
    });
  }

  // Run once after WA has had a chance to become ready
  await runMonitorJob();

  const cronExpression = `*/${CHECK_INTERVAL} * * * *`;
  logger.info('Scheduling recurring monitor job', { cron: cronExpression });

  cron.schedule(cronExpression, async () => {
    await runMonitorJob();
  });

  logger.info('Bot is running — press Ctrl+C to stop');
}

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  // WhatsApp Web navigates away on LOGOUT; wwebjs can throw this uncaught
  if (msg.includes('Execution context was destroyed')) {
    logger.warn('Ignored WA navigation error after disconnect', { msg });
    return;
  }
  logger.error('unhandledRejection', { msg });
});

main().catch((err: Error) => {
  logger.error('Fatal startup error', { error: err.message, stack: err.stack });
  process.exit(1);
});
