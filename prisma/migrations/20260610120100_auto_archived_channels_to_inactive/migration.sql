-- Channels auto-archived for inactivity were wrongly excluded from syncs and
-- dashboards (their old videos keep earning views). Under the new model they
-- are 'inactive'. Deliberate deletes (softDeleteChannels) set
-- auto_archived_for_inactivity = false and deleted_at, so they are untouched.
UPDATE "channels"
SET status = 'inactive', auto_archived_for_inactivity = false
WHERE status = 'archived'
  AND auto_archived_for_inactivity = true
  AND deleted_at IS NULL;
