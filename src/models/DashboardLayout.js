import mongoose from 'mongoose';

/**
 * Singleton document – there is only ever one layout record.
 * `layouts` stores the react-grid-layout responsive layout object,
 * e.g. { lg: [...], md: [...], sm: [...] }
 * `updatedBy` is the username of the last person who saved the layout.
 */
const dashboardLayoutSchema = new mongoose.Schema(
  {
    layouts: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    updatedBy: { type: String, default: '' },
  },
  { timestamps: true }
);

export default mongoose.model('DashboardLayout', dashboardLayoutSchema);
