import Channel from '../models/Channel.js';
import ChannelSnapshot from '../models/ChannelSnapshot.js';
import Video from '../models/Video.js';
import VideoSnapshot from '../models/VideoSnapshot.js';
import SyncLog from '../models/SyncLog.js';
import {
  fetchChannelsBatch,
  fetchPlaylistItems,
  fetchVideosBatch,
  getQuotaUsage,
} from './youtubeApi.js';
import { logger } from '../utils/logger.js';

let isChannelSyncing = false;
let isVideoSyncing   = false;

export function getSyncStatus() {
  return { isChannelSyncing, isVideoSyncing };
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
