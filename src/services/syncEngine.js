import { prisma } from '../config/prisma.js';
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
import { utcStartOfDay } from '../utils/dateUtc.js';
import { parseYoutubeStatInt } from '../utils/helpers.js';

// Re-entrancy guards — plain module-local booleans, identical semantics to the
// pre-migration Mongoose implementation. No DB involvement.
let isChannelSyncing = false;
let isVideoSyncing = false;
let isDedicatedIngestSyncing = false;
let isIhiIngestSyncing = false;
let isIhiSadhguruStatsSyncing = false;
let isPullingAllVideos = false;

const MS_24H = 24 * 60 * 60 * 1000;

export function getSyncStatus() {
  return {
    isChannelSyncing,
    isVideoSyncing,
    isDedicatedIngestSyncing,
    isIhiIngestSyncing,
    isIhiSadhguruStatsSyncing,
    isPullingAllVideos,
  };
}

// ---------------------------------------------------------------------------
// Local helpers — fetch/get the singleton SyncConfig and lookup utilities.
// ---------------------------------------------------------------------------

async function getSyncConfig() {
  return prisma.syncConfig.upsert({
    where: { id: 'sync' },
    update: {},
    create: { id: 'sync' },
  });
}

function pickThumbnail(thumbnails) {
  return thumbnails?.high?.url || thumbnails?.default?.url || '';
}

// ---------------------------------------------------------------------------
// Channel sync — updates Channel rows + ChannelSnapshot history.
// ---------------------------------------------------------------------------
export async function syncChannelStats(channelIds = null, type = 'manual') {
  if (isChannelSyncing) {
    throw new Error('Channel sync already in progress');
  }

  isChannelSyncing = true;
  let syncLog = await prisma.syncLog.create({
    data: {
      syncType: 'channel',
      type,
      status: 'running',
      startedAt: new Date(),
      errors: [],
    },
  });

  const errors = [];
  let channelsProcessed = 0;
  let quotaUsed = 0;

  try {
    const where = { status: { not: 'archived' } };
    if (channelIds) where.id = { in: channelIds };
    const channels = await prisma.channel.findMany({ where });

    if (channels.length === 0) {
      syncLog = await prisma.syncLog.update({
        where: { id: syncLog.id },
        data: { status: 'success', completedAt: new Date() },
      });
      return syncLog;
    }

    const ytChannelIds = channels.map((c) => c.youtubeChannelId);

    logger.info(`[Channel Sync] Syncing ${channels.length} channels...`);
    const channelData = await fetchChannelsBatch(ytChannelIds);
    quotaUsed += Math.ceil(ytChannelIds.length / 50);

    const channelMap = new Map(channels.map((ch) => [ch.youtubeChannelId, ch]));
    const today = utcStartOfDay();

    for (const ytChannel of channelData) {
      const channel = channelMap.get(ytChannel.id);
      if (!channel) continue;

      try {
        const stats    = ytChannel.statistics;
        const snippet  = ytChannel.snippet;
        const branding = ytChannel.brandingSettings;

        const subscribers = parseYoutubeStatInt(stats.subscriberCount);
        const views       = parseYoutubeStatInt(stats.viewCount);
        const videoCount  = parseYoutubeStatInt(stats.videoCount);

        const data = {
          title:        snippet.title,
          description:  snippet.description,
          thumbnailUrl: pickThumbnail(snippet.thumbnails),
          bannerUrl:    branding?.image?.bannerExternalUrl || '',
          customUrl:    snippet.customUrl || '',
          country:      snippet.country   || '',
          publishedAt:  snippet.publishedAt ? new Date(snippet.publishedAt) : null,
          uploadsPlaylistId:
            ytChannel.contentDetails?.relatedPlaylists?.uploads || '',
          currentSubscribers: subscribers,
          currentViews:       BigInt(views),
          currentVideoCount:  videoCount,
          lastSyncedAt:       new Date(),
        };

        // Mirror Mongoose: when allVideosPulled is currently true and the
        // remote video count exceeds what we have locally, flip it off so the
        // pull-all job will run again.
        if (channel.allVideosPulled) {
          const ourVideoCount = await prisma.video.count({
            where: { channelId: channel.id, deletedAt: null },
          });
          if (ourVideoCount < videoCount) {
            data.allVideosPulled = false;
          }
        }

        await prisma.channel.update({
          where: { id: channel.id },
          data,
        });

        await prisma.channelSnapshot.upsert({
          where: { channelId_date: { channelId: channel.id, date: today } },
          update: {
            subscribers,
            views: BigInt(views),
            videoCount,
          },
          create: {
            channelId: channel.id,
            date: today,
            subscribers,
            views: BigInt(views),
            videoCount,
          },
        });

        channelsProcessed += 1;
      } catch (err) {
        logger.error(`[Channel Sync] Error on ${ytChannel.id}: ${err.message}`);
        errors.push({ channelId: ytChannel.id, message: err.message });
      }
    }

    // Recompute Active/Inactive: auto-archive dormant channels and reactivate
    // those that have posted again. Isolated so a failure can't fail the sync.
    try {
      await updateChannelActivityStatuses(type);
    } catch (err) {
      logger.error(`[Channel Sync] Activity-status update failed: ${err.message}`);
    }

    syncLog = await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        channelsProcessed,
        quotaUsed,
        errors,
        status: errors.length > 0 ? 'partial' : 'success',
        completedAt: new Date(),
      },
    });

    logger.info(
      `[Channel Sync] Done: ${channelsProcessed} channels, ${quotaUsed} quota used`
    );
  } catch (err) {
    logger.error(`[Channel Sync] Failed: ${err.message}`);
    errors.push({ channelId: 'global', message: err.message });
    syncLog = await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        channelsProcessed,
        quotaUsed,
        errors,
        status: 'failed',
        completedAt: new Date(),
      },
    });
  } finally {
    isChannelSyncing = false;
  }

  return syncLog;
}

// ---------------------------------------------------------------------------
// Activity status — auto-archive channels with no qualifying recent posts, and
// reactivate auto-archived channels that have posted again. Runs as the final
// step of the daily channel sync. Reuses the `archived` status (already hidden
// by every status filter) plus the hidden `autoArchivedForInactivity` flag to
// tell automatic archives apart from deliberate manual ones.
//
// "Qualifying post" depends on channel group:
//   IHI             → only sadhguru-classified videos count
//   Dedicated/other → any upload counts
// ---------------------------------------------------------------------------
export async function updateChannelActivityStatuses(type = 'auto') {
  const config = await getSyncConfig();
  const days = config.inactivityThresholdDays ?? 14;
  const cutoff = new Date(Date.now() - days * MS_24H);

  const hasQualifyingRecentPost = async (channel) => {
    const where = {
      channelId: channel.id,
      deletedAt: null,
      publishedAt: { gte: cutoff },
    };
    if (isIhiChannel(channel)) where.classification = 'sadhguru';
    const found = await prisma.video.findFirst({ where, select: { id: true } });
    return !!found;
  };

  let archived = 0;
  let reactivated = 0;

  // Detection: active channels that have gone quiet → archive for inactivity.
  const activeChannels = await prisma.channel.findMany({ where: { status: 'active' } });
  for (const channel of activeChannels) {
    // Don't archive a freshly-added channel before ingest has had time to
    // populate its videos.
    if (channel.createdAt && channel.createdAt > cutoff) continue;
    if (await hasQualifyingRecentPost(channel)) continue;
    await prisma.channel.update({
      where: { id: channel.id },
      data: { status: 'archived', autoArchivedForInactivity: true },
    });
    archived += 1;
  }

  // Reactivation: auto-archived channels that posted again → back to active.
  const dormantChannels = await prisma.channel.findMany({
    where: { status: 'archived', autoArchivedForInactivity: true },
  });
  for (const channel of dormantChannels) {
    if (!(await hasQualifyingRecentPost(channel))) continue;
    await prisma.channel.update({
      where: { id: channel.id },
      data: { status: 'active', autoArchivedForInactivity: false },
    });
    reactivated += 1;
  }

  logger.info(
    `[Activity Status] ${archived} channel(s) archived for inactivity, ` +
      `${reactivated} reactivated (window: ${days}d, ${type})`
  );

  return { archived, reactivated, thresholdDays: days };
}

// ---------------------------------------------------------------------------
// Video sync — upserts Video rows + VideoSnapshot history (Dedicated only,
// top 10 most-recent uploads per channel).
// ---------------------------------------------------------------------------
export async function syncVideoStats(channelIds = null, type = 'manual') {
  if (isVideoSyncing) {
    throw new Error('Video sync already in progress');
  }

  isVideoSyncing = true;
  let syncLog = await prisma.syncLog.create({
    data: {
      syncType: 'video',
      type,
      status: 'running',
      startedAt: new Date(),
      errors: [],
    },
  });

  const errors = [];
  let videosProcessed = 0;
  let quotaUsed = 0;

  try {
    const where = { status: { not: 'archived' } };
    if (channelIds) where.id = { in: channelIds };
    const channels = (await prisma.channel.findMany({ where })).filter(isDedicatedChannel);

    if (channels.length === 0) {
      syncLog = await prisma.syncLog.update({
        where: { id: syncLog.id },
        data: { status: 'success', completedAt: new Date() },
      });
      return syncLog;
    }

    const today = utcStartOfDay();

    logger.info(
      `[Video Sync] Dedicated channels only — syncing videos for ${channels.length} channels...`
    );

    for (const channel of channels) {
      if (!channel.uploadsPlaylistId) continue;

      const quota = getQuotaUsage();
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

          const videoCommon = {
            channelId:   channel.id,
            title:       vid.snippet?.title       || '',
            description: vid.snippet?.description || '',
            thumbnailUrl: pickThumbnail(vid.snippet?.thumbnails),
            publishedAt: vid.snippet?.publishedAt ? new Date(vid.snippet.publishedAt) : null,
            views:    BigInt(views),
            likes,
            comments,
            duration: vid.contentDetails?.duration || '',
            lastSyncedAt: new Date(),
          };

          const savedVideo = await prisma.video.upsert({
            where: { youtubeVideoId: vid.id },
            update: videoCommon,
            create: { youtubeVideoId: vid.id, ...videoCommon },
          });

          await prisma.videoSnapshot.upsert({
            where: { videoId_date: { videoId: savedVideo.id, date: today } },
            update: {
              channelId: channel.id,
              views: BigInt(views),
              likes,
              comments,
            },
            create: {
              videoId: savedVideo.id,
              channelId: channel.id,
              date: today,
              views: BigInt(views),
              likes,
              comments,
            },
          });

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
        errors.push({ channelId: channel.youtubeChannelId, message: err.message });
      }
    }

    syncLog = await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        videosProcessed,
        quotaUsed,
        errors,
        status: errors.length > 0 ? 'partial' : 'success',
        completedAt: new Date(),
      },
    });

    logger.info(
      `[Video Sync] Done: ${videosProcessed} videos, ${quotaUsed} quota used`
    );
  } catch (err) {
    logger.error(`[Video Sync] Failed: ${err.message}`);
    errors.push({ channelId: 'global', message: err.message });
    syncLog = await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        videosProcessed,
        quotaUsed,
        errors,
        status: 'failed',
        completedAt: new Date(),
      },
    });
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
  let syncLog = await prisma.syncLog.create({
    data: {
      syncType: 'ihi_ingest',
      type,
      status: 'running',
      startedAt: new Date(),
      errors: [],
    },
  });

  const errors = [];
  let videosProcessed = 0;
  let quotaUsed = 0;
  let classified = 0;

  try {
    // Include inactivity-archived channels so new uploads keep being ingested
    // (and classified) — this is what lets the daily sync reactivate them.
    const where = {
      OR: [{ status: { not: 'archived' } }, { autoArchivedForInactivity: true }],
    };
    if (channelIds) where.id = { in: channelIds };
    const channels = (await prisma.channel.findMany({ where })).filter(isIhiChannel);

    if (channels.length === 0) {
      syncLog = await prisma.syncLog.update({
        where: { id: syncLog.id },
        data: { status: 'success', completedAt: new Date() },
      });
      return syncLog;
    }

    const since = new Date(Date.now() - MS_24H);

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

        const today = utcStartOfDay();

        for (const vid of videoData) {
          const views = parseInt(vid.statistics?.viewCount) || 0;
          const likes = parseInt(vid.statistics?.likeCount) || 0;
          const comments = parseInt(vid.statistics?.commentCount) || 0;

          const videoCommon = {
            channelId: channel.id,
            title: vid.snippet?.title || '',
            description: vid.snippet?.description || '',
            thumbnailUrl: pickThumbnail(vid.snippet?.thumbnails),
            publishedAt: vid.snippet?.publishedAt ? new Date(vid.snippet.publishedAt) : null,
            views: BigInt(views),
            likes,
            comments,
            duration: vid.contentDetails?.duration || '',
            lastSyncedAt: new Date(),
          };

          const savedVideo = await prisma.video.upsert({
            where: { youtubeVideoId: vid.id },
            update: videoCommon,
            create: { youtubeVideoId: vid.id, ...videoCommon },
          });

          await prisma.videoSnapshot.upsert({
            where: { videoId_date: { videoId: savedVideo.id, date: today } },
            update: {
              channelId: channel.id,
              views: BigInt(views),
              likes,
              comments,
            },
            create: {
              videoId: savedVideo.id,
              channelId: channel.id,
              date: today,
              views: BigInt(views),
              likes,
              comments,
            },
          });

          videosProcessed++;
        }

        const needsClassify = await prisma.video.findMany({
          where: {
            channelId: channel.id,
            youtubeVideoId: { in: videoIds },
            deletedAt: null,
            classification: '',
          },
          select: { id: true, title: true, description: true },
        });

        if (needsClassify.length > 0) {
          try {
            const map = await classifySadguruVideoBatch(
              needsClassify.map((v) => ({
                _id: v.id,
                title: v.title,
                description: v.description || '',
              }))
            );
            for (const v of needsClassify) {
              const val = map.get(String(v.id));
              if (val) {
                await prisma.video.update({
                  where: { id: v.id },
                  data: { classification: val },
                });
                classified++;
              }
            }
          } catch (aiErr) {
            logger.error(`[IHI Ingest] Vertex classify failed: ${aiErr.message}`);
            errors.push({
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
        errors.push({
          channelId: channel.youtubeChannelId,
          message: err.message,
        });
      }
    }

    syncLog = await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        videosProcessed,
        quotaUsed,
        errors,
        status: errors.length > 0 ? 'partial' : 'success',
        completedAt: new Date(),
      },
    });

    logger.info(
      `[IHI Ingest] Done: ${videosProcessed} videos upserted, ${classified} classified, ${quotaUsed} quota`
    );
  } catch (err) {
    logger.error(`[IHI Ingest] Failed: ${err.message}`);
    errors.push({ channelId: 'global', message: err.message });
    syncLog = await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        videosProcessed,
        quotaUsed,
        errors,
        status: 'failed',
        completedAt: new Date(),
      },
    });
  } finally {
    isIhiIngestSyncing = false;
  }

  return syncLog;
}

// ---------------------------------------------------------------------------
// Dedicated ingest — last 24h uploads, upsert, then auto-classify as sadhguru
// ---------------------------------------------------------------------------
export async function syncDedicatedIngestLast24h(channelIds = null, type = 'manual') {
  if (isDedicatedIngestSyncing) {
    throw new Error('Dedicated ingest sync already in progress');
  }

  isDedicatedIngestSyncing = true;
  let syncLog = await prisma.syncLog.create({
    data: {
      syncType: 'dedicated_ingest',
      type,
      status: 'running',
      startedAt: new Date(),
      errors: [],
    },
  });

  const errors = [];
  let videosProcessed = 0;
  let quotaUsed = 0;
  let classified = 0;

  try {
    // Include inactivity-archived channels so new uploads keep being ingested
    // — this is what lets the daily sync reactivate them.
    const where = {
      OR: [{ status: { not: 'archived' } }, { autoArchivedForInactivity: true }],
    };
    if (channelIds) where.id = { in: channelIds };
    const channels = (await prisma.channel.findMany({ where })).filter(isDedicatedChannel);

    if (channels.length === 0) {
      syncLog = await prisma.syncLog.update({
        where: { id: syncLog.id },
        data: { status: 'success', completedAt: new Date() },
      });
      return syncLog;
    }

    const since = new Date(Date.now() - MS_24H);

    logger.info(
      `[Dedicated Ingest] ${channels.length} channels, videos published since ${since.toISOString()}`
    );

    for (const channel of channels) {
      if (!channel.uploadsPlaylistId) continue;

      const quota = getQuotaUsage();
      if (quota.remaining < 10) {
        logger.warn('[Dedicated Ingest] Approaching quota limit, stopping');
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

        const today = utcStartOfDay();

        for (const vid of videoData) {
          const views = parseInt(vid.statistics?.viewCount) || 0;
          const likes = parseInt(vid.statistics?.likeCount) || 0;
          const comments = parseInt(vid.statistics?.commentCount) || 0;

          const videoCommon = {
            channelId: channel.id,
            title: vid.snippet?.title || '',
            description: vid.snippet?.description || '',
            thumbnailUrl: pickThumbnail(vid.snippet?.thumbnails),
            publishedAt: vid.snippet?.publishedAt ? new Date(vid.snippet.publishedAt) : null,
            views: BigInt(views),
            likes,
            comments,
            duration: vid.contentDetails?.duration || '',
            lastSyncedAt: new Date(),
          };

          const savedVideo = await prisma.video.upsert({
            where: { youtubeVideoId: vid.id },
            update: videoCommon,
            create: { youtubeVideoId: vid.id, ...videoCommon },
          });

          await prisma.videoSnapshot.upsert({
            where: { videoId_date: { videoId: savedVideo.id, date: today } },
            update: {
              channelId: channel.id,
              views: BigInt(views),
              likes,
              comments,
            },
            create: {
              videoId: savedVideo.id,
              channelId: channel.id,
              date: today,
              views: BigInt(views),
              likes,
              comments,
            },
          });

          videosProcessed++;
        }

        const classifyResult = await prisma.video.updateMany({
          where: {
            channelId: channel.id,
            youtubeVideoId: { in: videoIds },
            deletedAt: null,
            classification: '',
          },
          data: { classification: 'sadhguru' },
        });
        // Prisma returns `{ count }`; Mongoose returned `{ modifiedCount }`.
        // Support both shapes so tests that mock with the old field keep working.
        classified +=
          classifyResult.count ?? classifyResult.modifiedCount ?? 0;
      } catch (err) {
        if (err.message === 'QUOTA_EXCEEDED') {
          logger.error('[Dedicated Ingest] Quota exceeded');
          break;
        }
        logger.error(
          `[Dedicated Ingest] Error on channel ${channel.youtubeChannelId}: ${err.message}`
        );
        errors.push({
          channelId: channel.youtubeChannelId,
          message: err.message,
        });
      }
    }

    syncLog = await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        videosProcessed,
        quotaUsed,
        errors,
        status: errors.length > 0 ? 'partial' : 'success',
        completedAt: new Date(),
      },
    });

    logger.info(
      `[Dedicated Ingest] Done: ${videosProcessed} videos, ${quotaUsed} quota used, auto-classified: ${classified}`
    );
  } catch (err) {
    logger.error(`[Dedicated Ingest] Failed: ${err.message}`);
    errors.push({ channelId: 'global', message: err.message });
    syncLog = await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        videosProcessed,
        quotaUsed,
        errors,
        status: 'failed',
        completedAt: new Date(),
      },
    });
  } finally {
    isDedicatedIngestSyncing = false;
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
  let syncLog = await prisma.syncLog.create({
    data: {
      syncType: 'ihi_sadhguru_stats',
      type,
      status: 'running',
      startedAt: new Date(),
      errors: [],
    },
  });

  const errors = [];
  let videosProcessed = 0;
  let quotaUsed = 0;

  try {
    const where = { status: { not: 'archived' } };
    if (channelIds) where.id = { in: channelIds };
    const ihiChannelIds = (await prisma.channel.findMany({ where }))
      .filter(isIhiChannel)
      .map((c) => c.id);

    if (ihiChannelIds.length === 0) {
      syncLog = await prisma.syncLog.update({
        where: { id: syncLog.id },
        data: { status: 'success', completedAt: new Date() },
      });
      return syncLog;
    }

    const videos = await prisma.video.findMany({
      where: {
        channelId: { in: ihiChannelIds },
        deletedAt: null,
        classification: 'sadhguru',
      },
      select: { id: true, youtubeVideoId: true },
    });

    if (videos.length === 0) {
      syncLog = await prisma.syncLog.update({
        where: { id: syncLog.id },
        data: { status: 'success', completedAt: new Date() },
      });
      return syncLog;
    }

    const today = utcStartOfDay();
    const ytIds = videos.map((v) => v.youtubeVideoId).filter(Boolean);
    const idByYt = new Map(videos.map((v) => [v.youtubeVideoId, v.id]));

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
          const localId = idByYt.get(vid.id);
          if (!localId) continue;

          const views = parseInt(vid.statistics?.viewCount) || 0;
          const likes = parseInt(vid.statistics?.likeCount) || 0;
          const comments = parseInt(vid.statistics?.commentCount) || 0;

          // Mongoose used findOneAndUpdate(...) which returns null when the
          // target row is missing (e.g. deleted mid-flight). Prisma raises
          // P2025 on missing rows, so emulate the soft-skip by catching it.
          let savedVideo = null;
          try {
            savedVideo = await prisma.video.update({
              where: { id: localId },
              data: {
                title: vid.snippet?.title || '',
                description: vid.snippet?.description || '',
                thumbnailUrl: pickThumbnail(vid.snippet?.thumbnails),
                publishedAt: vid.snippet?.publishedAt ? new Date(vid.snippet.publishedAt) : null,
                views: BigInt(views),
                likes,
                comments,
                duration: vid.contentDetails?.duration || '',
                lastSyncedAt: new Date(),
              },
            });
          } catch (e) {
            if (e?.code === 'P2025') {
              savedVideo = null;
            } else {
              throw e;
            }
          }

          if (!savedVideo) continue;

          await prisma.videoSnapshot.upsert({
            where: { videoId_date: { videoId: savedVideo.id, date: today } },
            update: {
              channelId: savedVideo.channelId,
              views: BigInt(views),
              likes,
              comments,
            },
            create: {
              videoId: savedVideo.id,
              channelId: savedVideo.channelId,
              date: today,
              views: BigInt(views),
              likes,
              comments,
            },
          });

          videosProcessed++;
        }
      } catch (err) {
        if (err.message === 'QUOTA_EXCEEDED') {
          logger.error('[IHI Sadhguru Stats] Quota exceeded');
          break;
        }
        logger.error(`[IHI Sadhguru Stats] Batch error: ${err.message}`);
        errors.push({ channelId: 'batch', message: err.message });
      }
    }

    syncLog = await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        videosProcessed,
        quotaUsed,
        errors,
        status: errors.length > 0 ? 'partial' : 'success',
        completedAt: new Date(),
      },
    });

    logger.info(
      `[IHI Sadhguru Stats] Done: ${videosProcessed} videos, ${quotaUsed} quota`
    );
  } catch (err) {
    logger.error(`[IHI Sadhguru Stats] Failed: ${err.message}`);
    errors.push({ channelId: 'global', message: err.message });
    syncLog = await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        videosProcessed,
        quotaUsed,
        errors,
        status: 'failed',
        completedAt: new Date(),
      },
    });
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
  let channel;
  try {
    channel = await prisma.channel.findUnique({ where: { id: channelId } });
  } catch {
    channel = null;
  }
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
    await prisma.channel.update({
      where: { id: channel.id },
      data: { uploadsPlaylistId },
    });
    channel.uploadsPlaylistId = uploadsPlaylistId;
  }

  try {
    logger.info(`[Pull All Videos] Fetching all video IDs for channel ${channel.youtubeChannelId}...`);
    const allVideoIds = await fetchAllPlaylistItemIds(uploadsPlaylistId);
    logger.info(`[Pull All Videos] Found ${allVideoIds.length} videos, processing in batches of ${PULL_VIDEO_BATCH_SIZE}`);

    const today = utcStartOfDay();

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

          const videoCommon = {
            channelId: channel.id,
            title: vid.snippet?.title || '',
            description: vid.snippet?.description || '',
            thumbnailUrl: pickThumbnail(vid.snippet?.thumbnails),
            publishedAt: vid.snippet?.publishedAt ? new Date(vid.snippet.publishedAt) : null,
            views: BigInt(views),
            likes,
            comments,
            duration: vid.contentDetails?.duration || '',
            lastSyncedAt: new Date(),
          };

          const savedVideo = await prisma.video.upsert({
            where: { youtubeVideoId: vid.id },
            update: videoCommon,
            create: { youtubeVideoId: vid.id, ...videoCommon },
          });

          await prisma.videoSnapshot.upsert({
            where: { videoId_date: { videoId: savedVideo.id, date: today } },
            update: {
              channelId: channel.id,
              views: BigInt(views),
              likes,
              comments,
            },
            create: {
              videoId: savedVideo.id,
              channelId: channel.id,
              date: today,
              views: BigInt(views),
              likes,
              comments,
            },
          });

          videosProcessed++;
        } catch (err) {
          logger.error(`[Pull All Videos] Error saving video ${vid.id}: ${err.message}`);
        }
      }
    }

    const allPulled = videosProcessed === allVideoIds.length;
    if (allPulled) {
      await prisma.channel.update({
        where: { id: channel.id },
        data: { allVideosPulled: true },
      });
    }

    let dedicatedAutoClassified = 0;
    if (isDedicatedChannel(channel)) {
      const classifyResult = await prisma.video.updateMany({
        where: {
          channelId: channel.id,
          deletedAt: null,
          classification: '',
        },
        data: { classification: 'sadhguru' },
      });
      dedicatedAutoClassified =
        classifyResult.count ?? classifyResult.modifiedCount ?? 0;
      if (dedicatedAutoClassified > 0) {
        logger.info(
          `[Pull All Videos] Dedicated auto-classified ${dedicatedAutoClassified} videos as sadhguru for channel ${channel.title}`
        );
      }
    }

    logger.info(`[Pull All Videos] Done: ${videosProcessed} videos for channel ${channel.title}`);
    return {
      videosProcessed,
      totalIds: allVideoIds.length,
      allVideosPulled: allPulled,
      dedicatedAutoClassified,
    };
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

  const channels = await prisma.channel.findMany({
    where: {
      status: { not: 'archived' },
      allVideosPulled: { not: true },
    },
    orderBy: { title: 'asc' },
  });

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
      const result = await pullAllChannelVideos(channel.id);
      channelsProcessed++;
      totalVideosPulled += result.videosProcessed;
    } catch (err) {
      if (err.message === 'QUOTA_EXCEEDED') {
        logger.warn('[Pull All Channels] Quota exceeded, stopping');
        break;
      }
      logger.error(`[Pull All Channels] Error on ${channel.title}: ${err.message}`);
      errors.push({ channelId: channel.id, title: channel.title, message: err.message });
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
