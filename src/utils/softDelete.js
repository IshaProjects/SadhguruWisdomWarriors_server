/**
 * Soft-delete one or more channels and cascade to all related rows in a
 * single transaction.
 *
 * What gets updated atomically:
 *   channels         → status: 'archived', deletedAt: now
 *   videos           → deletedAt: now   (for every video belonging to the channels)
 *   channel_snapshots → deletedAt: now
 *   video_snapshots  → deletedAt: now
 *
 * Nothing is ever hard-deleted. All queries that surface data to the UI
 * already filter by Channel.status !== 'archived', so child rows are
 * naturally invisible once the parent is archived; the deletedAt stamp on
 * child rows ensures they are also excluded if queried directly.
 *
 * Children that already carry a deletedAt are left untouched so we preserve
 * the original archive timestamp.
 */

import { prisma } from '../config/prisma.js';

/**
 * @param {string | string[]} channelIds  - One or more Channel id values
 * @returns {{ archived: number }}
 */
export async function softDeleteChannels(channelIds) {
  const ids = Array.isArray(channelIds) ? channelIds : [channelIds];
  if (!ids.length) return { archived: 0 };
  const now = new Date();

  const [channelsResult] = await prisma.$transaction([
    prisma.channel.updateMany({
      where: { id: { in: ids } },
      // autoArchivedForInactivity:false marks this as a deliberate human archive
      // so the inactivity sync never auto-reactivates it.
      data: { status: 'archived', deletedAt: now, autoArchivedForInactivity: false },
    }),
    prisma.video.updateMany({
      where: { channelId: { in: ids }, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.channelSnapshot.updateMany({
      where: { channelId: { in: ids }, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.videoSnapshot.updateMany({
      where: { channelId: { in: ids }, deletedAt: null },
      data: { deletedAt: now },
    }),
  ]);

  return { archived: channelsResult.count };
}
