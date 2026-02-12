import mongoose from 'mongoose';

/**
 * Single-document collection that holds the full RBAC matrix.
 * There is only ever one document (singleton), looked up by a fixed key.
 */

const permissionEntrySchema = new mongoose.Schema(
  {
    key: { type: String, required: true },       // e.g. "dashboard", "channels.edit"
    label: { type: String, required: true },      // e.g. "Dashboard", "Edit Channel"
    roles: {
      admin: { type: Boolean, default: true },
      manager: { type: Boolean, default: false },
      viewer: { type: Boolean, default: false },
    },
  },
  { _id: false }
);

const rbacConfigSchema = new mongoose.Schema(
  {
    // Fixed singleton key so we can upsert easily
    _singletonKey: { type: String, default: 'rbac', unique: true },

    pages: [permissionEntrySchema],
    actions: [permissionEntrySchema],
  },
  { timestamps: true }
);

export default mongoose.model('RbacConfig', rbacConfigSchema);
