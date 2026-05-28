import Video from '../models/Video.js';
import VideoSnapshot from '../models/VideoSnapshot.js';

/**
 * Per-video view growth in [startDateObj, endDateObj], summed per channel.
 *
 * Opening:
 *   - If a snapshot exists with date < start: latest such snapshot's views.
 *   - Else if the video was tracked-from-fresh (first-ever snapshot landed
 *     within FRESH_TRACKING_GRACE_DAYS of publishedAt — i.e., we observed
 *     the video while its view count was still near 0): opening = 0.
 *   - Else: first-in-range snapshot views (we missed the early growth; treat
 *     the first observation as an opaque baseline).
 * Closing = latest snapshot with date <= end.
 *
 * Why this rule:
 *   The previous code keyed the opening=0 branch on
 *   `publishedAt ∈ [queryStart, queryEnd]`. That made the same video's
 *   opening depend on the query window. A video published Mar 15 with first
 *   snapshot Apr 1 was "new" for the Mar+Apr combined query (opening=0,
 *   delta = full Apr30 views) but not for the April-only query (opening =
 *   Apr1 baseline, delta = within-April growth only). Sum(monthly) therefore
 *   != combined for the same data: combined picked up the publish→first-
 *   snapshot views that the slices silently dropped.
 *
 *   Keying "new" on (first-snapshot - publishedAt) instead is a property of
 *   the video, not the query window, so opening is identical across queries.
 *   That gives the additive property: views(A) + views(B) = views(A ∪ B)
 *   for any non-overlapping A, B.
 *
 * Trade-off: a video that was published well before we started snapshotting
 * it will have its publish→first-snapshot views attributed to no period.
 * That's the unavoidable cost of not having pre-tracking data; we simply
 * cannot split those views across periods. Genuinely fresh content (caught
 * within the grace window) is unaffected.
 *
 * classificationKey: null = all videos; otherwise 'sadhguru' | 'non_sadhguru'.
 */
const FRESH_TRACKING_GRACE_DAYS = 2;
export async function getVideoSnapshotPeriodViewsByChannel(
  channelIds,
  startDateObj,
  endDateObj,
  classificationKey,
) {
  if (!channelIds?.length) return new Map();

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

  // Build the set of "freshly tracked" video IDs — those where the first-ever
  // snapshot landed within FRESH_TRACKING_GRACE_DAYS of publishedAt. This is a
  // property of the video, not the query window, so the same video gets the
  // same `opening` treatment regardless of [start, end]. That's what makes
  // period totals additive (sum of slices == total of union).
  const firstSnapAgg = await VideoSnapshot.aggregate([
    {
      $match: {
        channelId: { $in: channelIds },
        deletedAt: null,
        ...(videoIdFilter ? { videoId: { $in: videoIdFilter } } : {}),
      },
    },
    { $group: { _id: '$videoId', firstDate: { $min: '$date' } } },
  ]);
  const firstSnapByVideo = new Map(firstSnapAgg.map((r) => [r._id.toString(), r.firstDate]));
  const candidateVideoIds = Array.from(firstSnapByVideo.keys());
  const videos = candidateVideoIds.length
    ? await Video.find({ _id: { $in: candidateVideoIds } }).select('_id publishedAt').lean()
    : [];
  const GRACE_MS = FRESH_TRACKING_GRACE_DAYS * 24 * 60 * 60 * 1000;
  const freshlyTrackedIds = [];
  for (const v of videos) {
    const first = firstSnapByVideo.get(v._id.toString());
    if (!first || !v.publishedAt) continue;
    if (first.getTime() - new Date(v.publishedAt).getTime() <= GRACE_MS) {
      freshlyTrackedIds.push(v._id);
    }
  }

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
              isFreshlyTracked: { $in: ['$_id', freshlyTrackedIds] },
            },
            in: {
              $let: {
                vars: {
                  // opening:
                  //   - last preStart snapshot's views if any preStart exists
                  //   - else 0 if the video was freshly tracked (first snapshot
                  //     within grace of publishedAt — we observed it near 0)
                  //   - else first inRange snapshot's views (opaque baseline)
                  // Branch choice depends only on the video, not the query.
                  openingViews: {
                    $cond: [
                      { $gt: [{ $size: '$$preStart' }, 0] },
                      { $ifNull: [{ $getField: { field: 'views', input: { $arrayElemAt: ['$$preStart', -1] } } }, 0] },
                      {
                        $cond: [
                          '$$isFreshlyTracked',
                          0,
                          { $ifNull: [{ $getField: { field: 'views', input: { $arrayElemAt: ['$$inRange', 0] } } }, 0] },
                        ],
                      },
                    ],
                  },
                  closingViews: { $ifNull: [{ $getField: { field: 'views', input: '$$closing' } }, 0] },
                  hasObservation: {
                    $or: [
                      { $gt: [{ $size: '$$preStart' }, 0] },
                      { $gt: [{ $size: '$$inRange' }, 0] },
                    ],
                  },
                },
                in: {
                  $cond: [
                    { $not: '$$hasObservation' },
                    0,
                    { $max: [0, { $subtract: ['$$closingViews', '$$openingViews'] }] },
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
