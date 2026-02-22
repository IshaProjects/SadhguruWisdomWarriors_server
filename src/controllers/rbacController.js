import RbacConfig from '../models/RbacConfig.js';

/**
 * Default RBAC seed – used when no config exists yet.
 * Admin always has access to everything by default.
 */
const DEFAULT_PAGES = [
  { key: 'dashboard',  label: 'Dashboard',    roles: { admin: true, manager: true, viewer: true  } },
  { key: 'channels',   label: 'Channels',     roles: { admin: true, manager: true, viewer: true  } },
  { key: 'reports',    label: 'Reports',      roles: { admin: true, manager: true, viewer: false } },
  { key: 'sync',       label: 'Sync Status',  roles: { admin: true, manager: true, viewer: false } },
  { key: 'settings',   label: 'Settings',     roles: { admin: true, manager: false,viewer: false } },
  { key: 'import',     label: 'Import',       roles: { admin: true, manager: true, viewer: false } },
  { key: 'ai-studio', label: 'AI Studio',    roles: { admin: true, manager: true, viewer: true  } },
];

const DEFAULT_ACTIONS = [
  { key: 'channels.add',        label: 'Add Channel',              roles: { admin: true, manager: true,  viewer: false } },
  { key: 'channels.edit',       label: 'Edit Channel',             roles: { admin: true, manager: true,  viewer: false } },
  { key: 'channels.delete',     label: 'Delete Channel',           roles: { admin: true, manager: false, viewer: false } },
  { key: 'channels.sync',       label: 'Sync Channel',             roles: { admin: true, manager: true,  viewer: false } },
  { key: 'channels.export',     label: 'Export Channels CSV',      roles: { admin: true, manager: true,  viewer: false } },
  { key: 'channels.import',     label: 'Import Channels CSV',      roles: { admin: true, manager: true,  viewer: false } },
  { key: 'team.invite',         label: 'Invite Team Member',       roles: { admin: true, manager: false, viewer: false } },
  { key: 'sync.triggerChannel', label: 'Trigger Channel Sync Now', roles: { admin: true, manager: true,  viewer: false } },
  { key: 'sync.triggerVideo',   label: 'Trigger Video Sync Now',   roles: { admin: true, manager: true,  viewer: false } },
  { key: 'sync.configure',      label: 'Configure Sync Schedule',  roles: { admin: true, manager: false, viewer: false } },
  { key: 'queue.add',           label: 'Add to Ingest Queue',      roles: { admin: true, manager: true,  viewer: false } },
  { key: 'queue.process',       label: 'Process Ingest Queue',     roles: { admin: true, manager: false, viewer: false } },
];

/**
 * GET  /api/rbac
 * Returns the current RBAC config. Creates a default one if none exists.
 */
export async function getRbacConfig(req, res, next) {
  try {
    let config = await RbacConfig.findOne({ _singletonKey: 'rbac' });

    if (!config) {
      config = await RbacConfig.create({
        _singletonKey: 'rbac',
        pages: DEFAULT_PAGES,
        actions: DEFAULT_ACTIONS,
      });
    } else {
      // Merge any new default keys that don't exist in the stored config yet
      const existingPageKeys   = new Set(config.pages.map((p) => p.key));
      const existingActionKeys = new Set(config.actions.map((a) => a.key));

      const missingPages   = DEFAULT_PAGES.filter((p) => !existingPageKeys.has(p.key));
      const missingActions = DEFAULT_ACTIONS.filter((a) => !existingActionKeys.has(a.key));

      if (missingPages.length || missingActions.length) {
        config = await RbacConfig.findOneAndUpdate(
          { _singletonKey: 'rbac' },
          {
            $push: {
              ...(missingPages.length   && { pages:   { $each: missingPages   } }),
              ...(missingActions.length && { actions: { $each: missingActions } }),
            },
          },
          { new: true }
        );
      }
    }

    res.json({ pages: config.pages, actions: config.actions, updatedAt: config.updatedAt });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT  /api/rbac
 * Accepts { pages, actions } and replaces the entire config.
 * Admin-only.
 */
export async function updateRbacConfig(req, res, next) {
  try {
    const { pages, actions } = req.body;

    if (!Array.isArray(pages) || !Array.isArray(actions)) {
      return res.status(400).json({ message: 'pages and actions arrays are required' });
    }

    // Validate structure
    for (const list of [pages, actions]) {
      for (const entry of list) {
        if (!entry.key || !entry.label || !entry.roles) {
          return res.status(400).json({ message: 'Each entry needs key, label, and roles' });
        }
      }
    }

    // Ensure admin always keeps full access (safety net)
    const ensureAdmin = (list) =>
      list.map((entry) => ({
        ...entry,
        roles: { ...entry.roles, admin: true },
      }));

    const config = await RbacConfig.findOneAndUpdate(
      { _singletonKey: 'rbac' },
      { pages: ensureAdmin(pages), actions: ensureAdmin(actions) },
      { new: true, upsert: true }
    );

    res.json({ pages: config.pages, actions: config.actions, updatedAt: config.updatedAt });
  } catch (err) {
    next(err);
  }
}
