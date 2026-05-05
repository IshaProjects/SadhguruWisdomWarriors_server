import ChannelSnapshot from '../models/ChannelSnapshot.js';

/**
 * Opening = earliest snapshot in [start, end].
 * Closing = latest snapshot on or before end.
 *
 * NOTE: Intentionally does NOT look at snapshots before startDate, to match the
 * historical inline behavior. A pre-period lookup would (more accurately) capture
 * one extra day of growth between the last sync of the prior period and the first
 * sync of this period, but it would shift displayed totals upward and break parity
 * with what users have been seeing.
 */
export async function aggregateChannelOpeningAndClosingMaps(channelIds, startDateObj, endDateObj) {
  if (!channelIds?.length) return { openingMap: new Map(), closingMap: new Map() };

  const snapshotFilter = { channelId: { $in: channelIds }, deletedAt: null };

  const [firstInRange, atEnd] = await Promise.all([
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

  const openingMap = new Map(firstInRange.map((s) => [s._id.toString(), s]));
  const closingMap = new Map(atEnd.map((s) => [s._id.toString(), s]));

  return { openingMap, closingMap };
}
