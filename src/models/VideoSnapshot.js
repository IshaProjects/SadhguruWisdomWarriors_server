import mongoose from 'mongoose';

const videoSnapshotSchema = new mongoose.Schema(
  {
    videoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Video',
      required: true,
      index: true,
    },
    channelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Channel',
      required: true,
      index: true,
    },
    date: {
      type: Date,
      required: true,
      index: true,
    },
    views:    { type: Number, default: 0 },
    likes:    { type: Number, default: 0 },
    comments: { type: Number, default: 0 },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

// One snapshot per video per day
videoSnapshotSchema.index({ videoId: 1, date: 1 }, { unique: true });
// Efficient queries for all videos in a channel on a date range
videoSnapshotSchema.index({ channelId: 1, date: -1 });

export default mongoose.model('VideoSnapshot', videoSnapshotSchema);
