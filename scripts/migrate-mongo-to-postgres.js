#!/usr/bin/env node
/* eslint-disable no-console */

// Mongo → Postgres ETL.
//
// Reads each Mongoose collection from Atlas (or any reachable Mongo URI) via the
// native `mongodb` driver, transforms documents to the Prisma row shape, and
// writes them to Postgres with `prisma.x.createMany({ skipDuplicates: true })`.
// Idempotent — every row's primary key is the Mongo _id hex string, so a re-run
// silently skips already-inserted rows on the PK collision.
//
// Insert order respects FK dependencies:
//   users → categories → channels → videos → channel_snapshots →
//   video_snapshots → micro_units → micro_unit_channels → singletons →
//   video_queue_items → sync_logs.
//
// Singletons (sync_config, rbac_config, dashboard_layout) are upserted on a
// fixed-string id ("sync" / "rbac" / "layout") because they are not keyed by
// the Mongo ObjectId in Postgres.
//
// Connection requirements:
//   MONGODB_URI       — source (read-only operations only)
//   MONGODB_DB_NAME   — optional, overrides the database in MONGODB_URI
//   DIRECT_URL        — Postgres direct (port 5432) — NOT the pgbouncer pooler;
//                       large batched writes hit pooler row-limit issues.
//
// Usage:
//   node scripts/migrate-mongo-to-postgres.js                  # full migration
//   node scripts/migrate-mongo-to-postgres.js --dry-run        # counts only
//   node scripts/migrate-mongo-to-postgres.js --collections=channels,videos
//   node scripts/migrate-mongo-to-postgres.js --batch=2000

import 'dotenv/config';

import { MongoClient, ObjectId } from 'mongodb';
import { PrismaClient } from '@prisma/client';

/* ─────────────────────────────────────────────────────────────────────
   CLI
───────────────────────────────────────────────────────────────────── */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);
const DRY_RUN = args['dry-run'] === 'true';
const BATCH = Math.max(100, parseInt(args.batch, 10) || 5000);
const COLLECTIONS_FILTER = args.collections
  ? new Set(args.collections.split(','))
  : null;

function shouldRun(name) {
  return !COLLECTIONS_FILTER || COLLECTIONS_FILTER.has(name);
}

/* ─────────────────────────────────────────────────────────────────────
   Transform helpers
───────────────────────────────────────────────────────────────────── */

function toIdString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (v instanceof ObjectId) return v.toHexString();
  if (typeof v?.toHexString === 'function') return v.toHexString();
  return String(v);
}

function bigIntOf(n) {
  if (typeof n === 'bigint') return n;
  const num = Number(n);
  if (!Number.isFinite(num) || num < 0) return 0n;
  return BigInt(Math.trunc(num));
}

function intOf(n) {
  const num = Number(n);
  return Number.isFinite(num) ? Math.trunc(num) : 0;
}

function dateOr(d, fallback = new Date()) {
  if (!d) return fallback;
  return d instanceof Date ? d : new Date(d);
}

function boolOf(v) {
  return v === true;
}

/* ─────────────────────────────────────────────────────────────────────
   Streaming batched insert
───────────────────────────────────────────────────────────────────── */

async function streamInsert(prisma, mongo, label, collectionName, modelName, filter, mapRow) {
  const startedAt = Date.now();
  const collection = mongo.collection(collectionName);
  const cursor = collection.find(filter ?? {}, { batchSize: BATCH });

  let buffer = [];
  let read = 0;
  let dropped = 0;
  let inserted = 0;

  const flush = async () => {
    if (!buffer.length) return;
    if (DRY_RUN) {
      inserted += buffer.length;
    } else {
      const res = await prisma[modelName].createMany({
        data: buffer,
        skipDuplicates: true,
      });
      inserted += res.count;
    }
    buffer = [];
  };

  for await (const doc of cursor) {
    read += 1;
    const row = mapRow(doc);
    if (row === null) {
      dropped += 1;
      continue;
    }
    buffer.push(row);
    if (buffer.length >= BATCH) {
      await flush();
      process.stdout.write(`  [${label}] ${read} read · ${inserted} written\r`);
    }
  }
  await flush();
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const droppedNote = dropped ? ` · ${dropped} dropped (orphaned FK)` : '';
  console.log(`  [${label}] ${read} read · ${inserted} written${droppedNote} · ${elapsed}s`);
  return { read, inserted, dropped };
}

/* ─────────────────────────────────────────────────────────────────────
   Per-collection migrations
───────────────────────────────────────────────────────────────────── */

async function migrateUsers(prisma, mongo) {
  const validIds = new Set();
  await streamInsert(prisma, mongo, 'users', 'users', 'user', null, (d) => {
    const id = toIdString(d._id);
    validIds.add(id);
    return {
      id,
      email: d.email,
      password: d.password ?? '',
      name: d.name ?? '',
      role: d.role ?? 'viewer',
      refreshToken: d.refreshToken ?? null,
      createdAt: dateOr(d.createdAt),
      updatedAt: dateOr(d.updatedAt),
    };
  });
  return validIds;
}

async function migrateCategories(prisma, mongo) {
  await streamInsert(prisma, mongo, 'categories', 'categories', 'category', null, (d) => ({
    id: toIdString(d._id),
    name: d.name,
    createdAt: dateOr(d.createdAt),
    updatedAt: dateOr(d.updatedAt),
  }));
}

async function migrateChannels(prisma, mongo, validUserIds) {
  const validIds = new Set();
  await streamInsert(prisma, mongo, 'channels', 'channels', 'channel', null, (d) => {
    const id = toIdString(d._id);
    validIds.add(id);
    const assignedToId = toIdString(d.assignedTo);
    return {
      id,
      youtubeChannelId: d.youtubeChannelId,
      title: d.title ?? '',
      description: d.description ?? '',
      thumbnailUrl: d.thumbnailUrl ?? '',
      bannerUrl: d.bannerUrl ?? '',
      customUrl: d.customUrl ?? '',
      country: d.country ?? '',
      publishedAt: d.publishedAt ?? null,
      uploadsPlaylistId: d.uploadsPlaylistId ?? '',
      category: d.category ?? 'Uncategorized',
      tags: Array.isArray(d.tags) ? d.tags.filter((t) => typeof t === 'string') : [],
      assignedToId: assignedToId && validUserIds.has(assignedToId) ? assignedToId : null,
      status: d.status ?? 'active',
      notes: d.notes ?? '',
      currentSubscribers: intOf(d.currentStats?.subscribers),
      currentViews: bigIntOf(d.currentStats?.views),
      currentVideoCount: intOf(d.currentStats?.videoCount),
      lastSyncedAt: d.lastSyncedAt ?? null,
      allVideosPulled: boolOf(d.allVideosPulled),
      autoArchivedForInactivity: boolOf(d.autoArchivedForInactivity),
      deletedAt: d.deletedAt ?? null,
      createdAt: dateOr(d.createdAt),
      updatedAt: dateOr(d.updatedAt),
    };
  });
  return validIds;
}

async function migrateVideos(prisma, mongo, validChannelIds) {
  const validIds = new Set();
  await streamInsert(prisma, mongo, 'videos', 'videos', 'video', null, (d) => {
    const channelId = toIdString(d.channelId);
    if (!validChannelIds.has(channelId)) return null; // orphan — channel was hard-deleted
    const id = toIdString(d._id);
    validIds.add(id);
    return {
      id,
      youtubeVideoId: d.youtubeVideoId,
      channelId,
      title: d.title ?? '',
      description: d.description ?? '',
      thumbnailUrl: d.thumbnailUrl ?? '',
      publishedAt: d.publishedAt ?? null,
      views: bigIntOf(d.views),
      likes: intOf(d.likes),
      comments: intOf(d.comments),
      duration: d.duration ?? '',
      lastSyncedAt: d.lastSyncedAt ?? null,
      deletedAt: d.deletedAt ?? null,
      classification: typeof d.classification === 'string' ? d.classification : '',
      createdAt: dateOr(d.createdAt),
      updatedAt: dateOr(d.updatedAt),
    };
  });
  return validIds;
}

async function migrateChannelSnapshots(prisma, mongo, validChannelIds) {
  await streamInsert(prisma, mongo, 'channel_snapshots', 'channelsnapshots', 'channelSnapshot', null, (d) => {
    const channelId = toIdString(d.channelId);
    if (!validChannelIds.has(channelId)) return null;
    return {
      id: toIdString(d._id),
      channelId,
      date: dateOr(d.date),
      subscribers: intOf(d.subscribers),
      views: bigIntOf(d.views),
      videoCount: intOf(d.videoCount),
      deletedAt: d.deletedAt ?? null,
      createdAt: dateOr(d.createdAt),
      updatedAt: dateOr(d.updatedAt),
    };
  });
}

async function migrateVideoSnapshots(prisma, mongo, validVideoIds, validChannelIds) {
  await streamInsert(prisma, mongo, 'video_snapshots', 'videosnapshots', 'videoSnapshot', null, (d) => {
    const videoId = toIdString(d.videoId);
    const channelId = toIdString(d.channelId);
    if (!validVideoIds.has(videoId) || !validChannelIds.has(channelId)) return null;
    return {
      id: toIdString(d._id),
      videoId,
      channelId,
      date: dateOr(d.date),
      views: bigIntOf(d.views),
      likes: intOf(d.likes),
      comments: intOf(d.comments),
      deletedAt: d.deletedAt ?? null,
      createdAt: dateOr(d.createdAt),
      updatedAt: dateOr(d.updatedAt),
    };
  });
}

async function migrateMicroUnits(prisma, mongo, validChannelIds) {
  const muDocs = await mongo.collection('microunits').find({}).toArray();
  const muRows = muDocs.map((d) => ({
    id: toIdString(d._id),
    name: d.name,
    notes: d.notes ?? '',
    createdAt: dateOr(d.createdAt),
    updatedAt: dateOr(d.updatedAt),
  }));

  let muInserted = 0;
  if (!DRY_RUN && muRows.length) {
    const res = await prisma.microUnit.createMany({ data: muRows, skipDuplicates: true });
    muInserted = res.count;
  } else {
    muInserted = muRows.length;
  }
  console.log(`  [micro_units] ${muRows.length} read · ${muInserted} written`);

  // Junction rows. Skip channelIds that don't exist in Postgres.
  const junctionRows = [];
  for (const d of muDocs) {
    const microUnitId = toIdString(d._id);
    if (!Array.isArray(d.channelIds)) continue;
    for (const c of d.channelIds) {
      const channelId = toIdString(c);
      if (channelId && validChannelIds.has(channelId)) {
        junctionRows.push({ microUnitId, channelId });
      }
    }
  }

  let junctionInserted = 0;
  if (!DRY_RUN && junctionRows.length) {
    for (let i = 0; i < junctionRows.length; i += BATCH) {
      const res = await prisma.microUnitChannel.createMany({
        data: junctionRows.slice(i, i + BATCH),
        skipDuplicates: true,
      });
      junctionInserted += res.count;
    }
  } else {
    junctionInserted = junctionRows.length;
  }
  console.log(`  [micro_unit_channels] ${junctionRows.length} edges · ${junctionInserted} written`);
}

async function migrateVideoQueue(prisma, mongo) {
  await streamInsert(prisma, mongo, 'video_queue_items', 'videoqueueitems', 'videoQueueItem', null, (d) => ({
    id: toIdString(d._id),
    url: d.url,
    title: d.title ?? '',
    videoType: d.videoType ?? 'normal',
    eventName: d.eventName ?? '',
    notes: d.notes ?? '',
    priority: d.priority ?? 'normal',
    status: d.status ?? 'queued',
    errorMessage: d.errorMessage ?? '',
    addedBy: d.addedBy ?? '',
    startedAt: d.startedAt ?? null,
    completedAt: d.completedAt ?? null,
    createdAt: dateOr(d.createdAt),
    updatedAt: dateOr(d.updatedAt),
  }));
}

async function migrateSyncLogs(prisma, mongo) {
  await streamInsert(prisma, mongo, 'sync_logs', 'synclogs', 'syncLog', null, (d) => ({
    id: toIdString(d._id),
    syncType: d.syncType ?? 'channel',
    type: d.type, // required field — no default
    status: d.status ?? 'running',
    channelsProcessed: intOf(d.channelsProcessed),
    videosProcessed: intOf(d.videosProcessed),
    quotaUsed: intOf(d.quotaUsed),
    // Mongo embedded array items get auto-_id; strip and persist as plain {channelId,message}.
    errors: Array.isArray(d.errors)
      ? d.errors.map((e) => ({
          channelId: e?.channelId ?? null,
          message: e?.message ?? '',
        }))
      : [],
    startedAt: dateOr(d.startedAt),
    completedAt: d.completedAt ?? null,
  }));
}

/* ─────────────────────────────────────────────────────────────────────
   Singletons — upsert on fixed id
───────────────────────────────────────────────────────────────────── */

async function migrateSyncConfig(prisma, mongo) {
  const doc = await mongo.collection('syncconfigs').findOne({ _singletonKey: 'sync' });
  if (!doc) {
    console.log('  [sync_config] no source doc — leaving Postgres default');
    return;
  }
  const data = {
    channelSyncSchedule: doc.channelSyncSchedule ?? '0 3 * * *',
    videoSyncSchedule: doc.videoSyncSchedule ?? '0 4 * * *',
    dedicatedIngestSchedule: doc.dedicatedIngestSchedule ?? '0 0 * * *',
    ihiIngestSchedule: doc.ihiIngestSchedule ?? '0 */6 * * *',
    ihiSadhguruStatsSchedule: doc.ihiSadhguruStatsSchedule ?? '0 5 * * *',
    channelSyncEnabled: doc.channelSyncEnabled !== false,
    videoSyncEnabled: doc.videoSyncEnabled !== false,
    dedicatedIngestEnabled: doc.dedicatedIngestEnabled !== false,
    ihiIngestEnabled: doc.ihiIngestEnabled !== false,
    ihiSadhguruStatsEnabled: doc.ihiSadhguruStatsEnabled !== false,
    inactivityThresholdDays: intOf(doc.inactivityThresholdDays ?? 14),
    createdAt: dateOr(doc.createdAt),
    updatedAt: dateOr(doc.updatedAt),
  };
  if (DRY_RUN) {
    console.log('  [sync_config] (dry-run) would upsert');
    return;
  }
  await prisma.syncConfig.upsert({
    where: { id: 'sync' },
    update: data,
    create: { id: 'sync', ...data },
  });
  console.log('  [sync_config] upserted');
}

function stripEmbeddedIds(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const { _id, ...rest } = entry; // eslint-disable-line no-unused-vars
    return rest;
  });
}

async function migrateRbacConfig(prisma, mongo) {
  const doc = await mongo.collection('rbacconfigs').findOne({ _singletonKey: 'rbac' });
  if (!doc) {
    console.log('  [rbac_config] no source doc — leaving Postgres default');
    return;
  }
  const data = {
    pages: stripEmbeddedIds(doc.pages),
    actions: stripEmbeddedIds(doc.actions),
    createdAt: dateOr(doc.createdAt),
    updatedAt: dateOr(doc.updatedAt),
  };
  if (DRY_RUN) {
    console.log('  [rbac_config] (dry-run) would upsert');
    return;
  }
  await prisma.rbacConfig.upsert({
    where: { id: 'rbac' },
    update: data,
    create: { id: 'rbac', ...data },
  });
  console.log('  [rbac_config] upserted');
}

async function migrateDashboardLayout(prisma, mongo) {
  // No singleton key on this collection — take the most recently updated row.
  const doc = await mongo
    .collection('dashboardlayouts')
    .find({})
    .sort({ updatedAt: -1 })
    .limit(1)
    .next();
  if (!doc) {
    console.log('  [dashboard_layout] no source doc — leaving Postgres default');
    return;
  }
  const data = {
    layouts: doc.layouts && typeof doc.layouts === 'object' ? doc.layouts : {},
    updatedBy: doc.updatedBy ?? '',
    createdAt: dateOr(doc.createdAt),
    updatedAt: dateOr(doc.updatedAt),
  };
  if (DRY_RUN) {
    console.log('  [dashboard_layout] (dry-run) would upsert');
    return;
  }
  await prisma.dashboardLayout.upsert({
    where: { id: 'layout' },
    update: data,
    create: { id: 'layout', ...data },
  });
  console.log('  [dashboard_layout] upserted');
}

/* ─────────────────────────────────────────────────────────────────────
   Post-flight: assert row counts
───────────────────────────────────────────────────────────────────── */

async function assertCounts(prisma, mongo) {
  const pairs = [
    ['users', 'users', 'user'],
    ['categories', 'categories', 'category'],
    ['channels', 'channels', 'channel'],
    ['videos', 'videos', 'video'],
    ['channelsnapshots', 'channel_snapshots', 'channelSnapshot'],
    ['videosnapshots', 'video_snapshots', 'videoSnapshot'],
    ['microunits', 'micro_units', 'microUnit'],
    ['videoqueueitems', 'video_queue_items', 'videoQueueItem'],
    ['synclogs', 'sync_logs', 'syncLog'],
  ];
  console.log('\nRow count parity (Mongo vs Postgres):');
  let drift = 0;
  for (const [mongoCol, pgLabel, prismaModel] of pairs) {
    const [m, p] = await Promise.all([
      mongo.collection(mongoCol).countDocuments(),
      prisma[prismaModel].count(),
    ]);
    const flag = m === p ? '✓' : '✗';
    if (m !== p) drift += 1;
    console.log(`  ${flag} ${pgLabel.padEnd(20)} mongo=${m}  postgres=${p}`);
  }
  if (drift) {
    console.log(`\n  ⚠ ${drift} table(s) drifted — common causes: orphaned FK rows dropped during ETL, or a re-run with skipDuplicates.`);
  } else {
    console.log('\n  All tables match.');
  }
}

/* ─────────────────────────────────────────────────────────────────────
   Main
───────────────────────────────────────────────────────────────────── */

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  const mongoDbName = process.env.MONGODB_DB_NAME;
  if (!mongoUri) throw new Error('MONGODB_URI is required');
  if (!process.env.DIRECT_URL && !process.env.DATABASE_URL) {
    throw new Error('DIRECT_URL (preferred) or DATABASE_URL is required');
  }

  console.log(`\nMongo → Postgres ETL`);
  console.log(`  batch size : ${BATCH}`);
  console.log(`  dry-run    : ${DRY_RUN}`);
  console.log(`  collections: ${COLLECTIONS_FILTER ? [...COLLECTIONS_FILTER].join(',') : 'all'}\n`);

  const mongoClient = new MongoClient(mongoUri);
  await mongoClient.connect();
  const mongo = mongoClient.db(mongoDbName);

  // Force DIRECT_URL for the ETL — large batched writes choke on the pgbouncer pooler.
  const prisma = new PrismaClient({
    datasources: {
      db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL },
    },
  });
  await prisma.$connect();

  try {
    let validUserIds = new Set();
    let validChannelIds = new Set();
    let validVideoIds = new Set();

    if (shouldRun('users')) validUserIds = await migrateUsers(prisma, mongo);
    if (shouldRun('categories')) await migrateCategories(prisma, mongo);

    if (shouldRun('channels')) {
      // If --collections skips users, we still need their ids for the assignedTo FK.
      if (!validUserIds.size) {
        const ids = await prisma.user.findMany({ select: { id: true } });
        validUserIds = new Set(ids.map((u) => u.id));
      }
      validChannelIds = await migrateChannels(prisma, mongo, validUserIds);
    }

    if (shouldRun('videos')) {
      if (!validChannelIds.size) {
        const ids = await prisma.channel.findMany({ select: { id: true } });
        validChannelIds = new Set(ids.map((c) => c.id));
      }
      validVideoIds = await migrateVideos(prisma, mongo, validChannelIds);
    }

    if (shouldRun('channel_snapshots')) {
      if (!validChannelIds.size) {
        const ids = await prisma.channel.findMany({ select: { id: true } });
        validChannelIds = new Set(ids.map((c) => c.id));
      }
      await migrateChannelSnapshots(prisma, mongo, validChannelIds);
    }

    if (shouldRun('video_snapshots')) {
      if (!validChannelIds.size) {
        const ids = await prisma.channel.findMany({ select: { id: true } });
        validChannelIds = new Set(ids.map((c) => c.id));
      }
      if (!validVideoIds.size) {
        const ids = await prisma.video.findMany({ select: { id: true } });
        validVideoIds = new Set(ids.map((v) => v.id));
      }
      await migrateVideoSnapshots(prisma, mongo, validVideoIds, validChannelIds);
    }

    if (shouldRun('micro_units')) {
      if (!validChannelIds.size) {
        const ids = await prisma.channel.findMany({ select: { id: true } });
        validChannelIds = new Set(ids.map((c) => c.id));
      }
      await migrateMicroUnits(prisma, mongo, validChannelIds);
    }

    if (shouldRun('sync_config')) await migrateSyncConfig(prisma, mongo);
    if (shouldRun('rbac_config')) await migrateRbacConfig(prisma, mongo);
    if (shouldRun('dashboard_layout')) await migrateDashboardLayout(prisma, mongo);

    if (shouldRun('video_queue_items')) await migrateVideoQueue(prisma, mongo);
    if (shouldRun('sync_logs')) await migrateSyncLogs(prisma, mongo);

    if (!COLLECTIONS_FILTER) {
      await assertCounts(prisma, mongo);
    }
  } finally {
    await prisma.$disconnect();
    await mongoClient.close();
  }
}

main().catch((err) => {
  console.error('\nETL FAILED:', err);
  process.exitCode = 1;
});
