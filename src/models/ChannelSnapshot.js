import mongoose from 'mongoose';

const channelSnapshotSchema = new mongoose.Schema(
  {
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
    subscribers: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
    videoCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

channelSnapshotSchema.index({ channelId: 1, date: -1 });

export default mongoose.model('ChannelSnapshot', channelSnapshotSchema);
