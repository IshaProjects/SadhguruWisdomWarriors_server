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

    // 1. Daily aggregated trend across all videos in the channel.
    //    Mongo's $dateToString('%Y-%m-%d', $date) is replicated with
    //    to_char(date, 'YYYY-MM-DD') in Postgres.
    const dailyRows = await prisma.$queryRaw(Prisma.sql`
      SELECT
        to_char(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
        COALESCE(SUM(views), 0)::bigint    AS total_views,
        COALESCE(SUM(likes), 0)::bigint    AS total_likes,
        COALESCE(SUM(comments), 0)::bigint AS total_comments,
        COUNT(*)::bigint                   AS video_count
      FROM video_snapshots
      WHERE channel_id = ${channelId}
        AND date >= ${start}
        AND date <= ${end}
        AND deleted_at IS NULL
      GROUP BY 1
      ORDER BY 1 ASC
    `);

    const dailyTrend = dailyRows.map((r) => ({
      date: r.date,
      views: Number(r.total_views),
      likes: Number(r.total_likes),
      comments: Number(r.total_comments),
      videoCount: Number(r.video_count),
    }));

    // 2. Top videos by total views in the period, with raw data points to
    //    rebuild the trend client-side. Mongo's $first/$last on an unsorted
    //    $group is implementation-defined; here we compute first/last
    //    against the *date* ordering explicitly so the result is stable.
    const videoIdRows = await prisma.$queryRaw(Prisma.sql`
      SELECT
        video_id,
        COALESCE(SUM(views), 0)::bigint    AS total_views,
        COALESCE(SUM(likes), 0)::bigint    AS total_likes,
        COALESCE(SUM(comments), 0)::bigint AS total_comments
      FROM video_snapshots
      WHERE channel_id = ${channelId}
        AND date >= ${start}
        AND date <= ${end}
        AND deleted_at IS NULL
      GROUP BY video_id
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
      const firstViews = points.length ? Number(points[0].views) : 0;
      const lastViews  = points.length ? Number(points[points.length - 1].views) : 0;
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
