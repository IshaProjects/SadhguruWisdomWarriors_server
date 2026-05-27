import mongoose from 'mongoose';

const channelSchema = new mongoose.Schema(
  {
    youtubeChannelId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    title: { type: String, default: '' },
    description: { type: String, default: '' },
    thumbnailUrl: { type: String, default: '' },
    bannerUrl: { type: String, default: '' },
    customUrl: { type: String, default: '' },
    country: { type: String, default: '' },
    publishedAt: { type: Date },
    uploadsPlaylistId: { type: String, default: '' },

    // Internal metadata
    category: { type: String, default: 'Uncategorized', index: true },
    tags: [{ type: String }],
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    status: {
      type: String,
      enum: ['active', 'paused', 'archived'],
      default: 'active',
      index: true,
    },
    notes: { type: String, default: '' },

    // Current stats (updated on sync)
    currentStats: {
      subscribers: { type: Number, default: 0 },
      views: { type: Number, default: 0 },
      videoCount: { type: Number, default: 0 },
    },

    lastSyncedAt: { type: Date },
    allVideosPulled: { type: Boolean, default: false },

    // Set by the daily sync when a channel is archived for inactivity (no
    // qualifying posts in the inactivity window). Distinguishes an automatic
    // archive from a manual one so the sync can auto-reactivate it later.
    // Never surfaced or editable in the UI.
    autoArchivedForInactivity: { type: Boolean, default: false },

    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

channelSchema.index({ title: 'text', description: 'text' });
channelSchema.index({ 'currentStats.subscribers': -1 });
channelSchema.index({ 'currentStats.views': -1 });
channelSchema.index({ status: 1, autoArchivedForInactivity: 1 });

export default mongoose.model('Channel', channelSchema);
