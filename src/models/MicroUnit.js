import mongoose from 'mongoose';

const microUnitSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    channelIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Channel',
      },
    ],
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

microUnitSchema.index({ name: 'text' });

export default mongoose.model('MicroUnit', microUnitSchema);
