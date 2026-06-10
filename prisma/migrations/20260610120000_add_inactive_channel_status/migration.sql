-- Add 'inactive' to ChannelStatus. Inactive = not posting recently but still
-- tracked and counted everywhere (views accrue on old videos regardless of
-- posting activity). 'archived' is reserved for soft-deleted channels.
-- NOTE: must stay in its own migration — Postgres cannot USE a new enum value
-- in the same transaction that adds it.
ALTER TYPE "ChannelStatus" ADD VALUE IF NOT EXISTS 'inactive';
