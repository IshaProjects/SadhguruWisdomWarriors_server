import request from 'supertest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Hoisted mocks of external services (network/AI) ---------------------
vi.mock('../../src/services/youtubeApi.js', () => ({
  fetchSingleChannel: vi.fn(),
  resolveChannelByHandle: vi.fn(),
  fetchChannelByHandle: vi.fn(),
  getQuotaUsage: vi.fn(() => ({ used: 0, limit: 10000, remaining: 10000 })),
}));
vi.mock('../../src/services/syncEngine.js', () => ({
  syncChannels: vi.fn(),
  pullAllChannelVideos: vi.fn(),
  pullAllChannelsVideos: vi.fn(),
}));
vi.mock('../../src/services/vertexAiService.js', () => ({
  classifySadguruVideoBatch: vi.fn(async () => new Map()),
}));

import app from '../../src/app.js';
import { prisma } from '../setup.js';
import { authFor } from '../helpers.js';

import {
  fetchSingleChannel,
  resolveChannelByHandle,
  fetchChannelByHandle,
} from '../../src/services/youtubeApi.js';
import {
  syncChannels,
  pullAllChannelVideos,
  pullAllChannelsVideos,
} from '../../src/services/syncEngine.js';
import { classifySadguruVideoBatch } from '../../src/services/vertexAiService.js';

// Cuid-shaped fake id for "not found" lookups (matches isValidId pattern).
const fakeCuid = () => 'c' + 'x'.repeat(24);

let seq = 0;
const mkChannel = async (over = {}) => {
  seq += 1;
  // Translate legacy currentStats.{...} shape used by Mongoose tests into the
  // flat Prisma columns. Either shape is accepted for convenience.
  const stats = over.currentStats || {};
  const data = {
    youtubeChannelId: over.youtubeChannelId ?? `UC${'a'.repeat(20)}${seq}`,
    title: over.title ?? 'Channel ' + seq,
    description: over.description ?? '',
    category: over.category,
    tags: over.tags,
    status: over.status,
    notes: over.notes,
    assignedToId: over.assignedToId ?? over.assignedTo ?? undefined,
    autoArchivedForInactivity: over.autoArchivedForInactivity,
    allVideosPulled: over.allVideosPulled,
    publishedAt: over.publishedAt,
    customUrl: over.customUrl,
    currentSubscribers: stats.subscribers ?? over.currentSubscribers,
    currentViews: stats.views != null ? BigInt(stats.views) : (over.currentViews != null ? BigInt(over.currentViews) : undefined),
    currentVideoCount: stats.videoCount ?? over.currentVideoCount,
  };
  // Strip undefined entries so Prisma uses its column defaults.
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  return prisma.channel.create({ data });
};

const mkVideo = async (over) => {
  seq += 1;
  const data = {
    youtubeVideoId: over.youtubeVideoId ?? `yt-vid-${seq}`,
    channelId: over.channelId,
    title: over.title ?? 'Video ' + seq,
    publishedAt: over.publishedAt,
    views: over.views != null ? BigInt(over.views) : undefined,
    likes: over.likes,
    comments: over.comments,
    classification: over.classification,
  };
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  return prisma.video.create({ data });
};

const ytChannelPayload = (over = {}) => ({
  id: over.id ?? 'UCabcdefghijklmnopqrstuv',
  snippet: {
    title: 'YT Title',
    description: 'YT Desc',
    thumbnails: { high: { url: 'high.jpg' }, default: { url: 'default.jpg' } },
    customUrl: '@yt-handle',
    country: 'IN',
    publishedAt: '2020-01-01T00:00:00.000Z',
    ...(over.snippet || {}),
  },
  statistics: {
    subscriberCount: '1000',
    viewCount: '50000',
    videoCount: '42',
    ...(over.statistics || {}),
  },
  brandingSettings: { image: { bannerExternalUrl: 'banner.jpg' }, ...(over.brandingSettings || {}) },
  contentDetails: { relatedPlaylists: { uploads: 'UU' + 'x'.repeat(22) }, ...(over.contentDetails || {}) },
  ...over,
});

beforeEach(() => {
  fetchSingleChannel.mockReset();
  resolveChannelByHandle.mockReset();
  fetchChannelByHandle.mockReset();
  syncChannels.mockReset();
  pullAllChannelVideos.mockReset();
  pullAllChannelsVideos.mockReset();
  classifySadguruVideoBatch.mockReset();
  classifySadguruVideoBatch.mockResolvedValue(new Map());
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =========================================================================
// GET /api/channels
// =========================================================================
describe('GET /api/channels (listChannels)', () => {
  it('returns paginated channels with classificationDone flag and default sort', async () => {
    const { headers } = await authFor('viewer');
    const a = await mkChannel({ title: 'Apple', currentStats: { subscribers: 10, views: 0, videoCount: 0 } });
    const b = await mkChannel({ title: 'Banana', currentStats: { subscribers: 100, views: 0, videoCount: 0 } });
    await mkVideo({ channelId: a.id, classification: '' });
    await mkVideo({ channelId: b.id, classification: 'sadhguru' });

    const res = await request(app).get('/api/channels').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(2);
    expect(res.body.channels[0]._id).toBe(b.id);
    expect(res.body.channels.find((c) => c._id === a.id).classificationDone).toBe(false);
    expect(res.body.channels.find((c) => c._id === b.id).classificationDone).toBe(true);
    expect(res.body.pagination).toEqual({ page: 1, limit: 25, total: 2, pages: 1 });
  });

  it('filters by search (title contains, case-insensitive)', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ title: 'FindMe One' });
    await mkChannel({ title: 'Other Two' });
    const res = await request(app).get('/api/channels?search=FindMe').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(1);
    expect(res.body.channels[0].title).toBe('FindMe One');
  });

  it('filters by group=dedicated', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ category: 'Dedicated Channel' });
    await mkChannel({ category: 'Other' });
    const res = await request(app).get('/api/channels?group=dedicated').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(1);
    expect(res.body.channels[0].category).toBe('Dedicated Channel');
  });

  it('filters by group=ihi', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ category: 'IHI Stuff' });
    await mkChannel({ category: 'Other' });
    const res = await request(app).get('/api/channels?group=ihi').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(1);
    expect(res.body.channels[0].category).toBe('IHI Stuff');
  });

  it('filters by explicit category when group is absent', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ category: 'News' });
    await mkChannel({ category: 'Music' });
    const res = await request(app).get('/api/channels?category=News').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(1);
    expect(res.body.channels[0].category).toBe('News');
  });

  it('explicit status overrides the default not-archived filter', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ status: 'archived', title: 'Arc' });
    await mkChannel({ status: 'active', title: 'Act' });
    const res = await request(app).get('/api/channels?status=archived').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(1);
    expect(res.body.channels[0].title).toBe('Arc');
  });

  it('filters by tags csv (only non-empty tags pass)', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ title: 'T1', tags: ['alpha'] });
    await mkChannel({ title: 'T2', tags: ['beta'] });
    await mkChannel({ title: 'T3', tags: [] });
    const res = await request(app).get('/api/channels?tags=alpha,,').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.channels.map((c) => c.title).sort()).toEqual(['T1']);
  });

  it('ignores whitespace-only tags (empty list path)', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ title: 'Z', tags: ['x'] });
    const res = await request(app).get('/api/channels?tags=%20%2C%20').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(1);
  });

  it('filters by assignedTo, minSubs and maxSubs', async () => {
    const { headers } = await authFor('viewer');
    const u = await prisma.user.create({
      data: { email: 'assignee@test.local', name: 'Assignee', password: 'pw', role: 'viewer' },
    });
    await mkChannel({ title: 'in', assignedToId: u.id, currentStats: { subscribers: 500, views: 0, videoCount: 0 } });
    await mkChannel({ title: 'lo', assignedToId: u.id, currentStats: { subscribers: 10, views: 0, videoCount: 0 } });
    await mkChannel({ title: 'hi', assignedToId: u.id, currentStats: { subscribers: 9000, views: 0, videoCount: 0 } });
    await mkChannel({ title: 'noassign', currentStats: { subscribers: 500, views: 0, videoCount: 0 } });

    const res = await request(app)
      .get(`/api/channels?assignedTo=${u.id}&minSubs=100&maxSubs=1000&sort=title`)
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.channels.map((c) => c.title)).toEqual(['in']);
  });

  it('handles only-minSubs and only-maxSubs branches', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ title: 'low', currentStats: { subscribers: 5, views: 0, videoCount: 0 } });
    await mkChannel({ title: 'high', currentStats: { subscribers: 5000, views: 0, videoCount: 0 } });

    const r1 = await request(app).get('/api/channels?minSubs=1000').set(headers);
    expect(r1.body.channels.map((c) => c.title)).toEqual(['high']);

    const r2 = await request(app).get('/api/channels?maxSubs=100').set(headers);
    expect(r2.body.channels.map((c) => c.title)).toEqual(['low']);
  });

  it('paginates and reports pages correctly', async () => {
    const { headers } = await authFor('viewer');
    for (let i = 0; i < 3; i++) {
      await mkChannel({ title: `P${i}`, currentStats: { subscribers: i, views: 0, videoCount: 0 } });
    }
    const res = await request(app).get('/api/channels?page=2&limit=2&sort=title').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(1);
    expect(res.body.pagination).toEqual({ page: 2, limit: 2, total: 3, pages: 2 });
  });

  it('500 when Channel findMany throws (catch path)', async () => {
    vi.spyOn(prisma.channel, 'findMany').mockImplementationOnce(() => {
      throw new Error('boom-list');
    });
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/channels').set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom-list');
  });
});

// =========================================================================
// POST /api/channels (addChannel)
// =========================================================================
describe('POST /api/channels (addChannel)', () => {
  it('403 for viewer', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).post('/api/channels').set(headers).send({ channelInput: 'x' });
    expect(res.status).toBe(403);
  });

  it('400 when channelInput missing', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).post('/api/channels').set(headers).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Channel ID or URL is required');
  });

  it('resolves a handle via resolveChannelByHandle and creates the channel + snapshot', async () => {
    const { headers } = await authFor('manager');
    resolveChannelByHandle.mockResolvedValueOnce('UCabcdefghijklmnopqrstuv');
    fetchSingleChannel.mockResolvedValueOnce(ytChannelPayload());

    const res = await request(app)
      .post('/api/channels')
      .set(headers)
      .send({ channelInput: 'https://youtube.com/@somehandle', category: 'News', tags: ['t1'], notes: 'n', assignedTo: null });

    expect(res.status).toBe(201);
    expect(res.body.youtubeChannelId).toBe('UCabcdefghijklmnopqrstuv');
    expect(res.body.currentStats.subscribers).toBe(1000);
    const snap = await prisma.channelSnapshot.findFirst({ where: { channelId: res.body._id } });
    expect(snap).not.toBeNull();
    expect(snap.subscribers).toBe(1000);
  });

  it('404 when handle cannot be resolved', async () => {
    const { headers } = await authFor('admin');
    resolveChannelByHandle.mockResolvedValueOnce(null);
    const res = await request(app)
      .post('/api/channels')
      .set(headers)
      .send({ channelInput: 'https://youtube.com/@nohandle' });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Channel not found');
  });

  it('409 when channel already exists', async () => {
    const { headers } = await authFor('admin');
    await mkChannel({ youtubeChannelId: 'UCabcdefghijklmnopqrstuv' });
    const res = await request(app)
      .post('/api/channels')
      .set(headers)
      .send({ channelInput: 'https://youtube.com/channel/UCabcdefghijklmnopqrstuv' });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Channel already tracked');
  });

  it('404 when YouTube returns no channel for a direct id', async () => {
    const { headers } = await authFor('admin');
    fetchSingleChannel.mockResolvedValueOnce(null);
    const res = await request(app)
      .post('/api/channels')
      .set(headers)
      .send({ channelInput: 'https://youtube.com/channel/UCabcdefghijklmnopqrstuv' });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Channel not found on YouTube');
  });

  it('creates with sensible defaults when YT payload omits optional fields', async () => {
    const { headers } = await authFor('admin');
    fetchSingleChannel.mockResolvedValueOnce({
      id: 'UCabcdefghijklmnopqrstuv',
      snippet: {
        title: 'Bare',
        description: '',
        thumbnails: { default: { url: 'd.jpg' } },
        publishedAt: '2020-01-01T00:00:00.000Z',
      },
      statistics: { subscriberCount: '', viewCount: '', videoCount: '' },
    });

    const res = await request(app)
      .post('/api/channels')
      .set(headers)
      .send({ channelInput: 'https://youtube.com/channel/UCabcdefghijklmnopqrstuv' });

    expect(res.status).toBe(201);
    expect(res.body.thumbnailUrl).toBe('d.jpg');
    expect(res.body.bannerUrl).toBe('');
    expect(res.body.customUrl).toBe('');
    expect(res.body.country).toBe('');
    expect(res.body.uploadsPlaylistId).toBe('');
    expect(res.body.category).toBe('Uncategorized');
    expect(res.body.tags).toEqual([]);
    expect(res.body.notes).toBe('');
    expect(res.body.assignedTo).toBeNull();
    expect(res.body.currentStats.subscribers).toBe(0);
  });

  it('uses empty-string thumbnail when neither high nor default exist', async () => {
    const { headers } = await authFor('admin');
    fetchSingleChannel.mockResolvedValueOnce({
      id: 'UCabcdefghijklmnopqrstuv',
      snippet: {
        title: 'No Thumb',
        description: '',
        publishedAt: '2020-01-01T00:00:00.000Z',
      },
      statistics: { subscriberCount: '1', viewCount: '2', videoCount: '3' },
    });
    const res = await request(app)
      .post('/api/channels')
      .set(headers)
      .send({ channelInput: 'https://youtube.com/channel/UCabcdefghijklmnopqrstuv' });
    expect(res.status).toBe(201);
    expect(res.body.thumbnailUrl).toBe('');
  });

  it('500 catch path on addChannel', async () => {
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.channel, 'findFirst').mockImplementationOnce(() => { throw new Error('boom-add'); });
    const res = await request(app)
      .post('/api/channels')
      .set(headers)
      .send({ channelInput: 'https://youtube.com/channel/UCabcdefghijklmnopqrstuv' });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom-add');
  });
});

// =========================================================================
// POST /api/channels/bulk (bulkImport)
// =========================================================================
describe('POST /api/channels/bulk (bulkImport)', () => {
  it('403 for viewer', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).post('/api/channels/bulk').set(headers);
    expect(res.status).toBe(403);
  });

  it('400 when no file attached', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).post('/api/channels/bulk').set(headers);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('CSV file is required');
  });

  it('imports a mix of direct id, @handle, bare-fallback, and reports errors/skips', async () => {
    const { headers } = await authFor('manager');

    await mkChannel({ youtubeChannelId: 'UCexistingexistingexisti' });

    fetchSingleChannel
      .mockResolvedValueOnce(ytChannelPayload({
        id: 'UCnewxxxxxxxxxxxxxxxxxxx',
        snippet: { title: 'New 1', description: 'D1', thumbnails: { high: { url: 'h1' } }, publishedAt: '2020-01-01T00:00:00.000Z' },
        statistics: { subscriberCount: '5', viewCount: '6', videoCount: '7' },
      }))
      .mockResolvedValueOnce(ytChannelPayload({
        id: 'UCbarexxxxxxxxxxxxxxxxxx',
        snippet: { title: 'Bare OK', description: '', thumbnails: {}, publishedAt: '2020-01-01T00:00:00.000Z' },
        statistics: {}, brandingSettings: {}, contentDetails: {},
      }))
      .mockResolvedValueOnce(null);

    fetchChannelByHandle
      .mockResolvedValueOnce(ytChannelPayload({
        id: 'UChandle1xxxxxxxxxxxxxxx',
        snippet: { title: 'Handle 1', description: '', thumbnails: { high: { url: 'hh' } }, publishedAt: '2020-01-01T00:00:00.000Z' },
        statistics: { subscriberCount: '1' },
      }))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ytChannelPayload({
        id: 'UCexistingexistingexisti',
        snippet: { title: 'dup', description: '', thumbnails: {}, publishedAt: '2020-01-01T00:00:00.000Z' },
        statistics: {}, brandingSettings: {}, contentDetails: {},
      }));

    const csv = [
      'channel_id,category,tags,notes',
      'https://youtube.com/UCnewxxxxxxxxxxxxxxxxxxx,News,a;b;,note1',
      'https://youtube.com/@handle1,Music,,',
      'https://youtube.com/@handleNotFound,,,',
      'https://youtube.com/@handleExisting,Cat A,,',
      'https://example.test/,Cat A,,',
      'https://other.test/,,,',
      'https://youtube.com/channel/UCexistingexistingexisti,Cat B,,',
      ',,,',
    ].join('\n');

    const res = await request(app)
      .post('/api/channels/bulk')
      .set(headers)
      .attach('file', Buffer.from(csv, 'utf-8'), 'channels.csv');

    expect(res.status).toBe(200);
    expect(res.body.added).toBe(3);
    expect(res.body.skipped).toBe(2);
    expect(res.body.errors).toHaveLength(3);
    expect(res.body.addedChannels.map((c) => c.title).sort()).toEqual(['Bare OK', 'Handle 1', 'New 1']);

    expect(await prisma.category.count()).toBeGreaterThanOrEqual(3);
  });

  it('uses channelId column as alias for channel_id and supports default category/notes', async () => {
    const { headers } = await authFor('admin');
    fetchSingleChannel.mockResolvedValueOnce({
      id: 'UCalias1111111111111111x',
      snippet: { title: 'Alias', description: 'd', thumbnails: { high: { url: 'h' } }, publishedAt: '2020-01-01T00:00:00.000Z' },
      statistics: { subscriberCount: '1', viewCount: '2', videoCount: '3' },
      brandingSettings: { image: { bannerExternalUrl: 'b' } },
      contentDetails: { relatedPlaylists: { uploads: 'UUaa' } },
    });

    const csv = ['channelId', 'https://example.test/'].join('\n');
    const res = await request(app)
      .post('/api/channels/bulk')
      .set(headers)
      .attach('file', Buffer.from(csv, 'utf-8'), 'channels.csv');

    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
    const created = await prisma.channel.findFirst({ where: { youtubeChannelId: 'UCalias1111111111111111x' } });
    expect(created).not.toBeNull();
    expect(created.category).toBe('Uncategorized');
    expect(created.tags).toEqual([]);
    expect(created.notes).toBe('');
  });

  it('catches a thrown duplicate-key error (P2002) and counts as skipped', async () => {
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.channel, 'create').mockImplementationOnce(async () => {
      const e = new Error('Unique constraint failed');
      e.code = 'P2002';
      throw e;
    });

    fetchSingleChannel.mockResolvedValueOnce(ytChannelPayload({
      id: 'UCdupkey1111111111111111',
      snippet: { title: 'Dup', description: '', thumbnails: { high: { url: 'h' } }, publishedAt: '2020-01-01T00:00:00.000Z' },
      statistics: { subscriberCount: '1', viewCount: '2', videoCount: '3' },
    }));

    const csv = 'channel_id\nhttps://dup.example.test/';
    const res = await request(app)
      .post('/api/channels/bulk')
      .set(headers)
      .attach('file', Buffer.from(csv, 'utf-8'), 'c.csv');

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(1);
    expect(res.body.errors).toEqual([]);
  });

  it('bare-fallback branch skips when youtubeChannelId already exists', async () => {
    const { headers } = await authFor('admin');
    // Pre-seed with the exact URL key that extractChannelId will return for this row.
    await mkChannel({ youtubeChannelId: 'https://bare.existing.test/' });

    const csv = ['channel_id', 'https://bare.existing.test/'].join('\n');
    const res = await request(app)
      .post('/api/channels/bulk')
      .set(headers)
      .attach('file', Buffer.from(csv, 'utf-8'), 'c.csv');

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(1);
    expect(res.body.added).toBe(0);
    expect(fetchSingleChannel).not.toHaveBeenCalled();
  });

  it('catches a non-P2002 thrown error and reports it', async () => {
    const { headers } = await authFor('admin');
    fetchSingleChannel.mockResolvedValueOnce(ytChannelPayload({
      id: 'UCerr11111111111111111aa',
      snippet: { title: 'X', description: '', thumbnails: { high: { url: 'h' } }, publishedAt: '2020-01-01T00:00:00.000Z' },
      statistics: { subscriberCount: '1', viewCount: '2', videoCount: '3' },
    }));
    vi.spyOn(prisma.channel, 'create').mockImplementationOnce(async () => { throw new Error('inner-fail'); });

    const csv = 'channel_id\nUCerr11111111111111111aa';
    const res = await request(app)
      .post('/api/channels/bulk')
      .set(headers)
      .attach('file', Buffer.from(csv, 'utf-8'), 'c.csv');

    expect(res.status).toBe(200);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].error).toBe('inner-fail');
  });

  it('500 catch path (top-level error during category upsert)', async () => {
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.category, 'upsert').mockImplementationOnce(() => { throw new Error('cat-boom'); });

    const csv = 'channel_id,category\nUCwhatever1111111111111x,SomeCat';
    const res = await request(app)
      .post('/api/channels/bulk')
      .set(headers)
      .attach('file', Buffer.from(csv, 'utf-8'), 'c.csv');

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('cat-boom');
  });
});

// =========================================================================
// GET /api/channels/:id (getChannel)
// =========================================================================
describe('GET /api/channels/:id (getChannel)', () => {
  it('returns channel, reversed snapshots, recent videos and videoCountInDb', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel();
    await prisma.channelSnapshot.create({ data: { channelId: ch.id, date: new Date('2024-01-01T00:00:00Z'), subscribers: 1 } });
    await prisma.channelSnapshot.create({ data: { channelId: ch.id, date: new Date('2024-01-02T00:00:00Z'), subscribers: 2 } });
    await mkVideo({ channelId: ch.id, publishedAt: new Date('2024-01-01T00:00:00Z') });
    await mkVideo({ channelId: ch.id, publishedAt: new Date('2024-01-02T00:00:00Z') });

    const res = await request(app).get(`/api/channels/${ch.id}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.channel._id).toBe(ch.id);
    expect(res.body.snapshots.map((s) => s.subscribers)).toEqual([1, 2]);
    expect(res.body.videos).toHaveLength(2);
    expect(res.body.videoCountInDb).toBe(2);
  });

  it('404 when channel not found', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).get(`/api/channels/${fakeCuid()}`).set(headers);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Channel not found');
  });

  it('400 on invalid id', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/channels/not-an-id').set(headers);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid ID format');
  });
});

// =========================================================================
// PUT /api/channels/:id (updateChannel)
// =========================================================================
describe('PUT /api/channels/:id (updateChannel)', () => {
  it('403 for viewer', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel();
    const res = await request(app).put(`/api/channels/${ch.id}`).set(headers).send({ notes: 'x' });
    expect(res.status).toBe(403);
  });

  it('updates provided fields only and clears autoArchivedForInactivity on status change', async () => {
    const { headers } = await authFor('manager');
    const ch = await mkChannel({ status: 'archived', autoArchivedForInactivity: true });

    const res = await request(app)
      .put(`/api/channels/${ch.id}`)
      .set(headers)
      .send({ category: 'New', tags: ['a'], assignedTo: '', status: 'active', notes: 'n' });

    expect(res.status).toBe(200);
    expect(res.body.category).toBe('New');
    expect(res.body.tags).toEqual(['a']);
    expect(res.body.assignedTo).toBeNull();
    expect(res.body.status).toBe('active');
    expect(res.body.autoArchivedForInactivity).toBe(false);
    expect(res.body.notes).toBe('n');
  });

  it('keeps assignedTo set when truthy', async () => {
    const { headers, user } = await authFor('manager');
    const ch = await mkChannel();
    const res = await request(app)
      .put(`/api/channels/${ch.id}`)
      .set(headers)
      .send({ assignedTo: user.id });
    expect(res.status).toBe(200);
    expect(String(res.body.assignedTo?._id ?? res.body.assignedTo ?? '')).toBe(user.id);
  });

  it('404 when channel does not exist', async () => {
    const { headers } = await authFor('manager');
    const res = await request(app).put(`/api/channels/${fakeCuid()}`).set(headers).send({ notes: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Channel not found');
  });

  it('500 catch path on update', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel();
    vi.spyOn(prisma.channel, 'update').mockImplementationOnce(() => { throw new Error('boom-up'); });
    const res = await request(app).put(`/api/channels/${ch.id}`).set(headers).send({ notes: 'x' });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom-up');
  });
});

// =========================================================================
// DELETE /api/channels/:id (deleteChannel)
// =========================================================================
describe('DELETE /api/channels/:id (deleteChannel)', () => {
  it('403 for manager', async () => {
    const { headers } = await authFor('manager');
    const ch = await mkChannel();
    const res = await request(app).delete(`/api/channels/${ch.id}`).set(headers);
    expect(res.status).toBe(403);
  });

  it('archives and cascades (verify cascade by checking child rows)', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel();
    const v = await mkVideo({ channelId: ch.id });
    await prisma.channelSnapshot.create({ data: { channelId: ch.id, date: new Date('2024-06-01T00:00:00Z'), subscribers: 1 } });

    const res = await request(app).delete(`/api/channels/${ch.id}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Channel archived');
    expect(res.body.channelId).toBe(ch.id);

    const after = await prisma.channel.findUnique({ where: { id: ch.id } });
    expect(after.status).toBe('archived');
    expect(after.deletedAt).toBeInstanceOf(Date);
    const v2 = await prisma.video.findUnique({ where: { id: v.id } });
    expect(v2.deletedAt).toBeInstanceOf(Date);
    const snap = await prisma.channelSnapshot.findFirst({ where: { channelId: ch.id } });
    expect(snap.deletedAt).toBeInstanceOf(Date);
  });

  it('404 when channel not found', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).delete(`/api/channels/${fakeCuid()}`).set(headers);
    expect(res.status).toBe(404);
  });

  it('500 catch path', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel();
    vi.spyOn(prisma.channel, 'findUnique').mockImplementationOnce(() => { throw new Error('boom-del'); });
    const res = await request(app).delete(`/api/channels/${ch.id}`).set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom-del');
  });
});

// =========================================================================
// DELETE /api/channels/bulk (bulkDeleteChannels)
// =========================================================================
describe('DELETE /api/channels/bulk (bulkDeleteChannels)', () => {
  it('403 for manager', async () => {
    const { headers } = await authFor('manager');
    const res = await request(app).delete('/api/channels/bulk').set(headers).send({ ids: [fakeCuid()] });
    expect(res.status).toBe(403);
  });

  it('400 when ids missing or empty', async () => {
    const { headers } = await authFor('admin');
    const r1 = await request(app).delete('/api/channels/bulk').set(headers).send({});
    expect(r1.status).toBe(400);
    expect(r1.body.message).toBe('ids array is required');

    const r2 = await request(app).delete('/api/channels/bulk').set(headers).send({ ids: [] });
    expect(r2.status).toBe(400);

    const r3 = await request(app).delete('/api/channels/bulk').set(headers).send({ ids: 'notarray' });
    expect(r3.status).toBe(400);
  });

  it('archives multiple and returns the count', async () => {
    const { headers } = await authFor('admin');
    const a = await mkChannel();
    const b = await mkChannel();
    const res = await request(app)
      .delete('/api/channels/bulk')
      .set(headers)
      .send({ ids: [a.id, b.id] });
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(2);

    // Verify children are also soft-deleted (cascade visibility).
    const aAfter = await prisma.channel.findUnique({ where: { id: a.id } });
    const bAfter = await prisma.channel.findUnique({ where: { id: b.id } });
    expect(aAfter.status).toBe('archived');
    expect(bAfter.status).toBe('archived');
  });

  it('returns archived=0 for non-matching ids', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).delete('/api/channels/bulk').set(headers).send({ ids: [fakeCuid()] });
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(0);
  });

  it('500 catch path', async () => {
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.channel, 'updateMany').mockImplementationOnce(() => { throw new Error('boom-bd'); });
    const res = await request(app).delete('/api/channels/bulk').set(headers).send({ ids: [fakeCuid()] });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom-bd');
  });
});

// =========================================================================
// POST /api/channels/reclassify-bulk (bulkReclassifyChannelVideos)
// =========================================================================
describe('POST /api/channels/reclassify-bulk (bulkReclassifyChannelVideos)', () => {
  it('403 for manager', async () => {
    const { headers } = await authFor('manager');
    const res = await request(app).post('/api/channels/reclassify-bulk').set(headers).send({ ids: [fakeCuid()] });
    expect(res.status).toBe(403);
  });

  it('400 when ids missing/empty/non-array', async () => {
    const { headers } = await authFor('admin');
    const r1 = await request(app).post('/api/channels/reclassify-bulk').set(headers).send({});
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/channels/reclassify-bulk').set(headers).send({ ids: [] });
    expect(r2.status).toBe(400);
  });

  it('processes a Dedicated channel (rule-based, no AI) and an IHI channel (AI map) and accumulates totals', async () => {
    const { headers } = await authFor('admin');
    const dedicated = await mkChannel({ title: 'A Dedicated', category: 'Dedicated Channel' });
    const ihi = await mkChannel({ title: 'Z IHI', category: 'IHI Stuff' });
    const dv1 = await mkVideo({ channelId: dedicated.id, classification: 'sadhguru' });
    const dv2 = await mkVideo({ channelId: dedicated.id, classification: '' });
    const iv1 = await mkVideo({ channelId: ihi.id, classification: '' });
    const iv2 = await mkVideo({ channelId: ihi.id, classification: '' });

    classifySadguruVideoBatch.mockResolvedValueOnce(
      new Map([[String(iv1.id), 'sadhguru']])
    );

    const res = await request(app)
      .post('/api/channels/reclassify-bulk')
      .set(headers)
      .send({ ids: [dedicated.id, ihi.id] });

    expect(res.status).toBe(200);
    expect(res.body.channelsRequested).toBe(2);
    expect(res.body.channelsProcessed).toBe(2);
    expect(res.body.totalVideos).toBe(4);
    // Dedicated channel auto-classifies both videos as sadhguru (2). IHI channel
    // gets iv1 classified via the AI mock (1) and iv2 unmapped (failed). 2 + 1 = 3.
    expect(res.body.totalSadguru).toBe(3);
    expect(res.body.totalNonSadguru).toBe(0);
    expect(res.body.totalFailed).toBe(1);
    expect(res.body.errors).toBeUndefined();
    expect(classifySadguruVideoBatch).toHaveBeenCalledTimes(1);
    expect(dv1).toBeTruthy(); expect(dv2).toBeTruthy(); expect(iv2).toBeTruthy();
  });

  it('captures per-channel errors and returns them in the errors array', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel({ title: 'A Bad', category: 'IHI X' });
    await mkVideo({ channelId: ch.id, classification: '' });
    classifySadguruVideoBatch.mockRejectedValueOnce(new Error('per-channel-fail'));

    const res = await request(app)
      .post('/api/channels/reclassify-bulk')
      .set(headers)
      .send({ ids: [ch.id] });

    expect(res.status).toBe(200);
    expect(res.body.channelsProcessed).toBe(0);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].message).toBe('per-channel-fail');
  });

  it('skips archived channels (filter status != archived)', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel({ title: 'arc', category: 'Dedicated', status: 'archived' });
    const res = await request(app)
      .post('/api/channels/reclassify-bulk')
      .set(headers)
      .send({ ids: [ch.id] });
    expect(res.status).toBe(200);
    expect(res.body.channelsProcessed).toBe(0);
    expect(res.body.totalVideos).toBe(0);
  });

  it('503 when AI not configured (GEMINI_API_KEY/GOOGLE_CLOUD_PROJECT error message)', async () => {
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.channel, 'findMany').mockImplementationOnce(() => { throw new Error('Set GEMINI_API_KEY now'); });
    const res = await request(app)
      .post('/api/channels/reclassify-bulk')
      .set(headers)
      .send({ ids: [fakeCuid()] });
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/AI not configured/);
  });

  it('500 catch path on unexpected error', async () => {
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.channel, 'findMany').mockImplementationOnce(() => { throw new Error('outer-boom'); });
    const res = await request(app)
      .post('/api/channels/reclassify-bulk')
      .set(headers)
      .send({ ids: [fakeCuid()] });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('outer-boom');
  });
});

// =========================================================================
// POST /api/channels/:id/sync (syncSingleChannel)
// =========================================================================
describe('POST /api/channels/:id/sync (syncSingleChannel)', () => {
  it('403 for viewer', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel();
    const res = await request(app).post(`/api/channels/${ch.id}/sync`).set(headers);
    expect(res.status).toBe(403);
  });

  it('triggers sync and returns log', async () => {
    const { headers } = await authFor('manager');
    const ch = await mkChannel();
    syncChannels.mockResolvedValueOnce({ status: 'success', channelsProcessed: 1 });
    const res = await request(app).post(`/api/channels/${ch.id}/sync`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(syncChannels).toHaveBeenCalled();
  });

  it('404 if channel not found', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).post(`/api/channels/${fakeCuid()}/sync`).set(headers);
    expect(res.status).toBe(404);
  });

  it('409 if sync already in progress', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel();
    syncChannels.mockRejectedValueOnce(new Error('Sync already in progress'));
    const res = await request(app).post(`/api/channels/${ch.id}/sync`).set(headers);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Sync already in progress');
  });

  it('500 on other errors', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel();
    syncChannels.mockRejectedValueOnce(new Error('other-sync-fail'));
    const res = await request(app).post(`/api/channels/${ch.id}/sync`).set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('other-sync-fail');
  });
});

// =========================================================================
// POST /api/channels/:id/pull-videos (pullChannelVideos)
// =========================================================================
describe('POST /api/channels/:id/pull-videos (pullChannelVideos)', () => {
  it('403 for viewer', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel();
    const res = await request(app).post(`/api/channels/${ch.id}/pull-videos`).set(headers);
    expect(res.status).toBe(403);
  });

  it('404 when channel not found', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).post(`/api/channels/${fakeCuid()}/pull-videos`).set(headers);
    expect(res.status).toBe(404);
  });

  it('400 when allVideosPulled is true', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel({ allVideosPulled: true });
    const res = await request(app).post(`/api/channels/${ch.id}/pull-videos`).set(headers);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already pulled/);
  });

  it('triggers pull and returns result', async () => {
    const { headers } = await authFor('manager');
    const ch = await mkChannel();
    pullAllChannelVideos.mockResolvedValueOnce({ videosProcessed: 7 });
    const res = await request(app).post(`/api/channels/${ch.id}/pull-videos`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.videosProcessed).toBe(7);
  });

  it('409 when pull already in progress', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel();
    pullAllChannelVideos.mockRejectedValueOnce(new Error('Pull all videos already in progress'));
    const res = await request(app).post(`/api/channels/${ch.id}/pull-videos`).set(headers);
    expect(res.status).toBe(409);
  });

  it('429 on quota exceeded', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel();
    pullAllChannelVideos.mockRejectedValueOnce(new Error('QUOTA_EXCEEDED'));
    const res = await request(app).post(`/api/channels/${ch.id}/pull-videos`).set(headers);
    expect(res.status).toBe(429);
  });

  it('500 on other errors', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel();
    pullAllChannelVideos.mockRejectedValueOnce(new Error('boom-pull'));
    const res = await request(app).post(`/api/channels/${ch.id}/pull-videos`).set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom-pull');
  });
});

// =========================================================================
// POST /api/channels/sync-all (syncAllChannels)
// =========================================================================
describe('POST /api/channels/sync-all (syncAllChannels)', () => {
  it('403 for viewer', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).post('/api/channels/sync-all').set(headers);
    expect(res.status).toBe(403);
  });

  it('returns log on success', async () => {
    const { headers } = await authFor('manager');
    syncChannels.mockResolvedValueOnce({ status: 'success' });
    const res = await request(app).post('/api/channels/sync-all').set(headers);
    expect(res.status).toBe(200);
  });

  it('409 when sync already running', async () => {
    const { headers } = await authFor('admin');
    syncChannels.mockRejectedValueOnce(new Error('Sync already in progress'));
    const res = await request(app).post('/api/channels/sync-all').set(headers);
    expect(res.status).toBe(409);
  });

  it('500 on other errors', async () => {
    const { headers } = await authFor('admin');
    syncChannels.mockRejectedValueOnce(new Error('other-fail'));
    const res = await request(app).post('/api/channels/sync-all').set(headers);
    expect(res.status).toBe(500);
  });
});

// =========================================================================
// POST /api/channels/pull-all-videos (pullAllChannelsVideosHandler)
// =========================================================================
describe('POST /api/channels/pull-all-videos (pullAllChannelsVideosHandler)', () => {
  it('403 for viewer', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).post('/api/channels/pull-all-videos').set(headers);
    expect(res.status).toBe(403);
  });

  it('returns result on success', async () => {
    const { headers } = await authFor('manager');
    pullAllChannelsVideos.mockResolvedValueOnce({ channelsProcessed: 3 });
    const res = await request(app).post('/api/channels/pull-all-videos').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.channelsProcessed).toBe(3);
  });

  it('409 when in progress', async () => {
    const { headers } = await authFor('admin');
    pullAllChannelsVideos.mockRejectedValueOnce(new Error('Pull all videos already in progress'));
    const res = await request(app).post('/api/channels/pull-all-videos').set(headers);
    expect(res.status).toBe(409);
  });

  it('429 on quota exceeded', async () => {
    const { headers } = await authFor('admin');
    pullAllChannelsVideos.mockRejectedValueOnce(new Error('QUOTA_EXCEEDED'));
    const res = await request(app).post('/api/channels/pull-all-videos').set(headers);
    expect(res.status).toBe(429);
  });

  it('500 on other errors', async () => {
    const { headers } = await authFor('admin');
    pullAllChannelsVideos.mockRejectedValueOnce(new Error('pull-boom'));
    const res = await request(app).post('/api/channels/pull-all-videos').set(headers);
    expect(res.status).toBe(500);
  });
});

// =========================================================================
// GET /api/channels/:id/videos (getChannelVideos)
// =========================================================================
describe('GET /api/channels/:id/videos (getChannelVideos)', () => {
  it('400 on invalid channel id', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/channels/not-an-id/videos').set(headers);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid channel id');
  });

  it('returns paginated videos with summary and applies search/classification/views filters', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel();
    await mkVideo({ channelId: ch.id, title: 'Match A', views: 500, classification: 'sadhguru', likes: 10, comments: 1 });
    await mkVideo({ channelId: ch.id, title: 'B', views: 100, classification: 'non sadhguru', likes: 1, comments: 0 });
    await mkVideo({ channelId: ch.id, title: 'Match C', views: 9000, classification: 'sadhguru', likes: 5, comments: 2 });

    const res = await request(app)
      .get(`/api/channels/${ch.id}/videos?search=Match&classification=sadhguru&minViews=200&maxViews=8000&sort=views&page=1&limit=5`)
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.videos).toHaveLength(1);
    expect(res.body.videos[0].title).toBe('Match A');
    expect(res.body.pagination).toMatchObject({ page: 1, total: 1, pages: 1 });
    expect(res.body.summary.totalViews).toBe(500 + 100 + 9000);
    expect(res.body.summary.totalLikes).toBe(10 + 1 + 5);
    expect(res.body.summary.totalComments).toBe(1 + 0 + 2);
    expect(res.body.summary.totalVideos).toBe(1);
  });

  it('handles classification=non_sadhguru and default sort (-views)', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel();
    await mkVideo({ channelId: ch.id, title: 'A', views: 10, classification: 'non sadhguru' });
    await mkVideo({ channelId: ch.id, title: 'B', views: 500, classification: 'non sadhguru' });
    const res = await request(app)
      .get(`/api/channels/${ch.id}/videos?classification=non_sadhguru`)
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.videos[0].title).toBe('B');
  });

  it('handles all sort variants without error', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel();
    await mkVideo({ channelId: ch.id });
    for (const s of ['-views', 'views', '-publishedAt', 'publishedAt', '-likes', 'likes', '-comments', 'comments', 'unknown-fallback']) {
      const r = await request(app).get(`/api/channels/${ch.id}/videos?sort=${encodeURIComponent(s)}`).set(headers);
      expect(r.status).toBe(200);
    }
  });

  it('clamps limit to >=1 and <=100; whitespace search trimmed away', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel();
    await mkVideo({ channelId: ch.id, title: 'one' });

    const r1 = await request(app).get(`/api/channels/${ch.id}/videos?limit=99999&search=%20%20`).set(headers);
    expect(r1.status).toBe(200);
    expect(r1.body.pagination.limit).toBe(100);

    const r2 = await request(app).get(`/api/channels/${ch.id}/videos?limit=0`).set(headers);
    expect(r2.status).toBe(200);
    expect(r2.body.pagination.limit).toBe(50);

    const r2b = await request(app).get(`/api/channels/${ch.id}/videos?limit=1`).set(headers);
    expect(r2b.status).toBe(200);
    expect(r2b.body.pagination.limit).toBe(1);

    const r3 = await request(app).get(`/api/channels/${ch.id}/videos?limit=abc`).set(headers);
    expect(r3.status).toBe(200);
    expect(r3.body.pagination.limit).toBe(50);
  });

  it('returns zeroed summary when no matches', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel();
    const res = await request(app).get(`/api/channels/${ch.id}/videos`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.videos).toHaveLength(0);
    expect(res.body.summary).toEqual({ totalVideos: 0, totalViews: 0, totalLikes: 0, totalComments: 0 });
  });

  it('500 catch path on aggregation failure', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel();
    vi.spyOn(prisma.video, 'aggregate').mockImplementationOnce(() => { throw new Error('agg-boom'); });
    const res = await request(app).get(`/api/channels/${ch.id}/videos`).set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('agg-boom');
  });

  it('summary fields fall back to 0 when aggregation returns nullish totals', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel();
    await mkVideo({ channelId: ch.id });
    vi.spyOn(prisma.video, 'aggregate').mockResolvedValueOnce({ _sum: { views: null, likes: null, comments: null } });
    const res = await request(app).get(`/api/channels/${ch.id}/videos`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.summary.totalViews).toBe(0);
    expect(res.body.summary.totalLikes).toBe(0);
    expect(res.body.summary.totalComments).toBe(0);
  });
});

// =========================================================================
// POST /api/channels/:id/classify-videos (classifyChannelVideos)
// =========================================================================
describe('POST /api/channels/:id/classify-videos (classifyChannelVideos)', () => {
  it('403 for viewer', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel();
    const res = await request(app).post(`/api/channels/${ch.id}/classify-videos`).set(headers);
    expect(res.status).toBe(403);
  });

  it('404 when channel not found', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).post(`/api/channels/${fakeCuid()}/classify-videos`).set(headers);
    expect(res.status).toBe(404);
  });

  it('returns zeros when channel has no videos (empty branch)', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel();
    const res = await request(app).post(`/api/channels/${ch.id}/classify-videos`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalVideos: 0,
      newlyClassified: 0,
      failed: 0,
      sadhguruCount: 0,
      nonSadhguruCount: 0,
      isSadhguruChannel: false,
    });
  });

  it('Dedicated channel: marks all empty-classification videos as sadhguru without calling AI', async () => {
    const { headers } = await authFor('manager');
    const ch = await mkChannel({ category: 'Dedicated Z' });
    await mkVideo({ channelId: ch.id, classification: '' });
    await mkVideo({ channelId: ch.id, classification: '' });
    await mkVideo({ channelId: ch.id, classification: 'sadhguru' });
    const res = await request(app).post(`/api/channels/${ch.id}/classify-videos`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.isSadhguruChannel).toBe(true);
    expect(res.body.newlyClassified).toBe(2);
    expect(res.body.totalVideos).toBe(3);
    expect(res.body.alreadyClassified).toBe(1);
    expect(classifySadguruVideoBatch).not.toHaveBeenCalled();
  });

  it('non-Dedicated channel: uses AI with mix of mapped/unmapped videos', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel({ category: 'IHI A' });
    const fresh1 = await mkVideo({ channelId: ch.id, classification: '' });
    const fresh2 = await mkVideo({ channelId: ch.id, classification: '' });
    const fresh3 = await mkVideo({ channelId: ch.id, classification: '' });
    await mkVideo({ channelId: ch.id, classification: 'sadhguru' });

    classifySadguruVideoBatch.mockResolvedValueOnce(
      new Map([
        [String(fresh1.id), 'sadhguru'],
        [String(fresh2.id), 'non sadhguru'],
      ])
    );

    const res = await request(app).post(`/api/channels/${ch.id}/classify-videos`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.totalVideos).toBe(4);
    expect(res.body.failed).toBe(1);
    expect(res.body.sadhguruCount).toBe(1);
    expect(res.body.nonSadhguruCount).toBe(1);
    expect(res.body.newlyClassified).toBe(2);
    expect(res.body.alreadyClassified).toBe(1);

    const orphan = await prisma.video.findUnique({ where: { id: fresh3.id } });
    expect(orphan.classification).toBe('');
  });

  // Legacy `isSadguruVideo` migration branch — Prisma schema doesn't carry the
  // field, so we drive the branch by hijacking prisma.video.findMany to return
  // patched rows that look like legacy ETL output.
  it('migrates legacy isSadguruVideo=true → sadhguru via findMany patching', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel({ category: 'IHI A' });
    await mkVideo({ channelId: ch.id, classification: '' });

    const realFindMany = prisma.video.findMany.bind(prisma.video);
    let callCount = 0;
    vi.spyOn(prisma.video, 'findMany').mockImplementation(async (args) => {
      callCount += 1;
      const docs = await realFindMany(args);
      if (callCount === 1 && docs[0]) {
        docs[0].isSadguruVideo = true;
        docs[0].classification = '';
      }
      return docs;
    });

    classifySadguruVideoBatch.mockResolvedValueOnce(new Map());
    const res = await request(app).post(`/api/channels/${ch.id}/classify-videos`).set(headers);
    expect(res.status).toBe(200);
    const after = await realFindMany({ where: { channelId: ch.id } });
    expect(after.some((v) => v.classification === 'sadhguru')).toBe(true);
  });

  it('handles channel with no/empty category (falsy-or branch)', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel({ category: '' });
    await mkVideo({ channelId: ch.id, classification: '' });
    classifySadguruVideoBatch.mockResolvedValueOnce(new Map());
    const res = await request(app).post(`/api/channels/${ch.id}/classify-videos`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.isSadhguruChannel).toBe(false);
  });

  it('migrates legacy isSadguruVideo=false → non sadhguru', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel({ category: 'IHI B' });
    await mkVideo({ channelId: ch.id, classification: '' });

    const realFindMany = prisma.video.findMany.bind(prisma.video);
    let callCount = 0;
    vi.spyOn(prisma.video, 'findMany').mockImplementation(async (args) => {
      callCount += 1;
      const docs = await realFindMany(args);
      if (callCount === 1 && docs[0]) {
        docs[0].isSadguruVideo = false;
        docs[0].classification = '';
      }
      return docs;
    });

    classifySadguruVideoBatch.mockResolvedValueOnce(new Map());
    const res = await request(app).post(`/api/channels/${ch.id}/classify-videos`).set(headers);
    expect(res.status).toBe(200);
    const after = await realFindMany({ where: { channelId: ch.id } });
    expect(after.some((v) => v.classification === 'non sadhguru')).toBe(true);
  });

  it('503 when AI not configured', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel({ category: 'IHI X' });
    await mkVideo({ channelId: ch.id, classification: '' });
    classifySadguruVideoBatch.mockRejectedValueOnce(new Error('Set GEMINI_API_KEY please'));
    const res = await request(app).post(`/api/channels/${ch.id}/classify-videos`).set(headers);
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/AI not configured/);
  });

  it('500 on generic failure (logs and returns)', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel({ category: 'IHI X' });
    await mkVideo({ channelId: ch.id, classification: '' });
    classifySadguruVideoBatch.mockRejectedValueOnce(new Error('classify-boom'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).post(`/api/channels/${ch.id}/classify-videos`).set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('classify-boom');
    consoleSpy.mockRestore();
  });

  it('500 with default message when err.message is falsy', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel({ category: 'IHI X' });
    await mkVideo({ channelId: ch.id, classification: '' });
    classifySadguruVideoBatch.mockRejectedValueOnce(Object.assign(new Error(), { message: '' }));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).post(`/api/channels/${ch.id}/classify-videos`).set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Classification failed');
    consoleSpy.mockRestore();
  });
});

// =========================================================================
// POST /api/channels/:id/reclassify-videos (reclassifyChannelVideos)
// =========================================================================
describe('POST /api/channels/:id/reclassify-videos (reclassifyChannelVideos)', () => {
  it('403 for manager', async () => {
    const { headers } = await authFor('manager');
    const ch = await mkChannel();
    const res = await request(app).post(`/api/channels/${ch.id}/reclassify-videos`).set(headers);
    expect(res.status).toBe(403);
  });

  it('404 when channel not found', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).post(`/api/channels/${fakeCuid()}/reclassify-videos`).set(headers);
    expect(res.status).toBe(404);
  });

  it('clears classification then reclassifies (Dedicated path)', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel({ category: 'Dedicated Foo' });
    await mkVideo({ channelId: ch.id, classification: 'non sadhguru' });
    await mkVideo({ channelId: ch.id, classification: 'sadhguru' });

    const res = await request(app).post(`/api/channels/${ch.id}/reclassify-videos`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.reclassified).toBe(true);
    expect(res.body.isSadhguruChannel).toBe(true);
    expect(res.body.newlyClassified).toBe(2);
  });

  it('503 on AI not configured', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel({ category: 'IHI Y' });
    await mkVideo({ channelId: ch.id, classification: '' });
    classifySadguruVideoBatch.mockRejectedValueOnce(new Error('Provide GOOGLE_CLOUD_PROJECT'));
    const res = await request(app).post(`/api/channels/${ch.id}/reclassify-videos`).set(headers);
    expect(res.status).toBe(503);
  });

  it('500 on generic failure', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel({ category: 'IHI Y' });
    await mkVideo({ channelId: ch.id, classification: '' });
    classifySadguruVideoBatch.mockRejectedValueOnce(new Error('reclassify-boom'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).post(`/api/channels/${ch.id}/reclassify-videos`).set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('reclassify-boom');
    consoleSpy.mockRestore();
  });

  it('500 with default message when err.message is falsy', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel({ category: 'IHI Y' });
    await mkVideo({ channelId: ch.id, classification: '' });
    classifySadguruVideoBatch.mockRejectedValueOnce(Object.assign(new Error(), { message: '' }));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).post(`/api/channels/${ch.id}/reclassify-videos`).set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Reclassification failed');
    consoleSpy.mockRestore();
  });
});

// =========================================================================
// POST /api/channels/classify-all (classifyAllChannelsVideos)
// =========================================================================
describe('POST /api/channels/classify-all (classifyAllChannelsVideos)', () => {
  it('403 for viewer', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).post('/api/channels/classify-all').set(headers);
    expect(res.status).toBe(403);
  });

  it('processes non-archived channels and accumulates totals with per-channel errors', async () => {
    const { headers } = await authFor('manager');
    const ded = await mkChannel({ title: 'A Ded', category: 'Dedicated' });
    const ihi = await mkChannel({ title: 'B IHI', category: 'IHI Group' });
    const bad = await mkChannel({ title: 'C Bad', category: 'IHI Other' });
    await mkChannel({ title: 'Z arc', category: 'IHI', status: 'archived' });

    await mkVideo({ channelId: ded.id, classification: '' });
    const iv = await mkVideo({ channelId: ihi.id, classification: '' });
    await mkVideo({ channelId: bad.id, classification: '' });

    classifySadguruVideoBatch.mockImplementation(async (videos) => {
      if (videos.length && String(videos[0].id) === String(iv.id)) {
        return new Map([[String(iv.id), 'non sadhguru']]);
      }
      throw new Error('bad-channel-fail');
    });

    const res = await request(app).post('/api/channels/classify-all').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.channelsProcessed).toBe(2);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].message).toBe('bad-channel-fail');
  });

  it('returns errors:undefined when no per-channel failures (sorted: title asc)', async () => {
    const { headers } = await authFor('admin');
    await mkChannel({ title: 'Solo', category: 'Dedicated' });
    const res = await request(app).post('/api/channels/classify-all').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
  });

  it('503 when AI is not configured (top-level error matches)', async () => {
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.channel, 'findMany').mockImplementationOnce(() => { throw new Error('Missing GOOGLE_CLOUD_PROJECT'); });
    const res = await request(app).post('/api/channels/classify-all').set(headers);
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/AI not configured/);
  });

  it('500 on unexpected top-level error', async () => {
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.channel, 'findMany').mockImplementationOnce(() => { throw new Error('all-boom'); });
    const res = await request(app).post('/api/channels/classify-all').set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('all-boom');
  });
});
