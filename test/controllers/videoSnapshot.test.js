import request from 'supertest';
import { describe, it, expect } from 'vitest';
import app from '../../src/app.js';
import { prisma } from '../setup.js';
import { authFor } from '../helpers.js';

const D = (s) => new Date(`2024-01-${s}T00:00:00.000Z`);

let n = 0;
async function mkChannel(over = {}) {
  return prisma.channel.create({
    data: {
      youtubeChannelId: `yt-ch-vs-${(n += 1)}`,
      title: `Channel ${n}`,
      ...over,
    },
  });
}
async function mkVideo(over = {}) {
  return prisma.video.create({
    data: {
      youtubeVideoId: `yt-${(n += 1)}`,
      channelId: over.channelId,
      ...over,
    },
  });
}
async function mkSnap(o) {
  return prisma.videoSnapshot.create({
    data: { views: 0, likes: 0, comments: 0, ...o },
  });
}

describe('GET /api/video-snapshots/video/:videoId', () => {
  it('returns in-range, non-deleted snapshots sorted by date', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel();
    const v = await mkVideo({ channelId: ch.id });
    await mkSnap({ videoId: v.id, channelId: ch.id, date: D('18'), views: 200 });
    await mkSnap({ videoId: v.id, channelId: ch.id, date: D('12'), views: 100 });
    await mkSnap({ videoId: v.id, channelId: ch.id, date: D('15'), views: 150, deletedAt: new Date() });
    await mkSnap({ videoId: v.id, channelId: ch.id, date: D('25'), views: 999 }); // out of range

    const res = await request(app)
      .get(`/api/video-snapshots/video/${v.id}?startDate=2024-01-10&endDate=2024-01-20`)
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.map((s) => s.views)).toEqual([100, 200]); // sorted asc, deleted + out-of-range excluded
  });

  it('defaults to the last 90 days when no date query is given', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel();
    const v = await mkVideo({ channelId: ch.id });
    await mkSnap({ videoId: v.id, channelId: ch.id, date: new Date(), views: 42 });

    const res = await request(app).get(`/api/video-snapshots/video/${v.id}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].views).toBe(42);
  });

  it('returns an empty array when no snapshots match the videoId', async () => {
    // In Postgres an arbitrary string id is just a varchar lookup — it does
    // not throw a CastError the way Mongoose ObjectId.cast did. The faithful
    // Prisma behaviour is therefore "200 OK with no rows" rather than a 400.
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/video-snapshots/video/no-such-id').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('GET /api/video-snapshots/channel/:channelId', () => {
  it('aggregates a carry-forward daily trend and a ranked top-videos breakdown', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel();
    const v1 = await mkVideo({ channelId: ch.id, title: 'Alpha' });
    const v2 = await mkVideo({ channelId: ch.id, title: 'Beta' });
    await mkSnap({ videoId: v1.id, channelId: ch.id, date: D('12'), views: 100, likes: 10, comments: 1 });
    await mkSnap({ videoId: v1.id, channelId: ch.id, date: D('13'), views: 120, likes: 12, comments: 2 });
    await mkSnap({ videoId: v2.id, channelId: ch.id, date: D('12'), views: 50, likes: 5, comments: 0 });

    const res = await request(app)
      .get(`/api/video-snapshots/channel/${ch.id}?startDate=2024-01-10&endDate=2024-01-20`)
      .set(headers);

    expect(res.status).toBe(200);

    // daily trend: each day = total cumulative stats across the channel's
    // videos as of that day. On Jan 13 v2 has no snapshot, so it carries
    // forward at 50 → views 120+50=170, likes 12+5=17, both videos counted.
    expect(res.body.dailyTrend).toEqual([
      { date: '2024-01-12', views: 150, likes: 15, comments: 1, videoCount: 2 },
      { date: '2024-01-13', views: 170, likes: 17, comments: 2, videoCount: 2 },
    ]);

    // top videos: ranked by view count (closing balance), enriched with metadata.
    expect(res.body.topVideos).toHaveLength(2);
    const [top] = res.body.topVideos;
    expect(top.totalViews).toBe(120); // closing view count (latest <= end), not a sum across days
    expect(top.viewsGrowth).toBe(20); // 120 - 100 (opening = first in-range)
    expect(top.video.title).toBe('Alpha');
    expect(top.dataPoints.map((d) => d.date)).toEqual(['2024-01-12', '2024-01-13']);
    expect(res.body.topVideos[1].video.title).toBe('Beta');
  });

  // --- only-on-change invariance --------------------------------------------
  // dailyTrend and the top-videos numbers must be carry-forward so they are
  // invariant to whether unchanged days are materialized (the only-on-change
  // sync guard skips writing a row when views don't move). A "dense" trajectory
  // (a row every day, incl. unchanged days) and the equivalent "sparse"
  // trajectory (rows only where the value changed) must produce the SAME
  // dailyTrend and the SAME per-video totals/growth/ranking. (dataPoints — the
  // decorative sparkline — legitimately differ in point count and are not
  // asserted here.)
  const expectedDailyTrend = [
    { date: '2024-01-12', views: 150, likes: 15, comments: 1, videoCount: 2 },
    { date: '2024-01-13', views: 160, likes: 16, comments: 1, videoCount: 2 },
    { date: '2024-01-14', views: 190, likes: 19, comments: 1, videoCount: 2 },
  ];
  const assertCarryForward = (body) => {
    expect(body.dailyTrend).toEqual(expectedDailyTrend);
    expect(body.topVideos).toHaveLength(2);
    const [a, b] = body.topVideos;
    expect(a.video.title).toBe('Alpha');
    expect(a.totalViews).toBe(130); // closing view count, not sum-over-days
    expect(a.totalLikes).toBe(13);
    expect(a.totalComments).toBe(1);
    expect(a.viewsGrowth).toBe(30); // 130 - 100 (opening)
    expect(b.video.title).toBe('Beta');
    expect(b.totalViews).toBe(60);
    expect(b.viewsGrowth).toBe(10); // 60 - 50
  };

  it('carry-forward trends: DENSE daily snapshots (incl. unchanged days)', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel();
    const vA = await mkVideo({ channelId: ch.id, title: 'Alpha' });
    const vB = await mkVideo({ channelId: ch.id, title: 'Beta' });
    // Alpha: 100 (Jan12) → 100 unchanged (Jan13) → 130 (Jan14)
    await mkSnap({ videoId: vA.id, channelId: ch.id, date: D('12'), views: 100, likes: 10, comments: 1 });
    await mkSnap({ videoId: vA.id, channelId: ch.id, date: D('13'), views: 100, likes: 10, comments: 1 });
    await mkSnap({ videoId: vA.id, channelId: ch.id, date: D('14'), views: 130, likes: 13, comments: 1 });
    // Beta: 50 (Jan12) → 60 (Jan13) → 60 unchanged (Jan14)
    await mkSnap({ videoId: vB.id, channelId: ch.id, date: D('12'), views: 50, likes: 5, comments: 0 });
    await mkSnap({ videoId: vB.id, channelId: ch.id, date: D('13'), views: 60, likes: 6, comments: 0 });
    await mkSnap({ videoId: vB.id, channelId: ch.id, date: D('14'), views: 60, likes: 6, comments: 0 });

    const res = await request(app)
      .get(`/api/video-snapshots/channel/${ch.id}?startDate=2024-01-10&endDate=2024-01-20`)
      .set(headers);
    expect(res.status).toBe(200);
    assertCarryForward(res.body);
  });

  it('carry-forward trends: SPARSE only-on-change snapshots match the dense result', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel();
    const vA = await mkVideo({ channelId: ch.id, title: 'Alpha' });
    const vB = await mkVideo({ channelId: ch.id, title: 'Beta' });
    // Same trajectories, but unchanged days are NOT materialized.
    await mkSnap({ videoId: vA.id, channelId: ch.id, date: D('12'), views: 100, likes: 10, comments: 1 });
    await mkSnap({ videoId: vA.id, channelId: ch.id, date: D('14'), views: 130, likes: 13, comments: 1 });
    await mkSnap({ videoId: vB.id, channelId: ch.id, date: D('12'), views: 50, likes: 5, comments: 0 });
    await mkSnap({ videoId: vB.id, channelId: ch.id, date: D('13'), views: 60, likes: 6, comments: 0 });

    const res = await request(app)
      .get(`/api/video-snapshots/channel/${ch.id}?startDate=2024-01-10&endDate=2024-01-20`)
      .set(headers);
    expect(res.status).toBe(200);
    assertCarryForward(res.body);
  });

  it('sets video to null when the underlying video is missing/deleted', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel();
    const v = await mkVideo({ channelId: ch.id, deletedAt: new Date() }); // soft-deleted video
    await mkSnap({ videoId: v.id, channelId: ch.id, date: D('12'), views: 70 });

    const res = await request(app)
      .get(`/api/video-snapshots/channel/${ch.id}?startDate=2024-01-10&endDate=2024-01-20`)
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.topVideos[0].video).toBeNull();
  });

  it('defaults to the last 30 days when no date query is given', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel();
    const v = await mkVideo({ channelId: ch.id });
    await mkSnap({ videoId: v.id, channelId: ch.id, date: new Date(), views: 5 });

    const res = await request(app).get(`/api/video-snapshots/channel/${ch.id}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.dailyTrend.length).toBeGreaterThan(0);
  });

  it('returns empty aggregations when no snapshots match the channelId', async () => {
    // Mongoose threw on ObjectId cast for invalid ids → 500. Postgres just
    // matches no rows for an unknown channel_id varchar, which is the
    // faithful Prisma behaviour: 200 OK with empty result sets.
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/video-snapshots/channel/no-such-channel').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.dailyTrend).toEqual([]);
    expect(res.body.topVideos).toEqual([]);
  });
});
