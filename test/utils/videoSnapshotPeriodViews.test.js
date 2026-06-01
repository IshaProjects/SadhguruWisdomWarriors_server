import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../setup.js';
import { getVideoSnapshotPeriodViewsByChannel } from '../../src/utils/videoSnapshotPeriodViews.js';

// Fixed window for every test.
const START = new Date('2024-01-10T00:00:00.000Z');
const END = new Date('2024-01-20T00:00:00.000Z');
const D = (s) => new Date(`2024-01-${s}T00:00:00.000Z`);

// Snapshots/videos require the parent channel row under Postgres. Each test
// seeds an actual `channels` row and uses its string `id` everywhere the
// Mongoose version generated an ObjectId.
let chSeq = 0;
async function mkChannelRow() {
  chSeq += 1;
  const c = await prisma.channel.create({
    data: { youtubeChannelId: `yt-ch-${chSeq}-${Math.random()}`, title: `Ch ${chSeq}` },
  });
  return c.id;
}

let vidSeq = 0;
async function mkVideo({ channelId, classification = '', publishedAt, deletedAt = null }) {
  vidSeq += 1;
  return prisma.video.create({
    data: {
      youtubeVideoId: `yt-${vidSeq}-${Math.random()}`,
      channelId,
      classification,
      publishedAt,
      deletedAt,
    },
  });
}
async function mkSnap({ videoId, channelId, date, views, deletedAt = null }) {
  return prisma.videoSnapshot.create({
    data: { videoId, channelId, date, views, deletedAt },
  });
}

describe('getVideoSnapshotPeriodViewsByChannel', () => {
  beforeEach(() => {
    vidSeq = 0;
    chSeq = 0;
  });

  it('returns an empty Map when no channelIds are given', async () => {
    expect((await getVideoSnapshotPeriodViewsByChannel([], START, END, null)).size).toBe(0);
    expect((await getVideoSnapshotPeriodViewsByChannel(null, START, END, null)).size).toBe(0);
  });

  it('uses the last pre-period snapshot as the opening balance', async () => {
    const ch = await mkChannelRow();
    const v = await mkVideo({ channelId: ch, publishedAt: D('01') }); // before window
    await mkSnap({ videoId: v.id, channelId: ch, date: D('05'), views: 100 }); // pre-start opening
    await mkSnap({ videoId: v.id, channelId: ch, date: D('12'), views: 150 });
    await mkSnap({ videoId: v.id, channelId: ch, date: D('18'), views: 200 }); // closing

    const res = await getVideoSnapshotPeriodViewsByChannel([ch], START, END, null);
    expect(res.get(ch)).toBe(100); // 200 - 100
  });

  it('treats a freshly-tracked video (first snapshot within ~2 days of publish) as opening 0', async () => {
    const ch = await mkChannelRow();
    const v = await mkVideo({ channelId: ch, publishedAt: D('12') });
    await mkSnap({ videoId: v.id, channelId: ch, date: D('13'), views: 50 }); // 1-day gap = fresh
    await mkSnap({ videoId: v.id, channelId: ch, date: D('19'), views: 80 }); // closing

    const res = await getVideoSnapshotPeriodViewsByChannel([ch], START, END, null);
    expect(res.get(ch)).toBe(80); // 80 - 0
  });

  it('does NOT treat as opening 0 when the first snapshot lags publish by more than the grace window', async () => {
    // A video uploaded Jan 12 but first observed Jan 19 (7-day gap) is treated
    // as having an opaque baseline at first observation, not opening 0. This is
    // what makes period totals additive: the same gap-7 video gets the same
    // baseline whether queried for a single month or for a multi-month window.
    const ch = await mkChannelRow();
    const v = await mkVideo({ channelId: ch, publishedAt: D('12') });
    await mkSnap({ videoId: v.id, channelId: ch, date: D('19'), views: 80 });

    const res = await getVideoSnapshotPeriodViewsByChannel([ch], START, END, null);
    expect(res.get(ch) ?? 0).toBe(0); // opening = closing = 80; delta = 0
  });

  it('falls back to the first in-range snapshot when there is no pre-period data and the video is not new', async () => {
    const ch = await mkChannelRow();
    const v = await mkVideo({ channelId: ch, publishedAt: D('01') }); // old video, but data starts mid-window
    await mkSnap({ videoId: v.id, channelId: ch, date: D('12'), views: 300 }); // first in-range = opening
    await mkSnap({ videoId: v.id, channelId: ch, date: D('18'), views: 360 }); // closing

    const res = await getVideoSnapshotPeriodViewsByChannel([ch], START, END, null);
    expect(res.get(ch)).toBe(60); // 360 - 300
  });

  it('clamps a negative delta (views dropped) to 0', async () => {
    const ch = await mkChannelRow();
    const v = await mkVideo({ channelId: ch, publishedAt: D('01') });
    await mkSnap({ videoId: v.id, channelId: ch, date: D('05'), views: 500 }); // opening
    await mkSnap({ videoId: v.id, channelId: ch, date: D('18'), views: 400 }); // closing < opening

    const res = await getVideoSnapshotPeriodViewsByChannel([ch], START, END, null);
    expect(res.get(ch)).toBe(0); // max(0, 400 - 500)
  });

  it('ignores snapshots dated after the period end', async () => {
    const ch = await mkChannelRow();
    const v = await mkVideo({ channelId: ch, publishedAt: D('01') });
    await mkSnap({ videoId: v.id, channelId: ch, date: D('05'), views: 100 }); // opening
    await mkSnap({ videoId: v.id, channelId: ch, date: D('18'), views: 150 }); // real closing
    await mkSnap({ videoId: v.id, channelId: ch, date: D('25'), views: 999 }); // after END — excluded

    const res = await getVideoSnapshotPeriodViewsByChannel([ch], START, END, null);
    expect(res.get(ch)).toBe(50); // 150 - 100, not 899
  });

  it('excludes soft-deleted snapshots', async () => {
    const ch = await mkChannelRow();
    const v = await mkVideo({ channelId: ch, publishedAt: D('01') });
    await mkSnap({ videoId: v.id, channelId: ch, date: D('05'), views: 100, deletedAt: new Date() });
    await mkSnap({ videoId: v.id, channelId: ch, date: D('18'), views: 200, deletedAt: new Date() });

    const res = await getVideoSnapshotPeriodViewsByChannel([ch], START, END, null);
    expect(res.has(ch)).toBe(false); // no live snapshots -> channel absent
  });

  it('sums deltas across multiple videos in the same channel', async () => {
    const ch = await mkChannelRow();
    const a = await mkVideo({ channelId: ch, publishedAt: D('01') });
    await mkSnap({ videoId: a.id, channelId: ch, date: D('05'), views: 100 });
    await mkSnap({ videoId: a.id, channelId: ch, date: D('18'), views: 200 }); // +100
    const b = await mkVideo({ channelId: ch, publishedAt: D('12') });
    await mkSnap({ videoId: b.id, channelId: ch, date: D('13'), views: 20 }); // freshly tracked (1-day gap)
    await mkSnap({ videoId: b.id, channelId: ch, date: D('19'), views: 50 }); // +50 from opening 0

    const res = await getVideoSnapshotPeriodViewsByChannel([ch], START, END, null);
    expect(res.get(ch)).toBe(150);
  });

  it('period totals are additive: sum of disjoint slices equals the union (the bug this rule fixes)', async () => {
    // Regression: previously a video published in March with first snapshot
    // on Apr 1 was treated as "new-in-period" for Mar+Apr combined (opening 0,
    // delta = full Apr30 views) but not for April-only (opening = Apr 1
    // baseline, delta = within-April growth). Sum(Mar)+Sum(Apr) therefore
    // diverged from Sum(Mar+Apr) by the publish→first-snapshot views.
    const MAR_START = new Date('2024-03-01T00:00:00.000Z');
    const MAR_END   = new Date('2024-03-31T23:59:59.999Z');
    const APR_START = new Date('2024-04-01T00:00:00.000Z');
    const APR_END   = new Date('2024-04-30T23:59:59.999Z');

    const ch = await mkChannelRow();
    // Video published mid-March; first snapshot only on Apr 1 (17-day gap → NOT freshly tracked).
    const v = await mkVideo({ channelId: ch, publishedAt: new Date('2024-03-15T00:00:00.000Z') });
    await mkSnap({ videoId: v.id, channelId: ch, date: new Date('2024-04-01T00:00:00.000Z'), views: 323_699 });
    await mkSnap({ videoId: v.id, channelId: ch, date: new Date('2024-04-30T00:00:00.000Z'), views: 348_465 });

    const mar = (await getVideoSnapshotPeriodViewsByChannel([ch], MAR_START, MAR_END, null)).get(ch) ?? 0;
    const apr = (await getVideoSnapshotPeriodViewsByChannel([ch], APR_START, APR_END, null)).get(ch) ?? 0;
    const combined = (await getVideoSnapshotPeriodViewsByChannel([ch], MAR_START, APR_END, null)).get(ch) ?? 0;

    expect(mar + apr).toBe(combined);
  });

  describe('classification filtering', () => {
    async function seedMixedChannel() {
      const ch = await mkChannelRow();
      const sad = await mkVideo({ channelId: ch, classification: 'sadhguru', publishedAt: D('01') });
      await mkSnap({ videoId: sad.id, channelId: ch, date: D('05'), views: 10 });
      await mkSnap({ videoId: sad.id, channelId: ch, date: D('18'), views: 50 }); // +40
      const non = await mkVideo({ channelId: ch, classification: 'non sadhguru', publishedAt: D('01') });
      await mkSnap({ videoId: non.id, channelId: ch, date: D('05'), views: 0 });
      await mkSnap({ videoId: non.id, channelId: ch, date: D('18'), views: 1000 }); // +1000
      return ch;
    }

    it("counts only 'sadhguru' videos for classificationKey 'sadhguru'", async () => {
      const ch = await seedMixedChannel();
      const res = await getVideoSnapshotPeriodViewsByChannel([ch], START, END, 'sadhguru');
      expect(res.get(ch)).toBe(40);
    });

    it("maps 'non_sadhguru' to the 'non sadhguru' classification value", async () => {
      const ch = await seedMixedChannel();
      const res = await getVideoSnapshotPeriodViewsByChannel([ch], START, END, 'non_sadhguru');
      expect(res.get(ch)).toBe(1000);
    });

    it('returns an empty Map when no videos match the classification', async () => {
      const ch = await mkChannelRow();
      const non = await mkVideo({ channelId: ch, classification: 'non sadhguru', publishedAt: D('01') });
      await mkSnap({ videoId: non.id, channelId: ch, date: D('18'), views: 100 });

      const res = await getVideoSnapshotPeriodViewsByChannel([ch], START, END, 'sadhguru');
      expect(res.size).toBe(0);
    });
  });
});
