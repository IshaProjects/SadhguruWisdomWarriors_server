import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import {
  parseYmdToUtcEnd,
  parseYmdToUtcStart,
  utcEndOfDay,
  utcStartOfDay,
} from '../utils/dateUtc.js';
import { aggregateChannelOpeningAndClosingMaps } from '../utils/channelSnapshotPeriod.js';
import { getVideoSnapshotPeriodViewsByChannel } from '../utils/videoSnapshotPeriodViews.js';

/**
 * Returns { start, end } for filtering. Uses startDate/endDate query params if both
 * provided (ISO date strings YYYY-MM-DD), otherwise uses period (7d, 30d, 90d).
 */
function getDateRange(period, query = {}) {
  if (query.startDate && query.endDate) {
    const start = parseYmdToUtcStart(query.startDate);
    const end = parseYmdToUtcEnd(query.endDate);
    if (start > end) return getDateRange(period, {}); // fallback if invalid
    return { start, end };
  }

  const end = utcEndOfDay();
  const start = new Date(end);
  switch (period) {
    case '7d':
      start.setUTCDate(start.getUTCDate() - 7);
      break;
    case '30d':
      start.setUTCDate(start.getUTCDate() - 30);
      break;
    case '90d':
      start.setUTCDate(start.getUTCDate() - 90);
      break;
    default:
      start.setUTCDate(start.getUTCDate() - 30);
  }
  return { start: utcStartOfDay(start), end };
}

/**
 * Build the Prisma `where` filter that mirrors the legacy Mongo buildChannelFilter.
 * - status defaults to "not archived" unless explicitly overridden.
 * - group=dedicated → category startsWith "Dedicated" (case-insensitive).
 * - group=ihi      → category contains "IHI"        (case-insensitive).
 * - tags=csv,list  → tags has-some of the parsed list.
 * - startDate/endDate (only when wanted) → lastSyncedAt window.
 */
function buildChannelFilter(query) {
  const where = {};
  if (query.status) {
    where.status = query.status;
  } else {
    where.status = { not: 'archived' };
  }
  if (query.assignedTo) where.assignedToId = query.assignedTo;
  if (query.tags && query.tags.trim()) {
    const tagList = query.tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (tagList.length) where.tags = { hasSome: tagList };
  }
  if (query.group === 'dedicated') {
    where.category = { startsWith: 'Dedicated', mode: 'insensitive' };
  } else if (query.group === 'ihi') {
    where.category = { contains: 'IHI', mode: 'insensitive' };
  } else if (query.category) {
    where.category = query.category;
  }
  if (query.startDate || query.endDate) {
    where.lastSyncedAt = {};
    if (query.startDate) where.lastSyncedAt.gte = parseYmdToUtcStart(query.startDate);
    if (query.endDate) where.lastSyncedAt.lte = parseYmdToUtcEnd(query.endDate);
  }
  // Soft-delete safety on every read path.
  where.deletedAt = null;
  return where;
}

/** Convert a BigInt-or-number to a JS Number (we never sum > 2^53 in these APIs). */
function n(v) {
  if (v == null) return 0;
  if (typeof v === 'bigint') return Number(v);
  return v;
}

export async function getSummary(req, res, next) {
  try {
    const channelFilter = buildChannelFilter(req.query);
    const channels = await prisma.channel.findMany({ where: channelFilter });
    const channelIds = channels.map((c) => c.id);
    const group = req.query.group;

    const totalChannels = channels.length;
    const totalSubscribers = channels.reduce(
      (sum, c) => sum + (c.currentSubscribers || 0),
      0,
    );

    // Dedicated/default: totalViews = sum of channel views.
    // IHI: totalViews = sum of sadhguru video views.
    let totalViews;
    if (group === 'ihi') {
      if (channelIds.length === 0) {
        totalViews = 0;
      } else {
        const ihiAgg = await prisma.video.aggregate({
          where: {
            channelId: { in: channelIds },
            classification: 'sadhguru',
            deletedAt: null,
          },
          _sum: { views: true },
        });
        totalViews = n(ihiAgg._sum.views);
      }
    } else {
      totalViews = channels.reduce((sum, c) => sum + n(c.currentViews), 0);
    }

    // Period comparison ----------------------------------------------------
    const { period = '30d' } = req.query;
    const { start, end } = getDateRange(period, req.query);

    let prevSubscribers = 0;
    let prevViews = 0;

    if (group === 'ihi') {
      if (channelIds.length > 0) {
        // Subscribers: first channel snapshot per channel in [start, end].
        const oldChannelSnapshots = await prisma.$queryRaw(Prisma.sql`
          SELECT DISTINCT ON (channel_id) channel_id, subscribers
          FROM channel_snapshots
          WHERE channel_id IN (${Prisma.join(channelIds)})
            AND deleted_at IS NULL
            AND date >= ${start}
            AND date <= ${end}
          ORDER BY channel_id, date ASC
        `);
        prevSubscribers = oldChannelSnapshots.reduce(
          (s, r) => s + (r.subscribers || 0),
          0,
        );

        // Views: per-video first VideoSnapshot in [start, end], summed.
        const sadhguruVideos = await prisma.video.findMany({
          where: {
            channelId: { in: channelIds },
            classification: 'sadhguru',
            deletedAt: null,
          },
          select: { id: true },
        });
        const sadhguruVideoIds = sadhguruVideos.map((v) => v.id);
        if (sadhguruVideoIds.length > 0) {
          const ihiPrev = await prisma.$queryRaw(Prisma.sql`
            SELECT COALESCE(SUM(first_views), 0)::bigint AS total
            FROM (
              SELECT DISTINCT ON (video_id) video_id, views AS first_views
              FROM video_snapshots
              WHERE video_id IN (${Prisma.join(sadhguruVideoIds)})
                AND deleted_at IS NULL
                AND date >= ${start}
                AND date <= ${end}
              ORDER BY video_id, date ASC
            ) firsts
          `);
          prevViews = n(ihiPrev[0]?.total);
        }
      }
    } else if (channelIds.length > 0) {
      // Default group: per-channel first snapshot in [start, end].
      const oldSnapshots = await prisma.$queryRaw(Prisma.sql`
        SELECT DISTINCT ON (channel_id)
               channel_id, subscribers, views
        FROM channel_snapshots
        WHERE channel_id IN (${Prisma.join(channelIds)})
          AND deleted_at IS NULL
          AND date >= ${start}
          AND date <= ${end}
        ORDER BY channel_id, date ASC
      `);
      prevSubscribers = oldSnapshots.reduce(
        (sum, s) => sum + (s.subscribers || 0),
        0,
      );
      prevViews = oldSnapshots.reduce((sum, s) => sum + n(s.views), 0);
    }

    const subsChange = prevSubscribers
      ? ((totalSubscribers - prevSubscribers) / prevSubscribers) * 100
      : 0;
    const viewsChange = prevViews
      ? ((totalViews - prevViews) / prevViews) * 100
      : 0;

    // Videos published this period -----------------------------------------
    let videosThisPeriod = 0;
    if (channelIds.length > 0) {
      const videosWhere = {
        channelId: { in: channelIds },
        publishedAt: { gte: start, lte: end },
      };
      if (group === 'ihi') videosWhere.classification = 'sadhguru';
      videosThisPeriod = await prisma.video.count({ where: videosWhere });
    }

    // Average engagement rate (from recent videos) -------------------------
    let avgEngagement = 0;
    if (channelIds.length > 0) {
      const recentWhere = {
        channelId: { in: channelIds },
        publishedAt: { gte: start, lte: end },
        views: { gt: 0 },
        deletedAt: null,
      };
      if (group === 'ihi') recentWhere.classification = 'sadhguru';
      const recentVideos = await prisma.video.findMany({
        where: recentWhere,
        select: { views: true, likes: true, comments: true },
      });
      if (recentVideos.length > 0) {
        const totalEngagement = recentVideos.reduce((sum, v) => {
          const views = n(v.views);
          return sum + ((v.likes + v.comments) / views) * 100;
        }, 0);
        avgEngagement = totalEngagement / recentVideos.length;
      }
    }

    res.json({
      totalChannels,
      totalSubscribers,
      totalViews,
      subsChange: Math.round(subsChange * 100) / 100,
      viewsChange: Math.round(viewsChange * 100) / 100,
      videosThisPeriod,
      avgEngagement: Math.round(avgEngagement * 100) / 100,
    });
  } catch (err) {
    next(err);
  }
}

export async function getGrowthData(req, res, next) {
  try {
    const { period = '30d' } = req.query;
    const channelFilter = buildChannelFilter(req.query);
    const channels = await prisma.channel.findMany({
      where: channelFilter,
      select: { id: true },
    });
    const channelIds = channels.map((c) => c.id);
    const group = req.query.group;

    const { start, end } = getDateRange(period, req.query);

    let snapshots;
    if (channelIds.length === 0) {
      return res.json([]);
    }

    if (group === 'ihi') {
      // IHI: daily views from VideoSnapshot for sadhguru videos.
      const sadhguruVideos = await prisma.video.findMany({
        where: {
          channelId: { in: channelIds },
          classification: 'sadhguru',
          deletedAt: null,
        },
        select: { id: true },
      });
      const sadhguruVideoIds = sadhguruVideos.map((v) => v.id);

      const ihiSnapshots = sadhguruVideoIds.length
        ? await prisma.$queryRaw(Prisma.sql`
            SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                   COALESCE(SUM(views), 0)::bigint AS total_views
            FROM video_snapshots
            WHERE video_id IN (${Prisma.join(sadhguruVideoIds)})
              AND deleted_at IS NULL
              AND date >= ${start}
              AND date <= ${end}
            GROUP BY day
            ORDER BY day ASC
          `)
        : [];

      const channelSnapshots = await prisma.$queryRaw(Prisma.sql`
        SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
               COALESCE(SUM(subscribers), 0)::bigint AS total_subscribers,
               COALESCE(SUM(video_count), 0)::bigint AS total_videos
        FROM channel_snapshots
        WHERE channel_id IN (${Prisma.join(channelIds)})
          AND deleted_at IS NULL
          AND date >= ${start}
          AND date <= ${end}
        GROUP BY day
        ORDER BY day ASC
      `);

      const ihiMap = new Map(ihiSnapshots.map((s) => [s.day, n(s.total_views)]));
      snapshots = channelSnapshots.map((s) => ({
        _id: s.day,
        totalSubscribers: n(s.total_subscribers),
        totalViews: ihiMap.get(s.day) ?? 0,
        totalVideos: n(s.total_videos),
      }));
    } else {
      const rows = await prisma.$queryRaw(Prisma.sql`
        SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
               COALESCE(SUM(subscribers), 0)::bigint AS total_subscribers,
               COALESCE(SUM(views), 0)::bigint AS total_views,
               COALESCE(SUM(video_count), 0)::bigint AS total_videos
        FROM channel_snapshots
        WHERE channel_id IN (${Prisma.join(channelIds)})
          AND deleted_at IS NULL
          AND date >= ${start}
          AND date <= ${end}
        GROUP BY day
        ORDER BY day ASC
      `);
      snapshots = rows.map((s) => ({
        _id: s.day,
        totalSubscribers: n(s.total_subscribers),
        totalViews: n(s.total_views),
        totalVideos: n(s.total_videos),
      }));
    }

    res.json(
      snapshots.map((s) => ({
        date: s._id,
        subscribers: s.totalSubscribers,
        views: s.totalViews,
        videoCount: s.totalVideos,
      })),
    );
  } catch (err) {
    next(err);
  }
}

export async function getTopChannels(req, res, next) {
  try {
    const { period = '30d', metric = 'subscribers', limit = 10 } = req.query;
    const channelFilter = buildChannelFilter(req.query);
    const channels = await prisma.channel.findMany({ where: channelFilter });
    const channelIds = channels.map((c) => c.id);

    const { start, end } = getDateRange(period, req.query);

    let growthData = [];
    if (channelIds.length > 0) {
      // For each channel, get first and last snapshot (subs + views) in the window.
      const firsts = await prisma.$queryRaw(Prisma.sql`
        SELECT DISTINCT ON (channel_id)
               channel_id, subscribers, views
        FROM channel_snapshots
        WHERE channel_id IN (${Prisma.join(channelIds)})
          AND deleted_at IS NULL
          AND date >= ${start}
          AND date <= ${end}
        ORDER BY channel_id, date ASC
      `);
      const lasts = await prisma.$queryRaw(Prisma.sql`
        SELECT DISTINCT ON (channel_id)
               channel_id, subscribers, views
        FROM channel_snapshots
        WHERE channel_id IN (${Prisma.join(channelIds)})
          AND deleted_at IS NULL
          AND date >= ${start}
          AND date <= ${end}
        ORDER BY channel_id, date DESC
      `);
      const lastMap = new Map(lasts.map((r) => [r.channel_id, r]));

      growthData = firsts.map((f) => {
        const l = lastMap.get(f.channel_id) || f;
        const firstSubs = f.subscribers ?? 0;
        const lastSubs = l.subscribers ?? 0;
        const firstViews = n(f.views);
        const lastViews = n(l.views);
        return {
          _id: f.channel_id,
          firstSubs,
          lastSubs,
          firstViews,
          lastViews,
          subsGrowth: lastSubs - firstSubs,
          viewsGrowth: lastViews - firstViews,
        };
      });
      const sortKey = metric === 'views' ? 'viewsGrowth' : 'subsGrowth';
      growthData.sort((a, b) => b[sortKey] - a[sortKey]);
      growthData = growthData.slice(0, parseInt(limit));
    }

    const channelMap = new Map(channels.map((c) => [c.id, c]));

    const result = growthData.map((g) => {
      const ch = channelMap.get(g._id);
      return {
        channelId: g._id,
        title: ch?.title || 'Unknown',
        thumbnailUrl: ch?.thumbnailUrl || '',
        subsGrowth: g.subsGrowth,
        viewsGrowth: g.viewsGrowth,
        currentSubs: g.lastSubs,
        currentViews: g.lastViews,
      };
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getTopVideos(req, res, next) {
  try {
    const { period = '30d', limit = 10 } = req.query;
    const channelFilter = buildChannelFilter(req.query);
    const channels = await prisma.channel.findMany({
      where: channelFilter,
      select: { id: true, title: true },
    });
    const channelIds = channels.map((c) => c.id);
    const group = req.query.group;

    const { start, end } = getDateRange(period, req.query);

    if (channelIds.length === 0) return res.json([]);

    const videosWhere = {
      channelId: { in: channelIds },
      publishedAt: { gte: start, lte: end },
      deletedAt: null,
    };
    if (group === 'ihi') videosWhere.classification = 'sadhguru';
    const videos = await prisma.video.findMany({
      where: videosWhere,
      orderBy: { views: 'desc' },
      take: parseInt(limit),
      include: { channel: { select: { id: true, title: true, thumbnailUrl: true } } },
    });

    // Mirror the legacy Mongoose response shape: `channelId` is a populated
    // object with `{ _id?, title, thumbnailUrl }` (callers read .title).
    const shaped = videos.map((v) => ({
      ...v,
      // BigInt → Number for the JSON layer.
      views: n(v.views),
      channelId: v.channel
        ? { _id: v.channel.id, title: v.channel.title, thumbnailUrl: v.channel.thumbnailUrl }
        : null,
      channel: undefined,
    }));

    res.json(shaped);
  } catch (err) {
    next(err);
  }
}

export async function getCategoryBreakdown(req, res, next) {
  try {
    const { startDate, endDate, classification } = req.query;
    const isPeriodMode = !!(startDate && endDate);

    const channelFilter = buildChannelFilter(req.query);
    if (isPeriodMode) {
      delete channelFilter.lastSyncedAt;
    }
    if (classification === 'sadhguru' || classification === 'non_sadhguru') {
      const cls = classification === 'sadhguru' ? 'sadhguru' : 'non sadhguru';
      const idRows = await prisma.video.findMany({
        where: { classification: cls, deletedAt: null },
        select: { channelId: true },
        distinct: ['channelId'],
      });
      const ids = idRows.map((r) => r.channelId);
      channelFilter.id = { in: ids };
    }

    const channels = await prisma.channel.findMany({
      where: channelFilter,
      select: { id: true, category: true },
    });

    if (channels.length === 0) {
      return res.json([]);
    }

    const channelIds = channels.map((c) => c.id);

    if (isPeriodMode) {
      const startDateObj = parseYmdToUtcStart(startDate);
      const endDateObj = parseYmdToUtcEnd(endDate);
      let classificationKey = null;
      if (classification === 'sadhguru') classificationKey = 'sadhguru';
      else if (classification === 'non_sadhguru') classificationKey = 'non_sadhguru';

      const [{ openingMap, closingMap }, periodViewsByChannel] = await Promise.all([
        aggregateChannelOpeningAndClosingMaps(channelIds, startDateObj, endDateObj),
        getVideoSnapshotPeriodViewsByChannel(channelIds, startDateObj, endDateObj, classificationKey),
      ]);

      const channelPeriodData = channels.map((c) => {
        const sid = c.id;
        const opening = openingMap.get(sid);
        const closing = closingMap.get(sid) || opening;
        if (!closing || !opening) {
          return {
            category: c.category || 'Uncategorized',
            viewsInPeriod: 0,
            subsInPeriod: 0,
          };
        }
        return {
          category: c.category || 'Uncategorized',
          viewsInPeriod: periodViewsByChannel.get(sid) ?? 0,
          subsInPeriod: (closing.subscribers ?? 0) - (opening.subscribers ?? 0),
        };
      });

      const byCategory = new Map();
      for (const d of channelPeriodData) {
        const cat = d.category;
        if (!byCategory.has(cat)) {
          byCategory.set(cat, { count: 0, totalViews: 0, totalSubs: 0 });
        }
        const acc = byCategory.get(cat);
        acc.count += 1;
        acc.totalViews += d.viewsInPeriod;
        acc.totalSubs += d.subsInPeriod;
      }

      const result = Array.from(byCategory.entries())
        .map(([category, v]) => ({ category, ...v }))
        .sort((a, b) => b.totalViews - a.totalViews);

      return res.json(result);
    }

    // Current-mode: groupBy(category) on the already-filtered channel set.
    // Aggregating in JS keeps the channelFilter semantics intact (groupBy
    // would need to repeat them server-side) and avoids the BigInt sum hop.
    const byCategory = new Map();
    // Pull currentStats in a second query so we don't bloat the channels payload above.
    const fullChannels = await prisma.channel.findMany({
      where: channelFilter,
      select: { id: true, category: true, currentSubscribers: true, currentViews: true },
    });
    for (const c of fullChannels) {
      const cat = c.category || 'Uncategorized';
      if (!byCategory.has(cat)) {
        byCategory.set(cat, { count: 0, totalSubs: 0, totalViews: 0 });
      }
      const acc = byCategory.get(cat);
      acc.count += 1;
      acc.totalSubs += c.currentSubscribers || 0;
      acc.totalViews += n(c.currentViews);
    }

    const result = Array.from(byCategory.entries())
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.totalViews - a.totalViews);

    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/dashboard/micro-units-report
 * Returns aggregated stats per micro unit (same structure as category report).
 * Supports startDate/endDate for period views.
 */
export async function getMicroUnitsReport(req, res, next) {
  try {
    const { startDate, endDate, classification } = req.query;
    const isPeriodMode = !!(startDate && endDate);

    const channelFilter = buildChannelFilter(req.query);
    if (isPeriodMode) {
      delete channelFilter.lastSyncedAt;
    }
    let channelIdsWithClassification = null;
    if (classification === 'sadhguru' || classification === 'non_sadhguru') {
      const cls = classification === 'sadhguru' ? 'sadhguru' : 'non sadhguru';
      const idRows = await prisma.video.findMany({
        where: { classification: cls, deletedAt: null },
        select: { channelId: true },
        distinct: ['channelId'],
      });
      channelIdsWithClassification = new Set(idRows.map((r) => r.channelId));
    }

    const microUnits = await prisma.microUnit.findMany({
      include: { microUnitChannels: { select: { channelId: true } } },
    });

    if (microUnits.length === 0) {
      return res.json([]);
    }

    const result = [];

    for (const unit of microUnits) {
      let rawIds = (unit.microUnitChannels || []).map((mu) => mu.channelId).filter(Boolean);

      if (channelIdsWithClassification) {
        rawIds = rawIds.filter((id) => channelIdsWithClassification.has(id));
      }

      if (rawIds.length === 0) {
        result.push({
          name: unit.name,
          count: 0,
          totalSubs: 0,
          totalViews: 0,
          totalVideos: 0,
        });
        continue;
      }

      const channels = await prisma.channel.findMany({
        where: { id: { in: rawIds }, ...channelFilter },
        select: { id: true, currentSubscribers: true, currentViews: true, currentVideoCount: true },
      });
      const channelIds = channels.map((c) => c.id);

      if (channelIds.length === 0) {
        result.push({
          name: unit.name,
          count: 0,
          totalSubs: 0,
          totalViews: 0,
          totalVideos: 0,
        });
        continue;
      }

      if (isPeriodMode) {
        const startDateObj = parseYmdToUtcStart(startDate);
        const endDateObj = parseYmdToUtcEnd(endDate);
        let classificationKey = null;
        if (classification === 'sadhguru') classificationKey = 'sadhguru';
        else if (classification === 'non_sadhguru') classificationKey = 'non_sadhguru';

        const [{ openingMap, closingMap }, periodViewsByChannel] = await Promise.all([
          aggregateChannelOpeningAndClosingMaps(channelIds, startDateObj, endDateObj),
          getVideoSnapshotPeriodViewsByChannel(channelIds, startDateObj, endDateObj, classificationKey),
        ]);

        let totalViews = 0;
        let totalSubs = 0;
        for (const cid of channelIds) {
          const sid = cid;
          const opening = openingMap.get(sid);
          const closing = closingMap.get(sid) || opening;
          if (!closing || !opening) continue;
          totalViews += periodViewsByChannel.get(sid) ?? 0;
          totalSubs += (closing.subscribers ?? 0) - (opening.subscribers ?? 0);
        }

        const videoWhere = {
          channelId: { in: channelIds },
          deletedAt: null,
          publishedAt: { gte: startDateObj, lte: endDateObj },
        };
        if (classification === 'sadhguru') videoWhere.classification = 'sadhguru';
        else if (classification === 'non_sadhguru') videoWhere.classification = 'non sadhguru';

        const totalVideos = await prisma.video.count({ where: videoWhere });

        result.push({
          name: unit.name,
          count: channelIds.length,
          totalSubs,
          totalViews,
          totalVideos,
        });
      } else {
        const totalSubs = channels.reduce((s, c) => s + (c.currentSubscribers || 0), 0);
        const totalViews = channels.reduce((s, c) => s + n(c.currentViews), 0);
        const totalVideos = channels.reduce((s, c) => s + (c.currentVideoCount || 0), 0);

        result.push({
          name: unit.name,
          count: channels.length,
          totalSubs,
          totalViews,
          totalVideos,
        });
      }
    }

    result.sort((a, b) => b.totalViews - a.totalViews);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/dashboard/channel-metrics
 * Returns per-channel computed metrics:
 *   - engagementEfficiency : (likes + comments) / views  (from synced videos)
 *   - subscriberVelocity   : (currentSubs - subs7dAgo)  / subs7dAgo  (%)
 *   - contentImpact        : lifetime views / videoCount (from channel doc)
 *   - loyaltyIndex         : comments / views  (from synced videos)
 * Supports same filters as the rest of the dashboard.
 */
export async function getChannelMetrics(req, res, next) {
  try {
    const channelFilter = buildChannelFilter(req.query);
    const channels = await prisma.channel.findMany({
      where: channelFilter,
      select: {
        id: true,
        title: true,
        thumbnailUrl: true,
        category: true,
        currentSubscribers: true,
        currentViews: true,
        currentVideoCount: true,
      },
    });

    if (channels.length === 0) return res.json([]);

    const channelIds = channels.map((c) => c.id);

    // --- 1. Video aggregation: engagementEfficiency + loyaltyIndex ---
    const videoAgg = await prisma.video.groupBy({
      by: ['channelId'],
      where: { channelId: { in: channelIds } },
      _sum: { views: true, likes: true, comments: true },
    });
    const videoMap = new Map(
      videoAgg.map((v) => [
        v.channelId,
        {
          totalViews: n(v._sum.views),
          totalLikes: v._sum.likes ?? 0,
          totalComments: v._sum.comments ?? 0,
        },
      ]),
    );

    // --- 2. ChannelSnapshot: subscriber velocity (7-day lookback) ---
    const sevenDaysAgo = utcStartOfDay(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Latest snapshot per channel on or before 7 days ago.
    const snapRows = await prisma.$queryRaw(Prisma.sql`
      SELECT DISTINCT ON (channel_id) channel_id, subscribers
      FROM channel_snapshots
      WHERE channel_id IN (${Prisma.join(channelIds)})
        AND deleted_at IS NULL
        AND date <= ${sevenDaysAgo}
      ORDER BY channel_id, date DESC
    `);
    const snapMap = new Map(snapRows.map((s) => [s.channel_id, s.subscribers]));

    const result = channels.map((ch) => {
      const vid = videoMap.get(ch.id);
      const subs7dAgo = snapMap.get(ch.id) ?? null;
      const currentSubs = ch.currentSubscribers ?? 0;
      const currentViews = n(ch.currentViews);
      const videoCount = ch.currentVideoCount ?? 0;

      const totalViews = vid?.totalViews ?? 0;
      const totalLikes = vid?.totalLikes ?? 0;
      const totalComments = vid?.totalComments ?? 0;

      const engagementEfficiency =
        totalViews > 0 ? (totalLikes + totalComments) / totalViews : null;

      const subscriberVelocity =
        subs7dAgo != null && subs7dAgo > 0
          ? ((currentSubs - subs7dAgo) / subs7dAgo) * 100
          : null;

      const contentImpact = videoCount > 0 ? currentViews / videoCount : null;
      const loyaltyIndex = totalViews > 0 ? totalComments / totalViews : null;

      return {
        channelId: ch.id,
        title: ch.title,
        thumbnailUrl: ch.thumbnailUrl,
        category: ch.category,
        subscribers: currentSubs,
        engagementEfficiency,
        subscriberVelocity,
        contentImpact,
        loyaltyIndex,
      };
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getPublishingFrequency(req, res, next) {
  try {
    const { period = '30d' } = req.query;
    const channelFilter = buildChannelFilter(req.query);
    const channels = await prisma.channel.findMany({
      where: channelFilter,
      select: { id: true },
    });
    const channelIds = channels.map((c) => c.id);

    const { start, end } = getDateRange(period, req.query);

    if (channelIds.length === 0) return res.json([]);

    const rows = await prisma.$queryRaw(Prisma.sql`
      SELECT TO_CHAR(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
             COUNT(*)::bigint AS count
      FROM videos
      WHERE channel_id IN (${Prisma.join(channelIds)})
        AND published_at >= ${start}
        AND published_at <= ${end}
      GROUP BY day
      ORDER BY day ASC
    `);

    res.json(rows.map((d) => ({ date: d.day, count: n(d.count) })));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/dashboard/grade-grid
 * Returns counts and (optionally) views growth + top-10 channels per grade
 * bucket (A, B, C, D, E, Inactive), scoped by group (ihi | dedicated | both).
 *
 * Spec: docs/superpowers/specs/2026-05-06-grade-grid-dashboard-design.md
 */
export async function getGradeGrid(req, res, next) {
  try {
    const { group = '', startDate, endDate } = req.query;

    // ---- 1. Resolve channel set scoped by group ----
    const channelFilter = { status: { not: 'archived' }, deletedAt: null };
    if (group === 'dedicated') {
      channelFilter.category = { startsWith: 'Dedicated', mode: 'insensitive' };
    } else if (group === 'ihi') {
      // /IHI/i — the JS-side isIhi() below performs the formal disambiguation.
      channelFilter.category = { contains: 'IHI', mode: 'insensitive' };
    } else {
      // Default: matches /^(Dedicated|IHI)\s*-/i — Prisma has no regex, so we
      // OR two startsWith filters with a literal " -" suffix check in the
      // bucket loop. Postgres' StringFilter supports startsWith, so we accept
      // any channel whose category starts with "Dedicated" or "IHI" and rely
      // on bucketOf to reject ones without the proper " - …" suffix.
      channelFilter.OR = [
        { category: { startsWith: 'Dedicated', mode: 'insensitive' } },
        { category: { startsWith: 'IHI', mode: 'insensitive' } },
      ];
    }

    const channels = await prisma.channel.findMany({
      where: channelFilter,
      select: { id: true, title: true, thumbnailUrl: true, category: true },
    });

    // ---- 2. Bucket each channel by category suffix ----
    const BUCKETS = ['A', 'B', 'C', 'D', 'E', 'Inactive'];
    const bucketOf = (cat) => {
      const c = (cat || '').trim();
      const m = c.match(/Grade\s+([A-E])$/i);
      if (m) return m[1].toUpperCase();
      if (/Inactive$/i.test(c)) return 'Inactive';
      return null;
    };
    const isIhi = (cat) => /IHI/i.test(cat) && !/^Dedicated/i.test(cat);

    const channelsByBucket = Object.fromEntries(BUCKETS.map((b) => [b, []]));
    for (const ch of channels) {
      const b = bucketOf(ch.category);
      if (b) channelsByBucket[b].push(ch);
    }

    // ---- 3. Row 1: counts ----
    const row1 = Object.fromEntries(
      BUCKETS.map((b) => [b, channelsByBucket[b].length]),
    );

    // ---- 4. Decide whether to compute rows 2 & 3 ----
    const wantRange = !!(startDate && endDate);
    let row2 = null;
    let row3 = null;

    if (wantRange) {
      const start = parseYmdToUtcStart(startDate);
      const end = parseYmdToUtcEnd(endDate);

      if (start > end) {
        return res.json({ row1, row2, row3 });
      }

      const ihiChannelIds = [];
      const dedChannelIds = [];
      for (const ch of channels) {
        if (isIhi(ch.category)) ihiChannelIds.push(ch.id);
        else dedChannelIds.push(ch.id);
      }

      const [dedTotalsMap, ihiTotalsMap] = await Promise.all([
        getVideoSnapshotPeriodViewsByChannel(dedChannelIds, start, end, null),
        getVideoSnapshotPeriodViewsByChannel(ihiChannelIds, start, end, 'sadhguru'),
      ]);

      const growthByChannel = new Map();
      for (const ch of channels) {
        const g = isIhi(ch.category)
          ? ihiTotalsMap.get(ch.id) || 0
          : dedTotalsMap.get(ch.id) || 0;
        growthByChannel.set(ch.id, g);
      }

      row2 = {};
      row3 = {};
      for (const b of BUCKETS) {
        const inBucket = channelsByBucket[b].map((ch) => ({
          channelId: ch.id,
          title: ch.title || 'Unknown',
          thumbnailUrl: ch.thumbnailUrl || '',
          viewsGrowth: growthByChannel.get(ch.id) || 0,
        }));
        inBucket.sort((a, b) => b.viewsGrowth - a.viewsGrowth);
        row2[b] = inBucket.slice(0, 10);
        row3[b] = inBucket.reduce((s, x) => s + x.viewsGrowth, 0);
      }
    }

    res.json({ row1, row2, row3 });
  } catch (err) {
    next(err);
  }
}

export async function getLayout(req, res, next) {
  try {
    const doc = await prisma.dashboardLayout.findFirst();
    res.json(doc ? { layouts: doc.layouts, updatedBy: doc.updatedBy } : { layouts: {}, updatedBy: '' });
  } catch (err) {
    next(err);
  }
}

export async function saveLayout(req, res, next) {
  try {
    const { layouts } = req.body;
    if (!layouts || typeof layouts !== 'object') {
      return res.status(400).json({ message: 'layouts object is required' });
    }
    // No `username` on the Prisma User; the legacy fallback chain reduces to
    // `email || 'unknown'` here.
    const updatedBy = req.user?.username || req.user?.email || 'unknown';
    const doc = await prisma.dashboardLayout.upsert({
      where: { id: 'layout' },
      update: { layouts, updatedBy },
      create: { id: 'layout', layouts, updatedBy },
    });
    res.json({ layouts: doc.layouts, updatedBy: doc.updatedBy });
  } catch (err) {
    next(err);
  }
}
