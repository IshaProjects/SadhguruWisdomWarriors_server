/**
 * check-channel-activity.js
 *
 * Runs the inactivity recompute (updateChannelActivityStatuses) once and prints
 * a before/after summary of channel statuses plus the channels that changed.
 * This is the same logic the daily channel sync runs as its final step.
 *
 * Usage:
 *   node scripts/check-channel-activity.js            # apply changes
 *   node scripts/check-channel-activity.js --dry-run  # report only, no writes
 *
 * Requires MONGODB_URI (and optionally MONGODB_DB_NAME) in the environment / .env.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Channel from '../src/models/Channel.js';
import SyncConfig from '../src/models/SyncConfig.js';
import { updateChannelActivityStatuses } from '../src/services/syncEngine.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function statusCounts() {
  const rows = await Channel.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  return rows.reduce((acc, r) => ({ ...acc, [r._id]: r.count }), {});
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  const options = {};
  if (process.env.MONGODB_DB_NAME) options.dbName = process.env.MONGODB_DB_NAME;
  await mongoose.connect(uri, options);
  console.log(`Connected to ${mongoose.connection.db?.databaseName || '(unknown)'}`);

  const config = await SyncConfig.getSingleton();
  console.log(`Inactivity window: ${config.inactivityThresholdDays ?? 14} days${DRY_RUN ? '  (DRY RUN — no writes)' : ''}`);

  console.log('\nStatus counts (before):', await statusCounts());

  if (DRY_RUN) {
    // Report what would change without persisting: snapshot, run, then revert.
    const before = await Channel.find(
      {},
      { youtubeChannelId: 1, title: 1, status: 1, autoArchivedForInactivity: 1 }
    ).lean();
    const beforeMap = new Map(before.map((c) => [String(c._id), c]));

    const result = await updateChannelActivityStatuses('manual');

    const after = await Channel.find(
      {},
      { youtubeChannelId: 1, title: 1, status: 1, autoArchivedForInactivity: 1 }
    ).lean();

    const changes = [];
    for (const c of after) {
      const prev = beforeMap.get(String(c._id));
      if (prev && prev.status !== c.status) {
        changes.push({ title: c.title || c.youtubeChannelId, from: prev.status, to: c.status });
      }
    }

    // Revert every change we just made.
    await Promise.all(
      before.map((c) =>
        Channel.updateOne(
          { _id: c._id },
          { $set: { status: c.status, autoArchivedForInactivity: !!c.autoArchivedForInactivity } }
        )
      )
    );

    console.log('\nWould change:', result);
    for (const ch of changes) console.log(`  ${ch.from} -> ${ch.to}  ${ch.title}`);
    console.log('\nReverted all changes (dry run).');
  } else {
    const result = await updateChannelActivityStatuses('manual');
    console.log('\nResult:', result);
  }

  console.log('\nStatus counts (after):', await statusCounts());
  await mongoose.disconnect();
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    try {
      await mongoose.disconnect();
    } catch {}
    process.exit(1);
  });
