import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import {
  parseYmdToUtcEnd,
  parseYmdToUtcStart,
  utcDateString,
  utcEndOfDay,
  utcStartOfDay,
} from '../utils/dateUtc.js';

/**
 * GET /api/video-snapshots/video/:videoId
 * Returns daily snapshot history for a single video.
 * Query: startDate, endDate (YYYY-MM-DD, optional — defaults to last 90 days)
 */
export async function getVideoSnapshots(req, res, next) {
  try {
    const { videoId } = req.params;
    const { startDate, endDate } = req.query;

    const end = endDate ? parseYmdToUtcEnd(endDate) : utcEndOfDay();
    const start = startDate
      ? parseYmdToUtcStart(startDate)
      : utcStartOfDay(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const snapshots = await prisma.videoSnapshot.findMany({
      where: {
        videoId,
        date: { gte: start, lte: end },
        deletedAt: null,
      },
      orderBy: { date: 'asc' },
    });

    // BigInt views serialise as plain numbers (Mongo used plain Number) so
    // the wire shape matches the legacy JSON.
    res.json(snapshots.map(serialiseSnapshot));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/video-snapshots/channel/:channelId
 * Returns aggregated daily views/likes/comments for all videos in a channel.
 * Also returns per-video breakdown for the latest snapshot date.
 * Query: startDate, endDate (YYYY-MM-DD, optional — defaults to last 30 days)
 */
export async function getChannelVideoTrends(req, res, next) {
  try {
    const { channelId } = req.params;
    const { startDate, endDate } = req.query;

    const end = endDate ? parseYmdToUtcEnd(endDate) : utcEndOfDay();
    const start = startDate
      ? parseYmdToUtcStart(startDate)
      : utcStartOfDay(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // 1. Daily aggregated trend across all videos in the channel — CARRY-FORWARD.
    //    Each output day reports the channel's TOTAL cumulative views/likes/
    //    comments as of that day (sum over videos of each video's latest
    //    snapshot with date <= day), so the series is invariant to whether
    //    unchanged days are materialized (the only-on-change sync guard skips
    //    writing a row when a video's stats don't move). Implemented as a
    //    prefix-sum of per-snapshot increments (value - previous snapshot's
    //    value, which telescopes to the latest value per video): for each day d
    //    the total = SUM of all increments with date <= d. Increments are not
    //    lower-bounded by `start` so pre-window snapshots set the carried-in
    //    baseline. videoCount = videos whose first snapshot is <= d (i.e. live
    //    by that day). Output days are the distinct in-range snapshot days — on
    //    dense daily data that is every tracked day and this equals the old
    //    per-day SUM exactly; it differs only on unmaterialized days, where it
    //    correctly carries forward instead of dropping out.
    const dailyRows = await prisma.$queryRaw(Prisma.sql`
      WITH days AS (
        SELECT DISTINCT date AS d
        FROM video_snapshots
        WHERE channel_id = ${channelId}
          AND deleted_at IS NULL
          AND date >= ${start}
          AND date <= ${end}
      ),
      incs AS (
        SELECT
          date,
          views    - COALESCE(LAG(views)    OVER w, 0) AS inc_views,
          likes    - COALESCE(LAG(likes)    OVER w, 0) AS inc_likes,
          comments - COALESCE(LAG(comments) OVER w, 0) AS inc_comments,
          ROW_NUMBER() OVER w AS rn
        FROM video_snapshots
        WHERE channel_id = ${channelId}
          AND deleted_at IS NULL
          AND date <= ${end}
        WINDOW w AS (PARTITION BY video_id ORDER BY date)
      )
      SELECT
        to_char(days.d AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
        COALESCE((SELECT SUM(inc_views)    FROM incs WHERE incs.date <= days.d), 0)::bigint AS total_views,
        COALESCE((SELECT SUM(inc_likes)    FROM incs WHERE incs.date <= days.d), 0)::bigint AS total_likes,
        COALESCE((SELECT SUM(inc_comments) FROM incs WHERE incs.date <= days.d), 0)::bigint AS total_comments,
        (SELECT COUNT(*) FROM incs WHERE incs.date <= days.d AND incs.rn = 1)::bigint AS video_count
      FROM days
      ORDER BY days.d ASC
    `);

    const dailyTrend = dailyRows.map((r) => ({
      date: r.date,
      views: Number(r.total_views),
      likes: Number(r.total_likes),
      comments: Number(r.total_comments),
      videoCount: Number(r.video_count),
    }));

    // 2. Top videos by view count in the period. "Views (period)" = the
    //    video's actual view count at period end (carry-forward closing: latest
    //    snapshot with date <= end), NOT a sum across days — so the number is
    //    invariant to snapshot density and matches the column's meaning. Each
    //    row also carries the opening balance (latest snapshot <= start, else
    //    the first in-range snapshot) so viewsGrowth = closing - opening is
    //    stable. A video must have at least one in-range snapshot to appear
    //    (matches the previous membership rule); a video that is completely
    //    flat for the entire window therefore won't list — it has zero growth.
    const videoIdRows = await prisma.$queryRaw(Prisma.sql`
      SELECT
        tv.id AS video_id,
        COALESCE((
          SELECT s.views FROM video_snapshots s
          WHERE s.video_id = tv.id AND s.deleted_at IS NULL AND s.date <= ${end}
          ORDER BY s.date DESC LIMIT 1
        ), 0)::bigint AS total_views,
        COALESCE((
          SELECT s.likes FROM video_snapshots s
          WHERE s.video_id = tv.id AND s.deleted_at IS NULL AND s.date <= ${end}
          ORDER BY s.date DESC LIMIT 1
        ), 0)::bigint AS total_likes,
        COALESCE((
          SELECT s.comments FROM video_snapshots s
          WHERE s.video_id = tv.id AND s.deleted_at IS NULL AND s.date <= ${end}
          ORDER BY s.date DESC LIMIT 1
        ), 0)::bigint AS total_comments,
        COALESCE(
          (
            SELECT s.views FROM video_snapshots s
            WHERE s.video_id = tv.id AND s.deleted_at IS NULL AND s.date <= ${start}
            ORDER BY s.date DESC LIMIT 1
          ),
          (
            SELECT s.views FROM video_snapshots s
            WHERE s.video_id = tv.id AND s.deleted_at IS NULL
              AND s.date >= ${start} AND s.date <= ${end}
            ORDER BY s.date ASC LIMIT 1
          ),
          0
        )::bigint AS opening_views
      FROM videos tv
      WHERE tv.channel_id = ${channelId}
        AND EXISTS (
          SELECT 1 FROM video_snapshots s
          WHERE s.video_id = tv.id AND s.deleted_at IS NULL
            AND s.date >= ${start} AND s.date <= ${end}
        )
      ORDER BY total_views DESC
      LIMIT 10
    `);

    const topVideoIds = videoIdRows.map((r) => r.video_id);

    // Empty-fast-path: nothing in range.
    if (topVideoIds.length === 0) {
      return res.json({ dailyTrend, topVideos: [] });
    }

    // Pull all snapshots for the top videos (so dataPoints can be ordered &
    // first/last views computed in JS — mirrors $push of an unordered array
    // that the legacy code then sorted in JS).
    const snapshotRows = await prisma.videoSnapshot.findMany({
      where: {
        videoId: { in: topVideoIds },
        date: { gte: start, lte: end },
        deletedAt: null,
      },
      orderBy: { date: 'asc' },
      select: { videoId: true, date: true, views: true, likes: true, comments: true },
    });

    const byVideo = new Map();
    for (const id of topVideoIds) byVideo.set(id, []);
    for (const s of snapshotRows) {
      byVideo.get(s.videoId)?.push(s);
    }

    // Video metadata (soft-deleted videos surface as null per the original).
    const videos = await prisma.video.findMany({
      where: { id: { in: topVideoIds }, deletedAt: null },
      select: { id: true, title: true, thumbnailUrl: true, youtubeVideoId: true, publishedAt: true },
    });
    const videoMap = new Map(videos.map((v) => [v.id, { ...v, _id: v.id }]));

    const enriched = videoIdRows.map((r) => {
      const points = byVideo.get(r.video_id) || [];
      // firstViews/lastViews are the carry-forward opening/closing balances
      // computed in SQL (not derived from the in-range points, which may be
      // sparse under the only-on-change guard). totalViews IS the closing
      // balance, so lastViews === totalViews.
      const firstViews = Number(r.opening_views);
      const lastViews  = Number(r.total_views);
      return {
        _id: r.video_id,
        totalViews: Number(r.total_views),
        totalLikes: Number(r.total_likes),
        totalComments: Number(r.total_comments),
        firstViews,
        lastViews,
        video: videoMap.get(r.video_id) || null,
        viewsGrowth: lastViews - firstViews,
        dataPoints: points.map((d) => ({
          date: utcDateString(d.date),
          views: Number(d.views),
          likes: d.likes,
          comments: d.comments,
        })),
      };
    });

    res.json({ dailyTrend, topVideos: enriched });
  } catch (err) {
    next(err);
  }
}

/** Convert BigInt fields on a snapshot to plain numbers for JSON. */
function serialiseSnapshot(s) {
  return {
    ...s,
    _id: s.id,
    views: typeof s.views === 'bigint' ? Number(s.views) : s.views,
  };
}
