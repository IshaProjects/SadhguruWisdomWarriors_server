import { Parser } from '@json2csv/plainjs';
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import Channel from '../models/Channel.js';
import ChannelSnapshot from '../models/ChannelSnapshot.js';
import Video from '../models/Video.js';
import VideoSnapshot from '../models/VideoSnapshot.js';
import {
  parseYmdToUtcEnd,
  parseYmdToUtcStart,
  utcDateString,
} from '../utils/dateUtc.js';

/* ─────────────────────────────────────────────────────────────────────
   Helpers
───────────────────────────────────────────────────────────────────── */

function buildChannelFilter(query) {
  const { search, category, status, tags, minSubs, maxSubs, minViews, maxViews, country, startDate, endDate } = query;
  const filter = {};

  if (search) {
    filter.$or = [
      { title: { $regex: search, $options: 'i' } },
      { youtubeChannelId: { $regex: search, $options: 'i' } },
      { customUrl: { $regex: search, $options: 'i' } },
    ];
  }
  if (category) filter.category = category;
  if (status)   filter.status   = status;
  if (country)  filter.country  = { $regex: country, $options: 'i' };

  if (tags && tags.trim()) {
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (tagList.length) filter.tags = { $in: tagList };
  }
  if (minSubs || maxSubs) {
    filter['currentStats.subscribers'] = {};
    if (minSubs) filter['currentStats.subscribers'].$gte = parseInt(minSubs);
    if (maxSubs) filter['currentStats.subscribers'].$lte = parseInt(maxSubs);
  }
  if (minViews || maxViews) {
    filter['currentStats.views'] = {};
    if (minViews) filter['currentStats.views'].$gte = parseInt(minViews);
    if (maxViews) filter['currentStats.views'].$lte = parseInt(maxViews);
  }
  // Date range: when BOTH dates provided → period metrics mode (no lastSyncedAt filter).
  // When only one date → filter by lastSyncedAt.
  if (startDate && endDate) {
    // Period mode: dates used for snapshot delta, not for filtering
  } else if (startDate || endDate) {
    filter.lastSyncedAt = {};
    if (startDate) filter.lastSyncedAt.$gte = parseYmdToUtcStart(startDate);
    if (endDate)   filter.lastSyncedAt.$lte = parseYmdToUtcEnd(endDate);
  }
  return filter;
}

function buildVideoFilter(query) {
  const { search, channelId, category, tags, status, classification, minViews, maxViews, startDate, endDate, hashtags } = query;
  const channelFilter = {};
  const videoFilter   = {};

  if (category) channelFilter.category = category;
  if (status)   channelFilter.status   = status;
  if (classification) {
    if (classification === 'sadhguru') videoFilter.classification = 'sadhguru';
    else if (classification === 'non_sadhguru') videoFilter.classification = 'non sadhguru';
  }
  if (tags && tags.trim()) {
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (tagList.length) channelFilter.tags = { $in: tagList };
  }

  if (channelId) {
    videoFilter.channelId = mongoose.isValidObjectId(channelId)
      ? mongoose.Types.ObjectId.createFromHexString(channelId)
      : channelId;
  }

  const orConditions = [];

  if (search) {
    orConditions.push(
      { title:          { $regex: search, $options: 'i' } },
      { youtubeVideoId: { $regex: search, $options: 'i' } },
    );
  }

  if (hashtags && hashtags.trim()) {
    const keywords = hashtags.split(',').map((k) => k.trim().replace(/^#/, '')).filter(Boolean);
    if (keywords.length) {
      const hashtagPatterns = keywords.map((kw) => {
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return { $regex: `#${escaped}`, $options: 'i' };
      });
      const hashtagOr = [];
      for (const pattern of hashtagPatterns) {
        hashtagOr.push({ title: pattern }, { description: pattern });
      }
      if (search) {
        videoFilter.$and = [
          { $or: orConditions },
          { $or: hashtagOr },
        ];
      } else {
        videoFilter.$or = hashtagOr;
      }
    } else if (orConditions.length) {
      videoFilter.$or = orConditions;
    }
  } else if (orConditions.length) {
    videoFilter.$or = orConditions;
  }

  if (minViews || maxViews) {
    videoFilter.views = {};
    if (minViews) videoFilter.views.$gte = parseInt(minViews);
    if (maxViews) videoFilter.views.$lte = parseInt(maxViews);
  }
  if (startDate || endDate) {
    videoFilter.publishedAt = {};
    if (startDate) videoFilter.publishedAt.$gte = parseYmdToUtcStart(startDate);
    if (endDate)   videoFilter.publishedAt.$lte = parseYmdToUtcEnd(endDate);
  }

  return { channelFilter, videoFilter };
}

async function getClassificationCountsByChannel(channelIds, options = {}) {
  if (!channelIds?.length) return new Map();
  const { startDate, endDate } = options;
  const match = { channelId: { $in: channelIds }, deletedAt: null };
  if (startDate && endDate) {
    match.publishedAt = {
      $gte: parseYmdToUtcStart(startDate),
      $lte: parseYmdToUtcEnd(endDate),
    };
  }
  const agg = await Video.aggregate([
    { $match: match },
    { $group: { _id: { channelId: '$channelId', classification: '$classification' }, count: { $sum: 1 } } },
  ]);
  const map = new Map();
  for (const x of agg) {
    const cid = x._id.channelId?.toString();
    if (!cid) continue;
    if (!map.has(cid)) map.set(cid, {});
    const cls = x._id.classification || '';
    map.get(cid)[cls] = x.count;
  }
  return map;
}

/**
 * Sum per-video view deltas using first snapshot within range as baseline
 * and latest snapshot on/before end as closing point.
 * Used when channel report classification filter is sadhguru | non_sadhguru
 * so "views in period" reflects only in-range growth.
 */
async function getClassificationPeriodViewsByChannel(channelIds, startDateObj, endDateObj, classificationKey) {
  if (!channelIds?.length) return new Map();
  const clsMongo =
    classificationKey === 'sadhguru' ? 'sadhguru' : 'non sadhguru';
  const videoClsMatch = { 'video.classification': clsMongo };

  const base = { channelId: { $in: channelIds }, deletedAt: null };

  const startStages = [
    { $match: { ...base, date: { $gte: startDateObj, $lte: endDateObj } } },
    { $sort: { date: 1 } },
    {
      $group: {
        _id: '$videoId',
        views: { $first: '$views' },
      },
    },
    { $lookup: { from: 'videos', localField: '_id', foreignField: '_id', as: 'video' } },
    { $unwind: '$video' },
    { $match: { 'video.deletedAt': null, ...videoClsMatch } },
  ];
  const endStages = [
    { $match: { ...base, date: { $lte: endDateObj } } },
    { $sort: { date: -1 } },
    {
      $group: {
        _id: '$videoId',
        views: { $first: '$views' },
        channelId: { $first: '$channelId' },
      },
    },
    { $lookup: { from: 'videos', localField: '_id', foreignField: '_id', as: 'video' } },
    { $unwind: '$video' },
    { $match: { 'video.deletedAt': null, ...videoClsMatch } },
  ];

  const [startSnaps, endSnaps] = await Promise.all([
    VideoSnapshot.aggregate(startStages),
    VideoSnapshot.aggregate(endStages),
  ]);

  const startByVideo = new Map(startSnaps.map((s) => [s._id.toString(), s.views ?? 0]));
  const totals = new Map();
  for (const e of endSnaps) {
    const vid = e._id.toString();
    if (!startByVideo.has(vid)) continue;
    const cid = e.channelId.toString();
    const startV = startByVideo.get(vid);
    const delta = Math.max(0, (e.views ?? 0) - startV);
    totals.set(cid, (totals.get(cid) ?? 0) + delta);
  }
  return totals;
}

function mapChannel(c, periodMetrics = null, classificationCounts = null) {
  const subs   = c.currentStats?.subscribers ?? 0;
  const views  = c.currentStats?.views       ?? 0;
  const videos = c.currentStats?.videoCount  ?? 0;
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

/** Map UI/API sort keys to Mongo fields on Video for .find().sort() */
function mapVideoSortForFind(sortStr) {
  const { key, dir } = parseVideoSort(sortStr);
  const alias = {
    published_at: 'publishedAt',
    last_synced: 'lastSyncedAt',
    youtube_video_id: 'youtubeVideoId',
  };
  const mongoKey = alias[key] || key;
  const allowed = new Set([
    'title', 'views', 'likes', 'comments', 'classification', 'duration',
    'publishedAt', 'lastSyncedAt', 'youtubeVideoId',
  ]);
  if (!allowed.has(mongoKey)) {
    return { views: dir };
  }
  return { [mongoKey]: dir };
}

function needsAggregateVideoSort(sortStr) {
  const key = String(sortStr || '').replace(/^-/, '');
  return ['channel', 'category', 'engagement_rate', 'outlier_score'].includes(key);
}

/**
 * Fetch videos with correct ordering. Channel / category / engagement / outlier
 * require $lookup + computed fields; published_at etc. map to Video schema fields.
 */
async function fetchVideosForReportSorted(videoFilter, sortStr, skip, limit, isExport) {
  const { key, dir } = parseVideoSort(sortStr);
  const channelColl = Channel.collection.collectionName;

  if (needsAggregateVideoSort(sortStr)) {
    let globalAvg = 1;
    if (key === 'outlier_score') {
      const avgAgg = await Video.aggregate([
        { $match: videoFilter },
        { $group: { _id: null, avg: { $avg: '$views' } } },
      ]);
      globalAvg = avgAgg[0]?.avg || 1;
    }

    const pipeline = [
      { $match: videoFilter },
      { $lookup: { from: channelColl, localField: 'channelId', foreignField: '_id', as: 'ch' } },
      { $unwind: { path: '$ch', preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          _engagementRate: {
            $cond: [
              { $gt: [{ $ifNull: ['$views', 0] }, 0] },
              {
                $multiply: [
                  {
                    $divide: [
                      { $add: [{ $ifNull: ['$likes', 0] }, { $ifNull: ['$comments', 0] }] },
                      '$views',
                    ],
                  },
                  100,
                ],
              },
              0,
            ],
          },
          _outlierScore: {
            $divide: [{ $ifNull: ['$views', 0] }, { $literal: globalAvg || 1 }],
          },
        },
      },
    ];

    const sortFieldMap = {
      channel: 'ch.title',
      category: 'ch.category',
      engagement_rate: '_engagementRate',
      outlier_score: '_outlierScore',
    };
    const sortField = sortFieldMap[key] || 'views';
    pipeline.push({ $sort: { [sortField]: dir } });
    if (!isExport) {
      pipeline.push({ $skip: skip });
      if (limit > 0) pipeline.push({ $limit: limit });
    }

    const docs = await Video.aggregate(pipeline);
    const channelMap = {};
    const videos = docs.map((doc) => {
      if (doc.ch && doc.channelId) {
        channelMap[doc.channelId.toString()] = doc.ch;
      }
      const { ch, _engagementRate, _outlierScore, ...rest } = doc;
      return rest;
    });
    return { videos, channelMap };
  }

  const sortObj = mapVideoSortForFind(sortStr);
  let q = Video.find(videoFilter).sort(sortObj);
  if (!isExport) {
    q = q.skip(skip);
    if (limit > 0) q = q.limit(limit);
  }
  const videos = await q.lean();
  return { videos, channelMap: null };
}

function mapVideo(v, channelMap, avgViews) {
  const ch = channelMap[v.channelId?.toString()] || {};
  const engagement = v.views > 0
    ? (((v.likes + v.comments) / v.views) * 100).toFixed(2)
    : '0.00';
  const outlierScore = avgViews > 0
    ? parseFloat((v.views / avgViews).toFixed(2))
    : 0;
  return {
    title:            v.title,
    youtube_video_id: v.youtubeVideoId,
    channel:          ch.title    || '',
    category:         ch.category || '',
    classification: v.classification === 'non sadhguru' ? '-' : (v.classification || '—'),
    published_at:     v.publishedAt ? utcDateString(v.publishedAt) : '',
    views:            v.views    ?? 0,
    likes:            v.likes    ?? 0,
    comments:         v.comments ?? 0,
    engagement_rate:  parseFloat(engagement),
    outlier_score:    outlierScore,
    duration:         v.duration || '',
    last_synced:      v.lastSyncedAt ? utcDateString(v.lastSyncedAt) : '',
  };
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

    const filter = buildChannelFilter(req.query);

    if (req.query.classification) {
      const cls = req.query.classification === 'sadhguru' ? 'sadhguru' : 'non sadhguru';
      const ids = await Video.distinct('channelId', { classification: cls, deletedAt: null });
      filter._id = { $in: ids };
    }

    const isPeriodMode = !!(startDate && endDate);

    const isExport = format === 'csv' || format === 'excel';
    const lim      = isExport ? 0 : parseInt(limit); // 0 = no limit for exports

    let channels;
    let total;
    let summary = null;

    let rows;
    if (isPeriodMode) {
      // Fetch all matching channels (no skip/limit yet — we need to compute period metrics and sort)
      channels = await Channel.find(filter)
        .populate('assignedTo', 'name email')
        .lean();
      total = channels.length;

      const channelIds = channels.map((c) => c._id);
      const startDateObj = parseYmdToUtcStart(startDate);
      const endDateObj   = parseYmdToUtcEnd(endDate);
      const snapshotFilter = { channelId: { $in: channelIds }, deletedAt: null };

      const [startSnapshots, endSnapshots] = await Promise.all([
        ChannelSnapshot.aggregate([
          { $match: { ...snapshotFilter, date: { $gte: startDateObj, $lte: endDateObj } } },
          { $sort: { date: 1 } },
          {
            $group: {
              _id: '$channelId',
              views: { $first: '$views' },
              subscribers: { $first: '$subscribers' },
              videoCount: { $first: '$videoCount' },
            },
          },
        ]),
        ChannelSnapshot.aggregate([
          { $match: { ...snapshotFilter, date: { $lte: endDateObj } } },
          { $sort: { date: -1 } },
          {
            $group: {
              _id: '$channelId',
              views: { $first: '$views' },
              subscribers: { $first: '$subscribers' },
              videoCount: { $first: '$videoCount' },
            },
          },
        ]),
      ]);

      const startMap = new Map(startSnapshots.map((s) => [s._id.toString(), s]));
      const endMap   = new Map(endSnapshots.map((s) => [s._id.toString(), s]));

      const classMap = await getClassificationCountsByChannel(channelIds, { startDate, endDate });

      const clsParam = req.query.classification;
      let periodViewsByChannel = null;
      if (clsParam === 'sadhguru' || clsParam === 'non_sadhguru') {
        periodViewsByChannel = await getClassificationPeriodViewsByChannel(
          channelIds,
          startDateObj,
          endDateObj,
          clsParam
        );
      }

      rows = channels.map((c) => {
        const start = startMap.get(c._id.toString());
        const end   = endMap.get(c._id.toString()) || start;
        if (!start) {
          return mapChannel(c, {
            viewsInPeriod: 0,
            subscribersInPeriod: 0,
            videosInPeriod: 0,
          }, classMap.get(c._id.toString()));
        }
        const startViews = start?.views ?? 0;
        const endViews   = end?.views   ?? 0;
        const startSubs  = start?.subscribers ?? 0;
        const endSubs    = end?.subscribers   ?? 0;
        const startVideos = start?.videoCount ?? 0;
        const endVideos   = end?.videoCount ?? 0;
        const channelViewsInPeriod = Math.max(0, endViews - startViews);
        const periodMetrics = {
          viewsInPeriod:
            periodViewsByChannel != null
              ? (periodViewsByChannel.get(c._id.toString()) ?? 0)
              : channelViewsInPeriod,
          subscribersInPeriod: endSubs - startSubs,
          videosInPeriod:      endVideos - startVideos,
        };
        return mapChannel(c, periodMetrics, classMap.get(c._id.toString()));
      });

      // Sort by requested field (support period fields)
      const rawKey = sort.replace(/^[-+]/, '');
      const sortDir = sort.startsWith('-') ? -1 : 1;
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
            totalSubscribers: acc.totalSubscribers + z(r.subscribers),
            totalViews: acc.totalViews + z(r.total_views),
            totalVideos: acc.totalVideos + z(r.video_count),
            totalViewsInPeriod: acc.totalViewsInPeriod + z(r.views_in_period),
            totalSubscribersInPeriod: acc.totalSubscribersInPeriod + z(r.subscribers_in_period),
            totalVideosInPeriod: acc.totalVideosInPeriod + z(r.videos_in_period),
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

      const skip = isExport ? 0 : (parseInt(page) - 1) * parseInt(limit);
      if (!isExport) rows = rows.slice(skip, skip + parseInt(limit));
    } else {
      const skip = isExport ? 0 : (parseInt(page) - 1) * parseInt(limit);
      const query = Channel.find(filter)
        .populate('assignedTo', 'name email')
        .sort(sort);

      if (!isExport) query.skip(skip).limit(lim);

      [channels, total] = await Promise.all([
        query,
        Channel.countDocuments(filter),
      ]);
      const channelIds = channels.map((c) => c._id);
      const classMap = await getClassificationCountsByChannel(channelIds);
      rows = channels.map((c) => mapChannel(c, null, classMap.get(c._id.toString())));
    }

    /* ── Summary (for JSON, non-period mode) ── */
    if (format === 'json' && !summary) {
      const agg = await Channel.aggregate([
        { $match: filter },
        { $group: {
          _id: null,
          totalChannels:   { $sum: 1 },
          totalSubscribers: { $sum: { $ifNull: ['$currentStats.subscribers', 0] } },
          totalViews:      { $sum: { $ifNull: ['$currentStats.views', 0] } },
          totalVideos:     { $sum: { $ifNull: ['$currentStats.videoCount', 0] } },
        }},
      ]);
      summary = agg[0] ? {
        totalChannels:    agg[0].totalChannels,
        totalSubscribers: agg[0].totalSubscribers,
        totalViews:       agg[0].totalViews,
        totalVideos:      agg[0].totalVideos,
      } : { totalChannels: 0, totalSubscribers: 0, totalViews: 0, totalVideos: 0 };
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
        { header: 'Sadhguru Videos',     key: 'sadhguru_count',     width: 16 },
        { header: 'Tags',                key: 'tags',                width: 24 },
        { header: 'Subscribers',         key: 'subscribers',         width: 16 },
        { header: 'Total Views',         key: 'total_views',         width: 16 },
        ...(isPeriodMode
          ? [
              { header: 'Views (Period)',      key: 'views_in_period',       width: 16 },
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

    const { channelFilter, videoFilter } = buildVideoFilter(req.query);

    // Resolve channel IDs from channel-level filters
    if (Object.keys(channelFilter).length > 0) {
      const matchedChannels = await Channel.find(channelFilter).select('_id');
      const ids = matchedChannels.map((c) => c._id);
      // Merge with any explicit channelId filter
      videoFilter.channelId = videoFilter.channelId
        ? videoFilter.channelId  // already filtered above
        : { $in: ids };
    }

    const isExport = format === 'csv' || format === 'excel';
    const skip     = isExport ? 0 : (parseInt(page) - 1) * parseInt(limit);
    const lim      = isExport ? 0 : parseInt(limit);

    videoFilter.deletedAt = null;

    const summaryPipeline = format === 'json'
      ? Video.aggregate([
          { $match: videoFilter },
          {
            $group: {
              _id: null,
              totalVideos: { $sum: 1 },
              totalViews: { $sum: { $ifNull: ['$views', 0] } },
              totalLikes: { $sum: { $ifNull: ['$likes', 0] } },
              totalComments: { $sum: { $ifNull: ['$comments', 0] } },
            },
          },
        ])
      : Promise.resolve(null);

    const [sortedResult, total, summaryAgg] = await Promise.all([
      fetchVideosForReportSorted(videoFilter, sort, skip, lim, isExport),
      Video.countDocuments(videoFilter),
      summaryPipeline,
    ]);

    const { videos, channelMap: aggChannelMap } = sortedResult;

    const summary = format === 'json'
      ? (summaryAgg?.[0]
        ? {
            totalVideos: summaryAgg[0].totalVideos,
            totalViews: summaryAgg[0].totalViews,
            totalLikes: summaryAgg[0].totalLikes,
            totalComments: summaryAgg[0].totalComments,
          }
        : { totalVideos: 0, totalViews: 0, totalLikes: 0, totalComments: 0 })
      : undefined;

    // Build channel map for joined fields (aggregate path may have pre-filled)
    let channelMap = aggChannelMap;
    if (!channelMap) {
      const channelIds = [...new Set(videos.map((v) => v.channelId?.toString()).filter(Boolean))];
      const channelDocs = await Channel.find({ _id: { $in: channelIds } }).select('title category');
      channelMap = {};
      channelDocs.forEach((c) => { channelMap[c._id.toString()] = c; });
    }

    const avgViews = videos.length
      ? videos.reduce((s, v) => s + (v.views ?? 0), 0) / videos.length
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
        { header: 'Category',        key: 'category',         width: 18 },
        { header: 'Classification',  key: 'classification',   width: 16 },
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
