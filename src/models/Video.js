import mongoose from 'mongoose';

const videoSchema = new mongoose.Schema(
  {
    youtubeVideoId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    channelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Channel',
      required: true,
      index: true,
    },
    title: { type: String, default: '' },
    description: { type: String, default: '' },
    thumbnailUrl: { type: String, default: '' },
    publishedAt: { type: Date },
    views: { type: Number, default: 0 },
    likes: { type: Number, default: 0 },
    comments: { type: Number, default: 0 },
    duration: { type: String, default: '' },
    lastSyncedAt: { type: Date },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

videoSchema.index({ channelId: 1, publishedAt: -1 });
videoSchema.index({ views: -1 });

export default mongoose.model('Video', videoSchema);
