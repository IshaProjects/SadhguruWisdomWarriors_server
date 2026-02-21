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
      default: '0 4 * * *',   // 4 AM daily
    },
    channelSyncEnabled: { type: Boolean, default: true  },
    videoSyncEnabled:   { type: Boolean, default: true  },
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
