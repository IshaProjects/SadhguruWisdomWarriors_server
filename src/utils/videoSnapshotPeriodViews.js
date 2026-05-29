import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';

/**
 * Per-video view growth in [startDateObj, endDateObj], summed per channel.
 *
 * Opening:
 *   - If a snapshot exists with date < start: latest such snapshot's views.
 *   - Else if the video was tracked-from-fresh (first-ever snapshot landed
 *     within FRESH_TRACKING_GRACE_DAYS of publishedAt — i.e., we observed
 *     the video while its view count was still near 0): opening = 0.
 *   - Else: first-in-range snapshot views (we missed the early growth; treat
 *     the first observation as an opaque baseline).
 * Closing = latest snapshot with date <= end.
 *
 * Why this rule:
 *   The previous code keyed the opening=0 branch on
 *   `publishedAt ∈ [queryStart, queryEnd]`. That made the same video's
 *   opening depend on the query window. A video published Mar 15 with first
 *   snapshot Apr 1 was "new" for the Mar+Apr combined query (opening=0,
 *   delta = full Apr30 views) but not for the April-only query (opening =
 *   Apr1 baseline, delta = within-April growth only). Sum(monthly) therefore
 *   != combined for the same data: combined picked up the publish→first-
 *   snapshot views that the slices silently dropped.
 *
 *   Keying "new" on (first-snapshot - publishedAt) instead is a property of
 *   the video, not the query window, so opening is identical across queries.
 *   That gives the additive property: views(A) + views(B) = views(A ∪ B)
 *   for any non-overlapping A, B.
 *
 * Trade-off: a video that was published well before we started snapshotting
 * it will have its publish→first-snapshot views attributed to no period.
 * That's the unavoidable cost of not having pre-tracking data; we simply
 * cannot split those views across periods. Genuinely fresh content (caught
 * within the grace window) is unaffected.
 *
 * classificationKey: null = all videos; otherwise 'sadhguru' | 'non_sadhguru'.
 */
const FRESH_TRACKING_GRACE_DAYS = 2;

export async function getVideoSnapshotPeriodViewsByChannel(
  channelIds,
  startDateObj,
  endDateObj,
  classificationKey,
) {
  if (!channelIds?.length) return new Map();

  // Optional classification filter narrows the universe of videos. The
  // grace-day comparison runs against this same set so a freshly-tracked
  // video that doesn't match the classification is correctly excluded.
  const classificationValue =
    classificationKey === 'sadhguru'
      ? 'sadhguru'
      : classificationKey === 'non_sadhguru'
        ? 'non sadhguru'
        : null;

  // SQL strategy — one query, three CTEs:
  //
  // 1. `target_videos` — every live video in the channel set, optionally
  //    filtered by classification. Carries published_at for the grace calc.
  // 2. `per_video` — for each target video, compute four anchors via
  //    correlated subqueries on video_snapshots (each filtered to
  //    deleted_at IS NULL):
  //      • first_snap_date       : min(date) — used for the grace check.
  //      • opening_views         : latest pre-start snapshot, else NULL.
  //      • first_in_range_views  : earliest in-window snapshot, else NULL.
  //      • closing_views         : latest snapshot ≤ end, else NULL.
  // 3. `per_video_delta` — apply the opening rule (preStart >
  //    freshlyTracked=0 > firstInRange) then GREATEST(0, closing - opening).
  //    Videos with no live snapshot ≤ end are dropped here, which in turn
  //    drops a channel from the result if all its videos are dropped — the
  //    soft-deleted-snapshots test asserts that absence explicitly.
  const GRACE_MS = FRESH_TRACKING_GRACE_DAYS * 24 * 60 * 60 * 1000;

  const rows = await prisma.$queryRaw(Prisma.sql`
    WITH target_videos AS (
      SELECT v.id AS video_id, v.channel_id, v.published_at
      FROM videos v
      WHERE v.channel_id IN (${Prisma.join(channelIds)})
        AND v.deleted_at IS NULL
        ${
          classificationValue
            ? Prisma.sql`AND v.classification = ${classificationValue}`
            : Prisma.empty
        }
    ),
    per_video AS (
      SELECT
        tv.video_id,
        tv.channel_id,
        tv.published_at,
        (
          SELECT MIN(s.date) FROM video_snapshots s
          WHERE s.video_id = tv.video_id
            AND s.deleted_at IS NULL
        ) AS first_snap_date,
        (
          SELECT s.views FROM video_snapshots s
          WHERE s.video_id = tv.video_id
            AND s.deleted_at IS NULL
            AND s.date < ${startDateObj}
          ORDER BY s.date DESC
          LIMIT 1
        ) AS opening_views,
        (
          SELECT s.views FROM video_snapshots s
          WHERE s.video_id = tv.video_id
            AND s.deleted_at IS NULL
            AND s.date >= ${startDateObj}
            AND s.date <= ${endDateObj}
          ORDER BY s.date ASC
          LIMIT 1
        ) AS first_in_range_views,
        (
          SELECT s.views FROM video_snapshots s
          WHERE s.video_id = tv.video_id
            AND s.deleted_at IS NULL
            AND s.date <= ${endDateObj}
          ORDER BY s.date DESC
          LIMIT 1
        ) AS closing_views
      FROM target_videos tv
    ),
    per_video_delta AS (
      -- Only videos with at least one live snapshot ≤ end contribute a row
      -- here. This mirrors the Mongoose pipeline's $match (date ≤ end +
      -- deletedAt null) which drops a video entirely when no snapshot
      -- qualifies — and in turn drops a channel from the final result if
      -- ALL its videos are filtered out. The tests assert this (a channel
      -- with only soft-deleted snapshots is ABSENT from the returned map).
      SELECT
        channel_id,
        GREATEST(
          0::bigint,
          closing_views
          - CASE
              -- preStart wins outright.
              WHEN opening_views IS NOT NULL THEN opening_views
              -- Freshly tracked: first snapshot within grace of publishedAt → opening 0.
              WHEN published_at IS NOT NULL
                   AND first_snap_date IS NOT NULL
                   AND (EXTRACT(EPOCH FROM (first_snap_date - published_at)) * 1000) <= ${GRACE_MS}
                THEN 0::bigint
              -- Else: first in-range snapshot as opaque baseline.
              ELSE COALESCE(first_in_range_views, 0::bigint)
            END
        ) AS delta
      FROM per_video
      WHERE closing_views IS NOT NULL
    )
    SELECT channel_id, SUM(delta) AS total
    FROM per_video_delta
    GROUP BY channel_id
  `);

  const totals = new Map();
  for (const row of rows) {
    if (row.channel_id) totals.set(row.channel_id, Number(row.total));
  }
  return totals;
}
