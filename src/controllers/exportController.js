import { Parser } from '@json2csv/plainjs';
import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import {
  parseYmdToUtcEnd,
  parseYmdToUtcStart,
  utcDateString,
} from '../utils/dateUtc.js';
import { aggregateChannelOpeningAndClosingMaps } from '../utils/channelSnapshotPeriod.js';
import { getVideoSnapshotPeriodViewsByChannel } from '../utils/videoSnapshotPeriodViews.js';

/* ─────────────────────────────────────────────────────────────────────
   Helpers
───────────────────────────────────────────────────────────────────── */

/** BigInt-safe coercion to plain JS number. */
function asNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'bigint') return Number(value);
  return Number(value) || 0;
}

function buildChannelFilter(query) {
  const {
    search,
    category,
    status,
    tags,
    minSubs,
    maxSubs,
    minViews,
    maxViews,
    country,
    startDate,
    endDate,
  } = query;

  // Default: exclude archived channels (matches dashboard + listChannels behavior).
  // Caller can opt back in by passing ?status=archived explicitly.
  // Also exclude soft-deleted rows.
  const where = { deletedAt: null, status: { not: 'archived' } };

  if (search) {
    where.OR = [
      { title:            { contains: search, mode: 'insensitive' } },
      { youtubeChannelId: { contains: search, mode: 'insensitive' } },
      { customUrl:        { contains: search, mode: 'insensitive' } },
    ];
  }
  if (category) where.category = category;
  if (status)   where.status   = status;
  if (country)  where.country  = { contains: country, mode: 'insensitive' };

  if (tags && tags.trim()) {
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (tagList.length) where.tags = { hasSome: tagList };
  }
  if (minSubs || maxSubs) {
    where.currentSubscribers = {};
    if (minSubs) where.currentSubscribers.gte = parseInt(minSubs);
    if (maxSubs) where.currentSubscribers.lte = parseInt(maxSubs);
  }
  if (minViews || maxViews) {
    where.currentViews = {};
    if (minViews) where.currentViews.gte = BigInt(parseInt(minViews));
    if (maxViews) where.currentViews.lte = BigInt(parseInt(maxViews));
  }
  // Date range: when BOTH dates provided → period metrics mode (no lastSyncedAt filter).
  // When only one date → filter by lastSyncedAt.
  if (startDate && endDate) {
    // Period mode: dates used for snapshot delta, not for filtering
  } else if (startDate || endDate) {
    where.lastSyncedAt = {};
    if (startDate) where.lastSyncedAt.gte = parseYmdToUtcStart(startDate);
    if (endDate)   where.lastSyncedAt.lte = parseYmdToUtcEnd(endDate);
  }
  return where;
}

function buildVideoFilter(query) {
  const {
    search,
    channelId,
    category,
    tags,
    status,
    classification,
    minViews,
    maxViews,
    startDate,
    endDate,
    hashtags,
  } = query;

  // Default: video reports exclude videos whose channel is archived.
  // Caller can opt back in by passing ?status=archived explicitly.
  // Channel-level filters resolve to a channelId list later.
  const channelWhere = { deletedAt: null, status: { not: 'archived' } };
  const videoWhere   = {};

  if (category) channelWhere.category = category;
  if (status)   channelWhere.status   = status;
  if (classification) {
    if (classification === 'sadhguru') videoWhere.classification = 'sadhguru';
    else if (classification === 'non_sadhguru') videoWhere.classification = 'non sadhguru';
  }
  if (tags && tags.trim()) {
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (tagList.length) channelWhere.tags = { hasSome: tagList };
  }

  if (channelId) {
    // Prisma channelId is a plain string FK — pass through verbatim.
    videoWhere.channelId = channelId;
  }

  const orConditions = [];
  if (search) {
    orConditions.push(
      { title:          { contains: search, mode: 'insensitive' } },
      { youtubeVideoId: { contains: search, mode: 'insensitive' } },
    );
  }

  if (hashtags && hashtags.trim()) {
    const keywords = hashtags
      .split(',')
      .map((k) => k.trim().replace(/^#/, ''))
      .filter(Boolean);
    if (keywords.length) {
      const hashtagOr = [];
      for (const kw of keywords) {
        const needle = `#${kw}`;
        hashtagOr.push(
          { title:       { contains: needle, mode: 'insensitive' } },
          { description: { contains: needle, mode: 'insensitive' } },
        );
      }
      if (search) {
        videoWhere.AND = [
          { OR: orConditions },
          { OR: hashtagOr },
        ];
      } else {
        videoWhere.OR = hashtagOr;
      }
    } else if (orConditions.length) {
      videoWhere.OR = orConditions;
    }
  } else if (orConditions.length) {
    videoWhere.OR = orConditions;
  }

  if (minViews || maxViews) {
    videoWhere.views = {};
    if (minViews) videoWhere.views.gte = BigInt(parseInt(minViews));
    if (maxViews) videoWhere.views.lte = BigInt(parseInt(maxViews));
  }
  if (startDate || endDate) {
    videoWhere.publishedAt = {};
    if (startDate) videoWhere.publishedAt.gte = parseYmdToUtcStart(startDate);
    if (endDate)   videoWhere.publishedAt.lte = parseYmdToUtcEnd(endDate);
  }

  return { channelWhere, videoWhere };
}

async function getClassificationCountsByChannel(channelIds, options = {}) {
  if (!channelIds?.length) return new Map();
  const { startDate, endDate } = options;
  // Group by (channelId, classification) → count.
  const where = { channelId: { in: channelIds }, deletedAt: null };
  if (startDate && endDate) {
    where.publishedAt = {
      gte: parseYmdToUtcStart(startDate),
      lte: parseYmdToUtcEnd(endDate),
    };
  }
  const rows = await prisma.video.groupBy({
    by: ['channelId', 'classification'],
    where,
    _count: { _all: true },
  });
  const map = new Map();
  for (const row of rows) {
    const cid = row.channelId;
    if (!cid) continue;
    if (!map.has(cid)) map.set(cid, {});
    const cls = row.classification || '';
    map.get(cid)[cls] = row._count._all;
  }
  return map;
}

async function getPublishedVideoCountsByChannel(channelIds, options = {}) {
  if (!channelIds?.length) return new Map();
  const { startDate, endDate } = options;
  const where = { channelId: { in: channelIds }, deletedAt: null };
  if (startDate && endDate) {
    where.publishedAt = {
      gte: parseYmdToUtcStart(startDate),
      lte: parseYmdToUtcEnd(endDate),
    };
  }
  const rows = await prisma.video.groupBy({
    by: ['channelId'],
    where,
    _count: { _all: true },
  });
  const map = new Map();
  for (const row of rows) {
    if (row.channelId) map.set(row.channelId, row._count._all);
  }
  return map;
}

function mapChannel(c, periodMetrics = null, classificationCounts = null) {
  const subs   = asNumber(c.currentSubscribers);
  const views  = asNumber(c.currentViews);
  const videos = asNumber(c.currentVideoCount);
  const avgViewsPerVideo = videos > 0 ? Math.round(views / videos) : 0;
  const sadhguru = classificationCounts?.sadhguru ?? 0;
  const row = {
    title:               c.title,
    youtube_channel_id:  c.youtubeChannelId,
    custom_url:          c.customUrl || '',
    country:             c.country   || '',
    category:            c.category  || '',
    status:              c.status    || '',
    tags:                c.tags?.join('; ') || '',
    sadhguru_count:      sadhguru,
    subscribers:         subs,
    total_views:         views,
    video_count:         videos,
    avg_views_per_video: avgViewsPerVideo,
    assigned_to:         c.assignedTo?.name || '',
    notes:               c.notes || '',
    added_on:            c.createdAt ? utcDateString(c.createdAt) : '',
    last_synced:         c.lastSyncedAt ? utcDateString(c.lastSyncedAt) : '',
  };
  if (periodMetrics) {
    row.views_in_period       = periodMetrics.viewsInPeriod;
    row.subscribers_in_period = periodMetrics.subscribersInPeriod;
    row.videos_in_period      = periodMetrics.videosInPeriod;
  }
  return row;
}

function parseVideoSort(sortStr) {
  const s = String(sortStr || '-views');
  const desc = s.startsWith('-');
  const key = s.replace(/^-/, '');
  return { key, dir: desc ? -1 : 1 };
}

/** Map UI/API sort keys to Prisma orderBy. */
function mapVideoOrderByForFind(sortStr) {
  const { key, dir } = parseVideoSort(sortStr);
  const alias = {
    published_at: 'publishedAt',
    last_synced: 'lastSyncedAt',
    youtube_video_id: 'youtubeVideoId',
  };
  const prismaKey = alias[key] || key;
  const allowed = new Set([
    'title', 'views', 'likes', 'comments', 'classification', 'duration',
    'publishedAt', 'lastSyncedAt', 'youtubeVideoId',
  ]);
  const dirStr = dir === -1 ? 'desc' : 'asc';
  if (!allowed.has(prismaKey)) {
    return { views: dirStr };
  }
  return { [prismaKey]: dirStr };
}

function needsAggregateVideoSort(sortStr) {
  const key = String(sortStr || '').replace(/^-/, '');
  return ['channel', 'category', 'engagement_rate', 'outlier_score'].includes(key);
}

/**
 * Fetch videos with correct ordering. Channel / category / engagement / outlier
 * require a join + computed expressions; published_at etc. map directly to
 * Video columns.
 */
async function fetchVideosForReportSorted(videoWhere, sortStr, skip, limit, isExport) {
  const { key, dir } = parseVideoSort(sortStr);

  if (needsAggregateVideoSort(sortStr)) {
    // Compute globalAvg for outlier_score in the same shape as the Mongo path.
    let globalAvg = 1;
    if (key === 'outlier_score') {
      const matched = await prisma.video.findMany({
        where: videoWhere,
        select: { views: true },
      });
      if (matched.length) {
        const sum = matched.reduce((acc, v) => acc + asNumber(v.views), 0);
        const avg = sum / matched.length;
        globalAvg = avg || 1;
      }
    }

    // Pull all videos plus their channel; sort in JS so we can compute
    // engagement_rate / outlier_score and read channel.title / channel.category.
    const all = await prisma.video.findMany({
      where: videoWhere,
      include: { channel: { select: { id: true, title: true, category: true } } },
    });

    const withScores = all.map((v) => {
      const views = asNumber(v.views);
      const likes = asNumber(v.likes);
      const comments = asNumber(v.comments);
      const engagementRate = views > 0 ? ((likes + comments) / views) * 100 : 0;
      const outlierScore = views / (globalAvg || 1);
      return { v, engagementRate, outlierScore };
    });

    const sortFieldMap = {
      channel:         (x) => (x.v.channel?.title    ?? ''),
      category:        (x) => (x.v.channel?.category ?? ''),
      engagement_rate: (x) => x.engagementRate,
      outlier_score:   (x) => x.outlierScore,
    };
    const getKey = sortFieldMap[key] || ((x) => asNumber(x.v.views));
    withScores.sort((a, b) => {
      const ak = getKey(a);
      const bk = getKey(b);
      if (typeof ak === 'string' || typeof bk === 'string') {
        return dir * String(ak).localeCompare(String(bk));
      }
      return dir * (ak - bk);
    });

    let sliced = withScores;
    if (!isExport) {
      const end = limit > 0 ? skip + limit : undefined;
      sliced = withScores.slice(skip, end);
    }

    const channelMap = {};
    const videos = sliced.map(({ v }) => {
      if (v.channel && v.channelId) channelMap[v.channelId] = v.channel;
      const { channel: _channel, ...rest } = v;
      return rest;
    });
    return { videos, channelMap };
  }

  const orderBy = mapVideoOrderByForFind(sortStr);
  const findArgs = { where: videoWhere, orderBy };
  if (!isExport) {
    findArgs.skip = skip;
    if (limit > 0) findArgs.take = limit;
  }
  const videos = await prisma.video.findMany(findArgs);
  return { videos, channelMap: null };
}

function mapVideo(v, channelMap, avgViews) {
  const ch = channelMap[v.channelId] || {};
  const views = asNumber(v.views);
  const likes = asNumber(v.likes);
  const comments = asNumber(v.comments);
  const engagement = views > 0
    ? (((likes + comments) / views) * 100).toFixed(2)
    : '0.00';
  const outlierScore = avgViews > 0
    ? parseFloat((views / avgViews).toFixed(2))
    : 0;
  return {
    title:            v.title,
    youtube_video_id: v.youtubeVideoId,
    channel:          ch.title    || '',
    category:         ch.category || '',
    classification: v.classification === 'non sadhguru' ? '-' : (v.classification || '—'),
    published_at:     v.publishedAt ? utcDateString(v.publishedAt) : '',
    views,
    likes,
    comments,
    engagement_rate:  parseFloat(engagement),
    outlier_score:    outlierScore,
    duration:         v.duration || '',
    last_synced:      v.lastSyncedAt ? utcDateString(v.lastSyncedAt) : '',
  };
}

/** Map the API sort string to a Prisma orderBy clause for the channel report. */
function mapChannelOrderBy(sortStr) {
  const s = String(sortStr || '-currentSubscribers');
  const dir = s.startsWith('-') ? 'desc' : 'asc';
  const raw = s.replace(/^[-+]/, '');
  const alias = {
    'currentStats.subscribers': 'currentSubscribers',
    'currentStats.views':       'currentViews',
    'currentStats.videoCount':  'currentVideoCount',
  };
  const key = alias[raw] || raw;
  const allowed = new Set([
    'title', 'country', 'category', 'status', 'lastSyncedAt', 'createdAt',
    'currentSubscribers', 'currentViews', 'currentVideoCount',
  ]);
  if (!allowed.has(key)) return { currentSubscribers: 'desc' };
  return { [key]: dir };
}

/* ─────────────────────────────────────────────────────────────────────
   Channel report — GET /api/export/report/channels
   ?format=json|csv|excel  + all filter params + sort + page + limit
   When startDate+endDate provided: adds views_in_period, subscribers_in_period
───────────────────────────────────────────────────────────────────── */
export async function reportChannels(req, res, next) {
  try {
    const {
      format = 'json',
      sort   = '-currentStats.subscribers',
      page   = 1,
      limit  = 50,
      startDate,
      endDate,
    } = req.query;

    const where = buildChannelFilter(req.query);

    if (req.query.classification) {
      const cls = req.query.classification === 'sadhguru' ? 'sadhguru' : 'non sadhguru';
      const distinctRows = await prisma.video.findMany({
        where: { classification: cls, deletedAt: null },
        distinct: ['channelId'],
        select: { channelId: true },
      });
      const ids = distinctRows.map((r) => r.channelId);
      where.id = { in: ids };
    }

async function getMicroUnitChannelIds(microUnitId) {
  if (!microUnitId) return [];
  const rows = await prisma.microUnitChannel.findMany({
    where: { microUnitId },
    select: { channelId: true },
  });
  return rows.map((r) => r.channelId);
}

    if (req.query.microUnitId) {
      const unitChannelIds = await getMicroUnitChannelIds(req.query.microUnitId);
      if (where.id && where.id.in) {
        where.id = { in: where.id.in.filter((id) => unitChannelIds.includes(id)) };
      } else {
        where.id = { in: unitChannelIds };
      }
    }

    const isPeriodMode = !!(startDate && endDate);
    const isExport = format === 'csv' || format === 'excel';

    let channels;
    let total;
    let summary = null;
    let rows;

    if (isPeriodMode) {
      // Fetch all matching channels (no skip/limit yet — we need to compute period metrics and sort)
      channels = await prisma.channel.findMany({
        where,
        include: { assignedTo: { select: { name: true, email: true } } },
      });
      total = channels.length;

      const channelIds = channels.map((c) => c.id);
      const startDateObj = parseYmdToUtcStart(startDate);
      const endDateObj   = parseYmdToUtcEnd(endDate);

      const clsParam = req.query.classification;
      let classificationKey = null;
      if (clsParam === 'sadhguru') classificationKey = 'sadhguru';
      else if (clsParam === 'non_sadhguru') classificationKey = 'non_sadhguru';

      const [{ openingMap, closingMap }, classMap, publishedVideoCountMap, periodViewsByChannel] =
        await Promise.all([
          aggregateChannelOpeningAndClosingMaps(channelIds, startDateObj, endDateObj),
          getClassificationCountsByChannel(channelIds, { startDate, endDate }),
          getPublishedVideoCountsByChannel(channelIds, { startDate, endDate }),
          getVideoSnapshotPeriodViewsByChannel(
            channelIds,
            startDateObj,
            endDateObj,
            classificationKey,
          ),
        ]);

      rows = channels.map((c) => {
        const sid = c.id;
        const opening = openingMap.get(sid);
        const closing = closingMap.get(sid) || opening;
        if (!closing || !opening) {
          return mapChannel(c, {
            viewsInPeriod: 0,
            subscribersInPeriod: 0,
            videosInPeriod: 0,
          }, classMap.get(sid));
        }
        const endSubs   = closing.subscribers   ?? 0;
        const startSubs = opening.subscribers ?? 0;
        const periodMetrics = {
          viewsInPeriod:       periodViewsByChannel.get(sid) ?? 0,
          subscribersInPeriod: endSubs - startSubs,
          videosInPeriod:      publishedVideoCountMap.get(sid) ?? 0,
        };
        return mapChannel(c, periodMetrics, classMap.get(sid));
      });

      // Sort by requested field (support period fields)
      const rawKey = String(sort).replace(/^[-+]/, '');
      const sortDir = String(sort).startsWith('-') ? -1 : 1;
      const sortKey = rawKey
        .replace('currentStats.subscribers', 'subscribers')
        .replace('currentStats.views', 'total_views')
        .replace('currentStats.videoCount', 'video_count');
      rows.sort((a, b) => {
        const av = Number(a[sortKey]) || 0;
        const bv = Number(b[sortKey]) || 0;
        const cmp = av - bv;
        return sortDir * (cmp > 0 ? 1 : cmp < 0 ? -1 : 0);
      });

      // Compute summary from full rows before pagination (one pass — period totals match sum of period columns)
      if (format === 'json') {
        const z = (n) => {
          const v = Number(n);
          return Number.isFinite(v) ? v : 0;
        };
        const sums = rows.reduce(
          (acc, r) => ({
            totalSubscribers:        acc.totalSubscribers        + z(r.subscribers),
            totalViews:              acc.totalViews              + z(r.total_views),
            totalVideos:             acc.totalVideos             + z(r.video_count),
            totalViewsInPeriod:      acc.totalViewsInPeriod      + z(r.views_in_period),
            totalSubscribersInPeriod: acc.totalSubscribersInPeriod + z(r.subscribers_in_period),
            totalVideosInPeriod:     acc.totalVideosInPeriod     + z(r.videos_in_period),
          }),
          {
            totalSubscribers: 0,
            totalViews: 0,
            totalVideos: 0,
            totalViewsInPeriod: 0,
            totalSubscribersInPeriod: 0,
            totalVideosInPeriod: 0,
          },
        );
        summary = {
          totalChannels: rows.length,
          ...sums,
        };
      }

      if (!isExport) {
        const skip = (parseInt(page) - 1) * parseInt(limit);
        rows = rows.slice(skip, skip + parseInt(limit));
      }
    } else {
      const skip = isExport ? 0 : (parseInt(page) - 1) * parseInt(limit);
      const take = isExport ? undefined : parseInt(limit);
      const orderBy = mapChannelOrderBy(sort);

      const findArgs = {
        where,
        include: { assignedTo: { select: { name: true, email: true } } },
        orderBy,
      };
      if (!isExport) {
        findArgs.skip = skip;
        findArgs.take = take;
      }

      [channels, total] = await Promise.all([
        prisma.channel.findMany(findArgs),
        prisma.channel.count({ where }),
      ]);
      const channelIds = channels.map((c) => c.id);
      const classMap = await getClassificationCountsByChannel(channelIds);
      rows = channels.map((c) => mapChannel(c, null, classMap.get(c.id)));
    }

    /* ── Summary (for JSON, non-period mode) ── */
    if (format === 'json' && !summary) {
      const agg = await prisma.channel.aggregate({
        where,
        _count: { _all: true },
        _sum: {
          currentSubscribers: true,
          currentViews: true,
          currentVideoCount: true,
        },
      });
      summary = {
        totalChannels:    agg._count?._all ?? 0,
        totalSubscribers: asNumber(agg._sum?.currentSubscribers),
        totalViews:       asNumber(agg._sum?.currentViews),
        totalVideos:      asNumber(agg._sum?.currentVideoCount),
      };
    }

    /* ── JSON preview ── */
    if (format === 'json') {
      return res.json({
        data: rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit)),
        },
        summary,
      });
    }

    const filename = `channel-report-${utcDateString()}`;

    /* ── CSV ── */
    if (format === 'csv') {
      const parser = new Parser();
      const csv    = parser.parse(rows);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}.csv`);
      return res.send(csv);
    }

    /* ── Excel ── */
    if (format === 'excel') {
      const wb  = new ExcelJS.Workbook();
      wb.creator = 'Wisdom Warriors';
      const ws  = wb.addWorksheet('Channels');

      const baseColumns = [
        { header: 'Title',               key: 'title',               width: 40 },
        { header: 'YouTube Channel ID',  key: 'youtube_channel_id',  width: 26 },
        { header: 'Custom URL',          key: 'custom_url',          width: 22 },
        { header: 'Country',             key: 'country',             width: 10 },
        { header: 'Category',            key: 'category',            width: 18 },
        { header: 'Status',              key: 'status',              width: 10 },
        { header: 'Sadhguru Videos',     key: 'sadhguru_count',      width: 16 },
        { header: 'Tags',                key: 'tags',                width: 24 },
        { header: 'Subscribers',         key: 'subscribers',         width: 16 },
        { header: 'Total Views',         key: 'total_views',         width: 16 },
        ...(isPeriodMode
          ? [
              { header: 'Views (Period)',       key: 'views_in_period',       width: 16 },
              { header: 'Subscribers (Period)', key: 'subscribers_in_period', width: 18 },
              { header: 'Videos (Period)',      key: 'videos_in_period',      width: 16 },
            ]
          : []),
        { header: 'Video Count',         key: 'video_count',         width: 14 },
        { header: 'Avg Views/Video',     key: 'avg_views_per_video', width: 18 },
        { header: 'Assigned To',         key: 'assigned_to',         width: 18 },
        { header: 'Notes',               key: 'notes',               width: 30 },
        { header: 'Last Synced',         key: 'last_synced',         width: 14 },
      ];
      ws.columns = baseColumns;

      // Style header row
      ws.getRow(1).eachCell((cell) => {
        cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      });

      rows.forEach((r) => ws.addRow(r));

      // Freeze header, auto-filter
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      ws.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + ws.columns.length)}1` };

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}.xlsx`);
      await wb.xlsx.write(res);
      return res.end();
    }

    res.status(400).json({ message: 'Invalid format. Use json, csv, or excel.' });
  } catch (err) {
    next(err);
  }
}

/* ─────────────────────────────────────────────────────────────────────
   Video report — GET /api/export/report/videos
   ?format=json|csv|excel  + filter params + sort + page + limit
───────────────────────────────────────────────────────────────────── */
export async function reportVideos(req, res, next) {
  try {
    const {
      format = 'json',
      sort   = '-views',
      page   = 1,
      limit  = 50,
    } = req.query;

    const { channelWhere, videoWhere } = buildVideoFilter(req.query);

    // Resolve channel IDs from channel-level filters
    if (Object.keys(channelWhere).length > 0) {
      const matched = await prisma.channel.findMany({
        where: channelWhere,
        select: { id: true },
      });
      const ids = matched.map((c) => c.id);
      // If an explicit channelId was set, keep it; else restrict to resolved ids.
      if (!videoWhere.channelId) {
        videoWhere.channelId = { in: ids };
      }
    }

    if (req.query.microUnitId) {
      const unitChannelIds = await getMicroUnitChannelIds(req.query.microUnitId);
      if (videoWhere.channelId && videoWhere.channelId.in) {
        videoWhere.channelId = { in: videoWhere.channelId.in.filter((id) => unitChannelIds.includes(id)) };
      } else if (typeof videoWhere.channelId === 'string') {
        if (!unitChannelIds.includes(videoWhere.channelId)) {
          videoWhere.channelId = { in: [] };
        }
      } else {
        videoWhere.channelId = { in: unitChannelIds };
      }
    }

    const isExport = format === 'csv' || format === 'excel';
    const skip     = isExport ? 0 : (parseInt(page) - 1) * parseInt(limit);
    const lim      = isExport ? 0 : parseInt(limit);

    videoWhere.deletedAt = null;

    const summaryPromise = format === 'json'
      ? prisma.video.aggregate({
          where: videoWhere,
          _count: { _all: true },
          _sum: { views: true, likes: true, comments: true },
        })
      : Promise.resolve(null);

    const [sortedResult, total, summaryAgg] = await Promise.all([
      fetchVideosForReportSorted(videoWhere, sort, skip, lim, isExport),
      prisma.video.count({ where: videoWhere }),
      summaryPromise,
    ]);

    const { videos, channelMap: aggChannelMap } = sortedResult;

    const summary = format === 'json'
      ? {
          totalVideos:   summaryAgg?._count?._all ?? 0,
          totalViews:    asNumber(summaryAgg?._sum?.views),
          totalLikes:    asNumber(summaryAgg?._sum?.likes),
          totalComments: asNumber(summaryAgg?._sum?.comments),
        }
      : undefined;

    // Build channel map for joined fields (aggregate path may have pre-filled)
    let channelMap = aggChannelMap;
    if (!channelMap) {
      const channelIds = [...new Set(videos.map((v) => v.channelId).filter(Boolean))];
      if (channelIds.length) {
        const channelDocs = await prisma.channel.findMany({
          where: { id: { in: channelIds } },
          select: { id: true, title: true, category: true },
        });
        channelMap = {};
        for (const c of channelDocs) channelMap[c.id] = c;
      } else {
        channelMap = {};
      }
    }

    const avgViews = videos.length
      ? videos.reduce((s, v) => s + asNumber(v.views), 0) / videos.length
      : 0;

    const rows = videos.map((v) => mapVideo(v, channelMap, avgViews));

    /* ── JSON preview ── */
    if (format === 'json') {
      return res.json({
        data: rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit)),
        },
        summary,
      });
    }

    const filename = `video-report-${utcDateString()}`;

    /* ── CSV ── */
    if (format === 'csv') {
      const parser = new Parser();
      const csv    = parser.parse(rows);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}.csv`);
      return res.send(csv);
    }

    /* ── Excel ── */
    if (format === 'excel') {
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Wisdom Warriors';
      const ws = wb.addWorksheet('Videos');

      ws.columns = [
        { header: 'Title',            key: 'title',            width: 50 },
        { header: 'YouTube Video ID', key: 'youtube_video_id', width: 20 },
        { header: 'Channel',          key: 'channel',          width: 30 },
        { header: 'Category',         key: 'category',         width: 18 },
        { header: 'Classification',   key: 'classification',   width: 16 },
        { header: 'Published At',     key: 'published_at',     width: 14 },
        { header: 'Views',            key: 'views',            width: 14 },
        { header: 'Likes',            key: 'likes',            width: 12 },
        { header: 'Comments',         key: 'comments',         width: 12 },
        { header: 'Engagement Rate%', key: 'engagement_rate',  width: 18 },
        { header: 'Outlier Score',    key: 'outlier_score',    width: 16 },
        { header: 'Duration',         key: 'duration',         width: 10 },
        { header: 'Last Synced',      key: 'last_synced',      width: 14 },
      ];

      ws.getRow(1).eachCell((cell) => {
        cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      });

      rows.forEach((r) => ws.addRow(r));
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      ws.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + ws.columns.length)}1` };

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}.xlsx`);
      await wb.xlsx.write(res);
      return res.end();
    }

    res.status(400).json({ message: 'Invalid format. Use json, csv, or excel.' });
  } catch (err) {
    next(err);
  }
}

/* ─────────────────────────────────────────────────────────────────────
   Legacy — kept for backward compatibility
───────────────────────────────────────────────────────────────────── */
export async function exportChannelsCSV(req, res, next) {
  req.query.format = 'csv';
  return reportChannels(req, res, next);
}
