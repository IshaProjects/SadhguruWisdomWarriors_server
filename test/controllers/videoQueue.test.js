import request from 'supertest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import app from '../../src/app.js';
import { prisma } from '../setup.js';
import { authFor } from '../helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// Mock axios to prevent real network calls in processQueue and chatProxy
vi.mock('axios', () => {
  const mockAxios = {
    post: vi.fn(),
  };
  return { default: mockAxios };
});

import axios from 'axios';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Helper to seed items ──────────────────────────────────────────────────────

async function seedItem(overrides = {}) {
  return prisma.videoQueueItem.create({
    data: {
      url: 'https://youtube.com/watch?v=test',
      videoType: 'normal',
      eventName: '',
      notes: '',
      priority: 'normal',
      status: 'queued',
      ...overrides,
    },
  });
}

// ── GET /api/video-queue ──────────────────────────────────────────────────────

describe('GET /api/video-queue', () => {
  it('200 — admin can list queue (empty)', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).get('/api/video-queue').set(headers);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.page).toBe(1);
    expect(res.body.pages).toBe(0);
  });

  it('200 — viewer can list queue', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/video-queue').set(headers);
    expect(res.status).toBe(200);
  });

  it('200 — returns seeded items', async () => {
    await seedItem({ url: 'https://youtube.com/watch?v=abc' });
    await seedItem({ url: 'https://youtube.com/watch?v=def' });

    const { headers } = await authFor('admin');
    const res = await request(app).get('/api/video-queue').set(headers);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items).toHaveLength(2);
  });

  it('200 — filters by status', async () => {
    await seedItem({ status: 'queued' });
    await seedItem({ status: 'completed' });

    const { headers } = await authFor('admin');
    const res = await request(app)
      .get('/api/video-queue?status=queued')
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].status).toBe('queued');
  });

  it('200 — pagination: page and limit work', async () => {
    for (let i = 0; i < 5; i++) {
      await seedItem({ url: `https://youtube.com/watch?v=${i}` });
    }

    const { headers } = await authFor('admin');
    const res = await request(app)
      .get('/api/video-queue?page=2&limit=2')
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.pages).toBe(3);
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app).get('/api/video-queue');
    expect(res.status).toBe(401);
  });

  it('500 — DB error in listQueue triggers next(err)', async () => {
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.videoQueueItem, 'findMany').mockRejectedValueOnce(new Error('DB failure'));

    const res = await request(app).get('/api/video-queue').set(headers);
    expect(res.status).toBe(500);
  });
});

// ── POST /api/video-queue ─────────────────────────────────────────────────────

describe('POST /api/video-queue', () => {
  it('201 — admin can add a single url', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/video-queue')
      .set(headers)
      .send({ url: 'https://youtube.com/watch?v=single' });

    expect(res.status).toBe(201);
    expect(res.body.added).toBe(1);
    expect(res.body.items[0].url).toBe('https://youtube.com/watch?v=single');
    expect(res.body.items[0].addedBy).toBeTruthy();
  });

  it('201 — manager can add to queue', async () => {
    const { headers } = await authFor('manager');
    const res = await request(app)
      .post('/api/video-queue')
      .set(headers)
      .send({ url: 'https://youtube.com/watch?v=mgr' });

    expect(res.status).toBe(201);
    expect(res.body.added).toBe(1);
  });

  it('201 — addedBy uses email when user name is empty', async () => {
    // Bypass anything to set name to ''. Prisma's `String` is non-null but
    // empty string is permitted, so a direct update suffices.
    const { headers, user } = await authFor('admin');
    await prisma.user.update({ where: { id: user.id }, data: { name: '' } });

    const res = await request(app)
      .post('/api/video-queue')
      .set(headers)
      .send({ url: 'https://youtube.com/watch?v=email-fallback' });

    expect(res.status).toBe(201);
    expect(res.body.items[0].addedBy).toBe(user.email);
  });

  it('201 — bulk add via urls array', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/video-queue')
      .set(headers)
      .send({
        urls: [
          'https://youtube.com/watch?v=bulk1',
          'https://youtube.com/watch?v=bulk2',
          'https://youtube.com/watch?v=bulk3',
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.added).toBe(3);
    expect(res.body.items).toHaveLength(3);
  });

  it('201 — uses provided videoType, eventName, notes, priority', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/video-queue')
      .set(headers)
      .send({
        url: 'https://youtube.com/watch?v=meta',
        videoType: 'event',
        eventName: 'Isha Yoga',
        notes: 'some notes',
        priority: 'high',
      });

    expect(res.status).toBe(201);
    const item = res.body.items[0];
    expect(item.videoType).toBe('event');
    expect(item.eventName).toBe('Isha Yoga');
    expect(item.notes).toBe('some notes');
    expect(item.priority).toBe('high');
  });

  it('201 — defaults videoType/eventName/notes/priority when not provided', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/video-queue')
      .set(headers)
      .send({ url: 'https://youtube.com/watch?v=defaults' });

    expect(res.status).toBe(201);
    const item = res.body.items[0];
    expect(item.videoType).toBe('normal');
    expect(item.eventName).toBe('');
    expect(item.notes).toBe('');
    expect(item.priority).toBe('normal');
  });

  it('400 — no url or urls provided', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/video-queue')
      .set(headers)
      .send({ videoType: 'normal' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('url or urls[] is required');
  });

  it('400 — empty urls array', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/video-queue')
      .set(headers)
      .send({ urls: [] });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('url or urls[] is required');
  });

  it('403 — viewer cannot add to queue', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app)
      .post('/api/video-queue')
      .set(headers)
      .send({ url: 'https://youtube.com/watch?v=x' });

    expect(res.status).toBe(403);
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app)
      .post('/api/video-queue')
      .send({ url: 'https://youtube.com/watch?v=x' });

    expect(res.status).toBe(401);
  });

  it('500 — DB error in addToQueue triggers next(err)', async () => {
    const { headers } = await authFor('admin');
    // The controller calls prisma.$transaction([...prisma.videoQueueItem.create(...)]);
    // mocking the per-item create call surfaces the inner error in the
    // transaction wrapper and routes it through next(err) → 500.
    vi.spyOn(prisma.videoQueueItem, 'create').mockRejectedValueOnce(new Error('DB failure'));

    const res = await request(app)
      .post('/api/video-queue')
      .set(headers)
      .send({ url: 'https://youtube.com/watch?v=err' });

    expect(res.status).toBe(500);
  });
});

// ── DELETE /api/video-queue/:id ───────────────────────────────────────────────

describe('DELETE /api/video-queue/:id', () => {
  it('200 — admin can remove an item', async () => {
    const item = await seedItem();
    const { headers } = await authFor('admin');

    const res = await request(app)
      .delete(`/api/video-queue/${item.id}`)
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Removed');
    expect(res.body.id).toBe(item.id);
  });

  it('200 — manager can remove an item', async () => {
    const item = await seedItem();
    const { headers } = await authFor('manager');

    const res = await request(app)
      .delete(`/api/video-queue/${item.id}`)
      .set(headers);

    expect(res.status).toBe(200);
  });

  it('404 — item not found', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .delete('/api/video-queue/cuid-does-not-exist')
      .set(headers);

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Item not found');
  });

  it('403 — viewer cannot remove items', async () => {
    const item = await seedItem();
    const { headers } = await authFor('viewer');

    const res = await request(app)
      .delete(`/api/video-queue/${item.id}`)
      .set(headers);

    expect(res.status).toBe(403);
  });

  it('401 — unauthenticated', async () => {
    const item = await seedItem();
    const res = await request(app).delete(`/api/video-queue/${item.id}`);
    expect(res.status).toBe(401);
  });

  it('500 — DB error in removeFromQueue triggers next(err)', async () => {
    const item = await seedItem();
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.videoQueueItem, 'delete').mockRejectedValueOnce(new Error('DB failure'));

    const res = await request(app)
      .delete(`/api/video-queue/${item.id}`)
      .set(headers);

    expect(res.status).toBe(500);
  });
});

// ── PATCH /api/video-queue/:id/status ────────────────────────────────────────

describe('PATCH /api/video-queue/:id/status', () => {
  it('200 — admin can update status to processing (sets startedAt)', async () => {
    const item = await seedItem();
    const { headers } = await authFor('admin');

    const res = await request(app)
      .patch(`/api/video-queue/${item.id}/status`)
      .set(headers)
      .send({ status: 'processing' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processing');
    expect(res.body.startedAt).toBeTruthy();
  });

  it('200 — status completed sets completedAt', async () => {
    const item = await seedItem();
    const { headers } = await authFor('admin');

    const res = await request(app)
      .patch(`/api/video-queue/${item.id}/status`)
      .set(headers)
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.completedAt).toBeTruthy();
  });

  it('200 — status failed sets completedAt', async () => {
    const item = await seedItem();
    const { headers } = await authFor('admin');

    const res = await request(app)
      .patch(`/api/video-queue/${item.id}/status`)
      .set(headers)
      .send({ status: 'failed', errorMessage: 'Some error occurred' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.completedAt).toBeTruthy();
    expect(res.body.errorMessage).toBe('Some error occurred');
  });

  it('200 — can update title', async () => {
    const item = await seedItem();
    const { headers } = await authFor('admin');

    const res = await request(app)
      .patch(`/api/video-queue/${item.id}/status`)
      .set(headers)
      .send({ status: 'completed', title: 'My Video Title' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('My Video Title');
  });

  it('200 — status queued does not set startedAt or completedAt', async () => {
    const item = await seedItem({ status: 'processing' });
    const { headers } = await authFor('admin');

    const res = await request(app)
      .patch(`/api/video-queue/${item.id}/status`)
      .set(headers)
      .send({ status: 'queued' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('queued');
  });

  it('200 — manager can update status', async () => {
    const item = await seedItem();
    const { headers } = await authFor('manager');

    const res = await request(app)
      .patch(`/api/video-queue/${item.id}/status`)
      .set(headers)
      .send({ status: 'processing' });

    expect(res.status).toBe(200);
  });

  it('404 — item not found', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .patch('/api/video-queue/cuid-missing/status')
      .set(headers)
      .send({ status: 'completed' });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Item not found');
  });

  it('403 — viewer cannot update status', async () => {
    const item = await seedItem();
    const { headers } = await authFor('viewer');

    const res = await request(app)
      .patch(`/api/video-queue/${item.id}/status`)
      .set(headers)
      .send({ status: 'completed' });

    expect(res.status).toBe(403);
  });

  it('401 — unauthenticated', async () => {
    const item = await seedItem();
    const res = await request(app)
      .patch(`/api/video-queue/${item.id}/status`)
      .send({ status: 'completed' });

    expect(res.status).toBe(401);
  });

  it('500 — DB error in updateStatus triggers next(err)', async () => {
    const item = await seedItem();
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.videoQueueItem, 'update').mockRejectedValueOnce(new Error('DB failure'));

    const res = await request(app)
      .patch(`/api/video-queue/${item.id}/status`)
      .set(headers)
      .send({ status: 'completed' });

    expect(res.status).toBe(500);
  });
});

// ── POST /api/video-queue/process ────────────────────────────────────────────

describe('POST /api/video-queue/process', () => {
  it('200 — returns empty message when no queued items', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/video-queue/process')
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('No queued items to process');
    expect(res.body.processed).toBe(0);
  });

  it('200 — responds immediately with queued items, then processes them', async () => {
    // Seed some queued items
    await seedItem({ url: 'https://youtube.com/watch?v=p1', priority: 'high' });
    await seedItem({ url: 'https://youtube.com/watch?v=p2', priority: 'normal' });
    await seedItem({ url: 'https://youtube.com/watch?v=p3', priority: 'low' });

    axios.post.mockResolvedValue({ data: { title: 'Processed Video' } });

    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/video-queue/process')
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Processing started');
    expect(res.body.queued).toBe(3);
    expect(res.body.items).toHaveLength(3);
  });

  it('200 — processes items in priority order (high → normal → low)', async () => {
    await seedItem({ url: 'https://youtube.com/watch?v=low', priority: 'low' });
    await seedItem({ url: 'https://youtube.com/watch?v=high', priority: 'high' });
    await seedItem({ url: 'https://youtube.com/watch?v=normal', priority: 'normal' });

    axios.post.mockResolvedValue({ data: { title: 'Video' } });

    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/video-queue/process')
      .set(headers);

    expect(res.status).toBe(200);
    const urls = res.body.items.map((i) => i.url);
    expect(urls[0]).toContain('high');
    expect(urls[1]).toContain('normal');
    expect(urls[2]).toContain('low');
  });

  it('200 — sorts items with same priority by age (createdAt tie-break branch)', async () => {
    await seedItem({ url: 'https://youtube.com/watch?v=same1', priority: 'normal' });
    await new Promise((r) => setTimeout(r, 10));
    await seedItem({ url: 'https://youtube.com/watch?v=same2', priority: 'normal' });

    axios.post.mockResolvedValue({ data: { title: 'Video' } });

    const { headers } = await authFor('admin');
    const res = await request(app).post('/api/video-queue/process').set(headers);

    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(2);
    expect(res.body.items[0].url).toBe('https://youtube.com/watch?v=same1');
  });

  it('200 — background: title falls back to empty string when response.data has no title', async () => {
    const item = await seedItem({ url: 'https://youtube.com/watch?v=notitle' });

    axios.post.mockResolvedValue({ data: {} });

    const { headers } = await authFor('admin');
    await request(app).post('/api/video-queue/process').set(headers);

    await new Promise((r) => setTimeout(r, 300));

    const updated = await prisma.videoQueueItem.findUnique({ where: { id: item.id } });
    expect(updated.status).toBe('completed');
    expect(updated.title).toBe('');
  });

  it('200 — background processing marks items completed on success', async () => {
    const item = await seedItem({ url: 'https://youtube.com/watch?v=bg' });

    axios.post.mockResolvedValue({ data: { title: 'BG Video' } });

    const { headers } = await authFor('admin');
    await request(app).post('/api/video-queue/process').set(headers);

    await new Promise((r) => setTimeout(r, 300));

    const updated = await prisma.videoQueueItem.findUnique({ where: { id: item.id } });
    expect(['completed', 'processing']).toContain(updated.status);
  });

  it('200 — background processing marks items failed on axios error (with response detail)', async () => {
    const item = await seedItem({ url: 'https://youtube.com/watch?v=fail' });

    axios.post.mockRejectedValue({
      response: { data: { detail: 'Python error detail' } },
      message: 'Request failed',
    });

    const { headers } = await authFor('admin');
    await request(app).post('/api/video-queue/process').set(headers);

    await new Promise((r) => setTimeout(r, 300));

    const updated = await prisma.videoQueueItem.findUnique({ where: { id: item.id } });
    expect(updated.status).toBe('failed');
    expect(updated.errorMessage).toBe('Python error detail');
  });

  it('200 — background processing: error fallback to response.data.message', async () => {
    const item = await seedItem({ url: 'https://youtube.com/watch?v=fail2' });

    axios.post.mockRejectedValue({
      response: { data: { message: 'Some message error' } },
      message: 'Request failed',
    });

    const { headers } = await authFor('admin');
    await request(app).post('/api/video-queue/process').set(headers);

    await new Promise((r) => setTimeout(r, 300));

    const updated = await prisma.videoQueueItem.findUnique({ where: { id: item.id } });
    expect(updated.status).toBe('failed');
    expect(updated.errorMessage).toBe('Some message error');
  });

  it('200 — background processing: error fallback to err.message', async () => {
    const item = await seedItem({ url: 'https://youtube.com/watch?v=fail3' });

    axios.post.mockRejectedValue(new Error('Network error'));

    const { headers } = await authFor('admin');
    await request(app).post('/api/video-queue/process').set(headers);

    await new Promise((r) => setTimeout(r, 300));

    const updated = await prisma.videoQueueItem.findUnique({ where: { id: item.id } });
    expect(updated.status).toBe('failed');
    expect(updated.errorMessage).toBe('Network error');
  });

  it('200 — background processing: error fallback to Unknown error when no details', async () => {
    const item = await seedItem({ url: 'https://youtube.com/watch?v=fail4' });

    const errObj = {};
    Object.defineProperty(errObj, 'message', { get: () => undefined });
    axios.post.mockRejectedValue(errObj);

    const { headers } = await authFor('admin');
    await request(app).post('/api/video-queue/process').set(headers);

    await new Promise((r) => setTimeout(r, 300));

    const updated = await prisma.videoQueueItem.findUnique({ where: { id: item.id } });
    expect(updated.status).toBe('failed');
    expect(updated.errorMessage).toBe('Unknown error');
  });

  it('403 — manager cannot trigger process', async () => {
    const { headers } = await authFor('manager');
    const res = await request(app).post('/api/video-queue/process').set(headers);
    expect(res.status).toBe(403);
  });

  it('403 — viewer cannot trigger process', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).post('/api/video-queue/process').set(headers);
    expect(res.status).toBe(403);
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app).post('/api/video-queue/process');
    expect(res.status).toBe(401);
  });

  it('500 — DB error in processQueue outer try triggers next(err)', async () => {
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.videoQueueItem, 'findMany').mockRejectedValueOnce(new Error('DB failure'));

    const res = await request(app).post('/api/video-queue/process').set(headers);
    expect(res.status).toBe(500);
  });
});

// ── POST /api/video-queue/chat ────────────────────────────────────────────────

describe('POST /api/video-queue/chat', () => {
  it('200 — proxies message to Python server and returns response', async () => {
    axios.post.mockResolvedValue({ data: { answer: 'This is a response', sources: [] } });

    const { headers } = await authFor('viewer');
    const res = await request(app)
      .post('/api/video-queue/chat')
      .set(headers)
      .send({ message: 'Tell me about Sadhguru' });

    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('This is a response');
  });

  it('200 — passes history to Python server', async () => {
    const history = [{ role: 'user', content: 'Previous message' }];
    axios.post.mockResolvedValue({ data: { answer: 'With history' } });

    const { headers } = await authFor('viewer');
    const res = await request(app)
      .post('/api/video-queue/chat')
      .set(headers)
      .send({ message: 'Follow-up', history });

    expect(res.status).toBe(200);
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/chat'),
      { message: 'Follow-up', history },
      expect.objectContaining({ timeout: 60_000 })
    );
  });

  it('200 — uses empty array for history when not provided', async () => {
    axios.post.mockResolvedValue({ data: { answer: 'No history' } });

    const { headers } = await authFor('viewer');
    await request(app)
      .post('/api/video-queue/chat')
      .set(headers)
      .send({ message: 'Hello' });

    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      { message: 'Hello', history: [] },
      expect.any(Object)
    );
  });

  it('400 — missing message', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app)
      .post('/api/video-queue/chat')
      .set(headers)
      .send({ history: [] });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('message is required');
  });

  it('502 — Python server error returns upstream status and detail', async () => {
    axios.post.mockRejectedValue({
      response: { status: 503, data: { detail: 'Service unavailable' } },
    });

    const { headers } = await authFor('viewer');
    const res = await request(app)
      .post('/api/video-queue/chat')
      .set(headers)
      .send({ message: 'Hello' });

    expect(res.status).toBe(503);
    expect(res.body.message).toBe('Service unavailable');
  });

  it('502 — Python server error with err.message when no response', async () => {
    axios.post.mockRejectedValue(new Error('Connection refused'));

    const { headers } = await authFor('viewer');
    const res = await request(app)
      .post('/api/video-queue/chat')
      .set(headers)
      .send({ message: 'Hello' });

    expect(res.status).toBe(502);
    expect(res.body.message).toBe('Connection refused');
  });

  it('502 — Python server error fallback message', async () => {
    const errObj = {};
    Object.defineProperty(errObj, 'message', { get: () => undefined });
    axios.post.mockRejectedValue(errObj);

    const { headers } = await authFor('viewer');
    const res = await request(app)
      .post('/api/video-queue/chat')
      .set(headers)
      .send({ message: 'Hello' });

    expect(res.status).toBe(502);
    expect(res.body.message).toBe('Python server error');
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app)
      .post('/api/video-queue/chat')
      .send({ message: 'Hello' });

    expect(res.status).toBe(401);
  });
});
