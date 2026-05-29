import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock node-cron ────────────────────────────────────────────────────────
// We capture the scheduled callbacks so we can invoke them manually.
const cronCallbacks = {};
const mockTask = {
  stop: vi.fn(),
};

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn((expr, cb) => {
      cronCallbacks[expr] = cb;
      return { ...mockTask, stop: vi.fn() };
    }),
  },
}));

// ─── Mock syncEngine ───────────────────────────────────────────────────────
vi.mock('../../src/services/syncEngine.js', () => ({
  syncChannelStats: vi.fn(async () => ({ channelsProcessed: 5, status: 'done' })),
  syncVideoStats: vi.fn(async () => ({ videosProcessed: 10, status: 'done' })),
  syncDedicatedIngestLast24h: vi.fn(async () => ({ videosProcessed: 3, status: 'done' })),
  syncIhiIngestLast24h: vi.fn(async () => ({ videosProcessed: 7, status: 'done' })),
  syncIhiSadhguruVideoStats: vi.fn(async () => ({ videosProcessed: 2, status: 'done' })),
}));

// ─── Mock logger ───────────────────────────────────────────────────────────
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import cron from 'node-cron';
import {
  syncChannelStats,
  syncVideoStats,
  syncDedicatedIngestLast24h,
  syncIhiIngestLast24h,
  syncIhiSadhguruVideoStats,
} from '../../src/services/syncEngine.js';
import { logger } from '../../src/utils/logger.js';
import {
  startSyncScheduler,
  scheduleChannelSync,
  scheduleVideoSync,
  scheduleIhiIngest,
  scheduleDedicatedIngest,
  scheduleIhiSadhguruStats,
} from '../../src/jobs/syncScheduler.js';
import { prisma } from '../setup.js';

// ──────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(cronCallbacks).forEach((k) => delete cronCallbacks[k]);
});

// ─── scheduleChannelSync ───────────────────────────────────────────────────

describe('scheduleChannelSync', () => {
  it('schedules a cron job when enabled=true', () => {
    scheduleChannelSync('0 3 * * *', true);
    expect(cron.schedule).toHaveBeenCalledWith('0 3 * * *', expect.any(Function));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Channel sync scheduled'));
  });

  it('logs disabled message and does not schedule when enabled=false', () => {
    scheduleChannelSync('0 3 * * *', false);
    expect(cron.schedule).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Channel sync disabled'));
  });

  it('stops the previous task before scheduling a new one', () => {
    scheduleChannelSync('0 3 * * *', true);
    const firstStop = cron.schedule.mock.results[0].value.stop;
    scheduleChannelSync('0 4 * * *', true);
    expect(firstStop).toHaveBeenCalled();
  });

  it('stops a previous task and does not schedule when disabled', () => {
    scheduleChannelSync('0 3 * * *', true);
    const firstStop = cron.schedule.mock.results[0].value.stop;
    vi.clearAllMocks();
    scheduleChannelSync('0 3 * * *', false);
    expect(firstStop).toHaveBeenCalled();
    expect(cron.schedule).not.toHaveBeenCalled();
  });

  it('invokes syncChannelStats when the cron callback fires (success)', async () => {
    scheduleChannelSync('0 3 * * *', true);
    const cb = cron.schedule.mock.calls[0][1];
    await cb();
    expect(syncChannelStats).toHaveBeenCalledWith(null, 'auto');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Channel sync done'));
  });

  it('logs an error when syncChannelStats throws', async () => {
    syncChannelStats.mockRejectedValueOnce(new Error('network fail'));
    scheduleChannelSync('0 3 * * *', true);
    const cb = cron.schedule.mock.calls[0][1];
    await cb();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Channel sync failed'));
  });
});

// ─── scheduleVideoSync ─────────────────────────────────────────────────────

describe('scheduleVideoSync', () => {
  it('schedules a cron job when enabled=true', () => {
    scheduleVideoSync('0 4 * * *', true);
    expect(cron.schedule).toHaveBeenCalledWith('0 4 * * *', expect.any(Function));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Dedicated video sync scheduled'));
  });

  it('logs disabled message and does not schedule when enabled=false', () => {
    scheduleVideoSync('0 4 * * *', false);
    expect(cron.schedule).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Dedicated video sync disabled'));
  });

  it('stops previous task when re-scheduling', () => {
    scheduleVideoSync('0 4 * * *', true);
    const firstStop = cron.schedule.mock.results[0].value.stop;
    scheduleVideoSync('0 5 * * *', true);
    expect(firstStop).toHaveBeenCalled();
  });

  it('stops previous task when disabling', () => {
    scheduleVideoSync('0 4 * * *', true);
    const firstStop = cron.schedule.mock.results[0].value.stop;
    vi.clearAllMocks();
    scheduleVideoSync('0 4 * * *', false);
    expect(firstStop).toHaveBeenCalled();
  });

  it('invokes syncVideoStats when the cron callback fires (success)', async () => {
    scheduleVideoSync('0 4 * * *', true);
    const cb = cron.schedule.mock.calls[0][1];
    await cb();
    expect(syncVideoStats).toHaveBeenCalledWith(null, 'auto');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Dedicated video sync done'));
  });

  it('logs an error when syncVideoStats throws', async () => {
    syncVideoStats.mockRejectedValueOnce(new Error('video fail'));
    scheduleVideoSync('0 4 * * *', true);
    const cb = cron.schedule.mock.calls[0][1];
    await cb();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Dedicated video sync failed'));
  });
});

// ─── scheduleIhiIngest ─────────────────────────────────────────────────────

describe('scheduleIhiIngest', () => {
  it('schedules when enabled=true', () => {
    scheduleIhiIngest('0 */6 * * *', true);
    expect(cron.schedule).toHaveBeenCalledWith('0 */6 * * *', expect.any(Function));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('IHI ingest scheduled'));
  });

  it('does not schedule when enabled=false', () => {
    scheduleIhiIngest('0 */6 * * *', false);
    expect(cron.schedule).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('IHI ingest sync disabled'));
  });

  it('stops previous task when re-scheduling', () => {
    scheduleIhiIngest('0 */6 * * *', true);
    const firstStop = cron.schedule.mock.results[0].value.stop;
    scheduleIhiIngest('0 */3 * * *', true);
    expect(firstStop).toHaveBeenCalled();
  });

  it('stops previous task when disabling', () => {
    scheduleIhiIngest('0 */6 * * *', true);
    const firstStop = cron.schedule.mock.results[0].value.stop;
    vi.clearAllMocks();
    scheduleIhiIngest('0 */6 * * *', false);
    expect(firstStop).toHaveBeenCalled();
  });

  it('invokes syncIhiIngestLast24h when callback fires (success)', async () => {
    scheduleIhiIngest('0 */6 * * *', true);
    const cb = cron.schedule.mock.calls[0][1];
    await cb();
    expect(syncIhiIngestLast24h).toHaveBeenCalledWith(null, 'auto');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('IHI ingest done'));
  });

  it('logs error when syncIhiIngestLast24h throws', async () => {
    syncIhiIngestLast24h.mockRejectedValueOnce(new Error('ihi fail'));
    scheduleIhiIngest('0 */6 * * *', true);
    const cb = cron.schedule.mock.calls[0][1];
    await cb();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('IHI ingest failed'));
  });
});

// ─── scheduleDedicatedIngest ───────────────────────────────────────────────

describe('scheduleDedicatedIngest', () => {
  it('schedules when enabled=true', () => {
    scheduleDedicatedIngest('0 0 * * *', true);
    expect(cron.schedule).toHaveBeenCalledWith('0 0 * * *', expect.any(Function));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Dedicated ingest scheduled'));
  });

  it('does not schedule when enabled=false', () => {
    scheduleDedicatedIngest('0 0 * * *', false);
    expect(cron.schedule).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Dedicated ingest sync disabled'));
  });

  it('stops previous task when re-scheduling', () => {
    scheduleDedicatedIngest('0 0 * * *', true);
    const firstStop = cron.schedule.mock.results[0].value.stop;
    scheduleDedicatedIngest('0 1 * * *', true);
    expect(firstStop).toHaveBeenCalled();
  });

  it('stops previous task when disabling', () => {
    scheduleDedicatedIngest('0 0 * * *', true);
    const firstStop = cron.schedule.mock.results[0].value.stop;
    vi.clearAllMocks();
    scheduleDedicatedIngest('0 0 * * *', false);
    expect(firstStop).toHaveBeenCalled();
  });

  it('invokes syncDedicatedIngestLast24h when callback fires (success)', async () => {
    scheduleDedicatedIngest('0 0 * * *', true);
    const cb = cron.schedule.mock.calls[0][1];
    await cb();
    expect(syncDedicatedIngestLast24h).toHaveBeenCalledWith(null, 'auto');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Dedicated ingest done'));
  });

  it('logs error when syncDedicatedIngestLast24h throws', async () => {
    syncDedicatedIngestLast24h.mockRejectedValueOnce(new Error('ded fail'));
    scheduleDedicatedIngest('0 0 * * *', true);
    const cb = cron.schedule.mock.calls[0][1];
    await cb();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Dedicated ingest failed'));
  });
});

// ─── scheduleIhiSadhguruStats ──────────────────────────────────────────────

describe('scheduleIhiSadhguruStats', () => {
  it('schedules when enabled=true', () => {
    scheduleIhiSadhguruStats('0 5 * * *', true);
    expect(cron.schedule).toHaveBeenCalledWith('0 5 * * *', expect.any(Function));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('IHI Sadhguru stats scheduled'));
  });

  it('does not schedule when enabled=false', () => {
    scheduleIhiSadhguruStats('0 5 * * *', false);
    expect(cron.schedule).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('IHI Sadhguru stats sync disabled'));
  });

  it('stops previous task when re-scheduling', () => {
    scheduleIhiSadhguruStats('0 5 * * *', true);
    const firstStop = cron.schedule.mock.results[0].value.stop;
    scheduleIhiSadhguruStats('0 6 * * *', true);
    expect(firstStop).toHaveBeenCalled();
  });

  it('stops previous task when disabling', () => {
    scheduleIhiSadhguruStats('0 5 * * *', true);
    const firstStop = cron.schedule.mock.results[0].value.stop;
    vi.clearAllMocks();
    scheduleIhiSadhguruStats('0 5 * * *', false);
    expect(firstStop).toHaveBeenCalled();
  });

  it('invokes syncIhiSadhguruVideoStats when callback fires (success)', async () => {
    scheduleIhiSadhguruStats('0 5 * * *', true);
    const cb = cron.schedule.mock.calls[0][1];
    await cb();
    expect(syncIhiSadhguruVideoStats).toHaveBeenCalledWith(null, 'auto');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('IHI Sadhguru stats done'));
  });

  it('logs error when syncIhiSadhguruVideoStats throws', async () => {
    syncIhiSadhguruVideoStats.mockRejectedValueOnce(new Error('stats fail'));
    scheduleIhiSadhguruStats('0 5 * * *', true);
    const cb = cron.schedule.mock.calls[0][1];
    await cb();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('IHI Sadhguru stats failed'));
  });
});

// ─── startSyncScheduler ────────────────────────────────────────────────────

describe('startSyncScheduler', () => {
  it('reads SyncConfig singleton and schedules all five tasks', async () => {
    // No seeded row → upsert in startSyncScheduler creates the default row.
    await startSyncScheduler();
    expect(cron.schedule).toHaveBeenCalledTimes(5);
  });

  it('uses provided schedule values from config', async () => {
    await prisma.syncConfig.create({
      data: {
        id: 'sync',
        channelSyncSchedule: '0 2 * * *',
        channelSyncEnabled: true,
        videoSyncSchedule: '0 3 * * *',
        videoSyncEnabled: true,
        dedicatedIngestSchedule: '0 1 * * *',
        dedicatedIngestEnabled: true,
        ihiIngestSchedule: '0 */4 * * *',
        ihiIngestEnabled: true,
        ihiSadhguruStatsSchedule: '0 6 * * *',
        ihiSadhguruStatsEnabled: true,
      },
    });
    await startSyncScheduler();
    const cronExprs = cron.schedule.mock.calls.map((c) => c[0]);
    expect(cronExprs).toContain('0 2 * * *');
    expect(cronExprs).toContain('0 3 * * *');
    expect(cronExprs).toContain('0 1 * * *');
    expect(cronExprs).toContain('0 */4 * * *');
    expect(cronExprs).toContain('0 6 * * *');
  });

  it('uses fallback schedules when optional fields default to expected values', async () => {
    // Prisma defaults already match the fallback values in the scheduler so a
    // bare singleton row produces the same cron expressions as the Mongo-side
    // fallback chain. Same observable behaviour.
    await prisma.syncConfig.create({
      data: { id: 'sync' },
    });
    await startSyncScheduler();
    const cronExprs = cron.schedule.mock.calls.map((c) => c[0]);
    expect(cronExprs).toContain('0 0 * * *');  // dedicatedIngest default
    expect(cronExprs).toContain('0 */6 * * *'); // ihiIngest default
    expect(cronExprs).toContain('0 5 * * *');   // ihiSadhguruStats default
  });

  it('passes enabled=false to ingest schedulers when flags are explicitly false', async () => {
    await prisma.syncConfig.create({
      data: {
        id: 'sync',
        channelSyncSchedule: '0 3 * * *',
        channelSyncEnabled: true,
        videoSyncSchedule: '0 4 * * *',
        videoSyncEnabled: true,
        dedicatedIngestSchedule: '0 0 * * *',
        dedicatedIngestEnabled: false,
        ihiIngestSchedule: '0 */6 * * *',
        ihiIngestEnabled: false,
        ihiSadhguruStatsSchedule: '0 5 * * *',
        ihiSadhguruStatsEnabled: false,
      },
    });
    await startSyncScheduler();
    expect(cron.schedule).toHaveBeenCalledTimes(2);
  });
});
