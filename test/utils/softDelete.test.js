import { describe, it, expect } from 'vitest';
import { prisma } from '../setup.js';
import { softDeleteChannels } from '../../src/utils/softDelete.js';

// Seed helpers. Snapshots have real FK constraints to channels/videos under
// Postgres, so every test builds a tiny world (channel → video → snapshot)
// before exercising the soft-delete.
let seq = 0;
async function mkChannel(overrides = {}) {
  seq += 1;
  return prisma.channel.create({
    data: {
      youtubeChannelId: `yt-ch-${seq}`,
      title: `Ch ${seq}`,
      ...overrides,
    },
  });
}
async function mkVideo(channelId, overrides = {}) {
  seq += 1;
  return prisma.video.create({
    data: {
      youtubeVideoId: `yt-vid-${seq}`,
      channelId,
      title: `Vid ${seq}`,
      ...overrides,
    },
  });
}
async function mkChannelSnapshot(channelId, overrides = {}) {
  seq += 1;
  return prisma.channelSnapshot.create({
    data: {
      channelId,
      date: new Date(Date.UTC(2024, 0, seq)),
      views: 0,
      subscribers: 0,
      videoCount: 0,
      ...overrides,
    },
  });
}
async function mkVideoSnapshot(videoId, channelId, overrides = {}) {
  seq += 1;
  return prisma.videoSnapshot.create({
    data: {
      videoId,
      channelId,
      date: new Date(Date.UTC(2024, 0, seq)),
      views: 0,
      ...overrides,
    },
  });
}

describe('softDeleteChannels', () => {
  it('returns { archived: 0 } and no-ops when given an empty list', async () => {
    const ch = await mkChannel({ status: 'active' });
    const res = await softDeleteChannels([]);
    expect(res).toEqual({ archived: 0 });
    const after = await prisma.channel.findUnique({ where: { id: ch.id } });
    expect(after.status).toBe('active');
    expect(after.deletedAt).toBeNull();
  });

  it('accepts a single id string (not just an array)', async () => {
    const ch = await mkChannel({ status: 'active' });
    const res = await softDeleteChannels(ch.id);
    expect(res).toEqual({ archived: 1 });
    const after = await prisma.channel.findUnique({ where: { id: ch.id } });
    expect(after.status).toBe('archived');
    expect(after.deletedAt).not.toBeNull();
  });

  it('archives the channel: status=archived, deletedAt set, autoArchivedForInactivity=false', async () => {
    // Set autoArchivedForInactivity=true beforehand so we can prove the
    // soft-delete force-resets it to false (deliberate human archive must
    // not be mistaken for an inactivity auto-archive and re-activated).
    const ch = await mkChannel({ status: 'active', autoArchivedForInactivity: true });

    const before = Date.now();
    const res = await softDeleteChannels([ch.id]);
    const after = Date.now();

    expect(res).toEqual({ archived: 1 });
    const updated = await prisma.channel.findUnique({ where: { id: ch.id } });
    expect(updated.status).toBe('archived');
    expect(updated.autoArchivedForInactivity).toBe(false);
    expect(updated.deletedAt).not.toBeNull();
    expect(updated.deletedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(updated.deletedAt.getTime()).toBeLessThanOrEqual(after);
  });

  it('cascades deletedAt to every child video, channel snapshot, and video snapshot of the channel', async () => {
    const ch = await mkChannel();
    const v = await mkVideo(ch.id);
    const cs = await mkChannelSnapshot(ch.id);
    const vs = await mkVideoSnapshot(v.id, ch.id);

    await softDeleteChannels([ch.id]);

    expect((await prisma.video.findUnique({ where: { id: v.id } })).deletedAt).not.toBeNull();
    expect((await prisma.channelSnapshot.findUnique({ where: { id: cs.id } })).deletedAt).not.toBeNull();
    expect((await prisma.videoSnapshot.findUnique({ where: { id: vs.id } })).deletedAt).not.toBeNull();
  });

  it('preserves the original deletedAt timestamp on children that are already soft-deleted', async () => {
    const ch = await mkChannel();
    const v = await mkVideo(ch.id);
    const originalTimestamp = new Date('2023-01-01T00:00:00.000Z');
    await prisma.video.update({ where: { id: v.id }, data: { deletedAt: originalTimestamp } });

    await softDeleteChannels([ch.id]);

    const after = await prisma.video.findUnique({ where: { id: v.id } });
    // Already-deleted children must keep their original timestamp so we
    // don't lose the archival history when a channel is later archived.
    expect(after.deletedAt.toISOString()).toBe(originalTimestamp.toISOString());
  });

  it('handles multiple channel ids in a single call', async () => {
    const a = await mkChannel();
    const b = await mkChannel();
    const va = await mkVideo(a.id);
    const vb = await mkVideo(b.id);

    const res = await softDeleteChannels([a.id, b.id]);

    expect(res.archived).toBe(2);
    expect((await prisma.channel.findUnique({ where: { id: a.id } })).status).toBe('archived');
    expect((await prisma.channel.findUnique({ where: { id: b.id } })).status).toBe('archived');
    expect((await prisma.video.findUnique({ where: { id: va.id } })).deletedAt).not.toBeNull();
    expect((await prisma.video.findUnique({ where: { id: vb.id } })).deletedAt).not.toBeNull();
  });

  it('does not touch channels outside the provided id set', async () => {
    const target = await mkChannel();
    const bystander = await mkChannel({ status: 'active' });
    const bystanderVideo = await mkVideo(bystander.id);

    await softDeleteChannels([target.id]);

    const after = await prisma.channel.findUnique({ where: { id: bystander.id } });
    expect(after.status).toBe('active');
    expect(after.deletedAt).toBeNull();
    expect(
      (await prisma.video.findUnique({ where: { id: bystanderVideo.id } })).deletedAt,
    ).toBeNull();
  });

  it('returns archived=0 for ids that do not match any channel', async () => {
    const res = await softDeleteChannels(['nonexistent-id-123']);
    expect(res.archived).toBe(0);
  });
});
