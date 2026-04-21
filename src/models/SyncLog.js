import mongoose from 'mongoose';

const syncLogSchema = new mongoose.Schema({
  syncType: {
    type: String,
    enum: ['channel', 'video', 'dedicated_ingest', 'ihi_ingest', 'ihi_sadhguru_stats'],
    default: 'channel',
  },
  type: {
    type: String,
    enum: ['auto', 'manual'],
    required: true,
  },
  status: {
    type: String,
    enum: ['running', 'success', 'partial', 'failed'],
    default: 'running',
  },
  channelsProcessed: { type: Number, default: 0 },
  videosProcessed: { type: Number, default: 0 },
  quotaUsed: { type: Number, default: 0 },
  errors: [
    {
      channelId: String,
      message: String,
    },
  ],
  startedAt: { type: Date, default: Date.now },
  completedAt: { type: Date },
});

export default mongoose.model('SyncLog', syncLogSchema);
