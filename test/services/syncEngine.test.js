/**
 * Prisma port of test/services/syncEngine.test.js.
 *
 * Same external mocks (youtubeApi, vertexAiService, logger). DB is the
 * embedded Postgres booted in test/setup.js. Every test seeds via
 * Prisma; every assertion uses Prisma reads.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (hoisted) ─────────────────────────────────────────────────────────
vi.mock('../../src/services/youtubeApi.js', () => ({
  fetchChannelsBatch:               vi.fn(),
  fetchPlaylistItems:               vi.fn(),
  fetchAllPlaylistItemIds:          vi.fn(),
  fetchVideosBatch:                 vi.fn(),
  fetchSingleChannel:               vi.fn(),
  fetchPlaylistItemsPublishedSince: vi.fn(),
  getQuotaUsage:                    vi.fn(() => ({ used: 0, limit: 10000, remaining: 10000 })),
}));

vi.mock('../../src/services/vertexAiService.js', () => ({
  classifySadguruVideoBatch: vi.fn(),
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  fetchChannelsBatch,
  fetchPlaylistItems,
  fetchAllPlaylistItemIds,
  fetchVideosBatch,
  fetchSingleChannel,
  fetchPlaylistItemsPublishedSince,
  getQuotaUsage,
} from '../../src/services/youtubeApi.js';
import { classifySadguruVideoBatch } from '../../src/services/vertexAiService.js';
import { prisma } from '../setup.js';
import {
  getSyncStatus,
  syncChannelStats,
  syncVideoStats,
  syncIhiIngestLast24h,
  syncDedicatedIngestLast24h,
  syncIhiSadhguruVideoStats,
  syncChannels,
  pullAllChannelVideos,
  pullAllChannelsVideos,
  updateChannelActivityStatuses,
} from '../../src/services/syncEngine.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const FULL_QUOTA = { used: 0, limit: 10000, remaining: 10000 };
const LOW_QUOTA  = { used: 9995, limit: 10000, remaining: 5 };

function makeYtChannel(overrides = {}) {
  return {
    id: 'UC_default',
    snippet: {
      title: 'Default Title',
      description: 'Default description',
      thumbnails: { high: { url: 'https://thumb/high.jpg' }, default: { url: 'https://thumb/default.jpg' } },
      customUrl: '@default',
      country: 'IN',
      publishedAt: '2020-01-01T00:00:00Z',
    },
    statistics: { subscriberCount: '1000', viewCount: '50000', videoCount: '10' },
    contentDetails: { relatedPlaylists: { uploads: 'UU_default' } },
    brandingSettings: { image: { bannerExternalUrl: 'https://banner/banner.jpg' } },
    ...overrides,
  };
}

function makeYtVideo(overrides = {}) {
  return {
    id: 'vidDefault',
    snippet: {
      title: 'Default Video',
      description: 'Default description',
      thumbnails: { high: { url: 'https://thumb/high.jpg' }, default: { url: 'https://thumb/default.jpg' } },
      publishedAt: '2025-01-01T00:00:00Z',
    },
    statistics: { viewCount: '100', likeCount: '10', commentCount: '5' },
    contentDetails: { duration: 'PT5M' },
    ...overrides,
  };
}

function makePlaylistItem(videoId) {
  return { contentDetails: { videoId } };
}

beforeEach(() => {
  vi.clearAllMocks();
  getQuotaUsage.mockReturnValue(FULL_QUOTA);
});

// ────────────────────────────────────────────────────────────────────────────
// getSyncStatus
// ────────────────────────────────────────────────────────────────────────────

describe('getSyncStatus', () => {
  it('returns all flags false when nothing is running', () => {
    const s = getSyncStatus();
    expect(s).toEqual({
      isChannelSyncing:           false,
      isVideoSyncing:             false,
      isDedicatedIngestSyncing:   false,
      isIhiIngestSyncing:         false,
      isIhiSadhguruStatsSyncing:  false,
      isPullingAllVideos:         false,
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// syncChannelStats
// ────────────────────────────────────────────────────────────────────────────

describe('syncChannelStats', () => {
  it('returns a success log with no channels (empty result)', async () => {
    const log = await syncChannelStats();
    expect(log.status).toBe('success');
    expect(log.syncType).toBe('channel');
    expect(log.type).toBe('manual');
    expect(fetchChannelsBatch).not.toHaveBeenCalled();
  });

  it('syncs a channel, writes snapshot, updates Channel doc', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_a',
        title: 'Old',
        category: 'Dedicated Sadhguru',
      },
    });

    fetchChannelsBatch.mockResolvedValue([
      makeYtChannel({ id: 'UC_a', snippet: { ...makeYtChannel().snippet, title: 'New Title' } }),
    ]);

    const log = await syncChannelStats([ch.id], 'manual');

    expect(log.status).toBe('success');
    expect(log.channelsProcessed).toBe(1);
    expect(log.quotaUsed).toBe(1);

    const fresh = await prisma.channel.findUnique({ where: { id: ch.id } });
    expect(fresh.title).toBe('New Title');
    expect(fresh.currentSubscribers).toBe(1000);
    expect(fresh.uploadsPlaylistId).toBe('UU_default');
    expect(fresh.bannerUrl).toBe('https://banner/banner.jpg');

    const snap = await prisma.channelSnapshot.findFirst({ where: { channelId: ch.id } });
    expect(snap.subscribers).toBe(1000);
    expect(Number(snap.views)).toBe(50000);
  });

  it('upsert: second call updates same snapshot, not a duplicate', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_a', category: 'Dedicated Sadhguru' },
    });
    fetchChannelsBatch.mockResolvedValue([makeYtChannel({ id: 'UC_a' })]);
    await syncChannelStats([ch.id]);
    fetchChannelsBatch.mockResolvedValue([
      makeYtChannel({ id: 'UC_a', statistics: { subscriberCount: '2000', viewCount: '60000', videoCount: '11' } }),
    ]);
    await syncChannelStats([ch.id]);

    const snaps = await prisma.channelSnapshot.findMany({ where: { channelId: ch.id } });
    expect(snaps).toHaveLength(1);
    expect(snaps[0].subscribers).toBe(2000);
  });

  it('skips channelMap entries unknown to the DB (continue)', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_a', category: 'Dedicated Sadhguru' },
    });
    fetchChannelsBatch.mockResolvedValue([
      makeYtChannel({ id: 'UC_a' }),
      makeYtChannel({ id: 'UC_unknown' }),
    ]);
    const log = await syncChannelStats([ch.id]);
    expect(log.channelsProcessed).toBe(1);
  });

  it('archived channels are excluded by the query', async () => {
    await prisma.channel.create({
      data: { youtubeChannelId: 'UC_arch', status: 'archived' },
    });
    fetchChannelsBatch.mockResolvedValue([]);
    const log = await syncChannelStats();
    expect(log.status).toBe('success');
    expect(log.channelsProcessed).toBe(0);
  });

  it('per-channel error is collected, status=partial', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_a', category: 'Dedicated Sadhguru' },
    });
    // Trigger per-channel error: missing snippet throws on .title
    fetchChannelsBatch.mockResolvedValue([{ id: 'UC_a' /* no snippet */ }]);
    const log = await syncChannelStats([ch.id]);
    expect(log.status).toBe('partial');
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0].channelId).toBe('UC_a');
  });

  it('global error: fetchChannelsBatch throws → status=failed, error captured', async () => {
    await prisma.channel.create({ data: { youtubeChannelId: 'UC_a' } });
    fetchChannelsBatch.mockRejectedValue(new Error('network'));
    const log = await syncChannelStats();
    expect(log.status).toBe('failed');
    expect(log.errors[0].channelId).toBe('global');
    expect(log.errors[0].message).toBe('network');
  });

  it('throws when called while another channel sync is in-flight (re-entrancy guard)', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_a', category: 'Dedicated Sadhguru' },
    });
    let release;
    const blocker = new Promise((r) => { release = r; });
    fetchChannelsBatch.mockImplementation(async () => {
      await blocker;
      return [makeYtChannel({ id: 'UC_a' })];
    });

    const first = syncChannelStats([ch.id]);
    await new Promise((r) => setTimeout(r, 0));
    expect(getSyncStatus().isChannelSyncing).toBe(true);
    await expect(syncChannelStats([ch.id])).rejects.toThrow('Channel sync already in progress');
    release();
    await first;
    expect(getSyncStatus().isChannelSyncing).toBe(false);
  });

  it('falls back to default thumbnail and empty fields when snippet fields are missing', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_a', category: 'Dedicated Sadhguru' },
    });
    fetchChannelsBatch.mockResolvedValue([
      {
        id: 'UC_a',
        snippet: {
          title: 'T',
          description: 'D',
          thumbnails: { default: { url: 'https://thumb/default.jpg' } },
          publishedAt: '2020-01-01T00:00:00Z',
          // customUrl, country missing → falls back to ''
        },
        statistics: { subscriberCount: '1', viewCount: '2', videoCount: '3' },
        // contentDetails missing → uploadsPlaylistId = ''
        // brandingSettings missing → bannerUrl = ''
      },
    ]);
    const log = await syncChannelStats([ch.id]);
    expect(log.status).toBe('success');
    const fresh = await prisma.channel.findUnique({ where: { id: ch.id } });
    expect(fresh.thumbnailUrl).toBe('https://thumb/default.jpg');
    expect(fresh.bannerUrl).toBe('');
    expect(fresh.customUrl).toBe('');
    expect(fresh.country).toBe('');
    expect(fresh.uploadsPlaylistId).toBe('');
  });

  it('falls back to empty thumbnailUrl when no thumbnails at all', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_a', category: 'Dedicated Sadhguru' },
    });
    fetchChannelsBatch.mockResolvedValue([
      {
        id: 'UC_a',
        snippet: { title: 'T', description: 'D', thumbnails: {}, publishedAt: '2020-01-01T00:00:00Z' },
        statistics: { subscriberCount: '1', viewCount: '2', videoCount: '3' },
      },
    ]);
    await syncChannelStats([ch.id]);
    const fresh = await prisma.channel.findUnique({ where: { id: ch.id } });
    expect(fresh.thumbnailUrl).toBe('');
  });

  it('flips allVideosPulled back to false when channel videoCount > our count', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_a',
        category: 'Dedicated Sadhguru',
        allVideosPulled: true,
      },
    });
    fetchChannelsBatch.mockResolvedValue([makeYtChannel({ id: 'UC_a' })]);
    await syncChannelStats([ch.id]);
    const fresh = await prisma.channel.findUnique({ where: { id: ch.id } });
    expect(fresh.allVideosPulled).toBe(false);
  });

  it('keeps allVideosPulled=true when our count >= remote videoCount', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_a',
        category: 'Dedicated Sadhguru',
        allVideosPulled: true,
      },
    });
    for (let i = 0; i < 10; i++) {
      await prisma.video.create({
        data: { youtubeVideoId: `v${i}`, channelId: ch.id },
      });
    }
    fetchChannelsBatch.mockResolvedValue([makeYtChannel({ id: 'UC_a' })]);
    await syncChannelStats([ch.id]);
    const fresh = await prisma.channel.findUnique({ where: { id: ch.id } });
    expect(fresh.allVideosPulled).toBe(true);
  });

  it('catches updateChannelActivityStatuses failure without failing the parent sync', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_a', category: 'Dedicated Sadhguru' },
    });
    fetchChannelsBatch.mockResolvedValue([makeYtChannel({ id: 'UC_a' })]);
    const spy = vi
      .spyOn(prisma.syncConfig, 'upsert')
      .mockRejectedValueOnce(new Error('config blew up'));
    const log = await syncChannelStats([ch.id]);
    expect(log.status).toBe('success'); // activity-status error is swallowed
    spy.mockRestore();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// updateChannelActivityStatuses
// ────────────────────────────────────────────────────────────────────────────

describe('updateChannelActivityStatuses', () => {
  it('archives an active channel with no qualifying recent post', async () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_old',
        status: 'active',
        category: 'Dedicated Sadhguru',
      },
    });
    // Push createdAt back beyond the inactivity window using raw SQL so the
    // @updatedAt/createdAt magic doesn't override us.
    await prisma.$executeRawUnsafe(
      `UPDATE "channels" SET created_at = $1 WHERE id = $2`,
      oldDate,
      ch.id,
    );
    const result = await updateChannelActivityStatuses();
    expect(result.archived).toBe(1);
    expect(result.thresholdDays).toBe(14);
    const fresh = await prisma.channel.findUnique({ where: { id: ch.id } });
    expect(fresh.status).toBe('archived');
    expect(fresh.autoArchivedForInactivity).toBe(true);
  });

  it('skips a freshly-created channel even if it has no recent post', async () => {
    await prisma.channel.create({
      data: { youtubeChannelId: 'UC_new', status: 'active', category: 'Dedicated Sadhguru' },
    });
    const result = await updateChannelActivityStatuses();
    expect(result.archived).toBe(0);
  });

  it('keeps an active channel that has a recent post (any class for dedicated)', async () => {
    const oldCreated = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_active',
        status: 'active',
        category: 'Dedicated Sadhguru',
      },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE "channels" SET created_at = $1 WHERE id = $2`,
      oldCreated,
      ch.id,
    );
    await prisma.video.create({
      data: {
        youtubeVideoId: 'recent1',
        channelId: ch.id,
        publishedAt: new Date(),
      },
    });
    const result = await updateChannelActivityStatuses('auto');
    expect(result.archived).toBe(0);
    const fresh = await prisma.channel.findUnique({ where: { id: ch.id } });
    expect(fresh.status).toBe('active');
  });

  it('IHI channel keeps active only when a sadhguru-classified recent post exists', async () => {
    const oldCreated = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const ihiChan = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_ihi',
        status: 'active',
        category: 'IHI Partner',
      },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE "channels" SET created_at = $1 WHERE id = $2`,
      oldCreated,
      ihiChan.id,
    );
    // Non-sadhguru video → does NOT qualify
    await prisma.video.create({
      data: {
        youtubeVideoId: 'recent_nonsg',
        channelId: ihiChan.id,
        publishedAt: new Date(),
        classification: 'non sadhguru',
      },
    });
    const r1 = await updateChannelActivityStatuses();
    expect(r1.archived).toBe(1);

    // Reset and check sadhguru classification qualifies
    await prisma.channel.update({
      where: { id: ihiChan.id },
      data: { status: 'active', autoArchivedForInactivity: false },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE "channels" SET created_at = $1 WHERE id = $2`,
      oldCreated,
      ihiChan.id,
    );
    await prisma.video.deleteMany({ where: { channelId: ihiChan.id } });
    await prisma.video.create({
      data: {
        youtubeVideoId: 'recent_sg',
        channelId: ihiChan.id,
        publishedAt: new Date(),
        classification: 'sadhguru',
      },
    });
    const r2 = await updateChannelActivityStatuses();
    expect(r2.archived).toBe(0);
  });

  it('reactivates auto-archived channels that now have a qualifying post', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_reactivate',
        status: 'archived',
        autoArchivedForInactivity: true,
        category: 'Dedicated Sadhguru',
      },
    });
    await prisma.video.create({
      data: {
        youtubeVideoId: 'newpost',
        channelId: ch.id,
        publishedAt: new Date(),
      },
    });
    const r = await updateChannelActivityStatuses();
    expect(r.reactivated).toBe(1);
    const fresh = await prisma.channel.findUnique({ where: { id: ch.id } });
    expect(fresh.status).toBe('active');
    expect(fresh.autoArchivedForInactivity).toBe(false);
  });

  it('does not reactivate a dormant channel still without recent posts', async () => {
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_still_dormant',
        status: 'archived',
        autoArchivedForInactivity: true,
        category: 'Dedicated Sadhguru',
      },
    });
    const r = await updateChannelActivityStatuses();
    expect(r.reactivated).toBe(0);
  });

  it('respects custom inactivityThresholdDays from SyncConfig', async () => {
    await prisma.syncConfig.create({ data: { id: 'sync', inactivityThresholdDays: 5 } });
    const r = await updateChannelActivityStatuses();
    expect(r.thresholdDays).toBe(5);
  });

  it('uses fallback threshold 14 when SyncConfig has no inactivityThresholdDays', async () => {
    // Prisma column has a NOT NULL default of 14, so even an "empty" singleton
    // gives 14 — same observable behaviour as the Mongo fallback.
    await prisma.syncConfig.create({ data: { id: 'sync' } });
    const r = await updateChannelActivityStatuses();
    expect(r.thresholdDays).toBe(14);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// syncVideoStats
// ────────────────────────────────────────────────────────────────────────────

describe('syncVideoStats', () => {
  it('returns a success log when no channels exist', async () => {
    const log = await syncVideoStats();
    expect(log.status).toBe('success');
    expect(fetchVideosBatch).not.toHaveBeenCalled();
  });

  it('returns a success log when channels exist but no videos in scope', async () => {
    await prisma.channel.create({
      data: { youtubeChannelId: 'UC_x', category: 'Dedicated Sadhguru' },
    });
    const log = await syncVideoStats();
    expect(log.status).toBe('success');
    expect(log.videosProcessed).toBe(0);
    expect(fetchVideosBatch).not.toHaveBeenCalled();
  });

  it('refreshes stats + writes snapshots for every live video across all channel groups', async () => {
    const ded = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_d', category: 'Dedicated Sadhguru' },
    });
    const ihi = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_i', category: 'IHI Live' },
    });
    const other = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_o', category: 'Other' },
    });
    await prisma.video.create({ data: { youtubeVideoId: 'v_d', channelId: ded.id } });
    await prisma.video.create({ data: { youtubeVideoId: 'v_i', channelId: ihi.id } });
    await prisma.video.create({ data: { youtubeVideoId: 'v_o', channelId: other.id } });

    fetchVideosBatch.mockResolvedValueOnce([
      makeYtVideo({ id: 'v_d' }),
      makeYtVideo({ id: 'v_i', statistics: { viewCount: '200', likeCount: '20', commentCount: '15' } }),
      makeYtVideo({ id: 'v_o', statistics: { viewCount: '300', likeCount: '30', commentCount: '25' } }),
    ]);

    const log = await syncVideoStats();
    expect(log.status).toBe('success');
    expect(log.videosProcessed).toBe(3);
    expect(fetchVideosBatch).toHaveBeenCalledTimes(1);
    const snaps = await prisma.videoSnapshot.findMany({ orderBy: { views: 'asc' } });
    expect(snaps).toHaveLength(3);
    expect(Number(snaps[0].views)).toBe(100);
    expect(Number(snaps[2].views)).toBe(300);
  });

  it('upsert: second call updates the same snapshot row, no duplicate', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_d', category: 'Dedicated Sadhguru' },
    });
    await prisma.video.create({ data: { youtubeVideoId: 'v1', channelId: ch.id } });

    fetchVideosBatch.mockResolvedValueOnce([makeYtVideo({ id: 'v1' })]);
    await syncVideoStats([ch.id]);

    fetchVideosBatch.mockResolvedValueOnce([
      makeYtVideo({ id: 'v1', statistics: { viewCount: '999', likeCount: '99', commentCount: '99' } }),
    ]);
    await syncVideoStats([ch.id]);

    const vids = await prisma.video.findMany({});
    expect(vids).toHaveLength(1);
    expect(Number(vids[0].views)).toBe(999);
    const snaps = await prisma.videoSnapshot.findMany({});
    expect(snaps).toHaveLength(1);
    expect(Number(snaps[0].views)).toBe(999);
  });

  // --- only-on-change guard -------------------------------------------------
  // The sync must still UPDATE every video's current stats (so the dashboard
  // stays accurate), but it should only APPEND today's video_snapshot row when
  // the fetched stats differ from the video's most recent prior snapshot. This
  // is what keeps free-tier storage growth bounded; the carry-forward reports
  // make a skipped (unchanged) day lossless.
  const PRIOR = new Date('2025-01-01T00:00:00.000Z'); // any day before "today"

  it('only-on-change: unchanged stats update the video but write NO new snapshot', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_d', category: 'Dedicated Sadhguru' },
    });
    const v = await prisma.video.create({
      data: { youtubeVideoId: 'v1', channelId: ch.id, views: 0 },
    });
    // Prior snapshot equals what YouTube will return (100 / 10 / 5).
    await prisma.videoSnapshot.create({
      data: { videoId: v.id, channelId: ch.id, date: PRIOR, views: 100, likes: 10, comments: 5 },
    });

    fetchVideosBatch.mockResolvedValueOnce([makeYtVideo({ id: 'v1' })]); // 100/10/5
    await syncVideoStats([ch.id]);

    // The video's current stats are still refreshed...
    const vid = await prisma.video.findUnique({ where: { id: v.id } });
    expect(Number(vid.views)).toBe(100);
    // ...but no new (today) snapshot row was appended — only the prior remains.
    const snaps = await prisma.videoSnapshot.findMany({});
    expect(snaps).toHaveLength(1);
    expect(snaps[0].date.toISOString()).toBe(PRIOR.toISOString());
  });

  it('only-on-change: changed stats DO append a new snapshot', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_d', category: 'Dedicated Sadhguru' },
    });
    const v = await prisma.video.create({
      data: { youtubeVideoId: 'v1', channelId: ch.id, views: 0 },
    });
    await prisma.videoSnapshot.create({
      data: { videoId: v.id, channelId: ch.id, date: PRIOR, views: 100, likes: 10, comments: 5 },
    });

    fetchVideosBatch.mockResolvedValueOnce([
      makeYtVideo({ id: 'v1', statistics: { viewCount: '150', likeCount: '10', commentCount: '5' } }),
    ]);
    await syncVideoStats([ch.id]);

    const snaps = await prisma.videoSnapshot.findMany({ orderBy: { date: 'asc' } });
    expect(snaps).toHaveLength(2); // prior + today
    expect(Number(snaps[1].views)).toBe(150);
  });

  it('only-on-change: a video with no prior snapshot always gets its first one', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_d', category: 'Dedicated Sadhguru' },
    });
    await prisma.video.create({ data: { youtubeVideoId: 'v1', channelId: ch.id } });

    fetchVideosBatch.mockResolvedValueOnce([makeYtVideo({ id: 'v1' })]); // 100/10/5
    await syncVideoStats([ch.id]);

    const snaps = await prisma.videoSnapshot.findMany({});
    expect(snaps).toHaveLength(1);
    expect(Number(snaps[0].views)).toBe(100);
  });

  it('skips soft-deleted videos', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_d', category: 'Dedicated Sadhguru' },
    });
    await prisma.video.create({
      data: { youtubeVideoId: 'v_live', channelId: ch.id },
    });
    await prisma.video.create({
      data: { youtubeVideoId: 'v_dead', channelId: ch.id, deletedAt: new Date() },
    });

    fetchVideosBatch.mockResolvedValueOnce([makeYtVideo({ id: 'v_live' })]);
    const log = await syncVideoStats([ch.id]);
    expect(log.videosProcessed).toBe(1);
    const calledWith = fetchVideosBatch.mock.calls[0][0];
    expect(calledWith).toEqual(['v_live']);
  });

  it('skips archived channels entirely (channel-level scope filter)', async () => {
    const arch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_arch', category: 'Dedicated Sadhguru', status: 'archived' },
    });
    await prisma.video.create({ data: { youtubeVideoId: 'v_arch', channelId: arch.id } });

    const log = await syncVideoStats();
    expect(log.status).toBe('success');
    expect(log.videosProcessed).toBe(0);
    expect(fetchVideosBatch).not.toHaveBeenCalled();
  });

  it('breaks early when quota is low (before any fetch)', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_d', category: 'Dedicated Sadhguru' },
    });
    await prisma.video.create({ data: { youtubeVideoId: 'v1', channelId: ch.id } });
    getQuotaUsage.mockReturnValue(LOW_QUOTA);
    const log = await syncVideoStats();
    expect(log.status).toBe('success');
    expect(fetchVideosBatch).not.toHaveBeenCalled();
  });

  it('stops processing on QUOTA_EXCEEDED from a batch fetch', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_d', category: 'Dedicated Sadhguru' },
    });
    await prisma.video.create({ data: { youtubeVideoId: 'v1', channelId: ch.id } });
    fetchVideosBatch.mockRejectedValueOnce(new Error('QUOTA_EXCEEDED'));
    const log = await syncVideoStats();
    expect(log.status).toBe('success'); // no errors recorded because quota stop is graceful
    expect(log.errors).toEqual([]);
  });

  it('captures non-quota batch errors as partial (attributes channel id of first video in slice)', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_d', category: 'Dedicated Sadhguru' },
    });
    await prisma.video.create({ data: { youtubeVideoId: 'v1', channelId: ch.id } });
    fetchVideosBatch.mockRejectedValueOnce(new Error('boom'));
    const log = await syncVideoStats();
    expect(log.status).toBe('partial');
    expect(log.errors[0].channelId).toBe('UC_d');
    expect(log.errors[0].message).toBe('boom');
  });

  it('global error path → failed', async () => {
    vi.spyOn(prisma.channel, 'findMany').mockImplementationOnce(() => {
      throw new Error('db down');
    });
    const log = await syncVideoStats();
    expect(log.status).toBe('failed');
    expect(log.errors[0].channelId).toBe('global');
  });

  it('re-entrancy: parallel calls → one is rejected', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_d', category: 'Dedicated Sadhguru' },
    });
    await prisma.video.create({ data: { youtubeVideoId: 'v1', channelId: ch.id } });
    let release;
    const blocker = new Promise((r) => { release = r; });
    fetchVideosBatch.mockImplementation(async () => { await blocker; return []; });
    const a = syncVideoStats([ch.id]);
    await new Promise((r) => setTimeout(r, 0));
    await expect(syncVideoStats([ch.id])).rejects.toThrow('Video sync already in progress');
    release();
    await a;
  });

  it('handles missing snippet thumbnails / statistics fields (uses defaults)', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_d', category: 'Dedicated Sadhguru' },
    });
    await prisma.video.create({ data: { youtubeVideoId: 'v1', channelId: ch.id } });
    fetchVideosBatch.mockResolvedValueOnce([{ id: 'v1' }]);
    const log = await syncVideoStats([ch.id]);
    expect(log.status).toBe('success');
    const v = await prisma.video.findUnique({ where: { youtubeVideoId: 'v1' } });
    expect(Number(v.views)).toBe(0);
    expect(v.title).toBe('');
    expect(v.thumbnailUrl).toBe('');
    expect(v.duration).toBe('');
  });

  it('falls back to default thumbnail when only default thumbnail present', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_d', category: 'Dedicated Sadhguru' },
    });
    await prisma.video.create({ data: { youtubeVideoId: 'v1', channelId: ch.id } });
    fetchVideosBatch.mockResolvedValueOnce([
      {
        id: 'v1',
        snippet: { title: 'T', thumbnails: { default: { url: 'https://thumb/default.jpg' } } },
        statistics: { viewCount: '1', likeCount: '1', commentCount: '1' },
        contentDetails: { duration: 'PT1M' },
      },
    ]);
    await syncVideoStats([ch.id]);
    const v = await prisma.video.findUnique({ where: { youtubeVideoId: 'v1' } });
    expect(v.thumbnailUrl).toBe('https://thumb/default.jpg');
  });

  it('chunks large video lists into 50-batch groups', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_d', category: 'Dedicated Sadhguru' },
    });
    // 75 videos → 2 batches (50 + 25)
    const videos = Array.from({ length: 75 }, (_, i) => ({
      youtubeVideoId: `v${i}`,
      channelId: ch.id,
    }));
    await prisma.video.createMany({ data: videos });
    fetchVideosBatch.mockImplementation(async (ids) => ids.map((id) => makeYtVideo({ id })));

    const log = await syncVideoStats([ch.id]);
    expect(log.status).toBe('success');
    expect(log.videosProcessed).toBe(75);
    expect(fetchVideosBatch).toHaveBeenCalledTimes(2);
    expect(fetchVideosBatch.mock.calls[0][0]).toHaveLength(50);
    expect(fetchVideosBatch.mock.calls[1][0]).toHaveLength(25);
  });

  it('crosses the bulk-write flush boundary (>500 rows) and writes every snapshot', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_big', category: 'Dedicated Sadhguru' },
    });
    // 600 videos → forces a mid-loop flush (VIDEO_WRITE_FLUSH=500) plus a final flush.
    const data = Array.from({ length: 600 }, (_, i) => ({
      youtubeVideoId: `bv${i}`,
      channelId: ch.id,
    }));
    await prisma.video.createMany({ data });
    fetchVideosBatch.mockImplementation(async (ids) =>
      ids.map((id) => makeYtVideo({ id, statistics: { viewCount: '7', likeCount: '1', commentCount: '0' } }))
    );

    const log = await syncVideoStats([ch.id]);
    expect(log.status).toBe('success');
    expect(log.videosProcessed).toBe(600);

    // Exactly one snapshot per video, all carrying the refreshed view count.
    const snapCount = await prisma.videoSnapshot.count({ where: { channelId: ch.id } });
    expect(snapCount).toBe(600);
    const sample = await prisma.videoSnapshot.findMany({ where: { channelId: ch.id }, take: 5 });
    for (const s of sample) expect(Number(s.views)).toBe(7);
    const v = await prisma.video.findUnique({ where: { youtubeVideoId: 'bv0' } });
    expect(Number(v.views)).toBe(7);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// syncIhiIngestLast24h
// ────────────────────────────────────────────────────────────────────────────

describe('syncIhiIngestLast24h', () => {
  it('returns success with no matching channels', async () => {
    await prisma.channel.create({
      data: { youtubeChannelId: 'UC_x', category: 'Dedicated Sadhguru' },
    });
    const log = await syncIhiIngestLast24h();
    expect(log.status).toBe('success');
    expect(log.syncType).toBe('ihi_ingest');
  });

  it('happy path: ingests videos and classifies them', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_ihi',
        uploadsPlaylistId: 'UU_ihi',
        category: 'IHI Partner',
      },
    });
    fetchPlaylistItemsPublishedSince.mockResolvedValue({
      items: [makePlaylistItem('v1'), makePlaylistItem('v2')],
      pagesFetched: 2,
    });
    fetchVideosBatch.mockResolvedValue([makeYtVideo({ id: 'v1' }), makeYtVideo({ id: 'v2' })]);
    classifySadguruVideoBatch.mockImplementation(async (videos) => {
      const m = new Map();
      for (const v of videos) m.set(String(v._id), 'sadhguru');
      return m;
    });

    const log = await syncIhiIngestLast24h([ch.id]);
    expect(log.status).toBe('success');
    expect(log.videosProcessed).toBe(2);
    expect(log.quotaUsed).toBe(3); // 2 pages + 1 batch
    const v1 = await prisma.video.findUnique({ where: { youtubeVideoId: 'v1' } });
    expect(v1.classification).toBe('sadhguru');
  });

  it('includes auto-archived inactive channels (for reactivation flow)', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_ihi_arch',
        uploadsPlaylistId: 'UU_ihi_arch',
        category: 'IHI Partner',
        status: 'archived',
        autoArchivedForInactivity: true,
      },
    });
    fetchPlaylistItemsPublishedSince.mockResolvedValue({ items: [makePlaylistItem('vx')], pagesFetched: 1 });
    fetchVideosBatch.mockResolvedValue([makeYtVideo({ id: 'vx' })]);
    classifySadguruVideoBatch.mockResolvedValue(new Map([['placeholder', 'sadhguru']]));
    const log = await syncIhiIngestLast24h([ch.id]);
    expect(log.videosProcessed).toBe(1);
  });

  it('skips channels without uploadsPlaylistId', async () => {
    await prisma.channel.create({
      data: { youtubeChannelId: 'UC_no_play', category: 'IHI Partner' },
    });
    const log = await syncIhiIngestLast24h();
    expect(log.status).toBe('success');
    expect(log.videosProcessed).toBe(0);
    expect(fetchPlaylistItemsPublishedSince).not.toHaveBeenCalled();
  });

  it('breaks early on low quota', async () => {
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_ihi',
        uploadsPlaylistId: 'UU_ihi',
        category: 'IHI Partner',
      },
    });
    getQuotaUsage.mockReturnValue(LOW_QUOTA);
    const log = await syncIhiIngestLast24h();
    expect(log.status).toBe('success');
    expect(fetchPlaylistItemsPublishedSince).not.toHaveBeenCalled();
  });

  it('skips when playlist items are empty', async () => {
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_ihi',
        uploadsPlaylistId: 'UU_ihi',
        category: 'IHI Partner',
      },
    });
    fetchPlaylistItemsPublishedSince.mockResolvedValue({ items: [], pagesFetched: 1 });
    const log = await syncIhiIngestLast24h();
    expect(log.status).toBe('success');
    expect(fetchVideosBatch).not.toHaveBeenCalled();
  });

  it('skips when all playlist items lack videoId (videoIds=[])', async () => {
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_ihi',
        uploadsPlaylistId: 'UU_ihi',
        category: 'IHI Partner',
      },
    });
    fetchPlaylistItemsPublishedSince.mockResolvedValue({
      items: [{ contentDetails: {} }, { contentDetails: { videoId: '' } }],
      pagesFetched: 1,
    });
    const log = await syncIhiIngestLast24h();
    expect(log.status).toBe('success');
    expect(fetchVideosBatch).not.toHaveBeenCalled();
  });

  it('dedupes duplicate videoIds via Set', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_ihi',
        uploadsPlaylistId: 'UU_ihi',
        category: 'IHI Partner',
      },
    });
    fetchPlaylistItemsPublishedSince.mockResolvedValue({
      items: [makePlaylistItem('v1'), makePlaylistItem('v1'), makePlaylistItem('v2')],
      pagesFetched: 1,
    });
    fetchVideosBatch.mockResolvedValue([makeYtVideo({ id: 'v1' }), makeYtVideo({ id: 'v2' })]);
    classifySadguruVideoBatch.mockResolvedValue(new Map());
    await syncIhiIngestLast24h([ch.id]);
    expect(fetchVideosBatch).toHaveBeenCalledTimes(1);
    expect(fetchVideosBatch.mock.calls[0][0]).toEqual(['v1', 'v2']);
  });

  it('classify error: failure captured in syncLog as partial', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_ihi',
        uploadsPlaylistId: 'UU_ihi',
        category: 'IHI Partner',
      },
    });
    fetchPlaylistItemsPublishedSince.mockResolvedValue({ items: [makePlaylistItem('v1')], pagesFetched: 1 });
    fetchVideosBatch.mockResolvedValue([makeYtVideo({ id: 'v1' })]);
    classifySadguruVideoBatch.mockRejectedValue(new Error('vertex down'));
    const log = await syncIhiIngestLast24h([ch.id]);
    expect(log.status).toBe('partial');
    expect(log.errors[0].message).toMatch(/Classification: vertex down/);
  });

  it('classify returns no value for an id → video stays unclassified', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_ihi',
        uploadsPlaylistId: 'UU_ihi',
        category: 'IHI Partner',
      },
    });
    fetchPlaylistItemsPublishedSince.mockResolvedValue({ items: [makePlaylistItem('v1')], pagesFetched: 1 });
    fetchVideosBatch.mockResolvedValue([makeYtVideo({ id: 'v1' })]);
    classifySadguruVideoBatch.mockResolvedValue(new Map()); // no entries
    await syncIhiIngestLast24h([ch.id]);
    const v = await prisma.video.findUnique({ where: { youtubeVideoId: 'v1' } });
    expect(v.classification).toBe('');
  });

  it('only classifies unclassified videos (no needsClassify when all are classified)', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_ihi',
        uploadsPlaylistId: 'UU_ihi',
        category: 'IHI Partner',
      },
    });
    await prisma.video.create({
      data: {
        youtubeVideoId: 'v1',
        channelId: ch.id,
        classification: 'sadhguru',
      },
    });
    fetchPlaylistItemsPublishedSince.mockResolvedValue({ items: [makePlaylistItem('v1')], pagesFetched: 1 });
    fetchVideosBatch.mockResolvedValue([makeYtVideo({ id: 'v1' })]);
    await syncIhiIngestLast24h([ch.id]);
    expect(classifySadguruVideoBatch).not.toHaveBeenCalled();
  });

  it('breaks on QUOTA_EXCEEDED from per-channel call', async () => {
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_ihi',
        uploadsPlaylistId: 'UU_ihi',
        category: 'IHI Partner',
      },
    });
    fetchPlaylistItemsPublishedSince.mockRejectedValue(new Error('QUOTA_EXCEEDED'));
    const log = await syncIhiIngestLast24h();
    expect(log.status).toBe('success');
  });

  it('per-channel non-quota error captured as partial', async () => {
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_ihi',
        uploadsPlaylistId: 'UU_ihi',
        category: 'IHI Partner',
      },
    });
    fetchPlaylistItemsPublishedSince.mockRejectedValue(new Error('weird'));
    const log = await syncIhiIngestLast24h();
    expect(log.status).toBe('partial');
    expect(log.errors[0].channelId).toBe('UC_ihi');
  });

  it('global error path → failed', async () => {
    vi.spyOn(prisma.channel, 'findMany').mockImplementationOnce(() => {
      throw new Error('pgexplode');
    });
    const log = await syncIhiIngestLast24h();
    expect(log.status).toBe('failed');
    expect(log.errors[0].channelId).toBe('global');
  });

  it('re-entrancy guard rejects parallel runs', async () => {
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_ihi',
        uploadsPlaylistId: 'UU_ihi',
        category: 'IHI Partner',
      },
    });
    let release;
    const blocker = new Promise((r) => { release = r; });
    fetchPlaylistItemsPublishedSince.mockImplementation(async () => {
      await blocker;
      return { items: [], pagesFetched: 1 };
    });
    const a = syncIhiIngestLast24h();
    await new Promise((r) => setTimeout(r, 0));
    await expect(syncIhiIngestLast24h()).rejects.toThrow('IHI ingest sync already in progress');
    release();
    await a;
  });

  it('handles a video payload with no snippet/statistics/contentDetails (falls back to defaults)', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_ihi',
        uploadsPlaylistId: 'UU_ihi',
        category: 'IHI Partner',
      },
    });
    fetchPlaylistItemsPublishedSince.mockResolvedValue({ items: [makePlaylistItem('v1')], pagesFetched: 1 });
    fetchVideosBatch.mockResolvedValue([{ id: 'v1' }]);
    classifySadguruVideoBatch.mockResolvedValue(new Map());
    await syncIhiIngestLast24h([ch.id]);
    const v = await prisma.video.findUnique({ where: { youtubeVideoId: 'v1' } });
    expect(Number(v.views)).toBe(0);
    expect(v.title).toBe('');
    expect(v.thumbnailUrl).toBe('');
    expect(v.duration).toBe('');
  });

  it('falls back to default thumbnail when only default thumbnail present', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_ihi',
        uploadsPlaylistId: 'UU_ihi',
        category: 'IHI Partner',
      },
    });
    fetchPlaylistItemsPublishedSince.mockResolvedValue({ items: [makePlaylistItem('v1')], pagesFetched: 1 });
    fetchVideosBatch.mockResolvedValue([
      {
        id: 'v1',
        snippet: { title: 'T', thumbnails: { default: { url: 'https://thumb/default.jpg' } } },
        statistics: { viewCount: '1', likeCount: '1', commentCount: '1' },
        contentDetails: { duration: 'PT1M' },
      },
    ]);
    classifySadguruVideoBatch.mockResolvedValue(new Map());
    await syncIhiIngestLast24h([ch.id]);
    const v = await prisma.video.findUnique({ where: { youtubeVideoId: 'v1' } });
    expect(v.thumbnailUrl).toBe('https://thumb/default.jpg');
  });

  it('classify input falls back to empty description when missing', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_ihi',
        uploadsPlaylistId: 'UU_ihi',
        category: 'IHI Partner',
      },
    });
    fetchPlaylistItemsPublishedSince.mockResolvedValue({ items: [makePlaylistItem('v1')], pagesFetched: 1 });
    fetchVideosBatch.mockResolvedValue([
      {
        id: 'v1',
        snippet: { title: 'T', thumbnails: {} }, // no description
        statistics: {},
        contentDetails: {},
      },
    ]);
    classifySadguruVideoBatch.mockImplementation(async (videos) => {
      expect(videos[0].description).toBe('');
      return new Map();
    });
    await syncIhiIngestLast24h([ch.id]);
    expect(classifySadguruVideoBatch).toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// syncDedicatedIngestLast24h
// ────────────────────────────────────────────────────────────────────────────

describe('syncDedicatedIngestLast24h', () => {
  it('success path with no matching dedicated channels', async () => {
    await prisma.channel.create({
      data: { youtubeChannelId: 'UC_x', category: 'IHI Partner' },
    });
    const log = await syncDedicatedIngestLast24h();
    expect(log.status).toBe('success');
    expect(log.syncType).toBe('dedicated_ingest');
  });

  it('ingests + auto-classifies videos as sadhguru', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_d',
        uploadsPlaylistId: 'UU_d',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchPlaylistItemsPublishedSince.mockResolvedValue({
      items: [makePlaylistItem('v1')],
      pagesFetched: 1,
    });
    fetchVideosBatch.mockResolvedValue([makeYtVideo({ id: 'v1' })]);
    const log = await syncDedicatedIngestLast24h([ch.id]);
    expect(log.status).toBe('success');
    expect(log.videosProcessed).toBe(1);
    const v = await prisma.video.findUnique({ where: { youtubeVideoId: 'v1' } });
    expect(v.classification).toBe('sadhguru');
  });

  it('includes auto-archived inactive dedicated channels (reactivation flow)', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_d_arch',
        uploadsPlaylistId: 'UU_d_arch',
        category: 'Dedicated Sadhguru',
        status: 'archived',
        autoArchivedForInactivity: true,
      },
    });
    fetchPlaylistItemsPublishedSince.mockResolvedValue({ items: [makePlaylistItem('v1')], pagesFetched: 1 });
    fetchVideosBatch.mockResolvedValue([makeYtVideo({ id: 'v1' })]);
    const log = await syncDedicatedIngestLast24h([ch.id]);
    expect(log.videosProcessed).toBe(1);
  });

  it('skips channels without uploadsPlaylistId', async () => {
    await prisma.channel.create({
      data: { youtubeChannelId: 'UC_no_play', category: 'Dedicated Sadhguru' },
    });
    const log = await syncDedicatedIngestLast24h();
    expect(log.status).toBe('success');
    expect(log.videosProcessed).toBe(0);
  });

  it('breaks early on low quota', async () => {
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_d',
        uploadsPlaylistId: 'UU_d',
        category: 'Dedicated Sadhguru',
      },
    });
    getQuotaUsage.mockReturnValue(LOW_QUOTA);
    const log = await syncDedicatedIngestLast24h();
    expect(log.status).toBe('success');
    expect(fetchPlaylistItemsPublishedSince).not.toHaveBeenCalled();
  });

  it('skips when playlist items empty', async () => {
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_d',
        uploadsPlaylistId: 'UU_d',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchPlaylistItemsPublishedSince.mockResolvedValue({ items: [], pagesFetched: 1 });
    const log = await syncDedicatedIngestLast24h();
    expect(log.status).toBe('success');
    expect(fetchVideosBatch).not.toHaveBeenCalled();
  });

  it('skips when all items lack videoId', async () => {
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_d',
        uploadsPlaylistId: 'UU_d',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchPlaylistItemsPublishedSince.mockResolvedValue({
      items: [{ contentDetails: {} }],
      pagesFetched: 1,
    });
    const log = await syncDedicatedIngestLast24h();
    expect(log.status).toBe('success');
    expect(fetchVideosBatch).not.toHaveBeenCalled();
  });

  it('breaks on QUOTA_EXCEEDED', async () => {
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_d',
        uploadsPlaylistId: 'UU_d',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchPlaylistItemsPublishedSince.mockRejectedValue(new Error('QUOTA_EXCEEDED'));
    const log = await syncDedicatedIngestLast24h();
    expect(log.status).toBe('success');
  });

  it('per-channel non-quota error → partial', async () => {
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_d',
        uploadsPlaylistId: 'UU_d',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchPlaylistItemsPublishedSince.mockRejectedValue(new Error('whatever'));
    const log = await syncDedicatedIngestLast24h();
    expect(log.status).toBe('partial');
    expect(log.errors[0].channelId).toBe('UC_d');
  });

  it('global error path → failed', async () => {
    vi.spyOn(prisma.channel, 'findMany').mockImplementationOnce(() => {
      throw new Error('pg dead');
    });
    const log = await syncDedicatedIngestLast24h();
    expect(log.status).toBe('failed');
    expect(log.errors[0].channelId).toBe('global');
  });

  it('re-entrancy guard rejects parallel runs', async () => {
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_d',
        uploadsPlaylistId: 'UU_d',
        category: 'Dedicated Sadhguru',
      },
    });
    let release;
    const blocker = new Promise((r) => { release = r; });
    fetchPlaylistItemsPublishedSince.mockImplementation(async () => {
      await blocker;
      return { items: [], pagesFetched: 1 };
    });
    const a = syncDedicatedIngestLast24h();
    await new Promise((r) => setTimeout(r, 0));
    await expect(syncDedicatedIngestLast24h()).rejects.toThrow('Dedicated ingest sync already in progress');
    release();
    await a;
  });

  it('handles a video payload with no snippet/statistics/contentDetails (falls back to defaults)', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_d',
        uploadsPlaylistId: 'UU_d',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchPlaylistItemsPublishedSince.mockResolvedValue({ items: [makePlaylistItem('v1')], pagesFetched: 1 });
    fetchVideosBatch.mockResolvedValue([{ id: 'v1' }]);
    await syncDedicatedIngestLast24h([ch.id]);
    const v = await prisma.video.findUnique({ where: { youtubeVideoId: 'v1' } });
    expect(Number(v.views)).toBe(0);
    expect(v.title).toBe('');
    expect(v.thumbnailUrl).toBe('');
    expect(v.duration).toBe('');
  });

  it('falls back to default thumbnail when only default thumbnail present', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_d',
        uploadsPlaylistId: 'UU_d',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchPlaylistItemsPublishedSince.mockResolvedValue({ items: [makePlaylistItem('v1')], pagesFetched: 1 });
    fetchVideosBatch.mockResolvedValue([
      {
        id: 'v1',
        snippet: { title: 'T', thumbnails: { default: { url: 'https://thumb/default.jpg' } } },
        statistics: { viewCount: '1', likeCount: '1', commentCount: '1' },
        contentDetails: { duration: 'PT1M' },
      },
    ]);
    await syncDedicatedIngestLast24h([ch.id]);
    const v = await prisma.video.findUnique({ where: { youtubeVideoId: 'v1' } });
    expect(v.thumbnailUrl).toBe('https://thumb/default.jpg');
  });

  it('treats undefined modifiedCount as 0 (classifyResult fallback)', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_d',
        uploadsPlaylistId: 'UU_d',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchPlaylistItemsPublishedSince.mockResolvedValue({ items: [makePlaylistItem('v1')], pagesFetched: 1 });
    fetchVideosBatch.mockResolvedValue([makeYtVideo({ id: 'v1' })]);
    // Mock updateMany to return an object with neither `count` nor `modifiedCount`.
    const spy = vi.spyOn(prisma.video, 'updateMany').mockResolvedValueOnce({ /* no count */ });
    const log = await syncDedicatedIngestLast24h([ch.id]);
    expect(log.status).toBe('success');
    spy.mockRestore();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// syncIhiSadhguruVideoStats
// ────────────────────────────────────────────────────────────────────────────

describe('syncIhiSadhguruVideoStats', () => {
  it('success when no IHI channels', async () => {
    await prisma.channel.create({
      data: { youtubeChannelId: 'UC_x', category: 'Dedicated Sadhguru' },
    });
    const log = await syncIhiSadhguruVideoStats();
    expect(log.status).toBe('success');
    expect(log.syncType).toBe('ihi_sadhguru_stats');
  });

  it('success when IHI channels exist but no sadhguru videos', async () => {
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_ihi',
        category: 'IHI Partner',
      },
    });
    const log = await syncIhiSadhguruVideoStats();
    expect(log.status).toBe('success');
    expect(log.videosProcessed).toBe(0);
  });

  it('updates stats + writes snapshot for sadhguru videos (with explicit channelIds filter)', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_ihi', category: 'IHI Partner' },
    });
    await prisma.video.create({
      data: {
        youtubeVideoId: 'v1',
        channelId: ch.id,
        classification: 'sadhguru',
      },
    });
    fetchVideosBatch.mockResolvedValue([makeYtVideo({ id: 'v1' })]);
    const log = await syncIhiSadhguruVideoStats([ch.id]);
    expect(log.status).toBe('success');
    expect(log.videosProcessed).toBe(1);
    const v = await prisma.video.findUnique({ where: { youtubeVideoId: 'v1' } });
    expect(Number(v.views)).toBe(100);
    const snaps = await prisma.videoSnapshot.findMany({ where: { videoId: v.id } });
    expect(snaps).toHaveLength(1);
  });

  it('only-on-change: unchanged sadhguru stats update the video but write NO new snapshot', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_ihi', category: 'IHI Partner' },
    });
    const v = await prisma.video.create({
      data: { youtubeVideoId: 'v1', channelId: ch.id, classification: 'sadhguru', views: 0 },
    });
    const prior = new Date('2025-01-01T00:00:00.000Z');
    await prisma.videoSnapshot.create({
      data: { videoId: v.id, channelId: ch.id, date: prior, views: 100, likes: 10, comments: 5 },
    });

    fetchVideosBatch.mockResolvedValue([makeYtVideo({ id: 'v1' })]); // 100/10/5 unchanged
    await syncIhiSadhguruVideoStats([ch.id]);

    const vid = await prisma.video.findUnique({ where: { id: v.id } });
    expect(Number(vid.views)).toBe(100); // current stats still refreshed
    const snaps = await prisma.videoSnapshot.findMany({ where: { videoId: v.id } });
    expect(snaps).toHaveLength(1); // no duplicate today row appended
    expect(snaps[0].date.toISOString()).toBe(prior.toISOString());
  });

  it('ignores YouTube payload entries we no longer have a video for', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_ihi', category: 'IHI Partner' },
    });
    await prisma.video.create({
      data: {
        youtubeVideoId: 'v1',
        channelId: ch.id,
        classification: 'sadhguru',
      },
    });
    fetchVideosBatch.mockResolvedValue([
      makeYtVideo({ id: 'v1' }),
      makeYtVideo({ id: 'v_unknown' }),
    ]);
    const log = await syncIhiSadhguruVideoStats();
    expect(log.videosProcessed).toBe(1);
  });

  it('soft-deleted videos are not picked up (deletedAt set)', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_ihi', category: 'IHI Partner' },
    });
    await prisma.video.create({
      data: {
        youtubeVideoId: 'v1',
        channelId: ch.id,
        classification: 'sadhguru',
        deletedAt: new Date(),
      },
    });
    const log = await syncIhiSadhguruVideoStats();
    expect(log.status).toBe('success');
    expect(log.videosProcessed).toBe(0);
  });

  it('breaks on low quota mid-loop', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_ihi', category: 'IHI Partner' },
    });
    for (let i = 0; i < 51; i++) {
      await prisma.video.create({
        data: {
          youtubeVideoId: `v${i}`,
          channelId: ch.id,
          classification: 'sadhguru',
        },
      });
    }
    getQuotaUsage
      .mockReturnValueOnce(FULL_QUOTA)
      .mockReturnValueOnce({ used: 9998, limit: 10000, remaining: 2 });
    fetchVideosBatch.mockResolvedValue([]);
    const log = await syncIhiSadhguruVideoStats();
    expect(log.status).toBe('success');
    expect(fetchVideosBatch).toHaveBeenCalledTimes(1);
  });

  it('breaks on QUOTA_EXCEEDED from a batch call', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_ihi', category: 'IHI Partner' },
    });
    await prisma.video.create({
      data: { youtubeVideoId: 'v1', channelId: ch.id, classification: 'sadhguru' },
    });
    fetchVideosBatch.mockRejectedValue(new Error('QUOTA_EXCEEDED'));
    const log = await syncIhiSadhguruVideoStats();
    expect(log.status).toBe('success');
  });

  it('captures non-quota batch error as partial', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_ihi', category: 'IHI Partner' },
    });
    await prisma.video.create({
      data: { youtubeVideoId: 'v1', channelId: ch.id, classification: 'sadhguru' },
    });
    fetchVideosBatch.mockRejectedValue(new Error('boom'));
    const log = await syncIhiSadhguruVideoStats();
    expect(log.status).toBe('partial');
    expect(log.errors[0].channelId).toBe('batch');
  });

  it('skips when video update returns null (video deleted mid-flight)', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_ihi', category: 'IHI Partner' },
    });
    await prisma.video.create({
      data: {
        youtubeVideoId: 'v1',
        channelId: ch.id,
        classification: 'sadhguru',
      },
    });
    fetchVideosBatch.mockResolvedValue([makeYtVideo({ id: 'v1' })]);
    // Force the update to throw P2025 so the soft-skip branch fires.
    const p2025 = Object.assign(new Error('not found'), { code: 'P2025' });
    const spy = vi.spyOn(prisma.video, 'update').mockRejectedValueOnce(p2025);
    const log = await syncIhiSadhguruVideoStats();
    expect(log.status).toBe('success');
    expect(log.videosProcessed).toBe(0);
    spy.mockRestore();
  });

  it('global error → failed', async () => {
    vi.spyOn(prisma.channel, 'findMany').mockImplementationOnce(() => {
      throw new Error('catastrophe');
    });
    const log = await syncIhiSadhguruVideoStats();
    expect(log.status).toBe('failed');
    expect(log.errors[0].channelId).toBe('global');
  });

  it('re-entrancy guard rejects parallel runs', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_ihi', category: 'IHI Partner' },
    });
    await prisma.video.create({
      data: { youtubeVideoId: 'v1', channelId: ch.id, classification: 'sadhguru' },
    });
    let release;
    const blocker = new Promise((r) => { release = r; });
    fetchVideosBatch.mockImplementation(async () => { await blocker; return []; });
    const a = syncIhiSadhguruVideoStats();
    await new Promise((r) => setTimeout(r, 0));
    await expect(syncIhiSadhguruVideoStats()).rejects.toThrow('IHI Sadhguru stats sync already in progress');
    release();
    await a;
  });

  it('skips entries whose youtubeVideoId is falsy (ytIds.filter Boolean)', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_ihi', category: 'IHI Partner' },
    });
    await prisma.video.create({
      data: { youtubeVideoId: 'v_real', channelId: ch.id, classification: 'sadhguru' },
    });
    fetchVideosBatch.mockResolvedValue([makeYtVideo({ id: 'v_real' })]);
    const log = await syncIhiSadhguruVideoStats();
    expect(log.videosProcessed).toBe(1);
  });

  it('handles a video payload with no snippet/statistics/contentDetails (falls back to defaults)', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_ihi', category: 'IHI Partner' },
    });
    await prisma.video.create({
      data: { youtubeVideoId: 'v1', channelId: ch.id, classification: 'sadhguru' },
    });
    fetchVideosBatch.mockResolvedValue([{ id: 'v1' }]);
    const log = await syncIhiSadhguruVideoStats();
    expect(log.status).toBe('success');
    const v = await prisma.video.findUnique({ where: { youtubeVideoId: 'v1' } });
    expect(Number(v.views)).toBe(0);
    expect(v.title).toBe('');
    expect(v.thumbnailUrl).toBe('');
    expect(v.duration).toBe('');
  });

  it('falls back to default thumbnail when only default thumbnail is present', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_ihi', category: 'IHI Partner' },
    });
    await prisma.video.create({
      data: { youtubeVideoId: 'v1', channelId: ch.id, classification: 'sadhguru' },
    });
    fetchVideosBatch.mockResolvedValue([
      {
        id: 'v1',
        snippet: { title: 'T', thumbnails: { default: { url: 'https://thumb/default.jpg' } } },
        statistics: { viewCount: '1', likeCount: '1', commentCount: '1' },
        contentDetails: { duration: 'PT1M' },
      },
    ]);
    await syncIhiSadhguruVideoStats();
    const v = await prisma.video.findUnique({ where: { youtubeVideoId: 'v1' } });
    expect(v.thumbnailUrl).toBe('https://thumb/default.jpg');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// syncChannels (alias)
// ────────────────────────────────────────────────────────────────────────────

describe('syncChannels', () => {
  it('runs channel sync then video sync in sequence', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_d',
        uploadsPlaylistId: 'UU_d',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchChannelsBatch.mockResolvedValue([makeYtChannel({ id: 'UC_d' })]);
    fetchPlaylistItems.mockResolvedValue([makePlaylistItem('v1')]);
    fetchVideosBatch.mockResolvedValue([makeYtVideo({ id: 'v1' })]);
    await syncChannels([ch.id]);
    const logs = await prisma.syncLog.findMany({ orderBy: { startedAt: 'asc' } });
    expect(logs).toHaveLength(2);
    expect(logs[0].syncType).toBe('channel');
    expect(logs[1].syncType).toBe('video');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// pullAllChannelVideos
// ────────────────────────────────────────────────────────────────────────────

describe('pullAllChannelVideos', () => {
  it('throws when called while another pull is in flight', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_a',
        uploadsPlaylistId: 'UU_a',
        category: 'Dedicated Sadhguru',
      },
    });
    let release;
    const blocker = new Promise((r) => { release = r; });
    fetchAllPlaylistItemIds.mockImplementation(async () => { await blocker; return []; });
    const first = pullAllChannelVideos(ch.id);
    await new Promise((r) => setTimeout(r, 0));
    await expect(pullAllChannelVideos(ch.id)).rejects.toThrow('Pull all videos already in progress');
    release();
    await first;
  });

  it('throws when channel not found', async () => {
    const fakeId = 'nonexistent-channel-id';
    await expect(pullAllChannelVideos(fakeId)).rejects.toThrow('Channel not found');
    expect(getSyncStatus().isPullingAllVideos).toBe(false);
  });

  it('resolves missing uploadsPlaylistId via fetchSingleChannel and saves it', async () => {
    const ch = await prisma.channel.create({
      data: { youtubeChannelId: 'UC_a', category: 'Other' },
    });
    fetchSingleChannel.mockResolvedValue(makeYtChannel({ id: 'UC_a' }));
    fetchAllPlaylistItemIds.mockResolvedValue([]);
    const result = await pullAllChannelVideos(ch.id);
    expect(result.videosProcessed).toBe(0);
    const fresh = await prisma.channel.findUnique({ where: { id: ch.id } });
    expect(fresh.uploadsPlaylistId).toBe('UU_default');
  });

  it('throws when channel has no uploads playlist resolvable', async () => {
    const ch = await prisma.channel.create({ data: { youtubeChannelId: 'UC_a' } });
    fetchSingleChannel.mockResolvedValue(null);
    await expect(pullAllChannelVideos(ch.id)).rejects.toThrow('Channel has no uploads playlist');
    expect(getSyncStatus().isPullingAllVideos).toBe(false);
  });

  it('throws when fetchSingleChannel returns a channel without uploads', async () => {
    const ch = await prisma.channel.create({ data: { youtubeChannelId: 'UC_a' } });
    fetchSingleChannel.mockResolvedValue({ id: 'UC_a', contentDetails: {} });
    await expect(pullAllChannelVideos(ch.id)).rejects.toThrow('Channel has no uploads playlist');
  });

  it('pulls all videos, marks allVideosPulled=true, auto-classifies dedicated', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_a',
        uploadsPlaylistId: 'UU_a',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchAllPlaylistItemIds.mockResolvedValue(['v1', 'v2']);
    fetchVideosBatch.mockResolvedValue([makeYtVideo({ id: 'v1' }), makeYtVideo({ id: 'v2' })]);
    const result = await pullAllChannelVideos(ch.id);
    expect(result.videosProcessed).toBe(2);
    expect(result.totalIds).toBe(2);
    expect(result.allVideosPulled).toBe(true);
    expect(result.dedicatedAutoClassified).toBe(2);
    const v1 = await prisma.video.findUnique({ where: { youtubeVideoId: 'v1' } });
    expect(v1.classification).toBe('sadhguru');
    const fresh = await prisma.channel.findUnique({ where: { id: ch.id } });
    expect(fresh.allVideosPulled).toBe(true);
  });

  it('does not auto-classify non-dedicated channels', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_a',
        uploadsPlaylistId: 'UU_a',
        category: 'IHI Partner',
      },
    });
    fetchAllPlaylistItemIds.mockResolvedValue(['v1']);
    fetchVideosBatch.mockResolvedValue([makeYtVideo({ id: 'v1' })]);
    const result = await pullAllChannelVideos(ch.id);
    expect(result.dedicatedAutoClassified).toBe(0);
    const v1 = await prisma.video.findUnique({ where: { youtubeVideoId: 'v1' } });
    expect(v1.classification).toBe('');
  });

  it('breaks early on low quota', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_a',
        uploadsPlaylistId: 'UU_a',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchAllPlaylistItemIds.mockResolvedValue(['v1', 'v2']);
    getQuotaUsage.mockReturnValue(LOW_QUOTA);
    const result = await pullAllChannelVideos(ch.id);
    expect(result.videosProcessed).toBe(0);
    expect(result.allVideosPulled).toBe(false);
    expect(fetchVideosBatch).not.toHaveBeenCalled();
  });

  it('logs error and continues when saving an individual video throws', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_a',
        uploadsPlaylistId: 'UU_a',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchAllPlaylistItemIds.mockResolvedValue(['v1', 'v2']);
    fetchVideosBatch.mockResolvedValue([makeYtVideo({ id: 'v1' }), makeYtVideo({ id: 'v2' })]);
    let calls = 0;
    const original = prisma.video.upsert.bind(prisma.video);
    const spy = vi.spyOn(prisma.video, 'upsert').mockImplementation(function (...args) {
      calls += 1;
      if (calls === 1) throw new Error('save fail');
      return original(...args);
    });
    const result = await pullAllChannelVideos(ch.id);
    expect(result.videosProcessed).toBe(1);
    spy.mockRestore();
  });

  it('re-throws QUOTA_EXCEEDED from fetchAllPlaylistItemIds', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_a',
        uploadsPlaylistId: 'UU_a',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchAllPlaylistItemIds.mockRejectedValue(new Error('QUOTA_EXCEEDED'));
    await expect(pullAllChannelVideos(ch.id)).rejects.toThrow('QUOTA_EXCEEDED');
    expect(getSyncStatus().isPullingAllVideos).toBe(false);
  });

  it('re-throws other errors from fetchAllPlaylistItemIds and resets guard', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_a',
        uploadsPlaylistId: 'UU_a',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchAllPlaylistItemIds.mockRejectedValue(new Error('explode'));
    await expect(pullAllChannelVideos(ch.id)).rejects.toThrow('explode');
    expect(getSyncStatus().isPullingAllVideos).toBe(false);
  });

  it('processed < total → allVideosPulled stays false', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_a',
        uploadsPlaylistId: 'UU_a',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchAllPlaylistItemIds.mockResolvedValue(['v1', 'v2']);
    fetchVideosBatch.mockResolvedValue([makeYtVideo({ id: 'v1' })]); // one missing
    const result = await pullAllChannelVideos(ch.id);
    expect(result.videosProcessed).toBe(1);
    expect(result.totalIds).toBe(2);
    expect(result.allVideosPulled).toBe(false);
    const fresh = await prisma.channel.findUnique({ where: { id: ch.id } });
    expect(fresh.allVideosPulled).toBe(false);
  });

  it('handles a video payload with no snippet/statistics/contentDetails (falls back to defaults)', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_a',
        uploadsPlaylistId: 'UU_a',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchAllPlaylistItemIds.mockResolvedValue(['v1']);
    fetchVideosBatch.mockResolvedValue([{ id: 'v1' }]);
    const result = await pullAllChannelVideos(ch.id);
    expect(result.videosProcessed).toBe(1);
    const v = await prisma.video.findUnique({ where: { youtubeVideoId: 'v1' } });
    expect(Number(v.views)).toBe(0);
    expect(v.title).toBe('');
    expect(v.thumbnailUrl).toBe('');
    expect(v.duration).toBe('');
  });

  it('falls back to default thumbnail when only default thumbnail present', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_a',
        uploadsPlaylistId: 'UU_a',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchAllPlaylistItemIds.mockResolvedValue(['v1']);
    fetchVideosBatch.mockResolvedValue([
      {
        id: 'v1',
        snippet: { title: 'T', thumbnails: { default: { url: 'https://thumb/default.jpg' } } },
        statistics: { viewCount: '1', likeCount: '1', commentCount: '1' },
        contentDetails: { duration: 'PT1M' },
      },
    ]);
    await pullAllChannelVideos(ch.id);
    const v = await prisma.video.findUnique({ where: { youtubeVideoId: 'v1' } });
    expect(v.thumbnailUrl).toBe('https://thumb/default.jpg');
  });

  it('dedicated auto-classify when zero existing videos need updating logs nothing', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_a',
        uploadsPlaylistId: 'UU_a',
        category: 'Dedicated Sadhguru',
      },
    });
    await prisma.video.create({
      data: {
        youtubeVideoId: 'v1',
        channelId: ch.id,
        classification: 'sadhguru',
      },
    });
    fetchAllPlaylistItemIds.mockResolvedValue(['v1']);
    fetchVideosBatch.mockResolvedValue([makeYtVideo({ id: 'v1' })]);
    const result = await pullAllChannelVideos(ch.id);
    expect(result.dedicatedAutoClassified).toBe(0);
  });

  it('treats undefined count as 0 for dedicated auto-classify', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_a',
        uploadsPlaylistId: 'UU_a',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchAllPlaylistItemIds.mockResolvedValue(['v1']);
    fetchVideosBatch.mockResolvedValue([makeYtVideo({ id: 'v1' })]);
    const spy = vi.spyOn(prisma.video, 'updateMany').mockResolvedValueOnce({ /* no count */ });
    const result = await pullAllChannelVideos(ch.id);
    expect(result.dedicatedAutoClassified).toBe(0);
    spy.mockRestore();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// pullAllChannelsVideos (batch over multiple channels)
// ────────────────────────────────────────────────────────────────────────────

describe('pullAllChannelsVideos', () => {
  it('throws if a single-channel pull is in flight', async () => {
    const ch = await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_a',
        uploadsPlaylistId: 'UU_a',
        category: 'Dedicated Sadhguru',
      },
    });
    let release;
    const blocker = new Promise((r) => { release = r; });
    fetchAllPlaylistItemIds.mockImplementation(async () => { await blocker; return []; });
    const first = pullAllChannelVideos(ch.id);
    await new Promise((r) => setTimeout(r, 0));
    await expect(pullAllChannelsVideos()).rejects.toThrow('Pull all videos already in progress');
    release();
    await first;
  });

  it('returns "no channels need pull" when nothing to do', async () => {
    const result = await pullAllChannelsVideos();
    expect(result.channelsProcessed).toBe(0);
    expect(result.totalVideosPulled).toBe(0);
    expect(result.message).toMatch(/No channels need video pull/);
  });

  it('skips archived channels and channels with allVideosPulled=true', async () => {
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_arch',
        uploadsPlaylistId: 'UU_arch',
        status: 'archived',
        category: 'Dedicated Sadhguru',
      },
    });
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_pulled',
        uploadsPlaylistId: 'UU_pulled',
        allVideosPulled: true,
        category: 'Dedicated Sadhguru',
      },
    });
    const result = await pullAllChannelsVideos();
    expect(result.channelsProcessed).toBe(0);
  });

  it('processes each channel and accumulates totalVideosPulled', async () => {
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_a',
        uploadsPlaylistId: 'UU_a',
        title: 'A',
        category: 'Dedicated Sadhguru',
      },
    });
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_b',
        uploadsPlaylistId: 'UU_b',
        title: 'B',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchAllPlaylistItemIds.mockImplementation(async (pl) => (pl === 'UU_a' ? ['v1'] : ['v2', 'v3']));
    fetchVideosBatch.mockImplementation(async (ids) => ids.map((id) => makeYtVideo({ id })));
    const result = await pullAllChannelsVideos();
    expect(result.channelsProcessed).toBe(2);
    expect(result.totalVideosPulled).toBe(3);
  });

  it('stops on low quota mid-loop', async () => {
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_a',
        uploadsPlaylistId: 'UU_a',
        title: 'A',
        category: 'Dedicated Sadhguru',
      },
    });
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_b',
        uploadsPlaylistId: 'UU_b',
        title: 'B',
        category: 'Dedicated Sadhguru',
      },
    });
    getQuotaUsage.mockReturnValue(LOW_QUOTA);
    const result = await pullAllChannelsVideos();
    expect(result.channelsProcessed).toBe(0);
  });

  it('breaks on QUOTA_EXCEEDED from a child pull', async () => {
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_a',
        uploadsPlaylistId: 'UU_a',
        title: 'A',
        category: 'Dedicated Sadhguru',
      },
    });
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_b',
        uploadsPlaylistId: 'UU_b',
        title: 'B',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchAllPlaylistItemIds.mockRejectedValueOnce(new Error('QUOTA_EXCEEDED'));
    const result = await pullAllChannelsVideos();
    expect(result.channelsProcessed).toBe(0);
  });

  it('includes channels that have only youtubeChannelId (no uploadsPlaylistId)', async () => {
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_only_yt',
        title: 'OnlyYt',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchSingleChannel.mockResolvedValue(makeYtChannel({ id: 'UC_only_yt' }));
    fetchAllPlaylistItemIds.mockResolvedValue([]);
    const result = await pullAllChannelsVideos();
    expect(result.channelsProcessed).toBe(1);
  });

  it('captures non-quota child errors and continues', async () => {
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_a',
        uploadsPlaylistId: 'UU_a',
        title: 'A',
        category: 'Dedicated Sadhguru',
      },
    });
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'UC_b',
        uploadsPlaylistId: 'UU_b',
        title: 'B',
        category: 'Dedicated Sadhguru',
      },
    });
    fetchAllPlaylistItemIds
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValueOnce([]);
    const result = await pullAllChannelsVideos();
    expect(result.channelsProcessed).toBe(1);
    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toBe('flaky');
  });
});
