import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
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

    // Recompute Active/Inactive: mark dormant channels inactive and reactivate
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
// Activity status — mark channels with no qualifying recent posts `inactive`,
// and reactivate inactive channels that have posted again. Runs as the final
// step of the daily channel sync.
//
// `inactive` channels stay fully tracked and counted (their back-catalog keeps
// earning views); every sync/dashboard filter is `status != 'archived'`, so
// they flow through automatically. `archived` is reserved for soft-deleted
// channels (softDeleteChannels sets it together with deletedAt) and is never
// written or reverted here.
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

  let inactivated = 0;
  let reactivated = 0;

  // Detection: active channels that have gone quiet → inactive.
  const activeChannels = await prisma.channel.findMany({ where: { status: 'active' } });
  for (const channel of activeChannels) {
    // Don't demote a freshly-added channel before ingest has had time to
    // populate its videos.
    if (channel.createdAt && channel.createdAt > cutoff) continue;
    if (await hasQualifyingRecentPost(channel)) continue;
    await prisma.channel.update({
      where: { id: channel.id },
      data: { status: 'inactive' },
    });
    inactivated += 1;
  }

  // Reactivation: inactive channels that posted again → back to active.
  const dormantChannels = await prisma.channel.findMany({
    where: { status: 'inactive' },
  });
  for (const channel of dormantChannels) {
    if (!(await hasQualifyingRecentPost(channel))) continue;
    await prisma.channel.update({
      where: { id: channel.id },
      data: { status: 'active' },
    });
    reactivated += 1;
  }

  logger.info(
    `[Activity Status] ${inactivated} channel(s) marked inactive, ` +
      `${reactivated} reactivated (window: ${days}d, ${type})`
  );

  return { inactivated, reactivated, thresholdDays: days };
}

// ---------------------------------------------------------------------------
// Video sync — refresh stats + a daily snapshot for every live video across
// every active channel (Dedicated, IHI, Other). Iterates the stored video
// table (rather than re-walking each channel's uploads playlist), so the only
// YouTube quota cost is one `videos.list` batch per 50 videos.
//
// At present scale (~37k live videos) that's ~750 quota units for the whole
// daily pass — ~8% of the 10k daily cap.
// ---------------------------------------------------------------------------
const VIDEO_FETCH_BATCH = 50;        // YouTube videos.list cap
const VIDEO_FETCH_PARALLELISM = 5;   // concurrent batches
const VIDEO_WRITE_FLUSH = 500;       // rows per bulk DB write

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
  let quotaExceeded = false;

  try {
    const channelWhere = { status: { not: 'archived' } };
    if (channelIds) channelWhere.id = { in: channelIds };
    const channels = await prisma.channel.findMany({
      where: channelWhere,
      select: { id: true, youtubeChannelId: true },
    });

    if (channels.length === 0) {
      syncLog = await prisma.syncLog.update({
        where: { id: syncLog.id },
        data: { status: 'success', completedAt: new Date() },
      });
      return syncLog;
    }

    const channelIdSet = channels.map((c) => c.id);
    const ytChannelById = new Map(channels.map((c) => [c.id, c.youtubeChannelId]));
    const videos = await prisma.video.findMany({
      where: { channelId: { in: channelIdSet }, deletedAt: null },
      select: { id: true, youtubeVideoId: true, channelId: true },
    });

    if (videos.length === 0) {
      syncLog = await prisma.syncLog.update({
        where: { id: syncLog.id },
        data: { status: 'success', completedAt: new Date() },
      });
      return syncLog;
    }

    const today = utcStartOfDay();

    logger.info(
      `[Video Sync] Syncing ${videos.length} videos across ${channels.length} channels...`
    );

    // Only-on-change guard: load each video's most recent prior-day snapshot so
    // we can skip appending today's row when the fetched stats are unchanged.
    // We still refresh every video's current stats below (accuracy is never
    // sacrificed); we just don't store a duplicate time-series point. A video
    // with NO prior snapshot always gets its first one (absent from this map).
    // The carry-forward reports treat a skipped (unchanged) day as the carried
    // value, so this is lossless.
    const priorSnaps = await prisma.$queryRaw(Prisma.sql`
      SELECT DISTINCT ON (video_id) video_id, views, likes, comments
      FROM video_snapshots
      WHERE channel_id IN (${Prisma.join(channelIdSet)})
        AND deleted_at IS NULL
        AND date < ${today}
      ORDER BY video_id, date DESC
    `);
    const prevByVideo = new Map(
      priorSnaps.map((s) => [
        s.video_id,
        { views: BigInt(s.views), likes: Number(s.likes), comments: Number(s.comments) },
      ]),
    );

    const localByYt = new Map(videos.map((v) => [v.youtubeVideoId, v]));
    const batches = [];
    for (let i = 0; i < videos.length; i += VIDEO_FETCH_BATCH) {
      batches.push(videos.slice(i, i + VIDEO_FETCH_BATCH));
    }

    // Every video here already exists locally (it came from the findMany above
    // and unknowns are skipped), so we hold its internal id (local.id) and can
    // write both the video-stats UPDATE and the snapshot UPSERT in two bulk SQL
    // statements per flush — instead of two sequential round-trips per video,
    // which made the full sweep take ~hours against the pooler.
    let pending = [];
    const flush = async () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      try {
        // 1) Bulk-refresh video stats by internal id.
        const vRows = Prisma.join(
          batch.map(
            (p) => Prisma.sql`(${p.id}, ${p.title}, ${p.description}, ${p.thumbnailUrl}, ${p.publishedAt}::timestamptz, ${p.views}::bigint, ${p.likes}::int, ${p.comments}::int, ${p.duration}, ${p.lastSyncedAt}::timestamptz)`
          )
        );
        await prisma.$executeRaw(Prisma.sql`
          UPDATE videos AS v SET
            title = d.title, description = d.description, thumbnail_url = d.thumbnail_url,
            published_at = d.published_at, views = d.views, likes = d.likes,
            comments = d.comments, duration = d.duration, last_synced_at = d.last_synced_at,
            updated_at = now()
          FROM (VALUES ${vRows}) AS d(id, title, description, thumbnail_url, published_at, views, likes, comments, duration, last_synced_at)
          WHERE v.id = d.id
        `);

        // 2) Bulk-upsert today's snapshot (id/updated_at have no DB default).
        //    Only-on-change: skip rows whose stats are unchanged vs the prior
        //    snapshot (writeSnapshot=false) — the video UPDATE above already
        //    refreshed current stats; we just don't append a duplicate point.
        const snapBatch = batch.filter((p) => p.writeSnapshot);
        if (snapBatch.length) {
          const sRows = Prisma.join(
            snapBatch.map(
              (p) => Prisma.sql`(${p.snapId}, ${p.id}, ${p.channelId}, ${today}::timestamptz, ${p.views}::bigint, ${p.likes}::int, ${p.comments}::int, now())`
            )
          );
          await prisma.$executeRaw(Prisma.sql`
            INSERT INTO video_snapshots (id, video_id, channel_id, date, views, likes, comments, updated_at)
            VALUES ${sRows}
            ON CONFLICT (video_id, date) DO UPDATE SET
              channel_id = EXCLUDED.channel_id, views = EXCLUDED.views,
              likes = EXCLUDED.likes, comments = EXCLUDED.comments, updated_at = now()
          `);
        }

        videosProcessed += batch.length;
      } catch (err) {
        // A bad row (e.g. a video deleted mid-run) would fail the whole bulk
        // statement; fall back to per-row so the rest of the batch still lands
        // and we capture the offending row in the error log.
        logger.error(`[Video Sync] Bulk write failed for ${batch.length} rows, retrying per-row: ${err.message}`);
        for (const p of batch) {
          try {
            await prisma.video.update({
              where: { id: p.id },
              data: {
                title: p.title, description: p.description, thumbnailUrl: p.thumbnailUrl,
                publishedAt: p.publishedAt, views: p.views, likes: p.likes,
                comments: p.comments, duration: p.duration, lastSyncedAt: p.lastSyncedAt,
              },
            });
            if (p.writeSnapshot) {
              await prisma.videoSnapshot.upsert({
                where: { videoId_date: { videoId: p.id, date: today } },
                update: { channelId: p.channelId, views: p.views, likes: p.likes, comments: p.comments },
                create: { videoId: p.id, channelId: p.channelId, date: today, views: p.views, likes: p.likes, comments: p.comments },
              });
            }
            videosProcessed += 1;
          } catch (e2) {
            errors.push({ channelId: ytChannelById.get(p.channelId) ?? 'unknown', message: `${p.youtubeVideoId}: ${e2.message}` });
          }
        }
      }
    };

    // Run batches in groups of VIDEO_FETCH_PARALLELISM so we trade wall-time
    // for a bounded burst of concurrent HTTP requests against YouTube. Each
    // batch is one quota unit regardless of how many parts we ask for.
    for (let g = 0; g < batches.length; g += VIDEO_FETCH_PARALLELISM) {
      if (quotaExceeded) break;
      const quota = getQuotaUsage();
      if (quota.remaining < VIDEO_FETCH_PARALLELISM + 1) {
        logger.warn('[Video Sync] Approaching quota limit, stopping');
        break;
      }
      const group = batches.slice(g, g + VIDEO_FETCH_PARALLELISM);

      const groupResults = await Promise.allSettled(
        group.map(async (slice) => {
          const ytIds = slice.map((v) => v.youtubeVideoId);
          const videoData = await fetchVideosBatch(ytIds);
          return videoData;
        }),
      );

      for (let r = 0; r < groupResults.length; r += 1) {
        const result = groupResults[r];
        const slice = group[r];
        if (result.status === 'rejected') {
          const err = result.reason;
          if (err.message === 'QUOTA_EXCEEDED') {
            logger.error('[Video Sync] Quota exceeded');
            quotaExceeded = true;
            continue;
          }
          // Attribute the batch failure to the first channel in the slice for
          // the syncLog `errors` array (keeps the same shape as legacy logs).
          const ytChannel = ytChannelById.get(slice[0].channelId) ?? 'unknown';
          logger.error(`[Video Sync] Batch fetch error: ${err.message}`);
          errors.push({ channelId: ytChannel, message: err.message });
          continue;
        }
        quotaUsed += 1;
        for (const vid of result.value) {
          const local = localByYt.get(vid.id);
          if (!local) continue;
          const views = parseInt(vid.statistics?.viewCount) || 0;
          const likes = parseInt(vid.statistics?.likeCount) || 0;
          const comments = parseInt(vid.statistics?.commentCount) || 0;

          // Append today's snapshot only when the stats moved since the most
          // recent prior-day snapshot (or when there is none — first-ever).
          const prev = prevByVideo.get(local.id);
          const writeSnapshot =
            !prev ||
            prev.views !== BigInt(views) ||
            prev.likes !== likes ||
            prev.comments !== comments;

          pending.push({
            id: local.id,
            youtubeVideoId: vid.id,
            channelId: local.channelId,
            title: vid.snippet?.title || '',
            description: vid.snippet?.description || '',
            thumbnailUrl: pickThumbnail(vid.snippet?.thumbnails),
            publishedAt: vid.snippet?.publishedAt ? new Date(vid.snippet.publishedAt) : null,
            views: BigInt(views),
            likes,
            comments,
            duration: vid.contentDetails?.duration || '',
            lastSyncedAt: new Date(),
            snapId: randomUUID(),
            writeSnapshot,
          });

          if (pending.length >= VIDEO_WRITE_FLUSH) await flush();
        }
      }
    }

    // Write any rows accumulated since the last flush.
    await flush();

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

    // Only-on-change guard (same as syncVideoStats): load each video's most
    // recent prior-day snapshot so we skip appending an unchanged duplicate.
    // This path overlaps syncVideoStats (it re-stats existing IHI sadhguru
    // videos), so without the guard here it would re-create the very rows
    // syncVideoStats skips. The video UPDATE below still refreshes current
    // stats unconditionally.
    const prevByVideo = new Map(
      (
        await prisma.$queryRaw(Prisma.sql`
          SELECT DISTINCT ON (video_id) video_id, views, likes, comments
          FROM video_snapshots
          WHERE channel_id IN (${Prisma.join(ihiChannelIds)})
            AND deleted_at IS NULL
            AND date < ${today}
          ORDER BY video_id, date DESC
        `)
      ).map((s) => [
        s.video_id,
        { views: BigInt(s.views), likes: Number(s.likes), comments: Number(s.comments) },
      ]),
    );

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

          // Append today's snapshot only when stats moved vs the prior day
          // (or first-ever). Current stats were already refreshed above.
          const prev = prevByVideo.get(savedVideo.id);
          const writeSnapshot =
            !prev ||
            prev.views !== BigInt(views) ||
            prev.likes !== likes ||
            prev.comments !== comments;

          if (writeSnapshot) {
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
          }

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

  if (channels.length === 0) {
    return {
      channelsProcessed: 0,
      totalVideosPulled: 0,
      message: 'No channels need video pull (all already pulled)',
    };
  }

  let channelsProcessed = 0;
  let totalVideosPulled = 0;
  const errors = [];

  for (const channel of channels) {
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

  logger.info(
    `[Pull All Channels] Done: ${channelsProcessed} channels, ${totalVideosPulled} videos pulled`
  );

  return {
    channelsProcessed,
    totalVideosPulled,
    errors: errors.length > 0 ? errors : undefined,
  };
}
