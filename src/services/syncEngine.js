import Channel from '../models/Channel.js';
import ChannelSnapshot from '../models/ChannelSnapshot.js';
import Video from '../models/Video.js';
import SyncLog from '../models/SyncLog.js';
import {
  fetchChannelsBatch,
  fetchPlaylistItems,
  fetchVideosBatch,
  getQuotaUsage,
} from './youtubeApi.js';
import { logger } from '../utils/logger.js';

let isSyncing = false;

export function getSyncStatus() {
  return { isSyncing };
}

export async function syncChannels(channelIds = null, type = 'manual') {
  if (isSyncing) {
    throw new Error('Sync already in progress');
  }

  isSyncing = true;
  const syncLog = await SyncLog.create({
    type,
    status: 'running',
    startedAt: new Date(),
  });

  try {
    // Get channels to sync
    const query = { status: { $ne: 'archived' } };
    if (channelIds) {
      query._id = { $in: channelIds };
    }
    const channels = await Channel.find(query);

    if (channels.length === 0) {
      syncLog.status = 'success';
      syncLog.completedAt = new Date();
      await syncLog.save();
      isSyncing = false;
      return syncLog;
    }

    const ytChannelIds = channels.map((c) => c.youtubeChannelId);
    let quotaUsed = 0;

    // 1. Fetch channel stats in batches
    logger.info(`Syncing ${channels.length} channels...`);
    const channelData = await fetchChannelsBatch(ytChannelIds);
    quotaUsed += Math.ceil(ytChannelIds.length / 50);

    const channelMap = new Map();
    for (const ch of channels) {
      channelMap.set(ch.youtubeChannelId, ch);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const ytChannel of channelData) {
      const channel = channelMap.get(ytChannel.id);
      if (!channel) continue;

      try {
        const stats = ytChannel.statistics;
        const snippet = ytChannel.snippet;
        const branding = ytChannel.brandingSettings;

        // Update channel info
        channel.title = snippet.title;
        channel.description = snippet.description;
        channel.thumbnailUrl =
          snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || '';
        channel.bannerUrl =
          branding?.image?.bannerExternalUrl || '';
        channel.customUrl = snippet.customUrl || '';
        channel.country = snippet.country || '';
        channel.publishedAt = snippet.publishedAt;
        channel.uploadsPlaylistId =
          ytChannel.contentDetails?.relatedPlaylists?.uploads || '';

        channel.currentStats = {
          subscribers: parseInt(stats.subscriberCount) || 0,
          views: parseInt(stats.viewCount) || 0,
          videoCount: parseInt(stats.videoCount) || 0,
        };
        channel.lastSyncedAt = new Date();
        await channel.save();

        // Create daily snapshot (upsert to avoid duplicates)
        await ChannelSnapshot.findOneAndUpdate(
          { channelId: channel._id, date: today },
          {
            channelId: channel._id,
            date: today,
            subscribers: channel.currentStats.subscribers,
            views: channel.currentStats.views,
            videoCount: channel.currentStats.videoCount,
          },
          { upsert: true, new: true }
        );

        syncLog.channelsProcessed += 1;
      } catch (err) {
        logger.error(`Error processing channel ${ytChannel.id}: ${err.message}`);
        syncLog.errors.push({
          channelId: ytChannel.id,
          message: err.message,
        });
      }
    }

    // 2. Fetch videos for each channel
    let videosProcessed = 0;
    const quota = getQuotaUsage();

    for (const channel of channels) {
      if (!channel.uploadsPlaylistId) continue;

      // Check quota before continuing
      if (quota.remaining < 10) {
        logger.warn('Approaching quota limit, stopping video sync');
        break;
      }

      try {
        const playlistItems = await fetchPlaylistItems(
          channel.uploadsPlaylistId,
          10
        );
        quotaUsed += 1;

        if (playlistItems.length === 0) continue;

        const videoIds = playlistItems.map(
          (item) => item.contentDetails.videoId
        );
        const videoData = await fetchVideosBatch(videoIds);
        quotaUsed += Math.ceil(videoIds.length / 50);

        for (const vid of videoData) {
          await Video.findOneAndUpdate(
            { youtubeVideoId: vid.id },
            {
              youtubeVideoId: vid.id,
              channelId: channel._id,
              title: vid.snippet?.title || '',
              description: vid.snippet?.description || '',
              thumbnailUrl:
                vid.snippet?.thumbnails?.high?.url ||
                vid.snippet?.thumbnails?.default?.url ||
                '',
              publishedAt: vid.snippet?.publishedAt,
              views: parseInt(vid.statistics?.viewCount) || 0,
              likes: parseInt(vid.statistics?.likeCount) || 0,
              comments: parseInt(vid.statistics?.commentCount) || 0,
              duration: vid.contentDetails?.duration || '',
              lastSyncedAt: new Date(),
            },
            { upsert: true, new: true }
          );
          videosProcessed++;
        }
      } catch (err) {
        if (err.message === 'QUOTA_EXCEEDED') {
          logger.error('Quota exceeded during video sync');
          break;
        }
        logger.error(
          `Error syncing videos for channel ${channel.youtubeChannelId}: ${err.message}`
        );
        syncLog.errors.push({
          channelId: channel.youtubeChannelId,
          message: err.message,
        });
      }
    }

    syncLog.videosProcessed = videosProcessed;
    syncLog.quotaUsed = quotaUsed;
    syncLog.status = syncLog.errors.length > 0 ? 'partial' : 'success';
    syncLog.completedAt = new Date();
    await syncLog.save();

    logger.info(
      `Sync complete: ${syncLog.channelsProcessed} channels, ${videosProcessed} videos, ${quotaUsed} quota used`
    );
  } catch (err) {
    logger.error(`Sync failed: ${err.message}`);
    syncLog.status = 'failed';
    syncLog.errors.push({ channelId: 'global', message: err.message });
    syncLog.completedAt = new Date();
    await syncLog.save();
  } finally {
    isSyncing = false;
  }

  return syncLog;
}
