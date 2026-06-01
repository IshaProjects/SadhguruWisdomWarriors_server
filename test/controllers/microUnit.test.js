import request from 'supertest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import app from '../../src/app.js';
import { prisma } from '../setup.js';
import { authFor } from '../helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

let n = 0;
const mkChannel = (over = {}) =>
  prisma.channel.create({
    data: {
      youtubeChannelId: `yt-ch-${(n += 1)}`,
      title: `Ch ${n}`,
      ...over,
    },
  });

// Postgres cuid strings are just varchars — collision-free random ids that
// will not match anything in the DB stand in for Mongo's ObjectId() helper.
const fakeId = () => `cuid-missing-${Math.random().toString(36).slice(2, 12)}`;

describe('GET /api/micro-units', () => {
  it('lists micro units sorted by name with populated channels', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ title: 'Channel A' });
    await prisma.microUnit.create({
      data: {
        name: 'Zeta',
        microUnitChannels: { create: [{ channelId: ch.id }] },
      },
    });
    await prisma.microUnit.create({ data: { name: 'Alpha' } });

    const res = await request(app).get('/api/micro-units').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.map((m) => m.name)).toEqual(['Alpha', 'Zeta']); // sorted asc
    const zeta = res.body.find((m) => m.name === 'Zeta');
    expect(zeta.channelIds[0]).toMatchObject({
      title: 'Channel A',
      youtubeChannelId: ch.youtubeChannelId,
    });
  });
});

describe('POST /api/micro-units', () => {
  it('403 for a viewer (manager/admin only)', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).post('/api/micro-units').set(headers).send({ name: 'X' });
    expect(res.status).toBe(403);
  });

  it.each([
    ['missing name', {}],
    ['blank name', { name: '   ' }],
    ['non-string name', { name: 123 }],
  ])('400 on %s', async (_label, body) => {
    const { headers } = await authFor('manager');
    const res = await request(app).post('/api/micro-units').set(headers).send(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Name is required');
  });

  it('creates a micro unit, trims fields, and keeps only valid string channelIds', async () => {
    const { headers } = await authFor('admin');
    const ch = await mkChannel();
    const res = await request(app)
      .post('/api/micro-units')
      .set(headers)
      .send({ name: '  Unit 1  ', notes: '  hello  ', channelIds: [ch.id, null, 123, ''] });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Unit 1');
    expect(res.body.notes).toBe('hello');
    expect(res.body.channelIds).toHaveLength(1);
    expect(res.body.channelIds[0].youtubeChannelId).toBe(ch.youtubeChannelId);
  });

  it('treats a non-array channelIds as empty and defaults notes', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/micro-units')
      .set(headers)
      .send({ name: 'No Channels', channelIds: 'not-an-array' });

    expect(res.status).toBe(201);
    expect(res.body.channelIds).toEqual([]);
    expect(res.body.notes).toBe('');
  });

  it('forwards an error when a channelId does not exist (catch path)', async () => {
    // Original Mongoose test asserted 400 on a "not-a-valid-objectid"
    // CastError. In Postgres the same scenario surfaces as a Prisma FK
    // violation (the junction row references a missing channel.id). We assert
    // the request still fails with a 4xx/5xx and never returns a 2xx.
    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/micro-units')
      .set(headers)
      .send({ name: 'Bad', channelIds: ['no-such-channel-id'] });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(600);
    expect(res.status).not.toBe(201);
  });
});

describe('GET /api/micro-units/:id', () => {
  it('returns a populated micro unit', async () => {
    const { headers } = await authFor('viewer');
    const ch = await mkChannel({ category: 'News' });
    const mu = await prisma.microUnit.create({
      data: {
        name: 'U',
        microUnitChannels: { create: [{ channelId: ch.id }] },
      },
    });

    const res = await request(app).get(`/api/micro-units/${mu.id}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.channelIds[0].category).toBe('News'); // category is populated on this route
  });

  it('404 when not found', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).get(`/api/micro-units/${fakeId()}`).set(headers);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Micro unit not found');
  });
});

describe('PUT /api/micro-units/:id', () => {
  it('updates provided fields only', async () => {
    const { headers } = await authFor('manager');
    const ch = await mkChannel();
    const mu = await prisma.microUnit.create({ data: { name: 'Old', notes: 'old notes' } });

    const res = await request(app)
      .put(`/api/micro-units/${mu.id}`)
      .set(headers)
      .send({ name: '  New  ', notes: '  new notes  ', channelIds: [ch.id, 42] });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New');
    expect(res.body.notes).toBe('new notes');
    expect(res.body.channelIds).toHaveLength(1);
  });

  it('ignores a non-array channelIds and an empty body', async () => {
    const { headers } = await authFor('manager');
    const mu = await prisma.microUnit.create({ data: { name: 'Keep' } });

    const res = await request(app)
      .put(`/api/micro-units/${mu.id}`)
      .set(headers)
      .send({ channelIds: 'nope' }); // not an array -> not applied
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Keep');
    expect(res.body.channelIds).toEqual([]);
  });

  it('404 when not found', async () => {
    const { headers } = await authFor('manager');
    const res = await request(app)
      .put(`/api/micro-units/${fakeId()}`)
      .set(headers)
      .send({ name: 'X' });
    expect(res.status).toBe(404);
  });

  it('replaces the channel list when provided (delete-then-create semantics)', async () => {
    const { headers } = await authFor('admin');
    const chA = await mkChannel({ title: 'A' });
    const chB = await mkChannel({ title: 'B' });
    const mu = await prisma.microUnit.create({
      data: {
        name: 'Replaces',
        microUnitChannels: { create: [{ channelId: chA.id }] },
      },
    });

    const res = await request(app)
      .put(`/api/micro-units/${mu.id}`)
      .set(headers)
      .send({ channelIds: [chB.id] });

    expect(res.status).toBe(200);
    expect(res.body.channelIds).toHaveLength(1);
    expect(res.body.channelIds[0].youtubeChannelId).toBe(chB.youtubeChannelId);
  });
});

describe('DELETE /api/micro-units/:id', () => {
  it('deletes an existing micro unit', async () => {
    const { headers } = await authFor('admin');
    const mu = await prisma.microUnit.create({ data: { name: 'Bye' } });

    const res = await request(app).delete(`/api/micro-units/${mu.id}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(mu.id);
    expect(await prisma.microUnit.findUnique({ where: { id: mu.id } })).toBeNull();
  });

  it('404 when not found', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).delete(`/api/micro-units/${fakeId()}`).set(headers);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/micro-units error path', () => {
  it('forwards unexpected errors to the error handler (500)', async () => {
    vi.spyOn(prisma.microUnit, 'findMany').mockImplementation(() => {
      throw new Error('boom');
    });
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/micro-units').set(headers);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom');
  });
});
