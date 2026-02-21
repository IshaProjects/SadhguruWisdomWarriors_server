import SyncLog from '../models/SyncLog.js';
import SyncConfig from '../models/SyncConfig.js';
import { getSyncStatus, syncChannelStats, syncVideoStats } from '../services/syncEngine.js';
import { getQuotaUsage } from '../services/youtubeApi.js';
import { scheduleChannelSync, scheduleVideoSync } from '../jobs/syncScheduler.js';

// GET /api/sync/status
export async function getStatus(req, res) {
  const syncStatus = getSyncStatus();
  const quota = getQuotaUsage();
  const config = await SyncConfig.getSingleton();

  res.json({
    ...syncStatus,
    quota,
    config: {
      channelSyncSchedule: config.channelSyncSchedule,
      videoSyncSchedule:   config.videoSyncSchedule,
      channelSyncEnabled:  config.channelSyncEnabled,
      videoSyncEnabled:    config.videoSyncEnabled,
    },
  });
}

// GET /api/sync/logs?syncType=channel|video&page=1&limit=15
export async function getLogs(req, res, next) {
  try {
    const { page = 1, limit = 15, syncType } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = syncType ? { syncType } : {};

    const [logs, total] = await Promise.all([
      SyncLog.find(filter).sort({ startedAt: -1 }).skip(skip).limit(parseInt(limit)),
      SyncLog.countDocuments(filter),
    ]);

    res.json({
      logs,
      pagination: {
        page:  parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/sync/channels/trigger
export async function triggerChannelSync(req, res, next) {
  try {
    const log = await syncChannelStats(null, 'manual');
    res.json({ message: 'Channel sync started', log });
  } catch (err) {
    if (err.message.includes('already in progress')) {
      return res.status(409).json({ message: err.message });
    }
    next(err);
  }
}

// POST /api/sync/videos/trigger
export async function triggerVideoSync(req, res, next) {
  try {
    const log = await syncVideoStats(null, 'manual');
    res.json({ message: 'Video sync started', log });
  } catch (err) {
    if (err.message.includes('already in progress')) {
      return res.status(409).json({ message: err.message });
    }
    next(err);
  }
}

// GET /api/sync/config
export async function getConfig(req, res, next) {
  try {
    const config = await SyncConfig.getSingleton();
    res.json(config);
  } catch (err) {
    next(err);
  }
}

// PUT /api/sync/config
export async function updateConfig(req, res, next) {
  try {
    const {
      channelSyncSchedule,
      videoSyncSchedule,
      channelSyncEnabled,
      videoSyncEnabled,
    } = req.body;

    const config = await SyncConfig.getSingleton();

    const channelScheduleChanged =
      channelSyncSchedule !== undefined && channelSyncSchedule !== config.channelSyncSchedule;
    const channelEnabledChanged =
      channelSyncEnabled !== undefined && channelSyncEnabled !== config.channelSyncEnabled;
    const videoScheduleChanged =
      videoSyncSchedule !== undefined && videoSyncSchedule !== config.videoSyncSchedule;
    const videoEnabledChanged =
      videoSyncEnabled !== undefined && videoSyncEnabled !== config.videoSyncEnabled;

    if (channelSyncSchedule !== undefined) config.channelSyncSchedule = channelSyncSchedule;
    if (videoSyncSchedule   !== undefined) config.videoSyncSchedule   = videoSyncSchedule;
    if (channelSyncEnabled  !== undefined) config.channelSyncEnabled  = channelSyncEnabled;
    if (videoSyncEnabled    !== undefined) config.videoSyncEnabled    = videoSyncEnabled;

    await config.save();

    // Hot-reload the cron tasks if schedule or enabled flag changed
    if (channelScheduleChanged || channelEnabledChanged) {
      scheduleChannelSync(config.channelSyncSchedule, config.channelSyncEnabled);
    }
    if (videoScheduleChanged || videoEnabledChanged) {
      scheduleVideoSync(config.videoSyncSchedule, config.videoSyncEnabled);
    }

    res.json(config);
  } catch (err) {
    next(err);
  }
}
