import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';

/**
 * Opening = latest channel snapshot with date < start (the observed state
 *           just before the period). Falls back to the earliest snapshot in
 *           [start, end] only if no pre-period snapshot exists.
 * Closing = latest snapshot on or before end.
 *
 * Why "latest before start" and not "first in-range":
 *   Using the first in-range snapshot as opening makes the same channel's
 *   opening depend on the query window — for a channel synced weekly, the
 *   April-only query's opening is "first April snapshot" and the Mar+Apr
 *   query's opening is "first March snapshot". As a result, sum(monthly
 *   subscribers gained) != (Mar+Apr subscribers gained); the wider window
 *   captures the inter-sync growth at the prior boundary that the slices
 *   silently drop. Anchoring opening at the latest pre-period snapshot
 *   makes it a function of the data, not the query, which restores the
 *   additive property: subs(A) + subs(B) = subs(A ∪ B).
 *
 *   The fallback to first-in-range is for the bootstrap case (channel
 *   tracked starting inside the period); same additivity property holds.
 */
export async function aggregateChannelOpeningAndClosingMaps(channelIds, startDateObj, endDateObj) {
  if (!channelIds?.length) return { openingMap: new Map(), closingMap: new Map() };

  // Three Postgres `DISTINCT ON (channel_id)` queries, one per anchor:
  //   preStart    — latest snapshot strictly before the window.
  //   firstInRange — earliest snapshot inside the window (bootstrap fallback).
  //   atEnd       — latest snapshot on or before the window end (closing).
  // All filtered to live rows (deleted_at IS NULL) and to the channel set.
  const [preStart, firstInRange, atEnd] = await Promise.all([
    prisma.$queryRaw(Prisma.sql`
      SELECT DISTINCT ON (channel_id)
             channel_id, views, subscribers, video_count
      FROM channel_snapshots
      WHERE channel_id IN (${Prisma.join(channelIds)})
        AND deleted_at IS NULL
        AND date < ${startDateObj}
      ORDER BY channel_id, date DESC
    `),
    prisma.$queryRaw(Prisma.sql`
      SELECT DISTINCT ON (channel_id)
             channel_id, views, subscribers, video_count
      FROM channel_snapshots
      WHERE channel_id IN (${Prisma.join(channelIds)})
        AND deleted_at IS NULL
        AND date >= ${startDateObj}
        AND date <= ${endDateObj}
      ORDER BY channel_id, date ASC
    `),
    prisma.$queryRaw(Prisma.sql`
      SELECT DISTINCT ON (channel_id)
             channel_id, views, subscribers, video_count
      FROM channel_snapshots
      WHERE channel_id IN (${Prisma.join(channelIds)})
        AND deleted_at IS NULL
        AND date <= ${endDateObj}
      ORDER BY channel_id, date DESC
    `),
  ]);

  // Normalise the raw row shape (snake_case columns, BigInt views) to the
  // {views, subscribers, videoCount} shape the callers already consume.
  const shape = (row) => ({
    views: Number(row.views),
    subscribers: row.subscribers,
    videoCount: row.video_count,
  });

  const preStartMap = new Map(preStart.map((r) => [r.channel_id, shape(r)]));
  const inRangeMap = new Map(firstInRange.map((r) => [r.channel_id, shape(r)]));
  const openingMap = new Map();
  for (const id of new Set([...preStartMap.keys(), ...inRangeMap.keys()])) {
    openingMap.set(id, preStartMap.get(id) ?? inRangeMap.get(id));
  }
  const closingMap = new Map(atEnd.map((r) => [r.channel_id, shape(r)]));

  return { openingMap, closingMap };
}
