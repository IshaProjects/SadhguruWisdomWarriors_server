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
  fetchPlaylistItemsPublishedSince,
  getQuotaUsage,
} from './youtubeApi.js';
import { classifySadguruVideoBatch } from './vertexAiService.js';
import { isDedicatedChannel, isIhiChannel } from '../utils/channelGroup.js';
import { logger } from '../utils/logger.js';

let isChannelSyncing = false;
let isVideoSyncing = false;
let isIhiIngestSyncing = false;
let isIhiSadhguruStatsSyncing = false;
let isPullingAllVideos = false;

const MS_24H = 24 * 60 * 60 * 1000;

export function getSyncStatus() {
  return {
    isChannelSyncing,
    isVideoSyncing,
    isIhiIngestSyncing,
    isIhiSadhguruStatsSyncing,
    isPullingAllVideos,
  };
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
    const channels = (await Channel.find(query)).filter(isDedicatedChannel);

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

    logger.info(
      `[Video Sync] Dedicated channels only — syncing videos for ${channels.length} channels...`
    );

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
// IHI — last 24h uploads, upsert, then Vertex classify (title + description)
// ---------------------------------------------------------------------------
export async function syncIhiIngestLast24h(channelIds = null, type = 'manual') {
  if (isIhiIngestSyncing) {
    throw new Error('IHI ingest sync already in progress');
  }

  isIhiIngestSyncing = true;
  const syncLog = await SyncLog.create({
    syncType: 'ihi_ingest',
    type,
    status: 'running',
    startedAt: new Date(),
  });

  try {
    const query = { status: { $ne: 'archived' } };
    if (channelIds) query._id = { $in: channelIds };
    const channels = (await Channel.find(query)).filter(isIhiChannel);

    if (channels.length === 0) {
      syncLog.status = 'success';
      syncLog.completedAt = new Date();
      await syncLog.save();
      return syncLog;
    }

    const since = new Date(Date.now() - MS_24H);
    let videosProcessed = 0;
    let quotaUsed = 0;
    let classified = 0;

    logger.info(
      `[IHI Ingest] ${channels.length} channels, videos published since ${since.toISOString()}`
    );

    for (const channel of channels) {
      if (!channel.uploadsPlaylistId) continue;

      const quota = getQuotaUsage();
      if (quota.remaining < 10) {
        logger.warn('[IHI Ingest] Approaching quota limit, stopping');
        break;
      }

      try {
        const { items: playlistItems, pagesFetched } =
          await fetchPlaylistItemsPublishedSince(
            channel.uploadsPlaylistId,
            since
          );
        quotaUsed += pagesFetched;

        if (playlistItems.length === 0) continue;

        const videoIds = [
          ...new Set(
            playlistItems
              .map((item) => item.contentDetails?.videoId)
              .filter(Boolean)
          ),
        ];
        if (videoIds.length === 0) continue;

        const videoData = await fetchVideosBatch(videoIds);
        quotaUsed += Math.ceil(videoIds.length / 50);

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        for (const vid of videoData) {
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
                vid.snippet?.thumbnails?.default?.url ||
                '',
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
        }

        const needsClassify = await Video.find({
          channelId: channel._id,
          youtubeVideoId: { $in: videoIds },
          deletedAt: null,
          $or: [
            { classification: { $exists: false } },
            { classification: '' },
            { classification: null },
          ],
        }).lean();

        if (needsClassify.length > 0) {
          try {
            const map = await classifySadguruVideoBatch(
              needsClassify.map((v) => ({
                _id: v._id,
                title: v.title,
                description: v.description || '',
              }))
            );
            for (const v of needsClassify) {
              const val = map.get(String(v._id));
              if (val) {
                await Video.findByIdAndUpdate(v._id, { classification: val });
                classified++;
              }
            }
          } catch (aiErr) {
            logger.error(`[IHI Ingest] Vertex classify failed: ${aiErr.message}`);
            syncLog.errors.push({
              channelId: channel.youtubeChannelId,
              message: `Classification: ${aiErr.message}`,
            });
          }
        }
      } catch (err) {
        if (err.message === 'QUOTA_EXCEEDED') {
          logger.error('[IHI Ingest] Quota exceeded');
          break;
        }
        logger.error(
          `[IHI Ingest] Error on channel ${channel.youtubeChannelId}: ${err.message}`
        );
        syncLog.errors.push({
          channelId: channel.youtubeChannelId,
          message: err.message,
        });
      }
    }

    syncLog.videosProcessed = videosProcessed;
    syncLog.quotaUsed = quotaUsed;
    syncLog.status =
      syncLog.errors.length > 0 ? 'partial' : 'success';
    syncLog.completedAt = new Date();
    await syncLog.save();

    logger.info(
      `[IHI Ingest] Done: ${videosProcessed} videos upserted, ${classified} classified, ${quotaUsed} quota`
    );
  } catch (err) {
    logger.error(`[IHI Ingest] Failed: ${err.message}`);
    syncLog.status = 'failed';
    syncLog.errors.push({ channelId: 'global', message: err.message });
    syncLog.completedAt = new Date();
    await syncLog.save();
  } finally {
    isIhiIngestSyncing = false;
  }

  return syncLog;
}

// ---------------------------------------------------------------------------
// IHI — daily stats + snapshots for Sadhguru-classified videos only
// ---------------------------------------------------------------------------
export async function syncIhiSadhguruVideoStats(channelIds = null, type = 'manual') {
  if (isIhiSadhguruStatsSyncing) {
    throw new Error('IHI Sadhguru stats sync already in progress');
  }

  isIhiSadhguruStatsSyncing = true;
  const syncLog = await SyncLog.create({
    syncType: 'ihi_sadhguru_stats',
    type,
    status: 'running',
    startedAt: new Date(),
  });

  try {
    const query = { status: { $ne: 'archived' } };
    if (channelIds) query._id = { $in: channelIds };
    const ihiChannelIds = (await Channel.find(query))
      .filter(isIhiChannel)
      .map((c) => c._id);

    if (ihiChannelIds.length === 0) {
      syncLog.status = 'success';
      syncLog.completedAt = new Date();
      await syncLog.save();
      return syncLog;
    }

    const videos = await Video.find({
      channelId: { $in: ihiChannelIds },
      deletedAt: null,
      classification: 'sadhguru',
    })
      .select('youtubeVideoId')
      .lean();

    if (videos.length === 0) {
      syncLog.status = 'success';
      syncLog.completedAt = new Date();
      await syncLog.save();
      return syncLog;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let videosProcessed = 0;
    let quotaUsed = 0;
    const ytIds = videos.map((v) => v.youtubeVideoId).filter(Boolean);
    const idByYt = new Map(videos.map((v) => [v.youtubeVideoId, v._id]));

    const chunkSize = 50;
    for (let i = 0; i < ytIds.length; i += chunkSize) {
      const quota = getQuotaUsage();
      if (quota.remaining < 5) {
        logger.warn('[IHI Sadhguru Stats] Approaching quota limit, stopping');
        break;
      }

      const batchIds = ytIds.slice(i, i + chunkSize);
      try {
        const videoData = await fetchVideosBatch(batchIds);
        quotaUsed += Math.ceil(batchIds.length / 50);

        for (const vid of videoData) {
          const mongoId = idByYt.get(vid.id);
          if (!mongoId) continue;

          const views = parseInt(vid.statistics?.viewCount) || 0;
          const likes = parseInt(vid.statistics?.likeCount) || 0;
          const comments = parseInt(vid.statistics?.commentCount) || 0;

          const savedVideo = await Video.findOneAndUpdate(
            { _id: mongoId },
            {
              title: vid.snippet?.title || '',
              description: vid.snippet?.description || '',
              thumbnailUrl:
                vid.snippet?.thumbnails?.high?.url ||
                vid.snippet?.thumbnails?.default?.url ||
                '',
              publishedAt: vid.snippet?.publishedAt,
              views,
              likes,
              comments,
              duration: vid.contentDetails?.duration || '',
              lastSyncedAt: new Date(),
            },
            { new: true }
          );

          if (!savedVideo) continue;

          await VideoSnapshot.findOneAndUpdate(
            { videoId: savedVideo._id, date: today },
            {
              videoId: savedVideo._id,
              channelId: savedVideo.channelId,
              date: today,
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
          logger.error('[IHI Sadhguru Stats] Quota exceeded');
          break;
        }
        logger.error(`[IHI Sadhguru Stats] Batch error: ${err.message}`);
        syncLog.errors.push({ channelId: 'batch', message: err.message });
      }
    }

    syncLog.videosProcessed = videosProcessed;
    syncLog.quotaUsed = quotaUsed;
    syncLog.status =
      syncLog.errors.length > 0 ? 'partial' : 'success';
    syncLog.completedAt = new Date();
    await syncLog.save();

    logger.info(
      `[IHI Sadhguru Stats] Done: ${videosProcessed} videos, ${quotaUsed} quota`
    );
  } catch (err) {
    logger.error(`[IHI Sadhguru Stats] Failed: ${err.message}`);
    syncLog.status = 'failed';
    syncLog.errors.push({ channelId: 'global', message: err.message });
    syncLog.completedAt = new Date();
    await syncLog.save();
  } finally {
    isIhiSadhguruStatsSyncing = false;
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
