import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import app from '../../src/app.js';
import { prisma } from '../setup.js';
import { authFor } from '../helpers.js';

/* ──────────────────────────────────────────────────────────────────
   Helpers / factories — deterministic seed data.
─────────────────────────────────────────────────────────────────── */

const D = (s) => new Date(`2024-01-${s}T00:00:00.000Z`);

let chSeq = 0;
async function mkChannel(over = {}) {
  chSeq += 1;
  const {
    currentSubscribers = 0,
    currentViews = 0,
    currentVideoCount = 0,
    ...rest
  } = over;
  return prisma.channel.create({
    data: {
      youtubeChannelId: rest.youtubeChannelId ?? `yt-ch-${chSeq}`,
      title:            rest.title ?? `Channel ${chSeq}`,
      customUrl:        rest.customUrl ?? '',
      country:          rest.country ?? '',
      category:         rest.category ?? 'Uncategorized',
      status:           rest.status ?? 'active',
      tags:             rest.tags ?? [],
      notes:            rest.notes ?? '',
      currentSubscribers,
      currentViews:     BigInt(currentViews),
      currentVideoCount,
      lastSyncedAt:     rest.lastSyncedAt,
      assignedToId:     rest.assignedToId,
    },
  });
}

let vSeq = 0;
async function mkVideo(over = {}) {
  vSeq += 1;
  return prisma.video.create({
    data: {
      youtubeVideoId: over.youtubeVideoId ?? `yt-v-${vSeq}`,
      channelId:      over.channelId,
      title:          over.title ?? `Video ${vSeq}`,
      description:    over.description ?? '',
      publishedAt:    over.publishedAt,
      views:          BigInt(over.views ?? 0),
      likes:          over.likes ?? 0,
      comments:       over.comments ?? 0,
      duration:       over.duration ?? '',
      lastSyncedAt:   over.lastSyncedAt,
      classification: over.classification ?? '',
      deletedAt:      over.deletedAt ?? null,
    },
  });
}

const mkChSnap = (over) =>
  prisma.channelSnapshot.create({
    data: {
      channelId:   over.channelId,
      date:        over.date,
      subscribers: over.subscribers ?? 0,
      views:       BigInt(over.views ?? 0),
      videoCount:  over.videoCount ?? 0,
      deletedAt:   over.deletedAt ?? null,
    },
  });

const mkVSnap = (over) =>
  prisma.videoSnapshot.create({
    data: {
      videoId:   over.videoId,
      channelId: over.channelId,
      date:      over.date,
      views:     BigInt(over.views ?? 0),
      likes:     over.likes ?? 0,
      comments:  over.comments ?? 0,
      deletedAt: over.deletedAt ?? null,
    },
  });

afterEach(() => {
  vi.restoreAllMocks();
});

/* ──────────────────────────────────────────────────────────────────
   GET /api/export/report/channels — JSON / CSV / Excel
─────────────────────────────────────────────────────────────────── */

describe('GET /api/export/report/channels — non-period (filters & JSON)', () => {
  it('401 without an Authorization header', async () => {
    const res = await request(app).get('/api/export/report/channels');
    expect(res.status).toBe(401);
  });

  it('returns paginated channels + summary aggregate (default JSON)', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({
      title: 'Alpha',
      currentSubscribers: 1000, currentViews: 4000, currentVideoCount: 2,
    });
    await mkChannel({
      title: 'Beta',
      currentSubscribers: 200, currentViews: 100, currentVideoCount: 0,
    });

    const res = await request(app).get('/api/export/report/channels').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    // Default sort = -currentStats.subscribers
    expect(res.body.data[0].title).toBe('Alpha');
    expect(res.body.data[0].subscribers).toBe(1000);
    expect(res.body.data[0].avg_views_per_video).toBe(2000); // 4000 / 2
    expect(res.body.data[1].avg_views_per_video).toBe(0); // 0 videos
    expect(res.body.summary).toMatchObject({
      totalChannels: 2,
      totalSubscribers: 1200,
      totalViews: 4100,
      totalVideos: 2,
    });
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 50, total: 2, pages: 1 });
  });

  it('returns zero-summary when no channels match', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/export/report/channels').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.summary).toEqual({
      totalChannels: 0,
      totalSubscribers: 0,
      totalViews: 0,
      totalVideos: 0,
    });
  });

  it('applies every channel filter branch (search/category/status/country/tags/minSubs/maxSubs/minViews/maxViews)', async () => {
    const { headers } = await authFor('viewer');
    // target — passes every filter
    await mkChannel({
      title: 'Target Alpha',
      youtubeChannelId: 'UCtarget',
      customUrl: '@target',
      country: 'India',
      category: 'Spirituality',
      status: 'active',
      tags: ['guru', 'wisdom'],
      currentSubscribers: 5000, currentViews: 20000, currentVideoCount: 10,
    });
    // mismatched everything
    await mkChannel({
      title: 'Other',
      youtubeChannelId: 'UCother',
      country: 'USA',
      category: 'News',
      status: 'archived',
      tags: ['news'],
      currentSubscribers: 100, currentViews: 100, currentVideoCount: 1,
    });

    const res = await request(app)
      .get('/api/export/report/channels')
      .query({
        search: 'Target',
        category: 'Spirituality',
        status: 'active',
        country: 'india',
        tags: 'guru, wisdom',
        minSubs: '100',
        maxSubs: '10000',
        minViews: '100',
        maxViews: '50000',
      })
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].title).toBe('Target Alpha');
    expect(res.body.data[0].tags).toBe('guru; wisdom');
  });

  it('skips the tags filter when the value is empty / whitespace / has no real entries', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ title: 'A', tags: ['x'] });

    // tags trimmed to empty → no filter applied
    const res1 = await request(app).get('/api/export/report/channels').query({ tags: '  ' }).set(headers);
    expect(res1.body.data).toHaveLength(1);

    // tags = ',,' → tagList empty after filter(Boolean) → no `hasSome`
    const res2 = await request(app).get('/api/export/report/channels').query({ tags: ',,' }).set(headers);
    expect(res2.body.data).toHaveLength(1);
  });

  it('honours only minSubs / minViews (no max)', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ title: 'Low', currentSubscribers: 10, currentViews: 10, currentVideoCount: 0 });
    await mkChannel({ title: 'High', currentSubscribers: 1000, currentViews: 1000, currentVideoCount: 0 });

    const res = await request(app)
      .get('/api/export/report/channels')
      .query({ minSubs: '500', minViews: '500' })
      .set(headers);
    expect(res.body.data.map((c) => c.title)).toEqual(['High']);
  });

  it('honours only maxSubs / maxViews (no min)', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ title: 'Low', currentSubscribers: 10, currentViews: 10, currentVideoCount: 0 });
    await mkChannel({ title: 'High', currentSubscribers: 1000, currentViews: 1000, currentVideoCount: 0 });

    const res = await request(app)
      .get('/api/export/report/channels')
      .query({ maxSubs: '100', maxViews: '100' })
      .set(headers);
    expect(res.body.data.map((c) => c.title)).toEqual(['Low']);
  });

  it('filters by lastSyncedAt when only startDate is provided', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ title: 'Old', lastSyncedAt: D('05') });
    await mkChannel({ title: 'New', lastSyncedAt: D('15') });

    const res = await request(app)
      .get('/api/export/report/channels')
      .query({ startDate: '2024-01-10' })
      .set(headers);
    expect(res.body.data.map((c) => c.title)).toEqual(['New']);
  });

  it('filters by lastSyncedAt when only endDate is provided', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ title: 'Old', lastSyncedAt: D('05') });
    await mkChannel({ title: 'New', lastSyncedAt: D('15') });

    const res = await request(app)
      .get('/api/export/report/channels')
      .query({ endDate: '2024-01-10' })
      .set(headers);
    expect(res.body.data.map((c) => c.title)).toEqual(['Old']);
  });

  it('filters by classification=sadhguru using distinct video channelIds', async () => {
    const { headers } = await authFor('viewer');
    const a = await mkChannel({ title: 'A' });
    const b = await mkChannel({ title: 'B' });
    await mkVideo({ channelId: a.id, classification: 'sadhguru' });
    await mkVideo({ channelId: b.id, classification: 'non sadhguru' });

    const res = await request(app)
      .get('/api/export/report/channels')
      .query({ classification: 'sadhguru' })
      .set(headers);
    expect(res.body.data.map((c) => c.title)).toEqual(['A']);
  });

  it('filters by classification=non_sadhguru as well', async () => {
    const { headers } = await authFor('viewer');
    const a = await mkChannel({ title: 'A' });
    const b = await mkChannel({ title: 'B' });
    await mkVideo({ channelId: a.id, classification: 'sadhguru' });
    await mkVideo({ channelId: b.id, classification: 'non sadhguru' });

    const res = await request(app)
      .get('/api/export/report/channels')
      .query({ classification: 'non_sadhguru' })
      .set(headers);
    expect(res.body.data.map((c) => c.title)).toEqual(['B']);
  });

  it('exports CSV (legacy /channels endpoint) with the expected header line', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ title: 'Legacy', currentSubscribers: 1, currentViews: 1, currentVideoCount: 1 });

    const res = await request(app)
      .get('/api/export/channels')
      .buffer(true)
      .parse((r, cb) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (c) => { body += c; });
        r.on('end', () => cb(null, body));
      })
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/channel-report-/);
    const csv = res.body;
    expect(csv.split('\n')[0]).toContain('"title"');
    expect(csv).toContain('Legacy');
  });

  it('exports CSV via /report/channels?format=csv', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ title: 'CSV Direct' });
    const res = await request(app)
      .get('/api/export/report/channels?format=csv')
      .buffer(true)
      .parse((r, cb) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (c) => { body += c; });
        r.on('end', () => cb(null, body));
      })
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.body).toContain('CSV Direct');
  });

  it('exports Excel (xlsx) with the expected workbook shape (non-period)', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ title: 'Excel A', currentSubscribers: 2, currentViews: 2, currentVideoCount: 1 });

    const res = await request(app)
      .get('/api/export/report/channels?format=excel')
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml\.sheet/);
    expect(res.body.length).toBeGreaterThan(0);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.getWorksheet('Channels');
    expect(ws).toBeDefined();
    expect(ws.getCell('A1').value).toBe('Title');
    // header row should NOT include period columns in non-period mode
    const headersList = ws.getRow(1).values.filter(Boolean);
    expect(headersList).not.toContain('Views (Period)');
    // row 2 first cell
    expect(ws.getCell('A2').value).toBe('Excel A');
  });

  it('returns 400 for an unrecognised format', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ title: 'X' });
    const res = await request(app)
      .get('/api/export/report/channels?format=pdf')
      .set(headers);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid format/);
  });

  it('paginates correctly (page 2 + limit 1)', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ title: 'A', currentSubscribers: 10, currentViews: 0, currentVideoCount: 0 });
    await mkChannel({ title: 'B', currentSubscribers: 20, currentViews: 0, currentVideoCount: 0 });

    const res = await request(app)
      .get('/api/export/report/channels?page=2&limit=1')
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].title).toBe('A'); // page 2 of -subs
    expect(res.body.pagination).toMatchObject({ page: 2, limit: 1, total: 2, pages: 2 });
  });

  it('500 when channel.aggregate throws (catch path)', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ title: 'Boom' });
    vi.spyOn(prisma.channel, 'aggregate').mockImplementation(() => {
      throw new Error('agg-boom');
    });
    const res = await request(app).get('/api/export/report/channels').set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('agg-boom');
  });
});

describe('GET /api/export/report/channels — period mode', () => {
  it('computes views_in_period / subscribers_in_period / videos_in_period + period summary', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({
      title: 'Period',
      currentSubscribers: 500, currentViews: 9000, currentVideoCount: 5,
    });
    const otherCh = await mkChannel({
      title: 'NoSnaps',
      currentSubscribers: 50, currentViews: 50, currentVideoCount: 0,
    });

    // Channel snapshots: opening at D12, closing at D18 → subs +50
    await mkChSnap({ channelId: ch.id, date: D('12'), subscribers: 450, views: 8000, videoCount: 4 });
    await mkChSnap({ channelId: ch.id, date: D('18'), subscribers: 500, views: 9000, videoCount: 5 });

    // Two videos in period; one new, one preexisting.
    const oldV = await mkVideo({ channelId: ch.id, classification: 'sadhguru', publishedAt: D('01') });
    await mkVSnap({ videoId: oldV.id, channelId: ch.id, date: D('05'), views: 100 });
    await mkVSnap({ videoId: oldV.id, channelId: ch.id, date: D('18'), views: 200 }); // +100

    const newV = await mkVideo({ channelId: ch.id, classification: 'sadhguru', publishedAt: D('13') });
    await mkVSnap({ videoId: newV.id, channelId: ch.id, date: D('14'), views: 5 });  // within grace → freshly tracked
    await mkVSnap({ videoId: newV.id, channelId: ch.id, date: D('19'), views: 30 }); // +30 (opening = 0)

    const res = await request(app)
      .get('/api/export/report/channels')
      .query({ startDate: '2024-01-10', endDate: '2024-01-20' })
      .set(headers);

    expect(res.status).toBe(200);
    const periodRow = res.body.data.find((r) => r.title === 'Period');
    const noSnaps = res.body.data.find((r) => r.title === 'NoSnaps');

    expect(periodRow).toMatchObject({
      views_in_period: 130, // 100 (oldV delta) + 30 (newV delta)
      subscribers_in_period: 50, // 500 - 450
      videos_in_period: 1, // only newV published inside the window
      sadhguru_count: 1, // classification counts also filter by publishedAt in-window
    });
    // No snapshots → zeroes
    expect(noSnaps).toMatchObject({
      views_in_period: 0,
      subscribers_in_period: 0,
      videos_in_period: 0,
    });

    expect(res.body.summary).toMatchObject({
      totalChannels: 2,
      totalViewsInPeriod: 130,
      totalSubscribersInPeriod: 50,
      totalVideosInPeriod: 1,
    });
    expect(res.body.pagination.total).toBe(2);
    expect(otherCh.title).toBe('NoSnaps');
  });

  it('sorts by period-aware key (views_in_period asc) and slices for pagination', async () => {
    const { headers } = await authFor('viewer');
    const a = await mkChannel({ title: 'A' });
    const b = await mkChannel({ title: 'B' });
    // a: +200 views, b: +50
    await mkChSnap({ channelId: a.id, date: D('12'), views: 0, subscribers: 0 });
    await mkChSnap({ channelId: a.id, date: D('18'), views: 200, subscribers: 0 });
    const va = await mkVideo({ channelId: a.id, publishedAt: D('01') });
    await mkVSnap({ videoId: va.id, channelId: a.id, date: D('05'), views: 0 });
    await mkVSnap({ videoId: va.id, channelId: a.id, date: D('18'), views: 200 });

    await mkChSnap({ channelId: b.id, date: D('12'), views: 0, subscribers: 0 });
    await mkChSnap({ channelId: b.id, date: D('18'), views: 50, subscribers: 0 });
    const vb = await mkVideo({ channelId: b.id, publishedAt: D('01') });
    await mkVSnap({ videoId: vb.id, channelId: b.id, date: D('05'), views: 0 });
    await mkVSnap({ videoId: vb.id, channelId: b.id, date: D('18'), views: 50 });

    const res = await request(app)
      .get('/api/export/report/channels')
      .query({
        startDate: '2024-01-10',
        endDate: '2024-01-20',
        sort: 'views_in_period', // ASCENDING (no leading '-')
        page: '1',
        limit: '10',
      })
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.data.map((c) => c.title)).toEqual(['B', 'A']);
  });

  it('remaps currentStats.views / currentStats.videoCount sort keys in period mode', async () => {
    const { headers } = await authFor('viewer');
    await mkChannel({ title: 'Lo', currentSubscribers: 0, currentViews: 10, currentVideoCount: 1 });
    await mkChannel({ title: 'Hi', currentSubscribers: 0, currentViews: 999, currentVideoCount: 9 });

    const res = await request(app)
      .get('/api/export/report/channels')
      .query({
        startDate: '2024-01-10',
        endDate: '2024-01-20',
        sort: '-currentStats.views',
      })
      .set(headers);
    expect(res.body.data.map((c) => c.title)).toEqual(['Hi', 'Lo']);

    const res2 = await request(app)
      .get('/api/export/report/channels')
      .query({
        startDate: '2024-01-10',
        endDate: '2024-01-20',
        sort: '-currentStats.videoCount',
      })
      .set(headers);
    expect(res2.body.data.map((c) => c.title)).toEqual(['Hi', 'Lo']);
  });

  it('passes classification=sadhguru through to period-views calculation', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'Mixed' });
    const sad = await mkVideo({ channelId: ch.id, classification: 'sadhguru', publishedAt: D('01') });
    await mkVSnap({ videoId: sad.id, channelId: ch.id, date: D('05'), views: 0 });
    await mkVSnap({ videoId: sad.id, channelId: ch.id, date: D('18'), views: 40 });
    const non = await mkVideo({ channelId: ch.id, classification: 'non sadhguru', publishedAt: D('01') });
    await mkVSnap({ videoId: non.id, channelId: ch.id, date: D('05'), views: 0 });
    await mkVSnap({ videoId: non.id, channelId: ch.id, date: D('18'), views: 1000 });
    await mkChSnap({ channelId: ch.id, date: D('12'), subscribers: 0 });
    await mkChSnap({ channelId: ch.id, date: D('18'), subscribers: 0 });

    const res = await request(app)
      .get('/api/export/report/channels')
      .query({
        startDate: '2024-01-10',
        endDate: '2024-01-20',
        classification: 'sadhguru',
      })
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].views_in_period).toBe(40);
  });

  it('passes classification=non_sadhguru through to period-views calculation', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'Mixed2' });
    const sad = await mkVideo({ channelId: ch.id, classification: 'sadhguru', publishedAt: D('01') });
    await mkVSnap({ videoId: sad.id, channelId: ch.id, date: D('05'), views: 0 });
    await mkVSnap({ videoId: sad.id, channelId: ch.id, date: D('18'), views: 9 });
    const non = await mkVideo({ channelId: ch.id, classification: 'non sadhguru', publishedAt: D('01') });
    await mkVSnap({ videoId: non.id, channelId: ch.id, date: D('05'), views: 0 });
    await mkVSnap({ videoId: non.id, channelId: ch.id, date: D('18'), views: 77 });
    await mkChSnap({ channelId: ch.id, date: D('12'), subscribers: 0 });
    await mkChSnap({ channelId: ch.id, date: D('18'), subscribers: 0 });

    const res = await request(app)
      .get('/api/export/report/channels')
      .query({
        startDate: '2024-01-10',
        endDate: '2024-01-20',
        classification: 'non_sadhguru',
      })
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].views_in_period).toBe(77);
  });

  it('emits the Period columns in Excel + parses with exceljs', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'XP', currentSubscribers: 0, currentViews: 0, currentVideoCount: 0 });
    await mkChSnap({ channelId: ch.id, date: D('12'), subscribers: 0 });
    await mkChSnap({ channelId: ch.id, date: D('18'), subscribers: 10 });

    const res = await request(app)
      .get('/api/export/report/channels')
      .query({ startDate: '2024-01-10', endDate: '2024-01-20', format: 'excel' })
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml\.sheet/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.getWorksheet('Channels');
    const headerVals = ws.getRow(1).values.filter(Boolean);
    expect(headerVals).toContain('Views (Period)');
    expect(headerVals).toContain('Subscribers (Period)');
    expect(headerVals).toContain('Videos (Period)');
  });
});

/* ──────────────────────────────────────────────────────────────────
   GET /api/export/report/videos — JSON / CSV / Excel
─────────────────────────────────────────────────────────────────── */

describe('GET /api/export/report/videos', () => {
  it('401 without an Authorization header', async () => {
    const res = await request(app).get('/api/export/report/videos');
    expect(res.status).toBe(401);
  });

  it('returns videos (JSON) with engagement_rate, outlier_score, classification mapping, channel join, summary', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'Joined', category: 'Talks' });
    await mkVideo({ channelId: ch.id, title: 'V1', views: 100, likes: 10, comments: 5, classification: 'sadhguru', publishedAt: D('05') });
    await mkVideo({ channelId: ch.id, title: 'V2', views: 0, likes: 0, comments: 0, classification: 'non sadhguru' });
    await mkVideo({ channelId: ch.id, title: 'V3', views: 50, likes: 5, comments: 2, classification: '' });

    const res = await request(app).get('/api/export/report/videos').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    // sorted by -views by default
    expect(res.body.data[0].title).toBe('V1');
    expect(res.body.data[0].channel).toBe('Joined');
    expect(res.body.data[0].category).toBe('Talks');
    expect(res.body.data[0].engagement_rate).toBe(15); // (10+5)/100 * 100
    // V2 has zero views → engagement_rate 0
    const v2 = res.body.data.find((v) => v.title === 'V2');
    expect(v2.engagement_rate).toBe(0);
    expect(v2.classification).toBe('-'); // non sadhguru → '-'
    const v3 = res.body.data.find((v) => v.title === 'V3');
    expect(v3.classification).toBe('—'); // empty → em dash
    expect(res.body.summary).toMatchObject({
      totalVideos: 3,
      totalViews: 150,
      totalLikes: 15,
      totalComments: 7,
    });
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 50, total: 3 });
  });

  it('returns the empty-summary fallback when no videos match', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/export/report/videos').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.summary).toEqual({ totalVideos: 0, totalViews: 0, totalLikes: 0, totalComments: 0 });
  });

  it('skips soft-deleted videos in the result set', async () => {
    // Note: in Postgres videos.channel_id has an FK to channels; we can't seed
    // an orphan with a non-existent channel id. Instead verify the soft-delete
    // filter — the report restricts to channels visible to the user (non
    // archived) which means a video on an archived/deleted channel never
    // surfaces anyway.
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'SD' });
    await mkVideo({ channelId: ch.id, title: 'Deleted', deletedAt: new Date() });

    const res = await request(app).get('/api/export/report/videos').set(headers);
    expect(res.body.data).toHaveLength(0);
  });

  it('filters by channelId and minViews/maxViews + search', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'F' });
    const other = await mkChannel({ title: 'O' });
    await mkVideo({ channelId: ch.id, title: 'Match search', views: 500 });
    await mkVideo({ channelId: ch.id, title: 'TooLow', views: 5 });
    await mkVideo({ channelId: other.id, title: 'OtherChannel', views: 500 });

    const res = await request(app)
      .get('/api/export/report/videos')
      .query({
        channelId: ch.id,
        search: 'Match',
        minViews: '100',
        maxViews: '1000',
      })
      .set(headers);
    expect(res.body.data.map((v) => v.title)).toEqual(['Match search']);
  });

  it('filters by channelId with an id that does not match any channel → empty result', async () => {
    // In Mongoose, a non-ObjectId string raised CastError → 400. In Prisma the
    // channelId column is a plain string FK, so an arbitrary id is a valid
    // filter that simply matches no rows.
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'Z' });
    await mkVideo({ channelId: ch.id, title: 'Inside' });

    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ channelId: 'not-an-objectid' })
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('applies channel-level filters (category) and only honours their resolved channelIds', async () => {
    const { headers } = await authFor('viewer');
    const news = await mkChannel({ title: 'News', category: 'News' });
    const other = await mkChannel({ title: 'Other', category: 'Music' });
    await mkVideo({ channelId: news.id, title: 'NewsVid' });
    await mkVideo({ channelId: other.id, title: 'MusicVid' });

    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ category: 'News' })
      .set(headers);
    expect(res.body.data.map((v) => v.title)).toEqual(['NewsVid']);
  });

  it('honours channel-level filters (status + tags + classification + dates + hashtags)', async () => {
    const { headers } = await authFor('viewer');
    const a = await mkChannel({ title: 'A', status: 'active', tags: ['cool'] });
    const b = await mkChannel({ title: 'B', status: 'paused', tags: ['boring'] });
    await mkVideo({
      channelId: a.id,
      title: 'Inspiring #wisdom',
      description: 'a desc',
      classification: 'sadhguru',
      publishedAt: D('12'),
      views: 100,
    });
    await mkVideo({
      channelId: b.id,
      title: 'Other',
      classification: 'sadhguru',
      publishedAt: D('12'),
      views: 50,
    });
    await mkVideo({
      channelId: a.id,
      title: 'No hashtag',
      classification: 'non sadhguru',
      publishedAt: D('12'),
      views: 200,
    });

    const res = await request(app)
      .get('/api/export/report/videos')
      .query({
        status: 'active',
        tags: 'cool, ',
        classification: 'sadhguru',
        startDate: '2024-01-10',
        endDate: '2024-01-15',
        hashtags: '#wisdom',
      })
      .set(headers);
    expect(res.body.data.map((v) => v.title)).toEqual(['Inspiring #wisdom']);
  });

  it('handles classification=non_sadhguru on the video filter directly', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'C' });
    await mkVideo({ channelId: ch.id, title: 'Sad', classification: 'sadhguru', views: 1 });
    await mkVideo({ channelId: ch.id, title: 'Non', classification: 'non sadhguru', views: 1 });

    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ classification: 'non_sadhguru' })
      .set(headers);
    expect(res.body.data.map((v) => v.title)).toEqual(['Non']);
  });

  it('hashtags + search combine via AND (both must hit)', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'H' });
    await mkVideo({ channelId: ch.id, title: 'Wisdom #guru chat', description: 'irrelevant' });
    await mkVideo({ channelId: ch.id, title: 'Wisdom no hash', description: 'no hash here' });
    await mkVideo({ channelId: ch.id, title: 'NoWord #guru', description: 'just hash' });

    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ search: 'Wisdom', hashtags: '#guru' })
      .set(headers);
    expect(res.body.data.map((v) => v.title)).toEqual(['Wisdom #guru chat']);
  });

  it('hashtags with only whitespace falls through to search-only OR conditions', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'WH' });
    await mkVideo({ channelId: ch.id, title: 'searchme' });
    await mkVideo({ channelId: ch.id, title: 'unrelated' });

    // hashtags whitespace, search present → search-only OR path
    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ search: 'searchme', hashtags: '   ' })
      .set(headers);
    expect(res.body.data.map((v) => v.title)).toEqual(['searchme']);
  });

  it('hashtags with no valid keywords (after #-strip + filter) without search → no OR applied', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'HK' });
    await mkVideo({ channelId: ch.id, title: 'anything' });

    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ hashtags: ',,' })
      .set(headers);
    // tagList empty, no search → orConditions empty → no OR applied → all videos visible
    expect(res.body.data.map((v) => v.title)).toEqual(['anything']);
  });

  it('hashtags with no keywords but a search present → falls back to search-only OR', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'HX' });
    await mkVideo({ channelId: ch.id, title: 'searched' });
    await mkVideo({ channelId: ch.id, title: 'skipped' });

    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ search: 'searched', hashtags: ',,' })
      .set(headers);
    expect(res.body.data.map((v) => v.title)).toEqual(['searched']);
  });

  it('search only (no hashtags) populates the OR conditions', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'S' });
    await mkVideo({ channelId: ch.id, title: 'find me', youtubeVideoId: 'aaa' });
    await mkVideo({ channelId: ch.id, title: 'nope', youtubeVideoId: 'bbb' });
    await mkVideo({ channelId: ch.id, title: 'matched by id', youtubeVideoId: 'findid' });

    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ search: 'find' })
      .set(headers);
    expect(res.body.data.map((v) => v.title).sort()).toEqual(['find me', 'matched by id']);
  });

  it('honours only minViews (no maxViews)', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'MV' });
    await mkVideo({ channelId: ch.id, title: 'lo', views: 10 });
    await mkVideo({ channelId: ch.id, title: 'hi', views: 1000 });

    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ minViews: '500' })
      .set(headers);
    expect(res.body.data.map((v) => v.title)).toEqual(['hi']);
  });

  it('honours only startDate (no endDate)', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'DS' });
    await mkVideo({ channelId: ch.id, title: 'after', publishedAt: D('15') });
    await mkVideo({ channelId: ch.id, title: 'before', publishedAt: D('05') });

    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ startDate: '2024-01-10' })
      .set(headers);
    expect(res.body.data.map((v) => v.title)).toEqual(['after']);
  });

  it('sorts by aggregated keys (channel ASC) via channel join', async () => {
    const { headers } = await authFor('viewer');
    const z = await mkChannel({ title: 'Zoo' });
    const a = await mkChannel({ title: 'Apple' });
    await mkVideo({ channelId: z.id, title: 'fromZ' });
    await mkVideo({ channelId: a.id, title: 'fromA' });

    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ sort: 'channel' })
      .set(headers);
    expect(res.body.data.map((v) => v.title)).toEqual(['fromA', 'fromZ']);
  });

  it('sorts by aggregated keys (category) via channel join', async () => {
    const { headers } = await authFor('viewer');
    const z = await mkChannel({ title: 'Z', category: 'Zoology' });
    const a = await mkChannel({ title: 'A', category: 'Astronomy' });
    await mkVideo({ channelId: z.id, title: 'fromZ' });
    await mkVideo({ channelId: a.id, title: 'fromA' });

    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ sort: 'category' })
      .set(headers);
    expect(res.body.data.map((v) => v.title)).toEqual(['fromA', 'fromZ']);
  });

  it('sorts by aggregated -engagement_rate with paging', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'E' });
    await mkVideo({ channelId: ch.id, title: 'high', views: 100, likes: 50, comments: 50 }); // 100%
    await mkVideo({ channelId: ch.id, title: 'low', views: 100, likes: 1, comments: 1 }); // 2%

    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ sort: '-engagement_rate', page: '1', limit: '10' })
      .set(headers);
    expect(res.body.data.map((v) => v.title)).toEqual(['high', 'low']);
  });

  it('sorts by aggregated -outlier_score and computes globalAvg', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'O' });
    await mkVideo({ channelId: ch.id, title: 'big', views: 1000 });
    await mkVideo({ channelId: ch.id, title: 'small', views: 1 });

    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ sort: '-outlier_score' })
      .set(headers);
    expect(res.body.data.map((v) => v.title)).toEqual(['big', 'small']);
  });

  it('outlier_score sort falls back to globalAvg=1 when there are no matching videos', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ sort: '-outlier_score' })
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('unknown sort key falls back to views (ASC since no leading "-")', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'X' });
    await mkVideo({ channelId: ch.id, title: 'hi', views: 1000 });
    await mkVideo({ channelId: ch.id, title: 'lo', views: 10 });

    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ sort: 'gibberish' })
      .set(headers);
    // mapVideoOrderByForFind('gibberish') falls back to ascending views
    expect(res.body.data.map((v) => v.title)).toEqual(['lo', 'hi']);
  });

  it('sorts by aliased keys (published_at ASC, last_synced, youtube_video_id)', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'PS' });
    await mkVideo({ channelId: ch.id, title: 'older', publishedAt: D('05'), lastSyncedAt: D('05'), youtubeVideoId: 'ya' });
    await mkVideo({ channelId: ch.id, title: 'newer', publishedAt: D('15'), lastSyncedAt: D('15'), youtubeVideoId: 'yb' });

    const r1 = await request(app).get('/api/export/report/videos').query({ sort: 'published_at' }).set(headers);
    expect(r1.body.data.map((v) => v.title)).toEqual(['older', 'newer']);

    const r2 = await request(app).get('/api/export/report/videos').query({ sort: '-last_synced' }).set(headers);
    expect(r2.body.data.map((v) => v.title)).toEqual(['newer', 'older']);

    const r3 = await request(app).get('/api/export/report/videos').query({ sort: 'youtube_video_id' }).set(headers);
    expect(r3.body.data.map((v) => v.title)).toEqual(['older', 'newer']);
  });

  it('exports CSV with the expected header row', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'CSV' });
    await mkVideo({ channelId: ch.id, title: 'csvrow', views: 5 });

    const res = await request(app)
      .get('/api/export/report/videos?format=csv')
      .buffer(true)
      .parse((r, cb) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (c) => { body += c; });
        r.on('end', () => cb(null, body));
      })
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/video-report-/);
    expect(res.body.split('\n')[0]).toContain('"title"');
    expect(res.body).toContain('csvrow');
  });

  it('exports Excel (xlsx) parseable by exceljs', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'XL', category: 'Cat' });
    await mkVideo({ channelId: ch.id, title: 'xlrow', views: 7, likes: 1, comments: 1 });

    const res = await request(app)
      .get('/api/export/report/videos?format=excel')
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml\.sheet/);
    expect(res.body.length).toBeGreaterThan(0);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.getWorksheet('Videos');
    expect(ws).toBeDefined();
    expect(ws.getCell('A1').value).toBe('Title');
    expect(ws.getCell('A2').value).toBe('xlrow');
  });

  it('exports CSV with aggregate-sort branch (channelMap from join pre-fills join)', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'AggCh', category: 'AggCat' });
    await mkVideo({ channelId: ch.id, title: 'agg-csv', views: 5 });

    const res = await request(app)
      .get('/api/export/report/videos?format=csv&sort=channel')
      .buffer(true)
      .parse((r, cb) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (c) => { body += c; });
        r.on('end', () => cb(null, body));
      })
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toContain('AggCh');
    expect(res.body).toContain('AggCat');
  });

  it('returns 400 for an unrecognised format', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'IF' });
    await mkVideo({ channelId: ch.id, title: 'irrelevant' });
    const res = await request(app)
      .get('/api/export/report/videos?format=pdf')
      .set(headers);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid format/);
  });

  it('500 when video.count throws (catch path)', async () => {
    const { headers } = await authFor('viewer');
    vi.spyOn(prisma.video, 'count').mockImplementation(() => {
      throw new Error('count-boom');
    });
    const res = await request(app).get('/api/export/report/videos').set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('count-boom');
  });
});

/* ──────────────────────────────────────────────────────────────────
   Default-fallback / edge branches
─────────────────────────────────────────────────────────────────── */

describe('mapChannel default-fallback branches', () => {
  it('handles a channel with zero stats / empty category / empty status in period mode', async () => {
    const { headers } = await authFor('viewer');
    // Prisma columns are NOT NULL with defaults — currentSubscribers/views/
    // videoCount default to 0, category defaults to "Uncategorized" but we
    // override here to test the "category empty string" branch.
    await prisma.channel.create({
      data: {
        youtubeChannelId: 'yt-raw-1',
        title: 'Raw',
        category: '',
        tags: [],
        // status defaults to 'active'; the row is non-archived so it surfaces.
      },
    });

    const res = await request(app)
      .get('/api/export/report/channels')
      .query({ startDate: '2024-01-10', endDate: '2024-01-20' })
      .set(headers);
    expect(res.status).toBe(200);
    const row = res.body.data.find((r) => r.title === 'Raw');
    expect(row).toBeDefined();
    expect(row.subscribers).toBe(0);
    expect(row.total_views).toBe(0);
    expect(row.video_count).toBe(0);
    expect(row.avg_views_per_video).toBe(0);
    expect(row.category).toBe('');
    // createdAt is auto-populated by Prisma so this is the only place that
    // diverges from the legacy raw-insert test.
    expect(typeof row.added_on).toBe('string');
  });

  it("aggregates classification counts with classification === '' (empty string fallback)", async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'Empty cls', currentSubscribers: 1, currentViews: 0, currentVideoCount: 0 });
    // Default classification is '' on the model.
    await mkVideo({ channelId: ch.id, classification: '' });

    const res = await request(app).get('/api/export/report/channels').set(headers);
    expect(res.status).toBe(200);
    const row = res.body.data.find((r) => r.title === 'Empty cls');
    expect(row).toBeDefined();
    expect(row.sadhguru_count).toBe(0); // classification was '', so sadhguru_count stays 0
  });
});

describe('buildVideoFilter — remaining else / boundary branches', () => {
  it('treats classification with an unrecognised value as a no-op', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'CX' });
    await mkVideo({ channelId: ch.id, title: 'a', classification: 'sadhguru' });
    await mkVideo({ channelId: ch.id, title: 'b', classification: 'non sadhguru' });

    // classification value isn't 'sadhguru' nor 'non_sadhguru' → both inner ifs miss
    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ classification: 'something_else' })
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data.map((v) => v.title).sort()).toEqual(['a', 'b']);
  });

  it('honours only maxViews (no minViews) on the video filter', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'MX' });
    await mkVideo({ channelId: ch.id, title: 'lo', views: 10 });
    await mkVideo({ channelId: ch.id, title: 'hi', views: 1000 });
    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ maxViews: '500' })
      .set(headers);
    expect(res.body.data.map((v) => v.title)).toEqual(['lo']);
  });

  it('honours only endDate (no startDate) on the video filter', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'DE' });
    await mkVideo({ channelId: ch.id, title: 'old', publishedAt: D('05') });
    await mkVideo({ channelId: ch.id, title: 'new', publishedAt: D('25') });
    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ endDate: '2024-01-10' })
      .set(headers);
    expect(res.body.data.map((v) => v.title)).toEqual(['old']);
  });

  it('drops the tags filter when the comma-string yields no entries (videos endpoint)', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'TT', tags: ['only'] });
    await mkVideo({ channelId: ch.id, title: 'visible' });
    // tags=',,' → outer if true (trim is truthy), inner if false (empty tagList) → no hasSome applied.
    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ tags: ',,' })
      .set(headers);
    expect(res.body.data.map((v) => v.title)).toEqual(['visible']);
  });
});

describe('getClassificationCountsByChannel coverage from reportChannels', () => {
  it('groups multiple classifications under one channel (multiple classification rows merge into one map entry)', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'MultiCls', currentSubscribers: 5, currentViews: 0, currentVideoCount: 0 });
    await mkVideo({ channelId: ch.id, classification: 'sadhguru' });
    await mkVideo({ channelId: ch.id, classification: 'non sadhguru' });
    await mkVideo({ channelId: ch.id, classification: 'sadhguru' });

    const res = await request(app).get('/api/export/report/channels').set(headers);
    const row = res.body.data.find((r) => r.title === 'MultiCls');
    expect(row.sadhguru_count).toBe(2);
  });

  it('returns an empty period report when no channels match (early-return helpers)', async () => {
    const { headers } = await authFor('viewer');
    // No channels seeded → channelIds is empty → every helper early-returns its empty Map.
    const res = await request(app)
      .get('/api/export/report/channels')
      .query({ startDate: '2024-01-10', endDate: '2024-01-20' })
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.summary.totalChannels).toBe(0);
  });
});

describe('Sort-string fallback branches', () => {
  it('treats sort="" as the default in reportVideos', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'EQ' });
    await mkVideo({ channelId: ch.id, title: 'hi', views: 100 });
    await mkVideo({ channelId: ch.id, title: 'lo', views: 10 });

    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ sort: '' }) // empty string -> default '-views'
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data.map((v) => v.title)).toEqual(['hi', 'lo']);
  });
});

describe('reportVideos — merged channelFilter + explicit channelId branch', () => {
  it('keeps the explicit channelId when channel-level filters also resolve ids', async () => {
    const { headers } = await authFor('viewer');
    const newsA = await mkChannel({ title: 'NewsA', category: 'News' });
    const newsB = await mkChannel({ title: 'NewsB', category: 'News' });
    await mkVideo({ channelId: newsA.id, title: 'wantedA' });
    await mkVideo({ channelId: newsB.id, title: 'wantedB' });

    // Provide BOTH a channel-level filter (category) AND an explicit channelId →
    // the controller keeps the explicit id branch.
    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ category: 'News', channelId: newsA.id })
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.data.map((v) => v.title)).toEqual(['wantedA']);
  });
});

describe('limit=0 paths in fetchVideosForReportSorted', () => {
  it('non-export limit=0 (aggregate sort) — exercises the "no take" branch', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'L0' });
    await mkVideo({ channelId: ch.id, title: 'v', views: 1 });

    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ sort: 'channel', limit: '0', page: '1' })
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('non-export limit=0 (find sort path) — exercises the "no take" branch', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'L0f' });
    await mkVideo({ channelId: ch.id, title: 'v', views: 1 });

    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ limit: '0' })
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

describe('Aggregate-sort orphan channel branch', () => {
  it('surfaces a video on an archived channel via ?status=archived (channel.title empty)', async () => {
    // Postgres FK forbids true orphans (videos.channel_id → channels.id) so the
    // closest equivalent is a video on an archived channel with an empty title.
    const { headers } = await authFor('viewer');
    const archivedCh = await mkChannel({ title: '', status: 'archived' });
    await mkVideo({ channelId: archivedCh.id, title: 'orphan', views: 99 });

    const res = await request(app)
      .get('/api/export/report/videos')
      .query({ sort: 'channel', status: 'archived' })
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].channel).toBe('');
  });
});

describe('Raw-doc fallback branches (default 0 / BigInt handling)', () => {
  it('mapVideo and avgViews tolerate a Video doc with default zero views/likes/comments', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'RV' });
    // Insert with default zeros — exercises asNumber(BigInt 0) and mapVideo defaults.
    await prisma.video.create({
      data: {
        youtubeVideoId: 'yt-raw-v',
        channelId: ch.id,
        title: 'rawv',
        // views / likes / comments default to 0 in the schema
      },
    });

    const res = await request(app).get('/api/export/report/videos').set(headers);
    expect(res.status).toBe(200);
    const row = res.body.data.find((v) => v.title === 'rawv');
    expect(row).toBeDefined();
    expect(row.views).toBe(0);
    expect(row.likes).toBe(0);
    expect(row.comments).toBe(0);
  });

  it('period mode: opening/closing subscribers default to 0 when seeded that way', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'RSn', currentSubscribers: 0, currentViews: 0, currentVideoCount: 0 });
    // Snapshots default subscribers to 0.
    await prisma.channelSnapshot.create({
      data: { channelId: ch.id, date: D('12') },
    });
    await prisma.channelSnapshot.create({
      data: { channelId: ch.id, date: D('18') },
    });

    const res = await request(app)
      .get('/api/export/report/channels')
      .query({ startDate: '2024-01-10', endDate: '2024-01-20' })
      .set(headers);
    expect(res.status).toBe(200);
    const row = res.body.data.find((r) => r.title === 'RSn');
    expect(row.subscribers_in_period).toBe(0);
  });
});

describe('Period-mode rows.sort comparator branches', () => {
  it('handles equal values (cmp === 0) and 0/NaN-coerced sort fields', async () => {
    const { headers } = await authFor('viewer');
    const a = await mkChannel({
      title: 'Tie A',
      currentSubscribers: 0, currentViews: 0, currentVideoCount: 0,
    });
    const b = await mkChannel({
      title: 'Tie B',
      currentSubscribers: 0, currentViews: 0, currentVideoCount: 0,
    });
    await mkChSnap({ channelId: a.id, date: D('12'), subscribers: 0 });
    await mkChSnap({ channelId: a.id, date: D('18'), subscribers: 0 });
    await mkChSnap({ channelId: b.id, date: D('12'), subscribers: 0 });
    await mkChSnap({ channelId: b.id, date: D('18'), subscribers: 0 });

    const res = await request(app)
      .get('/api/export/report/channels')
      .query({ startDate: '2024-01-10', endDate: '2024-01-20' })
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    // Equal subscribers → comparator returns 0 → original order preserved.
    expect(res.body.data.map((r) => r.title).sort()).toEqual(['Tie A', 'Tie B']);
  });
});

/* ──────────────────────────────────────────────────────────────────
   Role parity (no authorize() on this router → all roles allowed)
─────────────────────────────────────────────────────────────────── */

describe('GET /api/export/* — role parity', () => {
  it.each(['admin', 'manager', 'viewer'])('lets a %s read both reports', async (role) => {
    const { headers } = await authFor(role);
    const r1 = await request(app).get('/api/export/report/channels').set(headers);
    const r2 = await request(app).get('/api/export/report/videos').set(headers);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});
