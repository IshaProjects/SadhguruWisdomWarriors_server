import cron from 'node-cron';
import { syncChannelStats, syncVideoStats } from '../services/syncEngine.js';
import SyncConfig from '../models/SyncConfig.js';
import { logger } from '../utils/logger.js';

// Active cron task references — kept in memory so we can cancel & recreate them
let channelTask = null;
let videoTask   = null;

export async function startSyncScheduler() {
  const config = await SyncConfig.getSingleton();
  scheduleChannelSync(config.channelSyncSchedule, config.channelSyncEnabled);
  scheduleVideoSync(config.videoSyncSchedule,   config.videoSyncEnabled);
}

export function scheduleChannelSync(cronExpr, enabled) {
  if (channelTask) {
    channelTask.stop();
    channelTask = null;
  }
  if (!enabled) {
    logger.info('[Scheduler] Channel sync disabled');
    return;
  }
  channelTask = cron.schedule(cronExpr, async () => {
    logger.info('[Scheduler] Starting scheduled channel sync...');
    try {
      const log = await syncChannelStats(null, 'auto');
      logger.info(`[Scheduler] Channel sync done: ${log.channelsProcessed} channels, status: ${log.status}`);
    } catch (err) {
      logger.error(`[Scheduler] Channel sync failed: ${err.message}`);
    }
  });
  logger.info(`[Scheduler] Channel sync scheduled: ${cronExpr}`);
}

export function scheduleVideoSync(cronExpr, enabled) {
  if (videoTask) {
    videoTask.stop();
    videoTask = null;
  }
  if (!enabled) {
    logger.info('[Scheduler] Video sync disabled');
    return;
  }
  videoTask = cron.schedule(cronExpr, async () => {
    logger.info('[Scheduler] Starting scheduled video sync...');
    try {
      const log = await syncVideoStats(null, 'auto');
      logger.info(`[Scheduler] Video sync done: ${log.videosProcessed} videos, status: ${log.status}`);
    } catch (err) {
      logger.error(`[Scheduler] Video sync failed: ${err.message}`);
    }
  });
  logger.info(`[Scheduler] Video sync scheduled: ${cronExpr}`);
}
