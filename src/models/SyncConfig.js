import mongoose from 'mongoose';

/**
 * Singleton document that stores the cron schedules for each sync type.
 * Use SyncConfig.getSingleton() to always get (or create) the one document.
 */
const syncConfigSchema = new mongoose.Schema(
  {
    _singletonKey: { type: String, default: 'sync', unique: true },
    channelSyncSchedule: {
      type: String,
      default: '0 3 * * *',   // 3 AM daily
    },
    videoSyncSchedule: {
      type: String,
      default: '0 4 * * *',   // 4 AM daily — Dedicated channels only
    },
    dedicatedIngestSchedule: {
      type: String,
      default: '0 0 * * *', // daily midnight — Dedicated last 24h ingest + auto-classify
    },
    ihiIngestSchedule: {
      type: String,
      default: '0 */6 * * *', // every 6 hours — IHI last 24h + classify
    },
    ihiSadhguruStatsSchedule: {
      type: String,
      default: '0 5 * * *',   // 5 AM daily — IHI stats + snapshots for sadhguru only
    },
    channelSyncEnabled: { type: Boolean, default: true  },
    videoSyncEnabled:   { type: Boolean, default: true  },
    dedicatedIngestEnabled:      { type: Boolean, default: true },
    ihiIngestEnabled:           { type: Boolean, default: true },
    ihiSadhguruStatsEnabled:    { type: Boolean, default: true },

    // A channel with no qualifying post within this many days is archived for
    // inactivity by the daily channel sync (and reactivated once it posts again).
    inactivityThresholdDays: { type: Number, default: 14 },
  },
  { timestamps: true }
);

syncConfigSchema.statics.getSingleton = async function () {
  let config = await this.findOne({ _singletonKey: 'sync' });
  if (!config) {
    config = await this.create({ _singletonKey: 'sync' });
  }
  return config;
};

export default mongoose.model('SyncConfig', syncConfigSchema);
