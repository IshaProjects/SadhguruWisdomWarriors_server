import request from 'supertest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import app from '../../src/app.js';
import { prisma } from '../setup.js';
import { authFor, createUser } from '../helpers.js';

// Deterministic Jan-2024 dates so aggregation numbers are reproducible.
const D = (s) => new Date(`2024-01-${s}T00:00:00.000Z`);

let chSeq = 0;
const mkChannel = (over = {}) => {
  chSeq += 1;
  const data = {
    youtubeChannelId: `yt-ch-${chSeq}`,
    title: over.title ?? `Channel ${chSeq}`,
    thumbnailUrl: over.thumbnailUrl ?? `thumb-${chSeq}`,
    ...over,
  };
  // Translate legacy currentStats.{...} into the flattened Prisma columns.
  if ('currentStats' in data) {
    const cs = data.currentStats || {};
    if (cs.subscribers != null) data.currentSubscribers = cs.subscribers;
    if (cs.views != null) data.currentViews = cs.views;
    if (cs.videoCount != null) data.currentVideoCount = cs.videoCount;
    delete data.currentStats;
  }
  // Legacy `assignedTo` → `assignedToId`. Tests only pass synthetic ObjectId-
  // shaped strings here; we treat them as opaque strings (no FK enforcement
  // since the test User row doesn't exist). To avoid Prisma's FK constraint,
  // skip if it doesn't look like a real user id (defaults to null instead).
  if ('assignedTo' in data) {
    // We can't honour an arbitrary string; drop it for safety. Tests that
    // exercise the assignedTo branch verify it via query-param matching only
    // (no inserted user), so we keep the column null and rely on the
    // category filter (also in the query) to scope channels.
    delete data.assignedTo;
  }
  return prisma.channel.create({ data });
};

let vidSeq = 0;
const mkVideo = async (over = {}) => {
  vidSeq += 1;
  let { channelId, ...rest } = over;
  if (!channelId) {
    // The legacy tests sometimes used `oid()` for a synthetic ObjectId. Under
    // Prisma we need an actual channel row to satisfy the FK, so auto-create
    // a throwaway channel when no channelId is provided.
    const ch = await mkChannel({});
    channelId = ch.id;
  }
  return prisma.video.create({
    data: {
      youtubeVideoId: `yt-v-${vidSeq}`,
      channelId,
      publishedAt: rest.publishedAt ?? D('12'),
      ...rest,
    },
  });
};

const mkChSnap = (o) =>
  prisma.channelSnapshot.create({
    data: {
      subscribers: 0,
      views: 0,
      videoCount: 0,
      deletedAt: null,
      ...o,
    },
  });

const mkVidSnap = (o) =>
  prisma.videoSnapshot.create({
    data: {
      views: 0,
      likes: 0,
      comments: 0,
      deletedAt: null,
      ...o,
    },
  });

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// GET /api/dashboard/summary
// ============================================================================
describe('GET /api/dashboard/summary', () => {
  it('200 — returns aggregated totals for a default (non-ihi) group', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({
      category: 'News',
      currentStats: { subscribers: 1000, views: 5000, videoCount: 10 },
      lastSyncedAt: D('15'),
    });
    await mkChSnap({ channelId: ch.id, date: D('12'), subscribers: 900, views: 4000 });
    await mkChSnap({ channelId: ch.id, date: D('18'), subscribers: 1000, views: 5000 });
    await mkVideo({ channelId: ch.id, publishedAt: D('15'), views: 100, likes: 10, comments: 5 });

    const res = await request(app)
      .get('/api/dashboard/summary?startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.totalChannels).toBe(1);
    expect(res.body.totalSubscribers).toBe(1000);
    expect(res.body.totalViews).toBe(5000);
    expect(res.body.subsChange).toBeCloseTo(11.11, 1);
    expect(res.body.viewsChange).toBe(25);
    expect(res.body.videosThisPeriod).toBe(1);
    expect(res.body.avgEngagement).toBe(15);
  });

  it('200 — IHI group: totalViews from sadhguru videos, prevViews from VideoSnapshot', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel({
      category: 'IHI - Local',
      currentStats: { subscribers: 500, views: 100 },
      lastSyncedAt: D('15'),
    });
    const v = await mkVideo({
      channelId: ch.id,
      classification: 'sadhguru',
      views: 800,
      likes: 80,
      comments: 20,
      publishedAt: D('15'),
    });
    await mkVideo({
      channelId: ch.id,
      classification: 'non sadhguru',
      views: 999,
      publishedAt: D('15'),
    });
    await mkChSnap({ channelId: ch.id, date: D('12'), subscribers: 400 });
    await mkVidSnap({ videoId: v.id, channelId: ch.id, date: D('12'), views: 100 });
    await mkVidSnap({ videoId: v.id, channelId: ch.id, date: D('18'), views: 700 });

    const res = await request(app)
      .get('/api/dashboard/summary?group=ihi&startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.totalChannels).toBe(1);
    expect(res.body.totalSubscribers).toBe(500);
    expect(res.body.totalViews).toBe(800);
    expect(res.body.prevSubscribers).toBeUndefined();
    expect(res.body.videosThisPeriod).toBe(1);
  });

  it('200 — non-ihi: handles missing currentStats and zero prevSubscribers/prevViews (no division by zero)', async () => {
    const { headers } = await authFor('viewer');
    // No currentStats overrides → default 0 / 0 / 0 columns.
    await mkChannel({ category: 'News' });

    const res = await request(app).get('/api/dashboard/summary').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.totalSubscribers).toBe(0);
    expect(res.body.totalViews).toBe(0);
    expect(res.body.subsChange).toBe(0);
    expect(res.body.viewsChange).toBe(0);
    expect(res.body.avgEngagement).toBe(0);
  });

  it('200 — IHI with no sadhguru videos returns 0 totals safely', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ category: 'IHI - X', lastSyncedAt: D('15') });
    const res = await request(app)
      .get('/api/dashboard/summary?group=ihi&startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.totalViews).toBe(0);
  });

  it('500 — forwards DB errors to the error handler', async () => {
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.channel, 'findMany').mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await request(app).get('/api/dashboard/summary').set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom');
  });
});

// ============================================================================
// GET /api/dashboard/summary — only-on-change invariance (IHI prevViews)
//
// The only-on-change sync guard writes a video_snapshot row ONLY when views
// differ from the previous stored row. The IHI prevViews baseline must
// therefore be invariant to whether unchanged days are materialized: a "dense"
// trajectory (a row every day, including unchanged days) and the equivalent
// "sparse" trajectory (rows only where the value changed) must produce the
// SAME viewsChange. prevViews is the view total at the START of the period, so
// the correct, densify-invariant baseline is carry-forward: the latest
// snapshot with date <= start (falling back to the first in-range snapshot for
// videos with no pre-start history — which the guard always keeps).
// ============================================================================
describe('GET /api/dashboard/summary — only-on-change invariance (IHI)', () => {
  // Old sadhguru video, published before the window, current views = 200.
  // Baseline (views at start = Jan 10) is 100, so viewsChange = (200-100)/100 = 100%.
  const seedVideo = async () => {
    const ch = await mkChannel({ category: 'IHI - Inv', lastSyncedAt: D('15') });
    const v = await mkVideo({
      channelId: ch.id,
      classification: 'sadhguru',
      views: 200,
      publishedAt: D('05'),
    });
    return v;
  };

  it('200 — IHI viewsChange: dense daily snapshots (incl. unchanged days)', async () => {
    const { headers } = await authFor('admin');
    const v = await seedVideo();
    // Dense: a row every day. 100 through Jan 14, 150 through Jan 19, 200 on Jan 20.
    const dense = [
      ['08', 100], ['09', 100], ['10', 100], ['11', 100], ['12', 100],
      ['13', 100], ['14', 100], ['15', 150], ['16', 150], ['17', 150],
      ['18', 150], ['19', 150], ['20', 200],
    ];
    for (const [day, views] of dense) {
      await mkVidSnap({ videoId: v.id, channelId: v.channelId, date: D(day), views });
    }

    const res = await request(app)
      .get('/api/dashboard/summary?group=ihi&startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.totalViews).toBe(200);
    expect(res.body.viewsChange).toBe(100);
  });

  it('200 — IHI viewsChange: SPARSE only-on-change snapshots match the dense result', async () => {
    const { headers } = await authFor('admin');
    const v = await seedVideo();
    // Same trajectory, but only the days the value changed are stored. The
    // last change before the window is Jan 08 (=100); inside the window the
    // value steps to 150 (Jan 15) then 200 (Jan 20). Carry-forward makes the
    // baseline at Jan 10 still 100 → viewsChange 100%, identical to dense.
    const sparse = [
      ['08', 100], ['15', 150], ['20', 200],
    ];
    for (const [day, views] of sparse) {
      await mkVidSnap({ videoId: v.id, channelId: v.channelId, date: D(day), views });
    }

    const res = await request(app)
      .get('/api/dashboard/summary?group=ihi&startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.totalViews).toBe(200);
    expect(res.body.viewsChange).toBe(100);
  });
});

// ============================================================================
// GET /api/dashboard/growth
// ============================================================================
describe('GET /api/dashboard/growth', () => {
  it('200 — non-ihi: groups channel snapshots per day', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ category: 'News', lastSyncedAt: D('15') });
    await mkChSnap({ channelId: ch.id, date: D('12'), subscribers: 100, views: 500, videoCount: 3 });
    await mkChSnap({ channelId: ch.id, date: D('13'), subscribers: 110, views: 550, videoCount: 4 });

    const res = await request(app)
      .get('/api/dashboard/growth?startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { date: '2024-01-12', subscribers: 100, views: 500, videoCount: 3 },
      { date: '2024-01-13', subscribers: 110, views: 550, videoCount: 4 },
    ]);
  });

  it('200 — ihi: per-day cumulative views, carry-forward on a gap day', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ category: 'IHI - A', lastSyncedAt: D('15') });
    const v = await mkVideo({
      channelId: ch.id,
      classification: 'sadhguru',
      publishedAt: D('05'),
    });
    await mkChSnap({ channelId: ch.id, date: D('12'), subscribers: 100, videoCount: 3 });
    await mkChSnap({ channelId: ch.id, date: D('13'), subscribers: 110, videoCount: 4 });
    await mkVidSnap({ videoId: v.id, channelId: ch.id, date: D('12'), views: 1000 });
    await mkVidSnap({ videoId: v.id, channelId: ch.id, date: D('13'), views: 1500 });
    await mkChSnap({ channelId: ch.id, date: D('14'), subscribers: 120, videoCount: 5 });

    const res = await request(app)
      .get('/api/dashboard/growth?group=ihi&startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    // Jan 14 has a channel snapshot but NO video snapshot. Carry-forward
    // reports the video's last-known cumulative views (1500) rather than the
    // old gap→0. This is the behavior the only-on-change guard relies on: an
    // unmaterialized (unchanged) day shows the carried value, not zero.
    expect(res.body).toEqual([
      { date: '2024-01-12', subscribers: 100, views: 1000, videoCount: 3 },
      { date: '2024-01-13', subscribers: 110, views: 1500, videoCount: 4 },
      { date: '2024-01-14', subscribers: 120, views: 1500, videoCount: 5 },
    ]);
  });

  it('500 — DB error', async () => {
    const { headers } = await authFor('viewer');
    vi.spyOn(prisma.channel, 'findMany').mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await request(app).get('/api/dashboard/growth').set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom');
  });

  // --- only-on-change invariance --------------------------------------------
  // The IHI per-day views must be carry-forward (each day = total cumulative
  // sadhguru views as of that day) so the chart is invariant to whether
  // unchanged days are materialized. A "dense" trajectory (a row every day,
  // incl. unchanged days) and the equivalent "sparse" trajectory (rows only
  // where the value changed) must produce the SAME per-day array.
  const seedGrowthIhi = async () => {
    const ch = await mkChannel({ category: 'IHI - G', lastSyncedAt: D('15') });
    const v = await mkVideo({ channelId: ch.id, classification: 'sadhguru', publishedAt: D('05') });
    // Three output days are driven by the channel snapshots.
    await mkChSnap({ channelId: ch.id, date: D('12'), subscribers: 100, videoCount: 3 });
    await mkChSnap({ channelId: ch.id, date: D('13'), subscribers: 110, videoCount: 4 });
    await mkChSnap({ channelId: ch.id, date: D('14'), subscribers: 120, videoCount: 5 });
    return v;
  };
  const expectedGrowth = [
    { date: '2024-01-12', subscribers: 100, views: 1000, videoCount: 3 },
    { date: '2024-01-13', subscribers: 110, views: 1000, videoCount: 4 },
    { date: '2024-01-14', subscribers: 120, views: 1500, videoCount: 5 },
  ];

  it('200 — ihi dense: per-day cumulative views (Jan13 unchanged at 1000)', async () => {
    const { headers } = await authFor('viewer');
    const v = await seedGrowthIhi();
    // Dense: a video snapshot every day; Jan13 is unchanged (still 1000).
    await mkVidSnap({ videoId: v.id, channelId: v.channelId, date: D('12'), views: 1000 });
    await mkVidSnap({ videoId: v.id, channelId: v.channelId, date: D('13'), views: 1000 });
    await mkVidSnap({ videoId: v.id, channelId: v.channelId, date: D('14'), views: 1500 });

    const res = await request(app)
      .get('/api/dashboard/growth?group=ihi&startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expectedGrowth);
  });

  it('200 — ihi SPARSE only-on-change: Jan13 carries forward, matches dense', async () => {
    const { headers } = await authFor('viewer');
    const v = await seedGrowthIhi();
    // Sparse: Jan13 (unchanged) is not materialized. Carry-forward must still
    // report 1000 for Jan13 — identical to the dense result above.
    await mkVidSnap({ videoId: v.id, channelId: v.channelId, date: D('12'), views: 1000 });
    await mkVidSnap({ videoId: v.id, channelId: v.channelId, date: D('14'), views: 1500 });

    const res = await request(app)
      .get('/api/dashboard/growth?group=ihi&startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expectedGrowth);
  });
});

// ============================================================================
// GET /api/dashboard/top-channels
// ============================================================================
describe('GET /api/dashboard/top-channels', () => {
  it('200 — ranks channels by subs growth (default metric)', async () => {
    const { headers } = await authFor('viewer');
    const a = await mkChannel({ title: 'A', thumbnailUrl: 'a.png', lastSyncedAt: D('15') });
    const b = await mkChannel({ title: 'B', thumbnailUrl: 'b.png', lastSyncedAt: D('15') });
    await mkChSnap({ channelId: a.id, date: D('12'), subscribers: 100, views: 1000 });
    await mkChSnap({ channelId: a.id, date: D('18'), subscribers: 200, views: 1100 });
    await mkChSnap({ channelId: b.id, date: D('12'), subscribers: 500, views: 5000 });
    await mkChSnap({ channelId: b.id, date: D('18'), subscribers: 550, views: 8000 });

    const res = await request(app)
      .get('/api/dashboard/top-channels?startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].title).toBe('A');
    expect(res.body[0].subsGrowth).toBe(100);
    expect(res.body[0].viewsGrowth).toBe(100);
    expect(res.body[0].currentSubs).toBe(200);
    expect(res.body[0].currentViews).toBe(1100);
    expect(res.body[0].thumbnailUrl).toBe('a.png');
  });

  it('200 — metric=views ranks by views growth and respects limit', async () => {
    const { headers } = await authFor('viewer');
    const a = await mkChannel({ title: 'A', lastSyncedAt: D('15') });
    const b = await mkChannel({ title: 'B', lastSyncedAt: D('15') });
    await mkChSnap({ channelId: a.id, date: D('12'), subscribers: 100, views: 1000 });
    await mkChSnap({ channelId: a.id, date: D('18'), subscribers: 200, views: 1100 });
    await mkChSnap({ channelId: b.id, date: D('12'), subscribers: 500, views: 5000 });
    await mkChSnap({ channelId: b.id, date: D('18'), subscribers: 550, views: 8000 });

    const res = await request(app)
      .get('/api/dashboard/top-channels?metric=views&limit=1&startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe('B');
    expect(res.body[0].viewsGrowth).toBe(3000);
  });

  it("200 — channel without matching doc shows title 'Unknown' and thumbnail ''", async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'Stub', lastSyncedAt: D('15') });
    await mkChSnap({ channelId: ch.id, date: D('12'), subscribers: 10, views: 100 });
    await mkChSnap({ channelId: ch.id, date: D('18'), subscribers: 50, views: 200 });

    // Inject a raw SQL row whose channel_id is not in the channels list.
    // We spy on the underlying PrismaClient ($queryRaw lives there — the
    // shared singleton is reachable through any namespace's $parent).
    const client = prisma.user.$parent;
    const stranger = 'no-such-channel';
    const spyRaw = vi.spyOn(client, '$queryRaw');
    // First call inside getTopChannels: "firsts" — return one row for stranger.
    spyRaw.mockResolvedValueOnce([
      { channel_id: stranger, subscribers: 0, views: 0n },
    ]);
    // Second call: "lasts" — return the corresponding final row.
    spyRaw.mockResolvedValueOnce([
      { channel_id: stranger, subscribers: 10, views: 100n },
    ]);

    const res = await request(app)
      .get('/api/dashboard/top-channels?startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body[0].title).toBe('Unknown');
    expect(res.body[0].thumbnailUrl).toBe('');
  });

  it('500 — DB error', async () => {
    const { headers } = await authFor('viewer');
    vi.spyOn(prisma.channel, 'findMany').mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await request(app).get('/api/dashboard/top-channels').set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom');
  });
});

// ============================================================================
// GET /api/dashboard/top-videos
// ============================================================================
describe('GET /api/dashboard/top-videos', () => {
  it('200 — returns videos sorted by views desc, populated with channel info', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'My Channel', lastSyncedAt: D('15') });
    await mkVideo({ channelId: ch.id, title: 'V-low', views: 50, publishedAt: D('12') });
    await mkVideo({ channelId: ch.id, title: 'V-high', views: 500, publishedAt: D('14') });
    await mkVideo({
      channelId: ch.id,
      title: 'V-deleted',
      views: 999,
      publishedAt: D('15'),
      deletedAt: new Date(),
    });

    const res = await request(app)
      .get('/api/dashboard/top-videos?startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.map((v) => v.title)).toEqual(['V-high', 'V-low']);
    expect(res.body[0].channelId.title).toBe('My Channel');
  });

  it("200 — group=ihi narrows to classification 'sadhguru' and respects limit", async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ category: 'IHI - A', lastSyncedAt: D('15') });
    await mkVideo({
      channelId: ch.id,
      title: 'sad-1',
      classification: 'sadhguru',
      views: 100,
      publishedAt: D('12'),
    });
    await mkVideo({
      channelId: ch.id,
      title: 'sad-2',
      classification: 'sadhguru',
      views: 200,
      publishedAt: D('13'),
    });
    await mkVideo({
      channelId: ch.id,
      title: 'non',
      classification: 'non sadhguru',
      views: 999,
      publishedAt: D('14'),
    });

    const res = await request(app)
      .get('/api/dashboard/top-videos?group=ihi&limit=1&startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe('sad-2');
  });

  it('500 — DB error', async () => {
    const { headers } = await authFor('viewer');
    vi.spyOn(prisma.channel, 'findMany').mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await request(app).get('/api/dashboard/top-videos').set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom');
  });
});

// ============================================================================
// GET /api/dashboard/categories
// ============================================================================
describe('GET /api/dashboard/categories', () => {
  it('200 — current-mode aggregation groups by category', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({
      category: 'News',
      currentStats: { subscribers: 100, views: 1000, videoCount: 5 },
    });
    await mkChannel({
      category: 'News',
      currentStats: { subscribers: 200, views: 2000, videoCount: 8 },
    });
    await mkChannel({
      category: 'Yoga',
      currentStats: { subscribers: 50, views: 500, videoCount: 1 },
    });

    const res = await request(app).get('/api/dashboard/categories').set(headers);
    expect(res.status).toBe(200);
    expect(res.body[0].category).toBe('News');
    expect(res.body[0].count).toBe(2);
    expect(res.body[0].totalSubs).toBe(300);
    expect(res.body[0].totalViews).toBe(3000);
    expect(res.body[1].category).toBe('Yoga');
  });

  it('200 — current-mode: empty/null category becomes Uncategorized (schema default)', async () => {
    const { headers } = await authFor('viewer');
    // Category column has @default("Uncategorized") so omitting it lands there.
    await mkChannel({ currentStats: { subscribers: 0, views: 0 } });
    const res = await request(app).get('/api/dashboard/categories').set(headers);
    expect(res.status).toBe(200);
    expect(res.body[0].category).toBeTruthy();
  });

  it('200 — period mode aggregates from VideoSnapshot + ChannelSnapshot', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ category: 'News' });
    const v = await mkVideo({ channelId: ch.id, classification: 'sadhguru', publishedAt: D('05') });
    await mkChSnap({ channelId: ch.id, date: D('12'), subscribers: 100 });
    await mkChSnap({ channelId: ch.id, date: D('18'), subscribers: 150 });
    await mkVidSnap({ videoId: v.id, channelId: ch.id, date: D('05'), views: 100 });
    await mkVidSnap({ videoId: v.id, channelId: ch.id, date: D('18'), views: 400 });

    const res = await request(app)
      .get('/api/dashboard/categories?startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].category).toBe('News');
    expect(res.body[0].count).toBe(1);
    expect(res.body[0].totalSubs).toBe(50);
    expect(res.body[0].totalViews).toBe(300);
  });

  it('200 — period mode with classification=sadhguru filters channel set and uses sadhguru videos', async () => {
    const { headers } = await authFor('viewer');
    const chSad = await mkChannel({ category: 'IHI - A' });
    const chOther = await mkChannel({ category: 'News' });
    const v = await mkVideo({
      channelId: chSad.id,
      classification: 'sadhguru',
      publishedAt: D('05'),
    });
    await mkVideo({ channelId: chOther.id, classification: 'non sadhguru', publishedAt: D('05') });
    await mkChSnap({ channelId: chSad.id, date: D('12'), subscribers: 100 });
    await mkChSnap({ channelId: chSad.id, date: D('18'), subscribers: 200 });
    await mkVidSnap({ videoId: v.id, channelId: chSad.id, date: D('12'), views: 50 });
    await mkVidSnap({ videoId: v.id, channelId: chSad.id, date: D('18'), views: 150 });

    const res = await request(app)
      .get('/api/dashboard/categories?classification=sadhguru&startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].category).toBe('IHI - A');
    expect(res.body[0].totalViews).toBe(100);
    expect(res.body[0].totalSubs).toBe(100);
  });

  it('200 — period mode with classification=non_sadhguru maps to "non sadhguru"', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ category: 'News' });
    const v = await mkVideo({
      channelId: ch.id,
      classification: 'non sadhguru',
      publishedAt: D('05'),
    });
    await mkChSnap({ channelId: ch.id, date: D('12'), subscribers: 100 });
    await mkChSnap({ channelId: ch.id, date: D('18'), subscribers: 110 });
    await mkVidSnap({ videoId: v.id, channelId: ch.id, date: D('12'), views: 10 });
    await mkVidSnap({ videoId: v.id, channelId: ch.id, date: D('18'), views: 60 });

    const res = await request(app)
      .get('/api/dashboard/categories?classification=non_sadhguru&startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body[0].totalViews).toBe(50);
  });

  it('200 — period mode: channel without snapshots produces zeros (default Uncategorized)', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({});
    const res = await request(app)
      .get('/api/dashboard/categories?startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].totalViews).toBe(0);
    expect(res.body[0].totalSubs).toBe(0);
  });

  it('200 — period mode: closing falls back to opening when only opening exists', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ category: 'News' });
    await mkChSnap({ channelId: ch.id, date: D('12'), subscribers: 100 });

    const res = await request(app)
      .get('/api/dashboard/categories?startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body[0].totalSubs).toBe(0);
  });

  it('200 — returns empty array when no channels match', async () => {
    const { headers } = await authFor('viewer');
    // Pass an assignedTo that doesn't match any channel → empty result.
    const res = await request(app)
      .get('/api/dashboard/categories?assignedTo=ghost-user-id')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('500 — DB error', async () => {
    const { headers } = await authFor('viewer');
    vi.spyOn(prisma.channel, 'findMany').mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await request(app).get('/api/dashboard/categories').set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom');
  });
});

// ============================================================================
// GET /api/dashboard/micro-units-report
// ============================================================================
describe('GET /api/dashboard/micro-units-report', () => {
  it('200 — returns [] when no micro units', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/dashboard/micro-units-report').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('200 — current-mode aggregates from currentStats per micro unit', async () => {
    const { headers } = await authFor('viewer');
    const ch1 = await mkChannel({
      currentStats: { subscribers: 100, views: 1000, videoCount: 5 },
    });
    const ch2 = await mkChannel({
      currentStats: { subscribers: 200, views: 2000, videoCount: 10 },
    });
    await prisma.microUnit.create({
      data: {
        name: 'Alpha',
        microUnitChannels: {
          create: [{ channelId: ch1.id }, { channelId: ch2.id }],
        },
      },
    });
    await prisma.microUnit.create({ data: { name: 'Beta' } });

    const res = await request(app).get('/api/dashboard/micro-units-report').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const alpha = res.body.find((r) => r.name === 'Alpha');
    expect(alpha.totalSubs).toBe(300);
    expect(alpha.totalViews).toBe(3000);
    expect(alpha.totalVideos).toBe(15);
    expect(alpha.count).toBe(2);
    const beta = res.body.find((r) => r.name === 'Beta');
    expect(beta.count).toBe(0);
    expect(beta.totalViews).toBe(0);
  });

  it('200 — period-mode aggregates from snapshots and Video.count', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ category: 'News' });
    const v = await mkVideo({
      channelId: ch.id,
      classification: 'sadhguru',
      publishedAt: D('05'),
    });
    await mkChSnap({ channelId: ch.id, date: D('12'), subscribers: 100 });
    await mkChSnap({ channelId: ch.id, date: D('18'), subscribers: 200 });
    await mkVidSnap({ videoId: v.id, channelId: ch.id, date: D('12'), views: 100 });
    await mkVidSnap({ videoId: v.id, channelId: ch.id, date: D('18'), views: 400 });
    const v2 = await mkVideo({
      channelId: ch.id,
      classification: 'sadhguru',
      publishedAt: D('15'),
    });
    await mkVidSnap({ videoId: v2.id, channelId: ch.id, date: D('18'), views: 0 });
    await prisma.microUnit.create({
      data: { name: 'U', microUnitChannels: { create: [{ channelId: ch.id }] } },
    });

    const res = await request(app)
      .get('/api/dashboard/micro-units-report?startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe('U');
    expect(res.body[0].totalSubs).toBe(100);
    expect(res.body[0].totalViews).toBe(300);
    expect(res.body[0].totalVideos).toBe(1);
  });

  it('200 — period-mode with classification=sadhguru narrows the channel and video filter', async () => {
    const { headers } = await authFor('viewer');
    const chSad = await mkChannel({});
    const chOther = await mkChannel({});
    const v = await mkVideo({
      channelId: chSad.id,
      classification: 'sadhguru',
      publishedAt: D('15'),
    });
    await mkChSnap({ channelId: chSad.id, date: D('12'), subscribers: 100 });
    await mkChSnap({ channelId: chSad.id, date: D('18'), subscribers: 150 });
    await mkVidSnap({ videoId: v.id, channelId: chSad.id, date: D('12'), views: 0 });
    await mkVidSnap({ videoId: v.id, channelId: chSad.id, date: D('18'), views: 200 });
    await prisma.microUnit.create({
      data: {
        name: 'Mix',
        microUnitChannels: { create: [{ channelId: chSad.id }, { channelId: chOther.id }] },
      },
    });

    const res = await request(app)
      .get('/api/dashboard/micro-units-report?classification=sadhguru&startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body[0].count).toBe(1);
    expect(res.body[0].totalViews).toBe(200);
    expect(res.body[0].totalSubs).toBe(50);
    expect(res.body[0].totalVideos).toBe(1);
  });

  it('200 — period-mode classification=non_sadhguru maps to "non sadhguru" classification', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({});
    const v = await mkVideo({
      channelId: ch.id,
      classification: 'non sadhguru',
      publishedAt: D('05'),
    });
    const v2 = await mkVideo({
      channelId: ch.id,
      classification: 'non sadhguru',
      publishedAt: D('15'),
    });
    await mkChSnap({ channelId: ch.id, date: D('12'), subscribers: 10 });
    await mkChSnap({ channelId: ch.id, date: D('18'), subscribers: 30 });
    await mkVidSnap({ videoId: v.id, channelId: ch.id, date: D('12'), views: 5 });
    await mkVidSnap({ videoId: v.id, channelId: ch.id, date: D('18'), views: 25 });
    await mkVidSnap({ videoId: v2.id, channelId: ch.id, date: D('18'), views: 0 });
    await prisma.microUnit.create({
      data: { name: 'NS', microUnitChannels: { create: [{ channelId: ch.id }] } },
    });

    const res = await request(app)
      .get('/api/dashboard/micro-units-report?classification=non_sadhguru&startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body[0].totalViews).toBe(20);
    expect(res.body[0].totalVideos).toBe(1);
  });

  it('200 — rawIds filter empties all → zero counts entry', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({});
    await mkVideo({ channelId: ch.id, classification: 'non sadhguru', publishedAt: D('15') });
    await prisma.microUnit.create({
      data: { name: 'OnlyNonSad', microUnitChannels: { create: [{ channelId: ch.id }] } },
    });

    const res = await request(app)
      .get('/api/dashboard/micro-units-report?classification=sadhguru')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body[0].count).toBe(0);
    expect(res.body[0].totalSubs).toBe(0);
  });

  it('200 — channels filtered out by channelFilter (status archived) yields empty unit', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ status: 'archived' });
    await prisma.microUnit.create({
      data: { name: 'AllArchived', microUnitChannels: { create: [{ channelId: ch.id }] } },
    });
    const res = await request(app).get('/api/dashboard/micro-units-report').set(headers);
    expect(res.status).toBe(200);
    expect(res.body[0].count).toBe(0);
  });

  it('200 — period-mode skips channels with no opening snapshot', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({});
    await prisma.microUnit.create({
      data: { name: 'NoSnaps', microUnitChannels: { create: [{ channelId: ch.id }] } },
    });
    const res = await request(app)
      .get('/api/dashboard/micro-units-report?startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body[0].totalSubs).toBe(0);
    expect(res.body[0].totalViews).toBe(0);
  });

  it('500 — DB error', async () => {
    const { headers } = await authFor('viewer');
    vi.spyOn(prisma.microUnit, 'findMany').mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await request(app).get('/api/dashboard/micro-units-report').set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom');
  });
});

// ============================================================================
// GET /api/dashboard/channel-metrics
// ============================================================================
describe('GET /api/dashboard/channel-metrics', () => {
  it('200 — returns [] when no channels match', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/dashboard/channel-metrics').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('200 — period mode includes channels synced AFTER the window end', async () => {
    // Regression: buildChannelFilter turns startDate/endDate into a
    // lastSyncedAt window; period mode must drop that (like every other
    // period endpoint) or actively-synced channels vanish from the widget.
    const { headers } = await authFor('viewer');
    await mkChannel({
      title: 'Fresh Sync',
      lastSyncedAt: D('20'),
      currentStats: { subscribers: 10, views: 100, videoCount: 1 },
    });
    const res = await request(app)
      .get('/api/dashboard/channel-metrics?startDate=2024-01-01&endDate=2024-01-05')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.title)).toContain('Fresh Sync');
  });

  it('200 — computes all four metrics with deterministic numbers', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({
      title: 'M',
      thumbnailUrl: 't',
      category: 'News',
      currentStats: { subscribers: 200, views: 2000, videoCount: 10 },
    });
    await mkVideo({ channelId: ch.id, views: 1000, likes: 100, comments: 50 });
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await mkChSnap({ channelId: ch.id, date: eightDaysAgo, subscribers: 100 });

    const res = await request(app).get('/api/dashboard/channel-metrics').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const m = res.body[0];
    expect(m.engagementEfficiency).toBeCloseTo(0.15, 5);
    expect(m.loyaltyIndex).toBeCloseTo(0.05, 5);
    expect(m.contentImpact).toBe(200);
    expect(m.subscriberVelocity).toBe(100);
  });

  it('200 — null-returning branches when there is no video data and no snapshot', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({
      title: 'M',
      currentStats: { subscribers: 0, views: 0, videoCount: 0 },
    });
    const res = await request(app).get('/api/dashboard/channel-metrics').set(headers);
    expect(res.status).toBe(200);
    expect(res.body[0].engagementEfficiency).toBeNull();
    expect(res.body[0].loyaltyIndex).toBeNull();
    expect(res.body[0].contentImpact).toBeNull();
    expect(res.body[0].subscriberVelocity).toBeNull();
  });

  it('200 — subscriberVelocity null when subs7dAgo is 0', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({
      currentStats: { subscribers: 100, views: 1, videoCount: 1 },
    });
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await mkChSnap({ channelId: ch.id, date: eightDaysAgo, subscribers: 0 });
    const res = await request(app).get('/api/dashboard/channel-metrics').set(headers);
    expect(res.status).toBe(200);
    expect(res.body[0].subscriberVelocity).toBeNull();
  });

  it('200 — uses defaults when currentStats fields are missing', async () => {
    const { headers } = await authFor('viewer');
    // No currentStats overrides → columns default to 0.
    await mkChannel({});
    const res = await request(app).get('/api/dashboard/channel-metrics').set(headers);
    expect(res.status).toBe(200);
    expect(res.body[0].subscribers).toBe(0);
  });

  it('500 — DB error', async () => {
    const { headers } = await authFor('viewer');
    vi.spyOn(prisma.channel, 'findMany').mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await request(app).get('/api/dashboard/channel-metrics').set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom');
  });
});

// ============================================================================
// GET /api/dashboard/publishing
// ============================================================================
describe('GET /api/dashboard/publishing', () => {
  it('200 — groups videos published per day', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ lastSyncedAt: D('15') });
    await mkVideo({ channelId: ch.id, publishedAt: D('12') });
    await mkVideo({ channelId: ch.id, publishedAt: D('12') });
    await mkVideo({ channelId: ch.id, publishedAt: D('13') });

    const res = await request(app)
      .get('/api/dashboard/publishing?startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { date: '2024-01-12', count: 2 },
      { date: '2024-01-13', count: 1 },
    ]);
  });

  it('500 — DB error', async () => {
    const { headers } = await authFor('viewer');
    vi.spyOn(prisma.channel, 'findMany').mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await request(app).get('/api/dashboard/publishing').set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom');
  });
});

// ============================================================================
// GET /api/dashboard/grade-grid
// ============================================================================
describe('GET /api/dashboard/grade-grid', () => {
  it('200 — buckets by Grade A-E and Inactive (group="")', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ category: 'Dedicated - Grade A' });
    await mkChannel({ category: 'Dedicated - Grade B' });
    await mkChannel({ category: 'IHI - Grade C' });
    await mkChannel({ category: 'IHI - Grade D' });
    await mkChannel({ category: 'Dedicated - Grade E' });
    await mkChannel({ category: 'IHI - Inactive' });
    await mkChannel({ category: 'News' });

    const res = await request(app).get('/api/dashboard/grade-grid').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.row1).toEqual({ A: 1, B: 1, C: 1, D: 1, E: 1, Inactive: 1 });
    expect(res.body.row2).toBeNull();
    expect(res.body.row3).toBeNull();
  });

  it('200 — group=dedicated narrows to "Dedicated -" categories', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ category: 'Dedicated - Grade A' });
    await mkChannel({ category: 'IHI - Grade A' });
    const res = await request(app).get('/api/dashboard/grade-grid?group=dedicated').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.row1.A).toBe(1);
  });

  it('200 — group=ihi narrows to /IHI/i categories', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ category: 'Dedicated - Grade A' });
    await mkChannel({ category: 'IHI - Grade A' });
    const res = await request(app).get('/api/dashboard/grade-grid?group=ihi').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.row1.A).toBe(1);
  });

  it('200 — start > end leaves row2/row3 null', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ category: 'Dedicated - Grade A' });
    const res = await request(app)
      .get('/api/dashboard/grade-grid?startDate=2024-01-20&endDate=2024-01-10')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.row1.A).toBe(1);
    expect(res.body.row2).toBeNull();
    expect(res.body.row3).toBeNull();
  });

  it('200 — wantRange: computes per-bucket top10 and totals from VideoSnapshot growth', async () => {
    const { headers } = await authFor('viewer');
    const ded = await mkChannel({ title: 'Ded', category: 'Dedicated - Grade A' });
    const ihi = await mkChannel({ title: 'Ihi', category: 'IHI - Grade A' });
    const vDed = await mkVideo({ channelId: ded.id, classification: '', publishedAt: D('05') });
    await mkVidSnap({ videoId: vDed.id, channelId: ded.id, date: D('05'), views: 100 });
    await mkVidSnap({ videoId: vDed.id, channelId: ded.id, date: D('18'), views: 300 });
    const vIhiSad = await mkVideo({
      channelId: ihi.id,
      classification: 'sadhguru',
      publishedAt: D('05'),
    });
    await mkVidSnap({ videoId: vIhiSad.id, channelId: ihi.id, date: D('05'), views: 50 });
    await mkVidSnap({ videoId: vIhiSad.id, channelId: ihi.id, date: D('18'), views: 150 });
    const vIhiNon = await mkVideo({
      channelId: ihi.id,
      classification: 'non sadhguru',
      publishedAt: D('05'),
    });
    await mkVidSnap({ videoId: vIhiNon.id, channelId: ihi.id, date: D('05'), views: 0 });
    await mkVidSnap({ videoId: vIhiNon.id, channelId: ihi.id, date: D('18'), views: 9999 });

    const res = await request(app)
      .get('/api/dashboard/grade-grid?startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.row1.A).toBe(2);
    expect(res.body.row2.A).toHaveLength(2);
    expect(res.body.row3.A).toBe(300);
    expect(res.body.row2.A[0].title).toBe('Ded');
    expect(res.body.row2.A[0].viewsGrowth).toBe(200);
    expect(res.body.row2.A[1].title).toBe('Ihi');
    expect(res.body.row2.A[1].viewsGrowth).toBe(100);
  });

  it('200 — wantRange with channel missing title/thumbnailUrl falls back to defaults', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ title: '', thumbnailUrl: '', category: 'Dedicated - Grade B' });
    const res = await request(app)
      .get('/api/dashboard/grade-grid?startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.row2.B).toHaveLength(1);
    expect(res.body.row2.B[0].title).toBe('Unknown');
    expect(res.body.row2.B[0].thumbnailUrl).toBe('');
    expect(res.body.row2.B[0].viewsGrowth).toBe(0);
  });

  it('200 — wantRange with no growth data leaves bucket sums at 0', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ category: 'Dedicated - Grade A' });
    const res = await request(app)
      .get('/api/dashboard/grade-grid?startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.row3.A).toBe(0);
  });

  it('500 — DB error', async () => {
    const { headers } = await authFor('viewer');
    vi.spyOn(prisma.channel, 'findMany').mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await request(app).get('/api/dashboard/grade-grid').set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom');
  });
});

// ============================================================================
// GET /api/dashboard/layout
// ============================================================================
describe('GET /api/dashboard/layout', () => {
  it('200 — returns existing layout', async () => {
    const { headers } = await authFor('viewer');
    await prisma.dashboardLayout.create({
      data: { id: 'layout', layouts: { lg: ['a'] }, updatedBy: 'admin@x' },
    });
    const res = await request(app).get('/api/dashboard/layout').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.layouts).toEqual({ lg: ['a'] });
    expect(res.body.updatedBy).toBe('admin@x');
  });

  it('200 — returns defaults when no layout exists', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/dashboard/layout').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ layouts: {}, updatedBy: '' });
  });

  it('500 — DB error', async () => {
    const { headers } = await authFor('viewer');
    vi.spyOn(prisma.dashboardLayout, 'findFirst').mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await request(app).get('/api/dashboard/layout').set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom');
  });
});

// ============================================================================
// PUT /api/dashboard/layout
// ============================================================================
describe('PUT /api/dashboard/layout', () => {
  it('200 — admin can save layout (upsert)', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .put('/api/dashboard/layout')
      .set(headers)
      .send({ layouts: { lg: ['x', 'y'] } });
    expect(res.status).toBe(200);
    expect(res.body.layouts).toEqual({ lg: ['x', 'y'] });
    expect(res.body.updatedBy).toMatch(/@test\.local$/);
  });

  it('200 — manager can save layout', async () => {
    const { headers } = await authFor('manager');
    const res = await request(app)
      .put('/api/dashboard/layout')
      .set(headers)
      .send({ layouts: { md: [] } });
    expect(res.status).toBe(200);
  });

  it('400 — missing layouts', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).put('/api/dashboard/layout').set(headers).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('layouts object is required');
  });

  it('400 — non-object layouts', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .put('/api/dashboard/layout')
      .set(headers)
      .send({ layouts: 'not-an-object' });
    expect(res.status).toBe(400);
  });

  it('403 — viewer cannot save layout', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app)
      .put('/api/dashboard/layout')
      .set(headers)
      .send({ layouts: { lg: [] } });
    expect(res.status).toBe(403);
  });

  it('500 — DB error', async () => {
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.dashboardLayout, 'upsert').mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await request(app)
      .put('/api/dashboard/layout')
      .set(headers)
      .send({ layouts: { lg: [] } });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom');
  });
});

// ============================================================================
// Branch-coverage top-ups
// ============================================================================
describe('branch coverage edge cases', () => {
  it('summary non-ihi: ChannelSnapshot rows with subscribers/views=0 hit ||0 fallbacks', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({
      category: 'News',
      currentStats: { subscribers: 0, views: 0 },
      lastSyncedAt: D('15'),
    });
    await mkChSnap({ channelId: ch.id, date: D('12'), subscribers: 0, views: 0 });
    const res = await request(app)
      .get('/api/dashboard/summary?startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.subsChange).toBe(0);
    expect(res.body.viewsChange).toBe(0);
  });

  it('summary IHI: oldChannelSnapshots reduce hits ||0 fallback', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({
      category: 'IHI - X',
      currentStats: { subscribers: 1, views: 1 },
      lastSyncedAt: D('15'),
    });
    await mkChSnap({ channelId: ch.id, date: D('12'), subscribers: 0 });
    const res = await request(app)
      .get('/api/dashboard/summary?group=ihi&startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
  });

  it('categories period-mode: channel.category falsy → "Uncategorized" + two channels in same category exercise byCategory else branch', async () => {
    const { headers } = await authFor('viewer');
    // Force category to '' (empty string is falsy) to hit the `|| 'Uncategorized'` branch.
    const c1 = await mkChannel({ category: '' });
    const c2 = await mkChannel({ category: '' });
    await mkChSnap({ channelId: c1.id, date: D('12'), subscribers: 0 });
    await mkChSnap({ channelId: c1.id, date: D('18'), subscribers: 0 });
    await mkChSnap({ channelId: c2.id, date: D('12'), subscribers: 0 });
    await mkChSnap({ channelId: c2.id, date: D('18'), subscribers: 0 });
    const res = await request(app)
      .get('/api/dashboard/categories?startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].category).toBe('Uncategorized');
    expect(res.body[0].count).toBe(2);
    expect(res.body[0].totalSubs).toBe(0);
  });

  it('categories period-mode sort: two different categories → comparator fires', async () => {
    const { headers } = await authFor('viewer');
    const ch1 = await mkChannel({ category: 'High' });
    const ch2 = await mkChannel({ category: 'Low' });
    const v1 = await mkVideo({
      channelId: ch1.id,
      classification: 'sadhguru',
      publishedAt: D('05'),
    });
    const v2 = await mkVideo({
      channelId: ch2.id,
      classification: 'sadhguru',
      publishedAt: D('05'),
    });
    await mkChSnap({ channelId: ch1.id, date: D('12'), subscribers: 10 });
    await mkChSnap({ channelId: ch1.id, date: D('18'), subscribers: 20 });
    await mkChSnap({ channelId: ch2.id, date: D('12'), subscribers: 5 });
    await mkChSnap({ channelId: ch2.id, date: D('18'), subscribers: 6 });
    await mkVidSnap({ videoId: v1.id, channelId: ch1.id, date: D('12'), views: 0 });
    await mkVidSnap({ videoId: v1.id, channelId: ch1.id, date: D('18'), views: 5000 });
    await mkVidSnap({ videoId: v2.id, channelId: ch2.id, date: D('12'), views: 0 });
    await mkVidSnap({ videoId: v2.id, channelId: ch2.id, date: D('18'), views: 100 });

    const res = await request(app)
      .get('/api/dashboard/categories?startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.category)).toEqual(['High', 'Low']);
  });

  it('micro-units current-mode: micro unit with no channel rows hits the `|| []` fallback', async () => {
    const { headers } = await authFor('viewer');
    // Bare MicroUnit with no microUnitChannels entries → unit.microUnitChannels = []
    await prisma.microUnit.create({ data: { name: 'NoChIds' } });
    const res = await request(app).get('/api/dashboard/micro-units-report').set(headers);
    expect(res.status).toBe(200);
    expect(res.body[0].count).toBe(0);
  });

  it('micro-units current-mode: currentStats with zero fields hits `|| 0` fallbacks', async () => {
    const { headers } = await authFor('viewer');
    // Default columns (no currentStats override) are 0 — equivalent to legacy
    // partial currentStats `{}` since the controller defaults via `|| 0`.
    const ch = await mkChannel({});
    await prisma.microUnit.create({
      data: { name: 'PartialStats', microUnitChannels: { create: [{ channelId: ch.id }] } },
    });
    const res = await request(app).get('/api/dashboard/micro-units-report').set(headers);
    expect(res.status).toBe(200);
    expect(res.body[0].count).toBe(1);
    expect(res.body[0].totalSubs).toBe(0);
    expect(res.body[0].totalViews).toBe(0);
    expect(res.body[0].totalVideos).toBe(0);
  });

  it('micro-units period-mode: missing closing/opening subscribers hits ?? 0 fallbacks', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({});
    // Snapshots with explicit subscribers=0 — same observable behaviour as legacy
    // "subscribers undefined" since the controller normalises via `?? 0`.
    await mkChSnap({ channelId: ch.id, date: D('12'), subscribers: 0 });
    await mkChSnap({ channelId: ch.id, date: D('18'), subscribers: 0 });
    await prisma.microUnit.create({
      data: { name: 'PMNull', microUnitChannels: { create: [{ channelId: ch.id }] } },
    });
    const res = await request(app)
      .get('/api/dashboard/micro-units-report?startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body[0].totalSubs).toBe(0);
    expect(res.body[0].totalViews).toBe(0);
  });

  it('channel-metrics: zero currentStats columns hit ?? 0 fallbacks', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ title: 't' });
    const res = await request(app).get('/api/dashboard/channel-metrics').set(headers);
    expect(res.status).toBe(200);
    expect(res.body[0].subscribers).toBe(0);
  });

  it('grade-grid: bucketOf returns null for non-grade categories (else branch fires)', async () => {
    const { headers } = await authFor('viewer');
    // 'Dedicated - Local' passes the prefix filter but has no Grade suffix
    // and no 'Inactive' suffix → bucketOf returns null and the channel is
    // skipped.
    await mkChannel({ category: 'Dedicated - Local' });
    const res = await request(app).get('/api/dashboard/grade-grid').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.row1.A).toBe(0);
    expect(res.body.row1.Inactive).toBe(0);
  });

  it('grade-grid wantRange: IHI channel missing from ihiTotalsMap → || 0 fallback', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ category: 'IHI - Grade A' });
    const res = await request(app)
      .get('/api/dashboard/grade-grid?group=ihi&startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.row3.A).toBe(0);
  });

  it('categories period-mode: channel without snapshots AND falsy category hits "Uncategorized" fallback in zero branch', async () => {
    const { headers } = await authFor('viewer');
    // Empty category + no snapshots → falls into the
    // `(!closing || !opening)` branch with the `c.category || 'Uncategorized'`
    // fallback.
    await mkChannel({ category: '' });
    const res = await request(app)
      .get('/api/dashboard/categories?startDate=2024-01-10&endDate=2024-01-20')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body[0].category).toBe('Uncategorized');
    expect(res.body[0].totalViews).toBe(0);
  });

  it('saveLayout: user without email falls back to "unknown"', async () => {
    // Mint a real user (so the JWT id resolves), then stub
    // prisma.user.findUnique to strip the email field on the next call —
    // forcing `updatedBy` to fall through to 'unknown'.
    const user = await createUser({ role: 'admin' });
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRE,
    });

    vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce({
      id: user.id,
      role: 'admin',
      name: user.name,
      // no email, no username
    });

    const res = await request(app)
      .put('/api/dashboard/layout')
      .set({ Authorization: `Bearer ${token}` })
      .send({ layouts: { lg: [] } });
    expect(res.status).toBe(200);
    expect(res.body.updatedBy).toBe('unknown');
  });
});

// ============================================================================
// getDateRange + buildChannelFilter branch coverage (via /summary)
// ============================================================================
describe('getDateRange / buildChannelFilter branches', () => {
  it('period=7d uses 7-day default window', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/dashboard/summary?period=7d').set(headers);
    expect(res.status).toBe(200);
  });

  it('period=90d uses 90-day default window', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/dashboard/summary?period=90d').set(headers);
    expect(res.status).toBe(200);
  });

  it('period=unknown falls through to default (30d)', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/dashboard/summary?period=nonsense').set(headers);
    expect(res.status).toBe(200);
  });

  it('start > end triggers fallback to period-based window', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app)
      .get('/api/dashboard/summary?startDate=2024-01-20&endDate=2024-01-10')
      .set(headers);
    expect(res.status).toBe(200);
  });

  it('buildChannelFilter: tags + status + category filters', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({
      tags: ['x', 'y'],
      status: 'paused',
      category: 'News',
    });
    const res = await request(app)
      .get('/api/dashboard/summary?tags=x,y&status=paused&category=News')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.totalChannels).toBe(1);
  });

  it('buildChannelFilter: tags="" (empty after trim) → no tag filter', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ category: 'News' });
    const res = await request(app).get('/api/dashboard/summary?tags=   ').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.totalChannels).toBe(1);
  });

  it('buildChannelFilter: tags="," (no real tags) → tagList empty, no filter applied', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ category: 'News' });
    const res = await request(app).get('/api/dashboard/summary?tags=,').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.totalChannels).toBe(1);
  });

  it('buildChannelFilter: group=dedicated matches "Dedicated - X" category', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ category: 'Dedicated - Local' });
    await mkChannel({ category: 'News' });
    const res = await request(app).get('/api/dashboard/summary?group=dedicated').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.totalChannels).toBe(1);
  });

  it('buildChannelFilter: only startDate (no endDate) — lastSyncedAt has only gte', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ category: 'News', lastSyncedAt: D('15') });
    const res = await request(app).get('/api/dashboard/summary?startDate=2024-01-10').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.totalChannels).toBe(1);
  });

  it('buildChannelFilter: only endDate (no startDate) — lastSyncedAt has only lte', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ category: 'News', lastSyncedAt: D('15') });
    const res = await request(app).get('/api/dashboard/summary?endDate=2024-01-20').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.totalChannels).toBe(1);
  });
});
