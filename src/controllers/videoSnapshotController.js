import mongoose from 'mongoose';
import VideoSnapshot from '../models/VideoSnapshot.js';
import Video from '../models/Video.js';

/**
 * GET /api/video-snapshots/video/:videoId
 * Returns daily snapshot history for a single video.
 * Query: startDate, endDate (YYYY-MM-DD, optional — defaults to last 90 days)
 */
export async function getVideoSnapshots(req, res, next) {
  try {
    const { videoId } = req.params;
    const { startDate, endDate } = req.query;

    const end = endDate ? new Date(endDate) : new Date();
    end.setHours(23, 59, 59, 999);

    const start = startDate ? new Date(startDate) : new Date();
    if (!startDate) start.setDate(start.getDate() - 90);
    start.setHours(0, 0, 0, 0);

    const snapshots = await VideoSnapshot.find({
      videoId,
      date: { $gte: start, $lte: end },
      deletedAt: null,
    })
      .sort({ date: 1 })
      .lean();

    res.json(snapshots);
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

    const end = endDate ? new Date(endDate) : new Date();
    end.setHours(23, 59, 59, 999);

    const start = startDate ? new Date(startDate) : new Date();
    if (!startDate) start.setDate(start.getDate() - 30);
    start.setHours(0, 0, 0, 0);

    // 1. Daily aggregated trend across all videos in the channel
    const dailyTrend = await VideoSnapshot.aggregate([
      {
        $match: {
          channelId: new mongoose.Types.ObjectId(channelId),
          date: { $gte: start, $lte: end },
          deletedAt: null,
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
          totalViews:    { $sum: '$views' },
          totalLikes:    { $sum: '$likes' },
          totalComments: { $sum: '$comments' },
          videoCount:    { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // 2. Top videos by total views in the period (with trend per video)
    const videoTrends = await VideoSnapshot.aggregate([
      {
        $match: {
          channelId: new mongoose.Types.ObjectId(channelId),
          date: { $gte: start, $lte: end },
          deletedAt: null,
        },
      },
      {
        $group: {
          _id: '$videoId',
          totalViews:    { $sum: '$views' },
          totalLikes:    { $sum: '$likes' },
          totalComments: { $sum: '$comments' },
          firstViews:    { $first: '$views' },
          lastViews:     { $last: '$views' },
          dataPoints:    { $push: { date: '$date', views: '$views', likes: '$likes', comments: '$comments' } },
        },
      },
      { $sort: { totalViews: -1 } },
      { $limit: 10 },
    ]);

    // Populate video metadata
    const videoIds = videoTrends.map((v) => v._id);
    const videos = await Video.find({ _id: { $in: videoIds }, deletedAt: null }).select('title thumbnailUrl youtubeVideoId publishedAt');
    const videoMap = new Map(videos.map((v) => [v._id.toString(), v]));

    const enriched = videoTrends.map((v) => ({
      ...v,
      video: videoMap.get(v._id.toString()) || null,
      viewsGrowth: v.lastViews - v.firstViews,
      dataPoints: v.dataPoints
        .sort((a, b) => new Date(a.date) - new Date(b.date))
        .map((d) => ({
          date: d.date.toISOString().slice(0, 10),
          views: d.views,
          likes: d.likes,
          comments: d.comments,
        })),
    }));

    res.json({
      dailyTrend: dailyTrend.map((d) => ({
        date:          d._id,
        views:         d.totalViews,
        likes:         d.totalLikes,
        comments:      d.totalComments,
        videoCount:    d.videoCount,
      })),
      topVideos: enriched,
    });
  } catch (err) {
    next(err);
  }
}
