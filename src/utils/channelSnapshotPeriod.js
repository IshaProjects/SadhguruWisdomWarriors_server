import ChannelSnapshot from '../models/ChannelSnapshot.js';

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

  const snapshotFilter = { channelId: { $in: channelIds }, deletedAt: null };

  const [preStart, firstInRange, atEnd] = await Promise.all([
    ChannelSnapshot.aggregate([
      { $match: { ...snapshotFilter, date: { $lt: startDateObj } } },
      { $sort: { date: -1 } },
      {
        $group: {
          _id: '$channelId',
          views: { $first: '$views' },
          subscribers: { $first: '$subscribers' },
          videoCount: { $first: '$videoCount' },
        },
      },
    ]),
    ChannelSnapshot.aggregate([
      { $match: { ...snapshotFilter, date: { $gte: startDateObj, $lte: endDateObj } } },
      { $sort: { date: 1 } },
      {
        $group: {
          _id: '$channelId',
          views: { $first: '$views' },
          subscribers: { $first: '$subscribers' },
          videoCount: { $first: '$videoCount' },
        },
      },
    ]),
    ChannelSnapshot.aggregate([
      { $match: { ...snapshotFilter, date: { $lte: endDateObj } } },
      { $sort: { date: -1 } },
      {
        $group: {
          _id: '$channelId',
          views: { $first: '$views' },
          subscribers: { $first: '$subscribers' },
          videoCount: { $first: '$videoCount' },
        },
      },
    ]),
  ]);

  const preStartMap = new Map(preStart.map((s) => [s._id.toString(), s]));
  const inRangeMap = new Map(firstInRange.map((s) => [s._id.toString(), s]));
  const openingMap = new Map();
  for (const id of new Set([...preStartMap.keys(), ...inRangeMap.keys()])) {
    openingMap.set(id, preStartMap.get(id) ?? inRangeMap.get(id));
  }
  const closingMap = new Map(atEnd.map((s) => [s._id.toString(), s]));

  return { openingMap, closingMap };
}
