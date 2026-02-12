import cron from 'node-cron';
import { syncChannels } from '../services/syncEngine.js';
import { logger } from '../utils/logger.js';

export function startSyncScheduler() {
  const schedule = process.env.SYNC_CRON_SCHEDULE || '0 3 * * *';

  cron.schedule(schedule, async () => {
    logger.info('Starting scheduled channel sync...');
    try {
      const log = await syncChannels(null, 'auto');
      logger.info(
        `Scheduled sync completed: ${log.channelsProcessed} channels, status: ${log.status}`
      );
    } catch (err) {
      logger.error(`Scheduled sync failed: ${err.message}`);
    }
  });

  logger.info(`Sync scheduler started with schedule: ${schedule}`);
}
