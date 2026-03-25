import cron from 'node-cron';
import {
  syncChannelStats,
  syncVideoStats,
  syncIhiIngestLast24h,
  syncIhiSadhguruVideoStats,
} from '../services/syncEngine.js';
import SyncConfig from '../models/SyncConfig.js';
import { logger } from '../utils/logger.js';

let channelTask = null;
let videoTask = null;
let ihiIngestTask = null;
let ihiSadhguruStatsTask = null;

export async function startSyncScheduler() {
  const config = await SyncConfig.getSingleton();
  scheduleChannelSync(config.channelSyncSchedule, config.channelSyncEnabled);
  scheduleVideoSync(config.videoSyncSchedule, config.videoSyncEnabled);
  scheduleIhiIngest(
    config.ihiIngestSchedule || '0 */6 * * *',
    config.ihiIngestEnabled !== false
  );
  scheduleIhiSadhguruStats(
    config.ihiSadhguruStatsSchedule || '0 5 * * *',
    config.ihiSadhguruStatsEnabled !== false
  );
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
      logger.info(
        `[Scheduler] Channel sync done: ${log.channelsProcessed} channels, status: ${log.status}`
      );
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
    logger.info('[Scheduler] Dedicated video sync disabled');
    return;
  }
  videoTask = cron.schedule(cronExpr, async () => {
    logger.info('[Scheduler] Starting scheduled dedicated video sync...');
    try {
      const log = await syncVideoStats(null, 'auto');
      logger.info(
        `[Scheduler] Dedicated video sync done: ${log.videosProcessed} videos, status: ${log.status}`
      );
    } catch (err) {
      logger.error(`[Scheduler] Dedicated video sync failed: ${err.message}`);
    }
  });
  logger.info(`[Scheduler] Dedicated video sync scheduled: ${cronExpr}`);
}

export function scheduleIhiIngest(cronExpr, enabled) {
  if (ihiIngestTask) {
    ihiIngestTask.stop();
    ihiIngestTask = null;
  }
  if (!enabled) {
    logger.info('[Scheduler] IHI ingest sync disabled');
    return;
  }
  ihiIngestTask = cron.schedule(cronExpr, async () => {
    logger.info('[Scheduler] Starting IHI ingest (24h + classify)...');
    try {
      const log = await syncIhiIngestLast24h(null, 'auto');
      logger.info(
        `[Scheduler] IHI ingest done: ${log.videosProcessed} videos, status: ${log.status}`
      );
    } catch (err) {
      logger.error(`[Scheduler] IHI ingest failed: ${err.message}`);
    }
  });
  logger.info(`[Scheduler] IHI ingest scheduled: ${cronExpr}`);
}

export function scheduleIhiSadhguruStats(cronExpr, enabled) {
  if (ihiSadhguruStatsTask) {
    ihiSadhguruStatsTask.stop();
    ihiSadhguruStatsTask = null;
  }
  if (!enabled) {
    logger.info('[Scheduler] IHI Sadhguru stats sync disabled');
    return;
  }
  ihiSadhguruStatsTask = cron.schedule(cronExpr, async () => {
    logger.info('[Scheduler] Starting IHI Sadhguru stats sync...');
    try {
      const log = await syncIhiSadhguruVideoStats(null, 'auto');
      logger.info(
        `[Scheduler] IHI Sadhguru stats done: ${log.videosProcessed} videos, status: ${log.status}`
      );
    } catch (err) {
      logger.error(`[Scheduler] IHI Sadhguru stats failed: ${err.message}`);
    }
  });
  logger.info(`[Scheduler] IHI Sadhguru stats scheduled: ${cronExpr}`);
}
