import Channel from '../models/Channel.js';
import ChannelSnapshot from '../models/ChannelSnapshot.js';
import Video from '../models/Video.js';
import VideoSnapshot from '../models/VideoSnapshot.js';
import MicroUnit from '../models/MicroUnit.js';
import DashboardLayout from '../models/DashboardLayout.js';
import {
  parseYmdToUtcEnd,
  parseYmdToUtcStart,
  utcEndOfDay,
  utcStartOfDay,
} from '../utils/dateUtc.js';

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

function buildChannelFilter(query) {
  const filter = { status: { $ne: 'archived' } };
  if (query.assignedTo) filter.assignedTo = query.assignedTo;
  if (query.status)     filter.status     = query.status;
  if (query.tags && query.tags.trim()) {
    const tagList = query.tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (tagList.length) filter.tags = { $in: tagList };
  }
  // Group filter: 'dedicated' = category starts with "Dedicated", 'ihi' = category contains "IHI"
  if (query.group === 'dedicated') {
    filter.category = { $regex: /^Dedicated/i };
  } else if (query.group === 'ihi') {
    filter.category = { $regex: /IHI/i };
  } else if (query.category) {
    filter.category = query.category;
  }
  if (query.startDate || query.endDate) {
    filter.lastSyncedAt = {};
    if (query.startDate) filter.lastSyncedAt.$gte = parseYmdToUtcStart(query.startDate);
    if (query.endDate)   filter.lastSyncedAt.$lte = parseYmdToUtcEnd(query.endDate);
  }
  return filter;
}

export async function getSummary(req, res, next) {
  try {
    const channelFilter = buildChannelFilter(req.query);
    const channels = await Channel.find(channelFilter);
    const channelIds = channels.map((c) => c._id);
    const group = req.query.group;

    const totalChannels = channels.length;
    const totalSubscribers = channels.reduce(
      (sum, c) => sum + (c.currentStats?.subscribers || 0),
      0
    );

    // Dedicated: totalViews = sum of channel views. IHI: totalViews = sum of sadhguru video views (MongoDB aggregation)
    let totalViews;
    if (group === 'ihi') {
      const ihiViewsAgg = await Video.aggregate([
        {
          $match: {
            channelId: { $in: channelIds },
            classification: 'sadhguru',
            deletedAt: null,
          },
        },
        { $group: { _id: null, total: { $sum: '$views' } } },
      ]);
      totalViews = ihiViewsAgg[0]?.total ?? 0;
    } else {
      totalViews = channels.reduce(
        (sum, c) => sum + (c.currentStats?.views || 0),
        0
      );
    }

    // Get period comparison data
    const { period = '30d' } = req.query;
    const { start, end } = getDateRange(period, req.query);

    let prevSubscribers = 0;
    let prevViews = 0;

    if (group === 'ihi') {
      // IHI: prevViews = sum of first VideoSnapshot views in period for sadhguru videos
      const oldChannelSnapshots = await ChannelSnapshot.aggregate([
        { $match: { channelId: { $in: channelIds }, date: { $gte: start, $lte: end } } },
        { $sort: { date: 1 } },
        { $group: { _id: '$channelId', firstSubscribers: { $first: '$subscribers' } } },
      ]);
      prevSubscribers = oldChannelSnapshots.reduce((s, x) => s + (x.firstSubscribers || 0), 0);

      const ihiPrevViewsAgg = await VideoSnapshot.aggregate([
        { $match: { channelId: { $in: channelIds }, date: { $gte: start, $lte: end } } },
        { $lookup: { from: 'videos', localField: 'videoId', foreignField: '_id', as: 'video' } },
        { $unwind: '$video' },
        { $match: { 'video.classification': 'sadhguru' } },
        { $sort: { date: 1 } },
        { $group: { _id: '$videoId', firstViews: { $first: '$views' } } },
        { $group: { _id: null, total: { $sum: '$firstViews' } } },
      ]);
      prevViews = ihiPrevViewsAgg[0]?.total ?? 0;
    } else {
      const oldSnapshots = await ChannelSnapshot.aggregate([
        {
          $match: {
            channelId: { $in: channelIds },
            date: { $gte: start, $lte: end },
          },
        },
        { $sort: { date: 1 } },
        {
          $group: {
            _id: '$channelId',
            firstSubscribers: { $first: '$subscribers' },
            firstViews: { $first: '$views' },
          },
        },
      ]);
      prevSubscribers = oldSnapshots.reduce((sum, s) => sum + (s.firstSubscribers || 0), 0);
      prevViews = oldSnapshots.reduce((sum, s) => sum + (s.firstViews || 0), 0);
    }

    const subsChange = prevSubscribers
      ? ((totalSubscribers - prevSubscribers) / prevSubscribers) * 100
      : 0;
    const viewsChange = prevViews
      ? ((totalViews - prevViews) / prevViews) * 100
      : 0;

    // Videos published this period
    const videosMatch = { channelId: { $in: channelIds }, publishedAt: { $gte: start, $lte: end } };
    if (group === 'ihi') {
      videosMatch.classification = 'sadhguru';
    }
    const videosThisPeriod = await Video.countDocuments(videosMatch);

    // Average engagement rate (from recent videos)
    const recentVideosMatch = {
      channelId: { $in: channelIds },
      publishedAt: { $gte: start, $lte: end },
      views: { $gt: 0 },
      deletedAt: null,
    };
    if (group === 'ihi') {
      recentVideosMatch.classification = 'sadhguru';
    }
    const recentVideos = await Video.find(recentVideosMatch).select('views likes comments');

    let avgEngagement = 0;
    if (recentVideos.length > 0) {
      const totalEngagement = recentVideos.reduce((sum, v) => {
        return sum + ((v.likes + v.comments) / v.views) * 100;
      }, 0);
      avgEngagement = totalEngagement / recentVideos.length;
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
    const channels = await Channel.find(channelFilter).select('_id');
    const channelIds = channels.map((c) => c._id);
    const group = req.query.group;

    const { start, end } = getDateRange(period, req.query);

    let snapshots;
    if (group === 'ihi') {
      // IHI: views = sum of VideoSnapshot.views for sadhguru videos per day
      const ihiSnapshots = await VideoSnapshot.aggregate([
        { $match: { channelId: { $in: channelIds }, date: { $gte: start, $lte: end } } },
        { $lookup: { from: 'videos', localField: 'videoId', foreignField: '_id', as: 'video' } },
        { $unwind: '$video' },
        { $match: { 'video.classification': 'sadhguru' } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
            totalViews: { $sum: '$views' },
          },
        },
        { $sort: { _id: 1 } },
      ]);
      const channelSnapshots = await ChannelSnapshot.aggregate([
        { $match: { channelId: { $in: channelIds }, date: { $gte: start, $lte: end } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
            totalSubscribers: { $sum: '$subscribers' },
            totalVideos: { $sum: '$videoCount' },
          },
        },
        { $sort: { _id: 1 } },
      ]);
      const ihiMap = new Map(ihiSnapshots.map((s) => [s._id, s.totalViews]));
      snapshots = channelSnapshots.map((s) => ({
        ...s,
        totalViews: ihiMap.get(s._id) ?? 0,
      }));
    } else {
      snapshots = await ChannelSnapshot.aggregate([
        {
          $match: {
            channelId: { $in: channelIds },
            date: { $gte: start, $lte: end },
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
            totalSubscribers: { $sum: '$subscribers' },
            totalViews: { $sum: '$views' },
            totalVideos: { $sum: '$videoCount' },
          },
        },
        { $sort: { _id: 1 } },
      ]);
    }

    res.json(
      snapshots.map((s) => ({
        date: s._id,
        subscribers: s.totalSubscribers,
        views: s.totalViews,
        videoCount: s.totalVideos,
      }))
    );
  } catch (err) {
    next(err);
  }
}

export async function getTopChannels(req, res, next) {
  try {
    const { period = '30d', metric = 'subscribers', limit = 10 } = req.query;
    const channelFilter = buildChannelFilter(req.query);
    const channels = await Channel.find(channelFilter);
    const channelIds = channels.map((c) => c._id);

    const { start, end } = getDateRange(period, req.query);

    // Get first and latest snapshot for each channel
    const growthData = await ChannelSnapshot.aggregate([
      {
        $match: {
          channelId: { $in: channelIds },
          date: { $gte: start, $lte: end },
        },
      },
      {
        $sort: { date: 1 },
      },
      {
        $group: {
          _id: '$channelId',
          firstSubs: { $first: '$subscribers' },
          lastSubs: { $last: '$subscribers' },
          firstViews: { $first: '$views' },
          lastViews: { $last: '$views' },
        },
      },
      {
        $addFields: {
          subsGrowth: { $subtract: ['$lastSubs', '$firstSubs'] },
          viewsGrowth: { $subtract: ['$lastViews', '$firstViews'] },
        },
      },
      {
        $sort: metric === 'views' ? { viewsGrowth: -1 } : { subsGrowth: -1 },
      },
      { $limit: parseInt(limit) },
    ]);

    // Map channel info
    const channelMap = new Map();
    channels.forEach((c) => channelMap.set(c._id.toString(), c));

    const result = growthData.map((g) => {
      const ch = channelMap.get(g._id.toString());
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
    const channels = await Channel.find(channelFilter).select('_id title');
    const channelIds = channels.map((c) => c._id);
    const group = req.query.group;

    const { start, end } = getDateRange(period, req.query);

    const videosMatch = {
      channelId: { $in: channelIds },
      publishedAt: { $gte: start, $lte: end },
      deletedAt: null,
    };
    if (group === 'ihi') {
      videosMatch.classification = 'sadhguru';
    }
    const videos = await Video.find(videosMatch)
      .sort({ views: -1 })
      .limit(parseInt(limit))
      .populate('channelId', 'title thumbnailUrl');

    res.json(videos);
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
      const ids = await Video.distinct('channelId', { classification: cls, deletedAt: null });
      channelFilter._id = { $in: ids };
    }

    const channels = await Channel.find(channelFilter)
      .select('_id category')
      .lean();

    if (channels.length === 0) {
      return res.json([]);
    }

    const channelIds = channels.map((c) => c._id);

    if (isPeriodMode) {
      const startDateObj = parseYmdToUtcStart(startDate);
      const endDateObj = parseYmdToUtcEnd(endDate);
      const snapshotFilter = { channelId: { $in: channelIds }, deletedAt: null };

      const [startSnapshots, endSnapshots] = await Promise.all([
        ChannelSnapshot.aggregate([
          { $match: { ...snapshotFilter, date: { $gte: startDateObj, $lte: endDateObj } } },
          { $sort: { date: 1 } },
          { $group: { _id: '$channelId', views: { $first: '$views' }, subscribers: { $first: '$subscribers' } } },
        ]),
        ChannelSnapshot.aggregate([
          { $match: { ...snapshotFilter, date: { $lte: endDateObj } } },
          { $sort: { date: -1 } },
          { $group: { _id: '$channelId', views: { $first: '$views' }, subscribers: { $first: '$subscribers' } } },
        ]),
      ]);

      const startMap = new Map(startSnapshots.map((s) => [s._id.toString(), s]));
      const endMap = new Map(endSnapshots.map((s) => [s._id.toString(), s]));

      const channelPeriodData = channels.map((c) => {
        const start = startMap.get(c._id.toString());
        const end = endMap.get(c._id.toString()) || start;
        if (!start) {
          return {
            category: c.category || 'Uncategorized',
            viewsInPeriod: 0,
            subsInPeriod: 0,
          };
        }
        const startViews = start?.views ?? 0;
        const endViews = end?.views ?? 0;
        const startSubs = start?.subscribers ?? 0;
        const endSubs = end?.subscribers ?? 0;
        return {
          category: c.category || 'Uncategorized',
          viewsInPeriod: Math.max(0, endViews - startViews),
          subsInPeriod: endSubs - startSubs,
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

    const result = await Channel.aggregate([
      { $match: channelFilter },
      {
        $group: {
          _id: '$category',
          count:      { $sum: 1 },
          totalSubs:  { $sum: '$currentStats.subscribers' },
          totalViews: { $sum: '$currentStats.views' },
        },
      },
      { $sort: { totalViews: -1 } },
    ]);

    res.json(result.map((r) => ({
      category:   r._id || 'Uncategorized',
      count:      r.count,
      totalSubs:  r.totalSubs,
      totalViews: r.totalViews,
    })));
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
      const ids = await Video.distinct('channelId', { classification: cls, deletedAt: null });
      channelIdsWithClassification = new Set(ids.map((i) => i.toString()));
    }

    const microUnits = await MicroUnit.find()
      .populate('channelIds', 'currentStats')
      .lean();

    if (microUnits.length === 0) {
      return res.json([]);
    }

    const result = [];

    for (const unit of microUnits) {
      let rawIds = (unit.channelIds || [])
        .map((c) => (typeof c === 'object' && c?._id ? c._id : c))
        .filter(Boolean);

      if (channelIdsWithClassification) {
        rawIds = rawIds.filter((id) => channelIdsWithClassification.has(id.toString()));
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

      const channels = await Channel.find({ _id: { $in: rawIds }, ...channelFilter })
        .select('_id currentStats')
        .lean();

      const channelIds = channels.map((c) => c._id);

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
        const snapshotFilter = { channelId: { $in: channelIds }, deletedAt: null };

        const [startSnapshots, endSnapshots] = await Promise.all([
          ChannelSnapshot.aggregate([
            { $match: { ...snapshotFilter, date: { $gte: startDateObj, $lte: endDateObj } } },
            { $sort: { date: 1 } },
            { $group: { _id: '$channelId', views: { $first: '$views' }, subscribers: { $first: '$subscribers' } } },
          ]),
          ChannelSnapshot.aggregate([
            { $match: { ...snapshotFilter, date: { $lte: endDateObj } } },
            { $sort: { date: -1 } },
            { $group: { _id: '$channelId', views: { $first: '$views' }, subscribers: { $first: '$subscribers' } } },
          ]),
        ]);

        const startMap = new Map(startSnapshots.map((s) => [s._id.toString(), s]));
        const endMap = new Map(endSnapshots.map((s) => [s._id.toString(), s]));

        let totalViews = 0;
        let totalSubs = 0;
        for (const cid of channelIds) {
          const sid = cid.toString();
          const start = startMap.get(sid);
          const end = endMap.get(sid) || start;
          if (!start) continue;
          const startViews = start?.views ?? 0;
          const endViews = end?.views ?? 0;
          const startSubs = start?.subscribers ?? 0;
          const endSubs = end?.subscribers ?? 0;
          totalViews += Math.max(0, endViews - startViews);
          totalSubs += endSubs - startSubs;
        }

        const videoMatch = {
          channelId: { $in: channelIds },
          deletedAt: null,
          publishedAt: { $gte: startDateObj, $lte: endDateObj },
        };
        if (classification === 'sadhguru') videoMatch.classification = 'sadhguru';
        else if (classification === 'non_sadhguru') videoMatch.classification = 'non sadhguru';

        const totalVideos = await Video.countDocuments(videoMatch);

        result.push({
          name: unit.name,
          count: channelIds.length,
          totalSubs,
          totalViews,
          totalVideos,
        });
      } else {
        const totalSubs = channels.reduce((s, c) => s + (c.currentStats?.subscribers || 0), 0);
        const totalViews = channels.reduce((s, c) => s + (c.currentStats?.views || 0), 0);
        const totalVideos = channels.reduce((s, c) => s + (c.currentStats?.videoCount || 0), 0);

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
    const channels = await Channel.find(channelFilter)
      .select('_id title thumbnailUrl currentStats category')
      .lean();

    if (channels.length === 0) return res.json([]);

    const channelIds = channels.map((c) => c._id);

    // --- 1. Video aggregation: engagementEfficiency + loyaltyIndex ---
    const videoAgg = await Video.aggregate([
      { $match: { channelId: { $in: channelIds } } },
      {
        $group: {
          _id:           '$channelId',
          totalViews:    { $sum: '$views'    },
          totalLikes:    { $sum: '$likes'    },
          totalComments: { $sum: '$comments' },
        },
      },
    ]);
    const videoMap = new Map(videoAgg.map((v) => [v._id.toString(), v]));

    // --- 2. ChannelSnapshot: subscriber velocity (7-day lookback) ---
    const sevenDaysAgo = utcStartOfDay(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // For each channel get the most recent snapshot on or before 7 days ago
    const snapAgg = await ChannelSnapshot.aggregate([
      {
        $match: {
          channelId: { $in: channelIds },
          date: { $lte: sevenDaysAgo },
        },
      },
      { $sort: { date: -1 } },
      {
        $group: {
          _id:        '$channelId',
          subscribers: { $first: '$subscribers' },
        },
      },
    ]);
    const snapMap = new Map(snapAgg.map((s) => [s._id.toString(), s.subscribers]));

    // --- 3. Compose result ---
    const result = channels.map((ch) => {
      const vid = videoMap.get(ch._id.toString());
      const subs7dAgo = snapMap.get(ch._id.toString()) ?? null;
      const currentSubs = ch.currentStats?.subscribers ?? 0;
      const currentViews = ch.currentStats?.views ?? 0;
      const videoCount = ch.currentStats?.videoCount ?? 0;

      const totalViews    = vid?.totalViews    ?? 0;
      const totalLikes    = vid?.totalLikes    ?? 0;
      const totalComments = vid?.totalComments ?? 0;

      const engagementEfficiency =
        totalViews > 0 ? (totalLikes + totalComments) / totalViews : null;

      const subscriberVelocity =
        subs7dAgo != null && subs7dAgo > 0
          ? ((currentSubs - subs7dAgo) / subs7dAgo) * 100
          : null;

      const contentImpact =
        videoCount > 0 ? currentViews / videoCount : null;

      const loyaltyIndex =
        totalViews > 0 ? totalComments / totalViews : null;

      return {
        channelId:            ch._id,
        title:                ch.title,
        thumbnailUrl:         ch.thumbnailUrl,
        category:             ch.category,
        subscribers:          currentSubs,
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
    const channels = await Channel.find(channelFilter).select('_id');
    const channelIds = channels.map((c) => c._id);

    const { start, end } = getDateRange(period, req.query);

    const data = await Video.aggregate([
      {
        $match: {
          channelId: { $in: channelIds },
          publishedAt: { $gte: start, $lte: end },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$publishedAt' },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json(data.map((d) => ({ date: d._id, count: d.count })));
  } catch (err) {
    next(err);
  }
}

export async function getLayout(req, res, next) {
  try {
    const doc = await DashboardLayout.findOne();
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
    const doc = await DashboardLayout.findOneAndUpdate(
      {},
      { layouts, updatedBy: req.user.username || req.user.email || 'unknown' },
      { upsert: true, new: true }
    );
    res.json({ layouts: doc.layouts, updatedBy: doc.updatedBy });
  } catch (err) {
    next(err);
  }
}
