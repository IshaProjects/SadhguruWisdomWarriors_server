import 'dotenv/config';
import mongoose from 'mongoose';
import ChannelSnapshot from '../src/models/ChannelSnapshot.js';
import VideoSnapshot from '../src/models/VideoSnapshot.js';

function toUtcMidnightFromLocalDate(dateValue) {
  const d = new Date(dateValue);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0));
}

function sameTimestamp(a, b) {
  return new Date(a).getTime() === new Date(b).getTime();
}

async function connect() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  const options = {};
  if (process.env.MONGODB_DB_NAME) options.dbName = process.env.MONGODB_DB_NAME;
  await mongoose.connect(uri, options);
}

async function migrateChannelSnapshots() {
  let scanned = 0;
  let updated = 0;
  let merged = 0;

  for await (const doc of ChannelSnapshot.find({}).cursor()) {
    scanned++;
    const targetDate = toUtcMidnightFromLocalDate(doc.date);
    if (sameTimestamp(doc.date, targetDate)) continue;

    const duplicate = await ChannelSnapshot.findOne({
      _id: { $ne: doc._id },
      channelId: doc.channelId,
      date: targetDate,
    });

    if (duplicate) {
      await ChannelSnapshot.findByIdAndUpdate(duplicate._id, {
        subscribers: Math.max(duplicate.subscribers || 0, doc.subscribers || 0),
        views: Math.max(duplicate.views || 0, doc.views || 0),
        videoCount: Math.max(duplicate.videoCount || 0, doc.videoCount || 0),
        deletedAt: duplicate.deletedAt ?? doc.deletedAt ?? null,
      });
      await ChannelSnapshot.deleteOne({ _id: doc._id });
      merged++;
      continue;
    }

    await ChannelSnapshot.updateOne({ _id: doc._id }, { $set: { date: targetDate } });
    updated++;
  }

  return { scanned, updated, merged };
}

async function migrateVideoSnapshots() {
  let scanned = 0;
  let updated = 0;
  let merged = 0;

  for await (const doc of VideoSnapshot.find({}).cursor()) {
    scanned++;
    const targetDate = toUtcMidnightFromLocalDate(doc.date);
    if (sameTimestamp(doc.date, targetDate)) continue;

    const duplicate = await VideoSnapshot.findOne({
      _id: { $ne: doc._id },
      videoId: doc.videoId,
      date: targetDate,
    });

    if (duplicate) {
      await VideoSnapshot.findByIdAndUpdate(duplicate._id, {
        views: Math.max(duplicate.views || 0, doc.views || 0),
        likes: Math.max(duplicate.likes || 0, doc.likes || 0),
        comments: Math.max(duplicate.comments || 0, doc.comments || 0),
        deletedAt: duplicate.deletedAt ?? doc.deletedAt ?? null,
      });
      await VideoSnapshot.deleteOne({ _id: doc._id });
      merged++;
      continue;
    }

    await VideoSnapshot.updateOne({ _id: doc._id }, { $set: { date: targetDate } });
    updated++;
  }

  return { scanned, updated, merged };
}

async function run() {
  await connect();
  console.log('Connected. Starting UTC snapshot migration...');

  const channelStats = await migrateChannelSnapshots();
  console.log('[ChannelSnapshot]', channelStats);

  const videoStats = await migrateVideoSnapshots();
  console.log('[VideoSnapshot]', videoStats);

  console.log('UTC snapshot migration complete.');
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error('Migration failed:', err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
