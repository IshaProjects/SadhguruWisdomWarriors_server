import SyncLog from '../models/SyncLog.js';
import { getSyncStatus } from '../services/syncEngine.js';
import { getQuotaUsage } from '../services/youtubeApi.js';

export async function getStatus(req, res) {
  const syncStatus = getSyncStatus();
  const quota = getQuotaUsage();

  res.json({
    ...syncStatus,
    quota,
  });
}

export async function getLogs(req, res, next) {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [logs, total] = await Promise.all([
      SyncLog.find().sort({ startedAt: -1 }).skip(skip).limit(parseInt(limit)),
      SyncLog.countDocuments(),
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
