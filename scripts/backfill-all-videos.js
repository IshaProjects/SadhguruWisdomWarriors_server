/**
 * backfill-all-videos.js
 *
 * Runs pullAllChannelsVideos() once: walks the uploads playlist of every
 * non-archived channel with allVideosPulled != true, upserts every video and
 * writes a today-dated snapshot for each. Quota-guarded (stops gracefully when
 * the in-process YouTube quota tracker approaches the daily cap — rerun the
 * next day to continue; allVideosPulled flips per channel only when complete).
 *
 * Context: part of the 2026-06 views-discrepancy fix — incomplete back-catalog
 * ingestion made period views undercount (e.g. The Mystic World: 37 of 631
 * videos tracked).
 *
 * Usage:
 *   node scripts/backfill-all-videos.js
 */
import 'dotenv/config';
import { prisma } from '../src/config/prisma.js';
import { pullAllChannelsVideos } from '../src/services/syncEngine.js';

async function main() {
  const pending = await prisma.channel.count({
    where: { deletedAt: null, status: { not: 'archived' }, allVideosPulled: { not: true } },
  });
  console.log(`[Backfill] ${pending} channel(s) need a back-catalog pull`);

  const result = await pullAllChannelsVideos();
  console.log('[Backfill] Result:', JSON.stringify(result, null, 2));

  const stillPending = await prisma.channel.count({
    where: { deletedAt: null, status: { not: 'archived' }, allVideosPulled: { not: true } },
  });
  console.log(`[Backfill] ${stillPending} channel(s) still pending (0 = fully done)`);
}

main()
  .catch((err) => {
    console.error('[Backfill] Failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
