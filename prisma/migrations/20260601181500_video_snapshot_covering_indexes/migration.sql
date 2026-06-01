-- Covering + partial indexes for the heavy dashboard aggregations over
-- video_snapshots. They turn the per-video opening/closing scan (DISTINCT ON)
-- and the per-channel date-range view-sum into INDEX-ONLY scans, cutting them
-- from ~4.3s / ~1.7s to ~525ms / ~70ms on the current dataset.
--
-- NOTE: Prisma's schema language cannot express INCLUDE or partial (WHERE)
-- indexes, so these live in raw SQL here and are intentionally NOT in
-- schema.prisma. Do not let `prisma migrate dev` drop them. On production they
-- were first created with CREATE INDEX CONCURRENTLY (non-locking); IF NOT
-- EXISTS makes this migration a no-op there and a plain create elsewhere.

CREATE INDEX IF NOT EXISTS "vs_vid_date_cover"
  ON "video_snapshots" ("video_id", "date" DESC) INCLUDE ("views", "likes", "comments")
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "vs_date_chan_cover"
  ON "video_snapshots" ("date") INCLUDE ("channel_id", "views")
  WHERE "deleted_at" IS NULL;
