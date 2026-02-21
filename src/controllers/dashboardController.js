import Channel from '../models/Channel.js';
import ChannelSnapshot from '../models/ChannelSnapshot.js';
import Video from '../models/Video.js';
import DashboardLayout from '../models/DashboardLayout.js';

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
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);

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
