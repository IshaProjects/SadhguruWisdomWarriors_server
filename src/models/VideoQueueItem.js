import mongoose from 'mongoose';

const videoQueueItemSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      required: true,
      trim: true,
    },
    title: {
      type: String,
      default: '',
    },
    videoType: {
      type: String,
      enum: ['viral', 'normal', 'event', 'educational', 'other'],
      default: 'normal',
    },
    eventName: {
      type: String,
      default: '',
      trim: true,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    priority: {
      type: String,
      enum: ['high', 'normal', 'low'],
      default: 'normal',
    },
    status: {
      type: String,
      enum: ['queued', 'processing', 'completed', 'failed'],
      default: 'queued',
      index: true,
    },
    errorMessage: {
      type: String,
      default: '',
    },
    addedBy: {
      type: String,
      default: '',
    },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

videoQueueItemSchema.index({ status: 1, createdAt: 1 });
videoQueueItemSchema.index({ priority: 1, status: 1, createdAt: 1 });

export default mongoose.model('VideoQueueItem', videoQueueItemSchema);
