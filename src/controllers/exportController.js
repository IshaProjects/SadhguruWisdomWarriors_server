import { Parser } from '@json2csv/plainjs';
import ExcelJS from 'exceljs';
import Channel from '../models/Channel.js';
import Video from '../models/Video.js';

/* ─────────────────────────────────────────────────────────────────────
   Helpers
───────────────────────────────────────────────────────────────────── */

function buildChannelFilter(query) {
  const { search, category, status, tags, minSubs, maxSubs, minViews, maxViews, country } = query;
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
  return filter;
}

function buildVideoFilter(query) {
  const { search, channelId, category, tags, status, minViews, maxViews, startDate, endDate } = query;
  const channelFilter = {};
  const videoFilter   = {};

  if (category) channelFilter.category = category;
  if (status)   channelFilter.status   = status;
  if (tags && tags.trim()) {
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (tagList.length) channelFilter.tags = { $in: tagList };
  }

  if (channelId) videoFilter.channelId = channelId;

  if (search) {
    videoFilter.$or = [
      { title:          { $regex: search, $options: 'i' } },
      { youtubeVideoId: { $regex: search, $options: 'i' } },
    ];
  }
  if (minViews || maxViews) {
    videoFilter.views = {};
    if (minViews) videoFilter.views.$gte = parseInt(minViews);
    if (maxViews) videoFilter.views.$lte = parseInt(maxViews);
  }
  if (startDate || endDate) {
    videoFilter.publishedAt = {};
    if (startDate) videoFilter.publishedAt.$gte = new Date(startDate);
    if (endDate)   videoFilter.publishedAt.$lte = new Date(endDate + 'T23:59:59.999Z');
  }

  return { channelFilter, videoFilter };
}

function mapChannel(c) {
  const subs   = c.currentStats?.subscribers ?? 0;
  const views  = c.currentStats?.views       ?? 0;
  const videos = c.currentStats?.videoCount  ?? 0;
  const avgViewsPerVideo = videos > 0 ? Math.round(views / videos) : 0;
  return {
    title:               c.title,
    youtube_channel_id:  c.youtubeChannelId,
    custom_url:          c.customUrl || '',
    country:             c.country   || '',
    category:            c.category  || '',
    status:              c.status    || '',
    tags:                c.tags?.join('; ') || '',
    subscribers:         subs,
    total_views:         views,
    video_count:         videos,
    avg_views_per_video: avgViewsPerVideo,
    assigned_to:         c.assignedTo?.name || '',
    notes:               c.notes || '',
    last_synced:         c.lastSyncedAt ? c.lastSyncedAt.toISOString().slice(0, 10) : '',
  };
}

function mapVideo(v, channelMap) {
  const ch = channelMap[v.channelId?.toString()] || {};
  const engagement = v.views > 0
    ? (((v.likes + v.comments) / v.views) * 100).toFixed(2)
    : '0.00';
  return {
    title:            v.title,
    youtube_video_id: v.youtubeVideoId,
    channel:          ch.title    || '',
    category:         ch.category || '',
    published_at:     v.publishedAt ? v.publishedAt.toISOString().slice(0, 10) : '',
    views:            v.views    ?? 0,
    likes:            v.likes    ?? 0,
    comments:         v.comments ?? 0,
    engagement_rate:  parseFloat(engagement),
    duration:         v.duration || '',
    last_synced:      v.lastSyncedAt ? v.lastSyncedAt.toISOString().slice(0, 10) : '',
  };
}

/* ─────────────────────────────────────────────────────────────────────
   Channel report — GET /api/export/report/channels
   ?format=json|csv|excel  + all filter params + sort + page + limit
───────────────────────────────────────────────────────────────────── */
export async function reportChannels(req, res, next) {
  try {
    const {
      format = 'json',
      sort   = '-currentStats.subscribers',
      page   = 1,
      limit  = 50,
    } = req.query;

    const filter = buildChannelFilter(req.query);

    const isExport = format === 'csv' || format === 'excel';
    const skip     = isExport ? 0 : (parseInt(page) - 1) * parseInt(limit);
    const lim      = isExport ? 0 : parseInt(limit); // 0 = no limit for exports

    const query = Channel.find(filter)
      .populate('assignedTo', 'name email')
      .sort(sort);

    if (!isExport) query.skip(skip).limit(lim);

    const [channels, total] = await Promise.all([
      query,
      Channel.countDocuments(filter),
    ]);

    const rows = channels.map(mapChannel);

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
      });
    }

    const filename = `channel-report-${new Date().toISOString().slice(0, 10)}`;

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
      wb.creator = 'YT Manager';
      const ws  = wb.addWorksheet('Channels');

      ws.columns = [
        { header: 'Title',               key: 'title',               width: 40 },
        { header: 'YouTube Channel ID',  key: 'youtube_channel_id',  width: 26 },
        { header: 'Custom URL',          key: 'custom_url',          width: 22 },
        { header: 'Country',             key: 'country',             width: 10 },
        { header: 'Category',            key: 'category',            width: 18 },
        { header: 'Status',              key: 'status',              width: 10 },
        { header: 'Tags',                key: 'tags',                width: 24 },
        { header: 'Subscribers',         key: 'subscribers',         width: 16 },
        { header: 'Total Views',         key: 'total_views',         width: 16 },
        { header: 'Video Count',         key: 'video_count',         width: 14 },
        { header: 'Avg Views/Video',     key: 'avg_views_per_video', width: 18 },
        { header: 'Assigned To',         key: 'assigned_to',         width: 18 },
        { header: 'Notes',               key: 'notes',               width: 30 },
        { header: 'Last Synced',         key: 'last_synced',         width: 14 },
      ];

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

    const query = Video.find(videoFilter).sort(sort);
    if (!isExport) query.skip(skip).limit(lim);

    const [videos, total] = await Promise.all([
      query,
      Video.countDocuments(videoFilter),
    ]);

    // Build channel map for joined fields
    const channelIds  = [...new Set(videos.map((v) => v.channelId?.toString()).filter(Boolean))];
    const channelDocs = await Channel.find({ _id: { $in: channelIds } }).select('title category');
    const channelMap  = {};
    channelDocs.forEach((c) => { channelMap[c._id.toString()] = c; });

    const rows = videos.map((v) => mapVideo(v, channelMap));

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
      });
    }

    const filename = `video-report-${new Date().toISOString().slice(0, 10)}`;

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
      wb.creator = 'YT Manager';
      const ws = wb.addWorksheet('Videos');

      ws.columns = [
        { header: 'Title',            key: 'title',            width: 50 },
        { header: 'YouTube Video ID', key: 'youtube_video_id', width: 20 },
        { header: 'Channel',          key: 'channel',          width: 30 },
        { header: 'Category',         key: 'category',         width: 18 },
        { header: 'Published At',     key: 'published_at',     width: 14 },
        { header: 'Views',            key: 'views',            width: 14 },
        { header: 'Likes',            key: 'likes',            width: 12 },
        { header: 'Comments',         key: 'comments',         width: 12 },
        { header: 'Engagement Rate%', key: 'engagement_rate',  width: 18 },
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
