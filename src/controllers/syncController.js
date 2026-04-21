import SyncLog from '../models/SyncLog.js';
import SyncConfig from '../models/SyncConfig.js';
import {
  getSyncStatus,
  syncChannelStats,
  syncVideoStats,
  syncDedicatedIngestLast24h,
  syncIhiIngestLast24h,
  syncIhiSadhguruVideoStats,
} from '../services/syncEngine.js';
import { getQuotaUsage } from '../services/youtubeApi.js';
import {
  scheduleChannelSync,
  scheduleVideoSync,
  scheduleDedicatedIngest,
  scheduleIhiIngest,
  scheduleIhiSadhguruStats,
} from '../jobs/syncScheduler.js';

function normalizeConfigDoc(config) {
  const o = config.toObject ? config.toObject() : { ...config };
  return {
    ...o,
    dedicatedIngestSchedule:
      o.dedicatedIngestSchedule || '0 */6 * * *',
    ihiIngestSchedule:
      o.ihiIngestSchedule || '0 */6 * * *',
    ihiSadhguruStatsSchedule:
      o.ihiSadhguruStatsSchedule || '0 5 * * *',
    dedicatedIngestEnabled: o.dedicatedIngestEnabled !== false,
    ihiIngestEnabled: o.ihiIngestEnabled !== false,
    ihiSadhguruStatsEnabled: o.ihiSadhguruStatsEnabled !== false,
  };
}

// GET /api/sync/status
export async function getStatus(req, res) {
  const syncStatus = getSyncStatus();
  const quota = getQuotaUsage();
  const config = await SyncConfig.getSingleton();

  res.json({
    ...syncStatus,
    quota,
    config: normalizeConfigDoc(config),
  });
}

// GET /api/sync/logs?syncType=channel|video|ihi_ingest|ihi_sadhguru_stats&page=1&limit=15
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
        page: parseInt(page),
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

// POST /api/sync/videos/trigger — Dedicated channels only (top 10 recent)
export async function triggerVideoSync(req, res, next) {
  try {
    const log = await syncVideoStats(null, 'manual');
    res.json({ message: 'Dedicated video sync started', log });
  } catch (err) {
    if (err.message.includes('already in progress')) {
      return res.status(409).json({ message: err.message });
    }
    next(err);
  }
}

export async function triggerIhiIngest(req, res, next) {
  try {
    const log = await syncIhiIngestLast24h(null, 'manual');
    res.json({ message: 'IHI ingest sync started', log });
  } catch (err) {
    if (err.message.includes('already in progress')) {
      return res.status(409).json({ message: err.message });
    }
    next(err);
  }
}

export async function triggerDedicatedIngest(req, res, next) {
  try {
    const log = await syncDedicatedIngestLast24h(null, 'manual');
    res.json({ message: 'Dedicated ingest sync started', log });
  } catch (err) {
    if (err.message.includes('already in progress')) {
      return res.status(409).json({ message: err.message });
    }
    next(err);
  }
}

export async function triggerIhiSadhguruStats(req, res, next) {
  try {
    const log = await syncIhiSadhguruVideoStats(null, 'manual');
    res.json({ message: 'IHI Sadhguru stats sync started', log });
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
    res.json(normalizeConfigDoc(config));
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
      dedicatedIngestSchedule,
      ihiIngestSchedule,
      ihiSadhguruStatsSchedule,
      channelSyncEnabled,
      videoSyncEnabled,
      dedicatedIngestEnabled,
      ihiIngestEnabled,
      ihiSadhguruStatsEnabled,
    } = req.body;

    const config = await SyncConfig.getSingleton();

    const channelScheduleChanged =
      channelSyncSchedule !== undefined &&
      channelSyncSchedule !== config.channelSyncSchedule;
    const channelEnabledChanged =
      channelSyncEnabled !== undefined &&
      channelSyncEnabled !== config.channelSyncEnabled;
    const videoScheduleChanged =
      videoSyncSchedule !== undefined &&
      videoSyncSchedule !== config.videoSyncSchedule;
    const videoEnabledChanged =
      videoSyncEnabled !== undefined &&
      videoSyncEnabled !== config.videoSyncEnabled;
    const dedicatedIngestScheduleChanged =
      dedicatedIngestSchedule !== undefined &&
      dedicatedIngestSchedule !== config.dedicatedIngestSchedule;
    const dedicatedIngestEnabledChanged =
      dedicatedIngestEnabled !== undefined &&
      dedicatedIngestEnabled !== config.dedicatedIngestEnabled;
    const ihiIngestScheduleChanged =
      ihiIngestSchedule !== undefined &&
      ihiIngestSchedule !== config.ihiIngestSchedule;
    const ihiIngestEnabledChanged =
      ihiIngestEnabled !== undefined &&
      ihiIngestEnabled !== config.ihiIngestEnabled;
    const ihiStatsScheduleChanged =
      ihiSadhguruStatsSchedule !== undefined &&
      ihiSadhguruStatsSchedule !== config.ihiSadhguruStatsSchedule;
    const ihiStatsEnabledChanged =
      ihiSadhguruStatsEnabled !== undefined &&
      ihiSadhguruStatsEnabled !== config.ihiSadhguruStatsEnabled;

    if (channelSyncSchedule !== undefined)
      config.channelSyncSchedule = channelSyncSchedule;
    if (videoSyncSchedule !== undefined)
      config.videoSyncSchedule = videoSyncSchedule;
    if (dedicatedIngestSchedule !== undefined)
      config.dedicatedIngestSchedule = dedicatedIngestSchedule;
    if (ihiIngestSchedule !== undefined)
      config.ihiIngestSchedule = ihiIngestSchedule;
    if (ihiSadhguruStatsSchedule !== undefined)
      config.ihiSadhguruStatsSchedule = ihiSadhguruStatsSchedule;
    if (channelSyncEnabled !== undefined)
      config.channelSyncEnabled = channelSyncEnabled;
    if (videoSyncEnabled !== undefined)
      config.videoSyncEnabled = videoSyncEnabled;
    if (dedicatedIngestEnabled !== undefined)
      config.dedicatedIngestEnabled = dedicatedIngestEnabled;
    if (ihiIngestEnabled !== undefined)
      config.ihiIngestEnabled = ihiIngestEnabled;
    if (ihiSadhguruStatsEnabled !== undefined)
      config.ihiSadhguruStatsEnabled = ihiSadhguruStatsEnabled;

    await config.save();

    if (channelScheduleChanged || channelEnabledChanged) {
      scheduleChannelSync(config.channelSyncSchedule, config.channelSyncEnabled);
    }
    if (videoScheduleChanged || videoEnabledChanged) {
      scheduleVideoSync(config.videoSyncSchedule, config.videoSyncEnabled);
    }
    if (dedicatedIngestScheduleChanged || dedicatedIngestEnabledChanged) {
      scheduleDedicatedIngest(
        config.dedicatedIngestSchedule,
        config.dedicatedIngestEnabled
      );
    }
    if (ihiIngestScheduleChanged || ihiIngestEnabledChanged) {
      scheduleIhiIngest(config.ihiIngestSchedule, config.ihiIngestEnabled);
    }
    if (ihiStatsScheduleChanged || ihiStatsEnabledChanged) {
      scheduleIhiSadhguruStats(
        config.ihiSadhguruStatsSchedule,
        config.ihiSadhguruStatsEnabled
      );
    }

    res.json(normalizeConfigDoc(config));
  } catch (err) {
    next(err);
  }
}
