import { describe, it, expect } from 'vitest';
import { prisma } from '../setup.js';
import { aggregateChannelOpeningAndClosingMaps } from '../../src/utils/channelSnapshotPeriod.js';

const START = new Date('2024-01-10T00:00:00.000Z');
const END = new Date('2024-01-20T00:00:00.000Z');
const D = (s) => new Date(`2024-01-${s}T00:00:00.000Z`);

// Postgres enforces the channel_snapshots → channels FK. Each test seeds a
// channel and returns its id (string), in place of the original `oid()`.
let seq = 0;
async function mkChannel() {
  seq += 1;
  const c = await prisma.channel.create({
    data: { youtubeChannelId: `yt-ch-${seq}-${Math.random()}`, title: `Ch ${seq}` },
  });
  return c.id;
}

const snap = (channelId, date, extra = {}) =>
  prisma.channelSnapshot.create({
    data: { channelId, date, views: 0, subscribers: 0, videoCount: 0, ...extra },
  });

describe('aggregateChannelOpeningAndClosingMaps', () => {
  it('returns empty maps when no channelIds are given', async () => {
    const { openingMap, closingMap } = await aggregateChannelOpeningAndClosingMaps([], START, END);
    expect(openingMap.size).toBe(0);
    expect(closingMap.size).toBe(0);
  });

  it('opening = latest pre-period snapshot, closing = latest on/before end', async () => {
    const ch = await mkChannel();
    await snap(ch, D('05'), { views: 100, subscribers: 3, videoCount: 1 }); // latest before start -> opening
    await snap(ch, D('12'), { views: 150, subscribers: 5, videoCount: 2 }); // in-range, not opening anymore
    await snap(ch, D('18'), { views: 200, subscribers: 7, videoCount: 3 }); // latest <= end -> closing
    await snap(ch, D('25'), { views: 300 }); // after end: excluded

    const { openingMap, closingMap } = await aggregateChannelOpeningAndClosingMaps([ch], START, END);
    expect(openingMap.get(ch)).toMatchObject({ views: 100, subscribers: 3, videoCount: 1 });
    expect(closingMap.get(ch)).toMatchObject({ views: 200, subscribers: 7, videoCount: 3 });
  });

  it('opening falls back to first in-range snapshot when no pre-period snapshot exists', async () => {
    const ch = await mkChannel();
    await snap(ch, D('12'), { views: 150, subscribers: 5 }); // first in-range -> opening (bootstrap case)
    await snap(ch, D('18'), { views: 200, subscribers: 7 });

    const { openingMap, closingMap } = await aggregateChannelOpeningAndClosingMaps([ch], START, END);
    expect(openingMap.get(ch)).toMatchObject({ views: 150, subscribers: 5 });
    expect(closingMap.get(ch)).toMatchObject({ views: 200, subscribers: 7 });
  });

  it('opening = closing when only a pre-period snapshot exists (delta is zero, but channel is observable)', async () => {
    const ch = await mkChannel();
    await snap(ch, D('05'), { views: 100 }); // only snapshot, before the window

    const { openingMap, closingMap } = await aggregateChannelOpeningAndClosingMaps([ch], START, END);
    // Both opening and closing point at the pre-period snapshot — period delta is 0
    // and the channel is included rather than silently dropped, which preserves
    // additivity across adjacent date ranges.
    expect(openingMap.get(ch)).toMatchObject({ views: 100 });
    expect(closingMap.get(ch)).toMatchObject({ views: 100 });
  });

  it('period subscribers are additive: sum of disjoint slices equals the union', async () => {
    // Regression: previously opening = first in-range; for weekly-synced channels
    // the inter-sync growth at the prior boundary was lost from monthly slices
    // but recovered in wider windows, so sum(monthly) != combined.
    const MAR_START = new Date('2024-03-01T00:00:00.000Z');
    const MAR_END   = new Date('2024-03-31T23:59:59.999Z');
    const APR_START = new Date('2024-04-01T00:00:00.000Z');
    const APR_END   = new Date('2024-04-30T23:59:59.999Z');

    const ch = await mkChannel();
    await snap(ch, new Date('2024-02-25T00:00:00.000Z'), { subscribers: 100 }); // pre-March opening
    await snap(ch, new Date('2024-03-10T00:00:00.000Z'), { subscribers: 120 });
    await snap(ch, new Date('2024-04-05T00:00:00.000Z'), { subscribers: 150 });
    await snap(ch, new Date('2024-04-25T00:00:00.000Z'), { subscribers: 200 });

    const delta = async (start, end) => {
      const { openingMap, closingMap } = await aggregateChannelOpeningAndClosingMaps([ch], start, end);
      const o = openingMap.get(ch);
      const c = closingMap.get(ch) || o;
      return (c.subscribers ?? 0) - (o.subscribers ?? 0);
    };
    const mar = await delta(MAR_START, MAR_END);
    const apr = await delta(APR_START, APR_END);
    const combined = await delta(MAR_START, APR_END);
    expect(mar + apr).toBe(combined);
  });

  it('excludes soft-deleted snapshots', async () => {
    const ch = await mkChannel();
    await snap(ch, D('12'), { views: 150, deletedAt: new Date() });
    await snap(ch, D('18'), { views: 200, deletedAt: new Date() });

    const { openingMap, closingMap } = await aggregateChannelOpeningAndClosingMaps([ch], START, END);
    expect(openingMap.has(ch)).toBe(false);
    expect(closingMap.has(ch)).toBe(false);
  });
});
