import request from 'supertest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock external modules BEFORE importing app ────────────────────────────
vi.mock('../../src/services/syncEngine.js', () => ({
  getSyncStatus: vi.fn(() => ({
    isChannelSyncing: false,
    isVideoSyncing: false,
    isDedicatedIngestSyncing: false,
    isIhiIngestSyncing: false,
    isIhiSadhguruStatsSyncing: false,
    isPullingAllVideos: false,
  })),
  syncChannelStats: vi.fn(async () => ({ id: 'log-1', syncType: 'channel', status: 'running' })),
  syncVideoStats: vi.fn(async () => ({ id: 'log-2', syncType: 'video', status: 'running' })),
  syncDedicatedIngestLast24h: vi.fn(async () => ({ id: 'log-3', syncType: 'dedicated_ingest', status: 'running' })),
  syncIhiIngestLast24h: vi.fn(async () => ({ id: 'log-4', syncType: 'ihi_ingest', status: 'running' })),
  syncIhiSadhguruVideoStats: vi.fn(async () => ({ id: 'log-5', syncType: 'ihi_sadhguru_stats', status: 'running' })),
}));

vi.mock('../../src/services/youtubeApi.js', () => ({
  getQuotaUsage: vi.fn(() => ({ used: 0, limit: 10000, remaining: 10000 })),
}));

vi.mock('../../src/jobs/syncScheduler.js', () => ({
  scheduleChannelSync: vi.fn(),
  scheduleVideoSync: vi.fn(),
  scheduleDedicatedIngest: vi.fn(),
  scheduleIhiIngest: vi.fn(),
  scheduleIhiSadhguruStats: vi.fn(),
}));

import app from '../../src/app.js';
import { prisma } from '../setup.js';
import {
  syncChannelStats,
  syncVideoStats,
  syncDedicatedIngestLast24h,
  syncIhiIngestLast24h,
  syncIhiSadhguruVideoStats,
} from '../../src/services/syncEngine.js';
import {
  scheduleChannelSync,
  scheduleVideoSync,
  scheduleDedicatedIngest,
  scheduleIhiIngest,
  scheduleIhiSadhguruStats,
} from '../../src/jobs/syncScheduler.js';
import { authFor } from '../helpers.js';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────────
// GET /api/sync/status
// ────────────────────────────────────────────────────────────────────────
describe('GET /api/sync/status', () => {
  it('200 — returns sync status + quota + normalized config (viewer allowed)', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/sync/status').set(headers);

    expect(res.status).toBe(200);
    expect(res.body.isChannelSyncing).toBe(false);
    expect(res.body.quota).toEqual({ used: 0, limit: 10000, remaining: 10000 });
    expect(res.body.config).toBeDefined();
    expect(res.body.config.dedicatedIngestSchedule).toBe('0 0 * * *');
    expect(res.body.config.ihiIngestSchedule).toBe('0 */6 * * *');
    expect(res.body.config.ihiSadhguruStatsSchedule).toBe('0 5 * * *');
    expect(res.body.config.dedicatedIngestEnabled).toBe(true);
    expect(res.body.config.ihiIngestEnabled).toBe(true);
    expect(res.body.config.ihiSadhguruStatsEnabled).toBe(true);
  });

  it('200 — normalizeConfigDoc: plain object input + null schedules + false enabled flags', async () => {
    // Stub the singleton fetch (prisma.syncConfig.upsert) to return a plain
    // object with explicit nulls / falses.
    vi.spyOn(prisma.syncConfig, 'upsert').mockResolvedValueOnce({
      dedicatedIngestSchedule: null,
      ihiIngestSchedule: null,
      ihiSadhguruStatsSchedule: null,
      dedicatedIngestEnabled: false,
      ihiIngestEnabled: false,
      ihiSadhguruStatsEnabled: false,
    });

    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/sync/status').set(headers);

    expect(res.status).toBe(200);
    // `||` should kick in with the defaults
    expect(res.body.config.dedicatedIngestSchedule).toBe('0 0 * * *');
    expect(res.body.config.ihiIngestSchedule).toBe('0 */6 * * *');
    expect(res.body.config.ihiSadhguruStatsSchedule).toBe('0 5 * * *');
    // explicit false → false
    expect(res.body.config.dedicatedIngestEnabled).toBe(false);
    expect(res.body.config.ihiIngestEnabled).toBe(false);
    expect(res.body.config.ihiSadhguruStatsEnabled).toBe(false);
  });

  it('200 — normalizeConfigDoc: plain object with undefined enabled flags treated as true', async () => {
    vi.spyOn(prisma.syncConfig, 'upsert').mockResolvedValueOnce({
      dedicatedIngestSchedule: '0 2 * * *',
      ihiIngestSchedule: '0 7 * * *',
      ihiSadhguruStatsSchedule: '0 8 * * *',
      // enabled flags intentionally absent
    });

    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/sync/status').set(headers);

    expect(res.status).toBe(200);
    expect(res.body.config.dedicatedIngestSchedule).toBe('0 2 * * *');
    expect(res.body.config.ihiIngestSchedule).toBe('0 7 * * *');
    expect(res.body.config.ihiSadhguruStatsSchedule).toBe('0 8 * * *');
    expect(res.body.config.dedicatedIngestEnabled).toBe(true);
    expect(res.body.config.ihiIngestEnabled).toBe(true);
    expect(res.body.config.ihiSadhguruStatsEnabled).toBe(true);
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app).get('/api/sync/status');
    expect(res.status).toBe(401);
  });
});

// ────────────────────────────────────────────────────────────────────────
// GET /api/sync/logs
// ────────────────────────────────────────────────────────────────────────
describe('GET /api/sync/logs', () => {
  it('200 — returns paginated logs (defaults: page=1, limit=15)', async () => {
    await prisma.syncLog.create({ data: { syncType: 'channel', type: 'manual', status: 'success' } });
    await prisma.syncLog.create({ data: { syncType: 'video', type: 'manual', status: 'success' } });

    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/sync/logs').set(headers);

    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(2);
    expect(res.body.pagination.page).toBe(1);
    expect(res.body.pagination.limit).toBe(15);
    expect(res.body.pagination.total).toBe(2);
    expect(res.body.pagination.pages).toBe(1);
  });

  it('200 — filters by syncType', async () => {
    await prisma.syncLog.create({ data: { syncType: 'channel', type: 'manual', status: 'success' } });
    await prisma.syncLog.create({ data: { syncType: 'video', type: 'manual', status: 'success' } });

    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/sync/logs?syncType=channel').set(headers);

    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0].syncType).toBe('channel');
    expect(res.body.pagination.total).toBe(1);
  });

  it('200 — honors page and limit query params', async () => {
    for (let i = 0; i < 5; i++) {
      await prisma.syncLog.create({ data: { syncType: 'channel', type: 'manual', status: 'success' } });
    }
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/sync/logs?page=2&limit=2').set(headers);

    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(2);
    expect(res.body.pagination.page).toBe(2);
    expect(res.body.pagination.limit).toBe(2);
    expect(res.body.pagination.total).toBe(5);
    expect(res.body.pagination.pages).toBe(3);
  });

  it('500 — DB error in getLogs triggers next(err)', async () => {
    vi.spyOn(prisma.syncLog, 'findMany').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/sync/logs').set(headers);
    expect(res.status).toBe(500);
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app).get('/api/sync/logs');
    expect(res.status).toBe(401);
  });
});

// ────────────────────────────────────────────────────────────────────────
// POST /api/sync/channels/trigger
// ────────────────────────────────────────────────────────────────────────
describe('POST /api/sync/channels/trigger', () => {
  it('200 — admin can trigger channel sync', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).post('/api/sync/channels/trigger').set(headers);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Channel sync started');
    expect(syncChannelStats).toHaveBeenCalledWith(null, 'manual');
  });

  it('200 — manager can trigger channel sync', async () => {
    const { headers } = await authFor('manager');
    const res = await request(app).post('/api/sync/channels/trigger').set(headers);
    expect(res.status).toBe(200);
  });

  it('403 — viewer cannot trigger', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).post('/api/sync/channels/trigger').set(headers);
    expect(res.status).toBe(403);
  });

  it('409 — already in progress', async () => {
    syncChannelStats.mockRejectedValueOnce(new Error('Channel sync already in progress'));
    const { headers } = await authFor('admin');
    const res = await request(app).post('/api/sync/channels/trigger').set(headers);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Channel sync already in progress');
  });

  it('500 — other engine error falls through to next(err)', async () => {
    syncChannelStats.mockRejectedValueOnce(new Error('network down'));
    const { headers } = await authFor('admin');
    const res = await request(app).post('/api/sync/channels/trigger').set(headers);
    expect(res.status).toBe(500);
  });
});

// ────────────────────────────────────────────────────────────────────────
// POST /api/sync/videos/trigger
// ────────────────────────────────────────────────────────────────────────
describe('POST /api/sync/videos/trigger', () => {
  it('200 — admin can trigger dedicated video sync', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).post('/api/sync/videos/trigger').set(headers);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Dedicated video sync started');
    expect(syncVideoStats).toHaveBeenCalledWith(null, 'manual');
  });

  it('200 — manager allowed', async () => {
    const { headers } = await authFor('manager');
    const res = await request(app).post('/api/sync/videos/trigger').set(headers);
    expect(res.status).toBe(200);
  });

  it('403 — viewer forbidden', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).post('/api/sync/videos/trigger').set(headers);
    expect(res.status).toBe(403);
  });

  it('409 — already in progress', async () => {
    syncVideoStats.mockRejectedValueOnce(new Error('Video sync already in progress'));
    const { headers } = await authFor('admin');
    const res = await request(app).post('/api/sync/videos/trigger').set(headers);
    expect(res.status).toBe(409);
  });

  it('500 — generic error', async () => {
    syncVideoStats.mockRejectedValueOnce(new Error('kaboom'));
    const { headers } = await authFor('admin');
    const res = await request(app).post('/api/sync/videos/trigger').set(headers);
    expect(res.status).toBe(500);
  });
});

// ────────────────────────────────────────────────────────────────────────
// POST /api/sync/dedicated/ingest/trigger
// ────────────────────────────────────────────────────────────────────────
describe('POST /api/sync/dedicated/ingest/trigger', () => {
  it('200 — admin can trigger', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).post('/api/sync/dedicated/ingest/trigger').set(headers);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Dedicated ingest sync started');
    expect(syncDedicatedIngestLast24h).toHaveBeenCalledWith(null, 'manual');
  });

  it('403 — viewer forbidden', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).post('/api/sync/dedicated/ingest/trigger').set(headers);
    expect(res.status).toBe(403);
  });

  it('409 — already in progress', async () => {
    syncDedicatedIngestLast24h.mockRejectedValueOnce(
      new Error('Dedicated ingest already in progress')
    );
    const { headers } = await authFor('admin');
    const res = await request(app).post('/api/sync/dedicated/ingest/trigger').set(headers);
    expect(res.status).toBe(409);
  });

  it('500 — generic error', async () => {
    syncDedicatedIngestLast24h.mockRejectedValueOnce(new Error('explode'));
    const { headers } = await authFor('admin');
    const res = await request(app).post('/api/sync/dedicated/ingest/trigger').set(headers);
    expect(res.status).toBe(500);
  });
});

// ────────────────────────────────────────────────────────────────────────
// POST /api/sync/ihi/ingest/trigger
// ────────────────────────────────────────────────────────────────────────
describe('POST /api/sync/ihi/ingest/trigger', () => {
  it('200 — admin can trigger', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).post('/api/sync/ihi/ingest/trigger').set(headers);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('IHI ingest sync started');
    expect(syncIhiIngestLast24h).toHaveBeenCalledWith(null, 'manual');
  });

  it('403 — viewer forbidden', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).post('/api/sync/ihi/ingest/trigger').set(headers);
    expect(res.status).toBe(403);
  });

  it('409 — already in progress', async () => {
    syncIhiIngestLast24h.mockRejectedValueOnce(new Error('IHI ingest already in progress'));
    const { headers } = await authFor('admin');
    const res = await request(app).post('/api/sync/ihi/ingest/trigger').set(headers);
    expect(res.status).toBe(409);
  });

  it('500 — generic error', async () => {
    syncIhiIngestLast24h.mockRejectedValueOnce(new Error('boom'));
    const { headers } = await authFor('admin');
    const res = await request(app).post('/api/sync/ihi/ingest/trigger').set(headers);
    expect(res.status).toBe(500);
  });
});

// ────────────────────────────────────────────────────────────────────────
// POST /api/sync/ihi/sadhguru-stats/trigger
// ────────────────────────────────────────────────────────────────────────
describe('POST /api/sync/ihi/sadhguru-stats/trigger', () => {
  it('200 — admin can trigger', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).post('/api/sync/ihi/sadhguru-stats/trigger').set(headers);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('IHI Sadhguru stats sync started');
    expect(syncIhiSadhguruVideoStats).toHaveBeenCalledWith(null, 'manual');
  });

  it('403 — viewer forbidden', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).post('/api/sync/ihi/sadhguru-stats/trigger').set(headers);
    expect(res.status).toBe(403);
  });

  it('409 — already in progress', async () => {
    syncIhiSadhguruVideoStats.mockRejectedValueOnce(
      new Error('IHI Sadhguru stats already in progress')
    );
    const { headers } = await authFor('admin');
    const res = await request(app).post('/api/sync/ihi/sadhguru-stats/trigger').set(headers);
    expect(res.status).toBe(409);
  });

  it('500 — generic error', async () => {
    syncIhiSadhguruVideoStats.mockRejectedValueOnce(new Error('nope'));
    const { headers } = await authFor('admin');
    const res = await request(app).post('/api/sync/ihi/sadhguru-stats/trigger').set(headers);
    expect(res.status).toBe(500);
  });
});

// ────────────────────────────────────────────────────────────────────────
// GET /api/sync/config
// ────────────────────────────────────────────────────────────────────────
describe('GET /api/sync/config', () => {
  it('200 — returns normalized config (viewer allowed)', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/sync/config').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.channelSyncSchedule).toBe('0 3 * * *');
    expect(res.body.dedicatedIngestEnabled).toBe(true);
  });

  it('500 — DB error in getConfig triggers next(err)', async () => {
    vi.spyOn(prisma.syncConfig, 'upsert').mockRejectedValueOnce(new Error('config boom'));
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/sync/config').set(headers);
    expect(res.status).toBe(500);
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app).get('/api/sync/config');
    expect(res.status).toBe(401);
  });
});

// ────────────────────────────────────────────────────────────────────────
// PUT /api/sync/config
// ────────────────────────────────────────────────────────────────────────
describe('PUT /api/sync/config', () => {
  it('200 — admin updates all schedules + enabled flags; all schedulers re-applied', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .put('/api/sync/config')
      .set(headers)
      .send({
        channelSyncSchedule: '0 9 * * *',
        videoSyncSchedule: '0 10 * * *',
        dedicatedIngestSchedule: '0 11 * * *',
        ihiIngestSchedule: '0 12 * * *',
        ihiSadhguruStatsSchedule: '0 13 * * *',
        channelSyncEnabled: false,
        videoSyncEnabled: false,
        dedicatedIngestEnabled: false,
        ihiIngestEnabled: false,
        ihiSadhguruStatsEnabled: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.channelSyncSchedule).toBe('0 9 * * *');
    expect(res.body.videoSyncSchedule).toBe('0 10 * * *');
    expect(res.body.dedicatedIngestSchedule).toBe('0 11 * * *');
    expect(res.body.ihiIngestSchedule).toBe('0 12 * * *');
    expect(res.body.ihiSadhguruStatsSchedule).toBe('0 13 * * *');
    expect(res.body.dedicatedIngestEnabled).toBe(false);
    expect(res.body.ihiIngestEnabled).toBe(false);
    expect(res.body.ihiSadhguruStatsEnabled).toBe(false);

    expect(scheduleChannelSync).toHaveBeenCalledWith('0 9 * * *', false);
    expect(scheduleVideoSync).toHaveBeenCalledWith('0 10 * * *', false);
    expect(scheduleDedicatedIngest).toHaveBeenCalledWith('0 11 * * *', false);
    expect(scheduleIhiIngest).toHaveBeenCalledWith('0 12 * * *', false);
    expect(scheduleIhiSadhguruStats).toHaveBeenCalledWith('0 13 * * *', false);
  });

  it('200 — empty body: no fields change, no schedulers called', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).put('/api/sync/config').set(headers).send({});

    expect(res.status).toBe(200);
    expect(scheduleChannelSync).not.toHaveBeenCalled();
    expect(scheduleVideoSync).not.toHaveBeenCalled();
    expect(scheduleDedicatedIngest).not.toHaveBeenCalled();
    expect(scheduleIhiIngest).not.toHaveBeenCalled();
    expect(scheduleIhiSadhguruStats).not.toHaveBeenCalled();
  });

  it('200 — providing same values as existing does NOT re-call schedulers', async () => {
    await prisma.syncConfig.create({
      data: {
        id: 'sync',
        channelSyncSchedule: '0 3 * * *',
        videoSyncSchedule: '0 4 * * *',
        dedicatedIngestSchedule: '0 0 * * *',
        ihiIngestSchedule: '0 */6 * * *',
        ihiSadhguruStatsSchedule: '0 5 * * *',
        channelSyncEnabled: true,
        videoSyncEnabled: true,
        dedicatedIngestEnabled: true,
        ihiIngestEnabled: true,
        ihiSadhguruStatsEnabled: true,
      },
    });

    const { headers } = await authFor('admin');
    const res = await request(app)
      .put('/api/sync/config')
      .set(headers)
      .send({
        channelSyncSchedule: '0 3 * * *',
        videoSyncSchedule: '0 4 * * *',
        dedicatedIngestSchedule: '0 0 * * *',
        ihiIngestSchedule: '0 */6 * * *',
        ihiSadhguruStatsSchedule: '0 5 * * *',
        channelSyncEnabled: true,
        videoSyncEnabled: true,
        dedicatedIngestEnabled: true,
        ihiIngestEnabled: true,
        ihiSadhguruStatsEnabled: true,
      });

    expect(res.status).toBe(200);
    expect(scheduleChannelSync).not.toHaveBeenCalled();
    expect(scheduleVideoSync).not.toHaveBeenCalled();
    expect(scheduleDedicatedIngest).not.toHaveBeenCalled();
    expect(scheduleIhiIngest).not.toHaveBeenCalled();
    expect(scheduleIhiSadhguruStats).not.toHaveBeenCalled();
  });

  it('200 — channel schedule change alone triggers ONLY scheduleChannelSync', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .put('/api/sync/config')
      .set(headers)
      .send({ channelSyncSchedule: '0 22 * * *' });

    expect(res.status).toBe(200);
    expect(scheduleChannelSync).toHaveBeenCalledTimes(1);
    expect(scheduleChannelSync).toHaveBeenCalledWith('0 22 * * *', true);
    expect(scheduleVideoSync).not.toHaveBeenCalled();
    expect(scheduleDedicatedIngest).not.toHaveBeenCalled();
    expect(scheduleIhiIngest).not.toHaveBeenCalled();
    expect(scheduleIhiSadhguruStats).not.toHaveBeenCalled();
  });

  it('200 — channel enabled-flag change alone triggers scheduleChannelSync', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .put('/api/sync/config')
      .set(headers)
      .send({ channelSyncEnabled: false });

    expect(res.status).toBe(200);
    expect(scheduleChannelSync).toHaveBeenCalledTimes(1);
    expect(scheduleChannelSync).toHaveBeenCalledWith(expect.any(String), false);
  });

  it('200 — video-only change triggers scheduleVideoSync', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .put('/api/sync/config')
      .set(headers)
      .send({ videoSyncSchedule: '0 23 * * *' });

    expect(res.status).toBe(200);
    expect(scheduleVideoSync).toHaveBeenCalledTimes(1);
    expect(scheduleChannelSync).not.toHaveBeenCalled();
  });

  it('200 — dedicated-ingest-only change triggers scheduleDedicatedIngest', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .put('/api/sync/config')
      .set(headers)
      .send({ dedicatedIngestSchedule: '15 1 * * *' });

    expect(res.status).toBe(200);
    expect(scheduleDedicatedIngest).toHaveBeenCalledTimes(1);
  });

  it('200 — ihi-ingest-only change triggers scheduleIhiIngest', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .put('/api/sync/config')
      .set(headers)
      .send({ ihiIngestSchedule: '0 */2 * * *' });

    expect(res.status).toBe(200);
    expect(scheduleIhiIngest).toHaveBeenCalledTimes(1);
  });

  it('200 — ihi-sadhguru-stats-only change triggers scheduleIhiSadhguruStats', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .put('/api/sync/config')
      .set(headers)
      .send({ ihiSadhguruStatsSchedule: '0 21 * * *' });

    expect(res.status).toBe(200);
    expect(scheduleIhiSadhguruStats).toHaveBeenCalledTimes(1);
  });

  it('403 — manager cannot update config', async () => {
    const { headers } = await authFor('manager');
    const res = await request(app)
      .put('/api/sync/config')
      .set(headers)
      .send({ channelSyncSchedule: '0 9 * * *' });
    expect(res.status).toBe(403);
  });

  it('403 — viewer cannot update config', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app)
      .put('/api/sync/config')
      .set(headers)
      .send({ channelSyncSchedule: '0 9 * * *' });
    expect(res.status).toBe(403);
  });

  it('500 — DB error in updateConfig triggers next(err)', async () => {
    vi.spyOn(prisma.syncConfig, 'upsert').mockRejectedValueOnce(new Error('update boom'));
    const { headers } = await authFor('admin');
    const res = await request(app)
      .put('/api/sync/config')
      .set(headers)
      .send({ channelSyncSchedule: '0 9 * * *' });
    expect(res.status).toBe(500);
  });
});
