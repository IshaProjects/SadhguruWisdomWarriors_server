import Channel from '../models/Channel.js';
import ChannelSnapshot from '../models/ChannelSnapshot.js';
import Video from '../models/Video.js';
import VideoSnapshot from '../models/VideoSnapshot.js';
import SyncLog from '../models/SyncLog.js';
import {
  fetchChannelsBatch,
  fetchPlaylistItems,
  fetchAllPlaylistItemIds,
  fetchVideosBatch,
  fetchSingleChannel,
  getQuotaUsage,
} from './youtubeApi.js';
import { logger } from '../utils/logger.js';

let isChannelSyncing = false;
let isVideoSyncing   = false;
let isPullingAllVideos = false;

export function getSyncStatus() {
  return { isChannelSyncing, isVideoSyncing, isPullingAllVideos };
}

// ---------------------------------------------------------------------------
// Channel sync — updates Channel docs + ChannelSnapshot history
// ---------------------------------------------------------------------------
export async function syncChannelStats(channelIds = null, type = 'manual') {
  if (isChannelSyncing) {
    throw new Error('Channel sync already in progress');
  }

  isChannelSyncing = true;
  const syncLog = await SyncLog.create({
    syncType: 'channel',
    type,
    status: 'running',
    startedAt: new Date(),
  });

  try {
    const query = { status: { $ne: 'archived' } };
    if (channelIds) query._id = { $in: channelIds };
    const channels = await Channel.find(query);

    if (channels.length === 0) {
      syncLog.status = 'success';
      syncLog.completedAt = new Date();
      await syncLog.save();
      return syncLog;
    }

    const ytChannelIds = channels.map((c) => c.youtubeChannelId);
    let quotaUsed = 0;

    logger.info(`[Channel Sync] Syncing ${channels.length} channels...`);
    const channelData = await fetchChannelsBatch(ytChannelIds);
    quotaUsed += Math.ceil(ytChannelIds.length / 50);

    const channelMap = new Map(channels.map((ch) => [ch.youtubeChannelId, ch]));

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const ytChannel of channelData) {
      const channel = channelMap.get(ytChannel.id);
      if (!channel) continue;

      try {
        const stats    = ytChannel.statistics;
        const snippet  = ytChannel.snippet;
        const branding = ytChannel.brandingSettings;

        channel.title       = snippet.title;
        channel.description = snippet.description;
        channel.thumbnailUrl =
          snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || '';
        channel.bannerUrl         = branding?.image?.bannerExternalUrl || '';
        channel.customUrl         = snippet.customUrl  || '';
        channel.country           = snippet.country    || '';
        channel.publishedAt       = snippet.publishedAt;
        channel.uploadsPlaylistId =
          ytChannel.contentDetails?.relatedPlaylists?.uploads || '';

        channel.currentStats = {
          subscribers: parseInt(stats.subscriberCount) || 0,
          views:       parseInt(stats.viewCount)       || 0,
          videoCount:  parseInt(stats.videoCount)      || 0,
        };
        channel.lastSyncedAt = new Date();
        if (channel.allVideosPulled) {
          const ourVideoCount = await Video.countDocuments({ channelId: channel._id, deletedAt: null });
          if (ourVideoCount < channel.currentStats.videoCount) {
            channel.allVideosPulled = false;
          }
        }
        await channel.save();

        await ChannelSnapshot.findOneAndUpdate(
          { channelId: channel._id, date: today },
          {
            channelId:  channel._id,
            date:       today,
            subscribers: channel.currentStats.subscribers,
            views:       channel.currentStats.views,
            videoCount:  channel.currentStats.videoCount,
          },
          { upsert: true, new: true }
        );

        syncLog.channelsProcessed += 1;
      } catch (err) {
        logger.error(`[Channel Sync] Error on ${ytChannel.id}: ${err.message}`);
        syncLog.errors.push({ channelId: ytChannel.id, message: err.message });
      }
    }

    syncLog.quotaUsed    = quotaUsed;
    syncLog.status       = syncLog.errors.length > 0 ? 'partial' : 'success';
    syncLog.completedAt  = new Date();
    await syncLog.save();

    logger.info(
      `[Channel Sync] Done: ${syncLog.channelsProcessed} channels, ${quotaUsed} quota used`
    );
  } catch (err) {
    logger.error(`[Channel Sync] Failed: ${err.message}`);
    syncLog.status = 'failed';
    syncLog.errors.push({ channelId: 'global', message: err.message });
    syncLog.completedAt = new Date();
    await syncLog.save();
  } finally {
    isChannelSyncing = false;
  }

  return syncLog;
}

// ---------------------------------------------------------------------------
// Video sync — upserts Video docs + VideoSnapshot history
// ---------------------------------------------------------------------------
export async function syncVideoStats(channelIds = null, type = 'manual') {
  if (isVideoSyncing) {
    throw new Error('Video sync already in progress');
  }

  isVideoSyncing = true;
  const syncLog = await SyncLog.create({
    syncType: 'video',
    type,
    status: 'running',
    startedAt: new Date(),
  });

  try {
    const query = { status: { $ne: 'archived' } };
    if (channelIds) query._id = { $in: channelIds };
    const channels = await Channel.find(query);

    if (channels.length === 0) {
      syncLog.status = 'success';
      syncLog.completedAt = new Date();
      await syncLog.save();
      return syncLog;
    }

    let videosProcessed = 0;
    let quotaUsed       = 0;
    const quota = getQuotaUsage();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    logger.info(`[Video Sync] Syncing videos for ${channels.length} channels...`);

    for (const channel of channels) {
      if (!channel.uploadsPlaylistId) continue;

      if (quota.remaining < 10) {
        logger.warn('[Video Sync] Approaching quota limit, stopping');
        break;
      }

      try {
        const playlistItems = await fetchPlaylistItems(channel.uploadsPlaylistId, 10);
        quotaUsed += 1;

        if (playlistItems.length === 0) continue;

        const videoIds = playlistItems.map((item) => item.contentDetails.videoId);
        const videoData = await fetchVideosBatch(videoIds);
        quotaUsed += Math.ceil(videoIds.length / 50);

        for (const vid of videoData) {
          const views    = parseInt(vid.statistics?.viewCount)    || 0;
          const likes    = parseInt(vid.statistics?.likeCount)    || 0;
          const comments = parseInt(vid.statistics?.commentCount) || 0;

          const savedVideo = await Video.findOneAndUpdate(
            { youtubeVideoId: vid.id },
            {
              youtubeVideoId: vid.id,
              channelId:      channel._id,
              title:          vid.snippet?.title       || '',
              description:    vid.snippet?.description || '',
              thumbnailUrl:
                vid.snippet?.thumbnails?.high?.url ||
                vid.snippet?.thumbnails?.default?.url || '',
              publishedAt: vid.snippet?.publishedAt,
              views,
              likes,
              comments,
              duration:     vid.contentDetails?.duration || '',
              lastSyncedAt: new Date(),
            },
            { upsert: true, new: true }
          );

          await VideoSnapshot.findOneAndUpdate(
            { videoId: savedVideo._id, date: today },
            {
              videoId:   savedVideo._id,
              channelId: channel._id,
              date:      today,
              views,
              likes,
              comments,
            },
            { upsert: true, new: true }
          );

          videosProcessed++;
        }
      } catch (err) {
        if (err.message === 'QUOTA_EXCEEDED') {
          logger.error('[Video Sync] Quota exceeded');
          break;
        }
        logger.error(
          `[Video Sync] Error on channel ${channel.youtubeChannelId}: ${err.message}`
        );
        syncLog.errors.push({ channelId: channel.youtubeChannelId, message: err.message });
      }
    }

    syncLog.videosProcessed = videosProcessed;
    syncLog.quotaUsed       = quotaUsed;
    syncLog.status          = syncLog.errors.length > 0 ? 'partial' : 'success';
    syncLog.completedAt     = new Date();
    await syncLog.save();

    logger.info(
      `[Video Sync] Done: ${videosProcessed} videos, ${quotaUsed} quota used`
    );
  } catch (err) {
    logger.error(`[Video Sync] Failed: ${err.message}`);
    syncLog.status = 'failed';
    syncLog.errors.push({ channelId: 'global', message: err.message });
    syncLog.completedAt = new Date();
    await syncLog.save();
  } finally {
    isVideoSyncing = false;
  }

  return syncLog;
}

// ---------------------------------------------------------------------------
// Backward-compat alias: runs both channel + video syncs sequentially
// ---------------------------------------------------------------------------
export async function syncChannels(channelIds = null, type = 'manual') {
  await syncChannelStats(channelIds, type);
  await syncVideoStats(channelIds, type);
}

// ---------------------------------------------------------------------------
// Pull all videos for a single channel (batches of 100)
// ---------------------------------------------------------------------------
const PULL_VIDEO_BATCH_SIZE = 100;

export async function pullAllChannelVideos(channelId) {
  if (isPullingAllVideos) {
    throw new Error('Pull all videos already in progress');
  }

  isPullingAllVideos = true;
  const channel = await Channel.findById(channelId);
  if (!channel) {
    isPullingAllVideos = false;
    throw new Error('Channel not found');
  }

  let uploadsPlaylistId = channel.uploadsPlaylistId;
  if (!uploadsPlaylistId) {
    const ytChannel = await fetchSingleChannel(channel.youtubeChannelId);
    if (!ytChannel?.contentDetails?.relatedPlaylists?.uploads) {
      isPullingAllVideos = false;
      throw new Error('Channel has no uploads playlist');
    }
    uploadsPlaylistId = ytChannel.contentDetails.relatedPlaylists.uploads;
    channel.uploadsPlaylistId = uploadsPlaylistId;
    await channel.save();
  }

  try {
    logger.info(`[Pull All Videos] Fetching all video IDs for channel ${channel.youtubeChannelId}...`);
    const allVideoIds = await fetchAllPlaylistItemIds(uploadsPlaylistId);
    logger.info(`[Pull All Videos] Found ${allVideoIds.length} videos, processing in batches of ${PULL_VIDEO_BATCH_SIZE}`);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let videosProcessed = 0;

    for (let i = 0; i < allVideoIds.length; i += PULL_VIDEO_BATCH_SIZE) {
      const quota = getQuotaUsage();
      if (quota.remaining < 10) {
        logger.warn('[Pull All Videos] Approaching quota limit, stopping');
        break;
      }

      const batchIds = allVideoIds.slice(i, i + PULL_VIDEO_BATCH_SIZE);
      const videoData = await fetchVideosBatch(batchIds);

      for (const vid of videoData) {
        try {
          const views = parseInt(vid.statistics?.viewCount) || 0;
          const likes = parseInt(vid.statistics?.likeCount) || 0;
          const comments = parseInt(vid.statistics?.commentCount) || 0;

          const savedVideo = await Video.findOneAndUpdate(
            { youtubeVideoId: vid.id },
            {
              youtubeVideoId: vid.id,
              channelId: channel._id,
              title: vid.snippet?.title || '',
              description: vid.snippet?.description || '',
              thumbnailUrl:
                vid.snippet?.thumbnails?.high?.url ||
                vid.snippet?.thumbnails?.default?.url || '',
              publishedAt: vid.snippet?.publishedAt,
              views,
              likes,
              comments,
              duration: vid.contentDetails?.duration || '',
              lastSyncedAt: new Date(),
            },
            { upsert: true, new: true }
          );

          await VideoSnapshot.findOneAndUpdate(
            { videoId: savedVideo._id, date: today },
            {
              videoId: savedVideo._id,
              channelId: channel._id,
              date: today,
              views,
              likes,
              comments,
            },
            { upsert: true, new: true }
          );

          videosProcessed++;
        } catch (err) {
          logger.error(`[Pull All Videos] Error saving video ${vid.id}: ${err.message}`);
        }
      }
    }

    const allPulled = videosProcessed === allVideoIds.length;
    if (allPulled) {
      channel.allVideosPulled = true;
      await channel.save();
    }

    logger.info(`[Pull All Videos] Done: ${videosProcessed} videos for channel ${channel.title}`);
    return { videosProcessed, totalIds: allVideoIds.length, allVideosPulled: allPulled };
  } catch (err) {
    if (err.message === 'QUOTA_EXCEEDED') throw err;
    logger.error(`[Pull All Videos] Failed: ${err.message}`);
    throw err;
  } finally {
    isPullingAllVideos = false;
  }
}

// ---------------------------------------------------------------------------
// Pull all videos for all channels (one channel at a time, 100 videos per batch)
// ---------------------------------------------------------------------------
export async function pullAllChannelsVideos() {
  if (isPullingAllVideos) {
    throw new Error('Pull all videos already in progress');
  }

  const channels = await Channel.find({
    status: { $ne: 'archived' },
    allVideosPulled: { $ne: true },
  }).sort({ title: 1 });

  const channelsWithPlaylist = channels.filter(
    (ch) => ch.uploadsPlaylistId || ch.youtubeChannelId
  );

  if (channelsWithPlaylist.length === 0) {
    return {
      channelsProcessed: 0,
      channelsSkipped: 0,
      totalVideosPulled: 0,
      message: 'No channels need video pull (all already pulled or no uploads playlist)',
    };
  }

  let channelsProcessed = 0;
  let totalVideosPulled = 0;
  const errors = [];

  for (const channel of channelsWithPlaylist) {
    const quota = getQuotaUsage();
    if (quota.remaining < 10) {
      logger.warn('[Pull All Channels] Approaching quota limit, stopping');
      break;
    }

    try {
      const result = await pullAllChannelVideos(channel._id);
      channelsProcessed++;
      totalVideosPulled += result.videosProcessed;
    } catch (err) {
      if (err.message === 'QUOTA_EXCEEDED') {
        logger.warn('[Pull All Channels] Quota exceeded, stopping');
        break;
      }
      logger.error(`[Pull All Channels] Error on ${channel.title}: ${err.message}`);
      errors.push({ channelId: channel._id, title: channel.title, message: err.message });
    }
  }

  const channelsSkipped = channels.length - channelsWithPlaylist.length;
  logger.info(
    `[Pull All Channels] Done: ${channelsProcessed} channels, ${totalVideosPulled} videos pulled`
  );

  return {
    channelsProcessed,
    channelsSkipped,
    totalVideosPulled,
    errors: errors.length > 0 ? errors : undefined,
  };
}
