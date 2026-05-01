import 'dotenv/config';
import mongoose from 'mongoose';
import Channel from '../src/models/Channel.js';
import Video from '../src/models/Video.js';
import { classifySadguruVideoBatch } from '../src/services/vertexAiService.js';

function nowIso() {
  return new Date().toISOString();
}

function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'n/a';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function parseArgs(argv) {
  const args = {
    batchSize: 100,
    dryRun: false,
    skipArchived: false,
    channelStartsWith: '',
    maxChannels: 0,
  };

  for (const raw of argv) {
    if (raw === '--dry-run') args.dryRun = true;
    else if (raw === '--skip-archived') args.skipArchived = true;
    else if (raw.startsWith('--batch-size=')) args.batchSize = Math.max(1, parseInt(raw.split('=')[1], 10) || 100);
    else if (raw.startsWith('--channel-starts-with=')) args.channelStartsWith = raw.split('=')[1] || '';
    else if (raw.startsWith('--max-channels=')) args.maxChannels = Math.max(0, parseInt(raw.split('=')[1], 10) || 0);
  }

  return args;
}

async function connectDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  const options = {};
  if (process.env.MONGODB_DB_NAME) options.dbName = process.env.MONGODB_DB_NAME;
  await mongoose.connect(uri, options);
}

async function run() {
  const cfg = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  console.log(`[${nowIso()}] Starting reclassification job`);
  console.log(`[${nowIso()}] Config: ${JSON.stringify(cfg)}`);

  await connectDb();
  const dbName = mongoose.connection.db?.databaseName || '(unknown)';
  console.log(`[${nowIso()}] Connected to DB: ${dbName}`);

  const channelFilter = {};
  if (cfg.skipArchived) channelFilter.status = { $ne: 'archived' };
  if (cfg.channelStartsWith) channelFilter.title = { $regex: `^${cfg.channelStartsWith}`, $options: 'i' };

  let channels = await Channel.find(channelFilter)
    .select('_id title status')
    .sort({ title: 1 })
    .lean();

  if (cfg.maxChannels > 0) channels = channels.slice(0, cfg.maxChannels);

  console.log(`[${nowIso()}] Channels to process: ${channels.length}`);
  if (!channels.length) {
    console.log(`[${nowIso()}] No channels matched the filter. Exiting.`);
    await mongoose.disconnect();
    return;
  }

  const totals = {
    channelsProcessed: 0,
    channelsWithErrors: 0,
    videosScanned: 0,
    videosUpdated: 0,
    videosUnchanged: 0,
    videosFailed: 0,
  };

  for (let i = 0; i < channels.length; i++) {
    const channel = channels[i];
    const channelStart = Date.now();

    console.log(`\n[${nowIso()}] Channel ${i + 1}/${channels.length}: ${channel.title} (${channel._id})`);

    try {
      const totalVideosInChannel = await Video.countDocuments({ channelId: channel._id, deletedAt: null });
      console.log(`[${nowIso()}]   Videos to scan: ${totalVideosInChannel}`);

      if (totalVideosInChannel === 0) {
        totals.channelsProcessed++;
        continue;
      }

      let processedInChannel = 0;
      let updatedInChannel = 0;
      let unchangedInChannel = 0;
      let failedInChannel = 0;
      let lastId = null;
      let batchNo = 0;

      while (true) {
        const query = { channelId: channel._id, deletedAt: null };
        if (lastId) query._id = { $gt: lastId };

        const batch = await Video.find(query)
          .sort({ _id: 1 })
          .limit(cfg.batchSize)
          .select('_id title description classification youtubeVideoId')
          .lean();

        if (!batch.length) break;

        batchNo++;
        lastId = batch[batch.length - 1]._id;

        const classified = await classifySadguruVideoBatch(
          batch.map((v) => ({
            _id: v._id,
            title: v.title || '',
            description: v.description || '',
          }))
        );

        const ops = [];
        let unchangedInBatch = 0;
        let failedInBatch = 0;
        for (const v of batch) {
          const next = classified.get(String(v._id));
          if (!next) {
            failedInBatch++;
            continue;
          }
          const prev = v.classification || '';
          if (prev !== next) {
            ops.push({
              updateOne: {
                filter: { _id: v._id },
                update: { $set: { classification: next } },
              },
            });
          } else {
            unchangedInBatch++;
          }
        }

        if (!cfg.dryRun && ops.length > 0) {
          await Video.bulkWrite(ops, { ordered: false });
        }

        processedInChannel += batch.length;
        updatedInChannel += ops.length;
        unchangedInChannel += unchangedInBatch;
        failedInChannel += failedInBatch;
        totals.videosScanned += batch.length;
        totals.videosUpdated += ops.length;
        totals.videosUnchanged += unchangedInBatch;
        totals.videosFailed += failedInBatch;

        const elapsed = Date.now() - startedAt;
        const rate = totals.videosScanned > 0 ? totals.videosScanned / Math.max(1, elapsed / 1000) : 0;
        const remainingInChannel = Math.max(0, totalVideosInChannel - processedInChannel);
        const etaSecChannel = rate > 0 ? Math.ceil(remainingInChannel / rate) : 0;

        console.log(
          `[${nowIso()}]   Batch ${batchNo}: scanned=${processedInChannel}/${totalVideosInChannel}, changed=${updatedInChannel}, unchanged~=${processedInChannel - updatedInChannel - failedInChannel}, failed=${failedInChannel}, eta_channel=${fmtMs(etaSecChannel * 1000)}`
        );
      }

      totals.channelsProcessed++;

      const channelElapsed = Date.now() - channelStart;
      console.log(
        `[${nowIso()}]   Channel done in ${fmtMs(channelElapsed)} | scanned=${processedInChannel}, changed=${updatedInChannel}, unchanged=${Math.max(0, processedInChannel - updatedInChannel - failedInChannel)}, failed=${failedInChannel}`
      );
    } catch (err) {
      totals.channelsWithErrors++;
      console.error(`[${nowIso()}]   Channel error: ${err.message}`);
    }

    const elapsed = Date.now() - startedAt;
    const done = i + 1;
    const channelsLeft = channels.length - done;
    const avgPerChannelMs = elapsed / done;
    const etaAll = channelsLeft * avgPerChannelMs;
    console.log(
      `[${nowIso()}] Progress: channels=${done}/${channels.length}, elapsed=${fmtMs(elapsed)}, eta_total=${fmtMs(etaAll)}`
    );
  }

  const totalElapsed = Date.now() - startedAt;
  const summary = {
    ...totals,
    duration: fmtMs(totalElapsed),
    dryRun: cfg.dryRun,
    dbName,
  };

  console.log(`\n[${nowIso()}] Reclassification completed.`);
  console.log(`[${nowIso()}] Summary: ${JSON.stringify(summary, null, 2)}`);

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(`[${nowIso()}] Fatal error:`, err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
