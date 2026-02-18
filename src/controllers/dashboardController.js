import Channel from '../models/Channel.js';
import ChannelSnapshot from '../models/ChannelSnapshot.js';
import Video from '../models/Video.js';

/**
 * Returns { start, end } for filtering. Uses startDate/endDate query params if both
 * provided (ISO date strings YYYY-MM-DD), otherwise uses period (7d, 30d, 90d).
 */
function getDateRange(period, query = {}) {
  if (query.startDate && query.endDate) {
    const start = new Date(query.startDate);
    const end = new Date(query.endDate);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    if (start > end) return getDateRange(period, {}); // fallback if invalid
    return { start, end };
  }

  const end = new Date();
  const start = new Date();
  switch (period) {
    case '7d':
      start.setDate(start.getDate() - 7);
      break;
    case '30d':
      start.setDate(start.getDate() - 30);
      break;
    case '90d':
      start.setDate(start.getDate() - 90);
      break;
    default:
      start.setDate(start.getDate() - 30);
  }
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function buildChannelFilter(query) {
  const filter = { status: { $ne: 'archived' } };
  if (query.category) filter.category = query.category;
  if (query.tags && query.tags.trim()) {
    const tagList = query.tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (tagList.length) filter.tags = { $in: tagList };
  }
  if (query.assignedTo) filter.assignedTo = query.assignedTo;
  if (query.status) filter.status = query.status;
  return filter;
}

export async function getSummary(req, res, next) {
  try {
    const channelFilter = buildChannelFilter(req.query);
    const channels = await Channel.find(channelFilter);
    const channelIds = channels.map((c) => c._id);

    const totalChannels = channels.length;
    const totalSubscribers = channels.reduce(
      (sum, c) => sum + (c.currentStats?.subscribers || 0),
      0
    );
    const totalViews = channels.reduce(
      (sum, c) => sum + (c.currentStats?.views || 0),
      0
    );

    // Get period comparison data
    const { period = '30d' } = req.query;
    const { start, end } = getDateRange(period, req.query);

    // Get earliest snapshots in the period for comparison
    const oldSnapshots = await ChannelSnapshot.aggregate([
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
          firstSubscribers: { $first: '$subscribers' },
          firstViews: { $first: '$views' },
        },
      },
    ]);

    const prevSubscribers = oldSnapshots.reduce(
      (sum, s) => sum + (s.firstSubscribers || 0),
      0
    );
    const prevViews = oldSnapshots.reduce(
      (sum, s) => sum + (s.firstViews || 0),
      0
    );

    const subsChange = prevSubscribers
      ? ((totalSubscribers - prevSubscribers) / prevSubscribers) * 100
      : 0;
    const viewsChange = prevViews
      ? ((totalViews - prevViews) / prevViews) * 100
      : 0;

    // Videos published this period
    const videosThisPeriod = await Video.countDocuments({
      channelId: { $in: channelIds },
      publishedAt: { $gte: start, $lte: end },
    });

    // Average engagement rate (from recent videos)
    const recentVideos = await Video.find({
      channelId: { $in: channelIds },
      publishedAt: { $gte: start, $lte: end },
      views: { $gt: 0 },
    }).select('views likes comments');

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

    const { start, end } = getDateRange(period, req.query);

    const snapshots = await ChannelSnapshot.aggregate([
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

    const { start, end } = getDateRange(period, req.query);

    const videos = await Video.find({
      channelId: { $in: channelIds },
      publishedAt: { $gte: start, $lte: end },
    })
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
    const channelFilter = buildChannelFilter(req.query);
    const result = await Channel.aggregate([
      { $match: channelFilter },
      {
        $group: {
          _id: '$category',
          count: { $sum: 1 },
          totalSubs: { $sum: '$currentStats.subscribers' },
        },
      },
      { $sort: { count: -1 } },
    ]);

    res.json(result.map((r) => ({
      category: r._id,
      count: r.count,
      totalSubs: r.totalSubs,
    })));
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
