// Vitest setup for Prisma-backed test files (Phase 4 of Mongo→Postgres migration).
//
// Boots a per-process embedded Postgres instance, applies the same Prisma
// migration that runs against production, exposes a single PrismaClient
// pointed at it, and TRUNCATEs every domain table between tests so each test
// starts from a known-empty DB — mirrors the mongodb-memory-server pattern in
// test/setup.js exactly.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret';
process.env.JWT_EXPIRE = '15m';
process.env.JWT_REFRESH_EXPIRE = '7d';

import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { beforeAll, afterEach, afterAll } from 'vitest';
import { prisma, disconnectPrisma } from '../src/config/prisma.js';

export { prisma };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'prisma', 'migrations');

// Per-process port so parallel Vitest workers don't collide.
const PORT = 54000 + Math.floor(Math.random() * 1000) + (process.pid % 500);

let pg;
let dataDir;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'epg-test-'));
  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'pw',
    port: PORT,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('test');

  const url = `postgresql://postgres:pw@127.0.0.1:${PORT}/test`;
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;

  // Apply every migration in order, one statement at a time (Prisma's
  // migration files are valid SQL but we use the raw connection here so we
  // don't need to spawn `prisma migrate deploy`).
  const adminClient = pg.getPgClient();
  await adminClient.connect();
  try {
    await adminClient.query('GRANT ALL ON DATABASE test TO postgres');
  } catch {
    // ignore
  } finally {
    await adminClient.end();
  }

  const dbClient = new (await import('pg')).Client({ connectionString: url });
  await dbClient.connect();
  const migDirs = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f !== 'migration_lock.toml')
    .sort();
  for (const dir of migDirs) {
    const sqlPath = path.join(MIGRATIONS_DIR, dir, 'migration.sql');
    const sql = readFileSync(sqlPath, 'utf8');
    await dbClient.query(sql);
  }
  await dbClient.end();

  // Prisma client is lazy and reads DATABASE_URL at first call, which is the
  // env var we just set above.
  await prisma.$connect();
}, 60000);

afterEach(async () => {
  // Truncate every domain table to wipe state. Snapshots have FKs to their
  // parents; CASCADE makes the order irrelevant. `_prisma_migrations` is left
  // alone — the schema persists for the whole process lifetime.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "video_snapshots",
      "channel_snapshots",
      "micro_unit_channels",
      "micro_units",
      "videos",
      "channels",
      "categories",
      "video_queue_items",
      "sync_logs",
      "users"
    RESTART IDENTITY CASCADE
  `);
  // Singletons get reset to a known-empty state (no row) for tests that
  // explicitly seed them; otherwise leave them absent.
  await prisma.$executeRawUnsafe('DELETE FROM "sync_config"');
  await prisma.$executeRawUnsafe('DELETE FROM "rbac_config"');
  await prisma.$executeRawUnsafe('DELETE FROM "dashboard_layout"');
});

afterAll(async () => {
  await disconnectPrisma();
  if (pg) await pg.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});
