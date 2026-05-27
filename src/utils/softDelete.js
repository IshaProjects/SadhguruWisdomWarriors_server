/**
 * Soft-delete one or more channels and cascade to all related collections.
 *
 * What gets updated:
 *   Channel        → status: 'archived', deletedAt: now
 *   Video          → deletedAt: now   (for every video belonging to the channels)
 *   ChannelSnapshot → deletedAt: now
 *   VideoSnapshot  → deletedAt: now
 *
 * Nothing is ever hard-deleted. All queries that surface data to the UI
 * already filter by Channel.status !== 'archived', so child records are
 * naturally invisible once the parent is archived. The deletedAt stamp on
 * child documents ensures they are also excluded if queried directly.
 */

import Channel         from '../models/Channel.js';
import Video           from '../models/Video.js';
import ChannelSnapshot from '../models/ChannelSnapshot.js';
import VideoSnapshot   from '../models/VideoSnapshot.js';

/**
 * @param {string | string[]} channelIds  - One or more Channel _id values (strings or ObjectIds)
 * @returns {{ archived: number }}
 */
export async function softDeleteChannels(channelIds) {
  const ids = Array.isArray(channelIds) ? channelIds : [channelIds];
  const now = new Date();

  // 1. Archive the channels themselves
  const { modifiedCount } = await Channel.updateMany(
    { _id: { $in: ids } },
    // autoArchivedForInactivity:false marks this as a deliberate human archive
    // so the inactivity sync never auto-reactivates it.
    { $set: { status: 'archived', deletedAt: now, autoArchivedForInactivity: false } }
  );

  // 2. Soft-delete all videos belonging to these channels
  await Video.updateMany(
    { channelId: { $in: ids }, deletedAt: null },
    { $set: { deletedAt: now } }
  );

  // 3. Soft-delete all channel snapshots
  await ChannelSnapshot.updateMany(
    { channelId: { $in: ids }, deletedAt: null },
    { $set: { deletedAt: now } }
  );

  // 4. Soft-delete all video snapshots linked to these channels
  await VideoSnapshot.updateMany(
    { channelId: { $in: ids }, deletedAt: null },
    { $set: { deletedAt: now } }
  );

  return { archived: modifiedCount };
}
