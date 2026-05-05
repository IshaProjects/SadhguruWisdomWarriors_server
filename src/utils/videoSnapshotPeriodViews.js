import Video from '../models/Video.js';
import VideoSnapshot from '../models/VideoSnapshot.js';

/**
 * Per-video view growth in [startDateObj, endDateObj], summed per channel.
 * Opening = latest snapshot with date < start (state just before the period),
 * else first snapshot in-range (video had no history before this window).
 * Closing = latest snapshot with date <= end.
 * classificationKey: null = all videos; otherwise 'sadhguru' | 'non_sadhguru'.
 *
 * Computes per-video delta and per-channel sum entirely server-side via a single
 * aggregation, returning ~one-row-per-channel instead of ~one-row-per-video × 3
 * roundtrips. This is a large win once the snapshots collection grows past the
 * point where per-video data dwarfs per-channel data over the wire.
 */
export async function getVideoSnapshotPeriodViewsByChannel(
  channelIds,
  startDateObj,
  endDateObj,
  classificationKey,
) {
  if (!channelIds?.length) return new Map();

  // Classification filter: pre-fetch the videoId list once (indexed query) and
  // narrow the snapshot $match by videoId. Avoids fetching 55k snapshots only
  // to discard most of them in JS.
  let videoIdFilter = null;
  if (classificationKey === 'sadhguru' || classificationKey === 'non_sadhguru') {
    const cls = classificationKey === 'sadhguru' ? 'sadhguru' : 'non sadhguru';
    videoIdFilter = await Video.distinct('_id', {
      classification: cls,
      channelId: { $in: channelIds },
      deletedAt: null,
    });
    if (!videoIdFilter.length) return new Map();
  }

  const match = {
    channelId: { $in: channelIds },
    deletedAt: null,
    date: { $lte: endDateObj },
  };
  if (videoIdFilter) match.videoId = { $in: videoIdFilter };

  const result = await VideoSnapshot.aggregate([
    { $match: match },
    { $sort: { videoId: 1, date: 1 } },
    {
      $group: {
        _id: '$videoId',
        channelId: { $first: '$channelId' },
        snapshots: { $push: { date: '$date', views: '$views' } },
      },
    },
    {
      $project: {
        channelId: 1,
        delta: {
          $let: {
            vars: {
              preStart: {
                $filter: {
                  input: '$snapshots',
                  cond: { $lt: ['$$this.date', startDateObj] },
                },
              },
              inRange: {
                $filter: {
                  input: '$snapshots',
                  cond: { $gte: ['$$this.date', startDateObj] },
                },
              },
              closing: { $arrayElemAt: ['$snapshots', -1] },
            },
            in: {
              $let: {
                vars: {
                  opening: {
                    $cond: [
                      { $gt: [{ $size: '$$preStart' }, 0] },
                      { $arrayElemAt: ['$$preStart', -1] },
                      { $arrayElemAt: ['$$inRange', 0] },
                    ],
                  },
                },
                in: {
                  $cond: [
                    { $eq: ['$$opening', null] },
                    0,
                    {
                      $max: [
                        0,
                        {
                          $subtract: [
                            { $ifNull: ['$$closing.views', 0] },
                            { $ifNull: ['$$opening.views', 0] },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
    { $group: { _id: '$channelId', total: { $sum: '$delta' } } },
  ]);

  const totals = new Map();
  for (const row of result) {
    if (row._id) totals.set(row._id.toString(), row.total);
  }
  return totals;
}
