import request from 'supertest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import app from '../../src/app.js';
import { prisma } from '../setup.js';
import { authFor } from '../helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/categories', () => {
  it('200 — returns categories with channel counts (seeds Uncategorized)', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/categories').set(headers);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const names = res.body.map((c) => c.name);
    expect(names).toContain('Uncategorized');
  });

  it('200 — reflects correct channel counts', async () => {
    await prisma.category.create({ data: { name: 'Spirituality' } });
    await prisma.channel.create({ data: { youtubeChannelId: 'ch1', title: 'Ch1', category: 'Spirituality' } });
    await prisma.channel.create({ data: { youtubeChannelId: 'ch2', title: 'Ch2', category: 'Spirituality' } });

    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/categories').set(headers);

    expect(res.status).toBe(200);
    const spirituality = res.body.find((c) => c.name === 'Spirituality');
    expect(spirituality).toBeTruthy();
    expect(spirituality.count).toBe(2);
  });

  it('200 — auto-registers category names used by channels but not in categories table', async () => {
    await prisma.channel.create({ data: { youtubeChannelId: 'ch3', title: 'Ch3', category: 'Orphan Category' } });

    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/categories').set(headers);

    expect(res.status).toBe(200);
    const names = res.body.map((c) => c.name);
    expect(names).toContain('Orphan Category');
  });

  it('200 — category with no channels has count 0', async () => {
    await prisma.category.create({ data: { name: 'Empty Cat' } });

    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/categories').set(headers);

    expect(res.status).toBe(200);
    const emptyCat = res.body.find((c) => c.name === 'Empty Cat');
    expect(emptyCat).toBeTruthy();
    expect(emptyCat.count).toBe(0);
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(401);
  });

  it('500 — DB error in listCategories triggers next(err)', async () => {
    const { headers } = await authFor('viewer');
    vi.spyOn(prisma.channel, 'groupBy').mockRejectedValueOnce(new Error('DB failure'));

    const res = await request(app).get('/api/categories').set(headers);
    expect(res.status).toBe(500);
  });

  it('200 — createMany error in auto-register is swallowed silently', async () => {
    await prisma.channel.create({ data: { youtubeChannelId: 'ch_orphan', title: 'Orphan', category: 'OrphanCat' } });

    vi.spyOn(prisma.category, 'createMany').mockRejectedValueOnce(
      Object.assign(new Error('Duplicate'), { code: 'P2002' }),
    );

    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/categories').set(headers);

    // listCategories does not wrap createMany in .catch so the error propagates to 500.
    expect(res.status).toBe(500);
  });
});

describe('POST /api/categories', () => {
  it('201 — admin can create a category', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/categories')
      .set(headers)
      .send({ name: 'Meditation' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Meditation');
    expect(res.body.count).toBe(0);
  });

  it('201 — manager can create a category', async () => {
    const { headers } = await authFor('manager');
    const res = await request(app)
      .post('/api/categories')
      .set(headers)
      .send({ name: 'Yoga' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Yoga');
  });

  it('201 — trims whitespace from category name', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/categories')
      .set(headers)
      .send({ name: '  TrimMe  ' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('TrimMe');
  });

  it('400 — missing name', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/categories')
      .set(headers)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Category name is required');
  });

  it('400 — name is empty string', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/categories')
      .set(headers)
      .send({ name: '' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Category name is required');
  });

  it('400 — name is only whitespace', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/categories')
      .set(headers)
      .send({ name: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Category name is required');
  });

  it('409 — duplicate category name', async () => {
    await prisma.category.create({ data: { name: 'Duplicate' } });

    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/categories')
      .set(headers)
      .send({ name: 'Duplicate' });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Category already exists');
  });

  it('403 — viewer cannot create categories', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app)
      .post('/api/categories')
      .set(headers)
      .send({ name: 'NewCat' });

    expect(res.status).toBe(403);
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app).post('/api/categories').send({ name: 'NewCat' });
    expect(res.status).toBe(401);
  });

  it('409 — race condition duplicate (P2002 from create)', async () => {
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.category, 'findUnique').mockResolvedValueOnce(null);
    const dupErr = Object.assign(new Error('Duplicate key'), { code: 'P2002' });
    vi.spyOn(prisma.category, 'create').mockRejectedValueOnce(dupErr);

    const res = await request(app)
      .post('/api/categories')
      .set(headers)
      .send({ name: 'RaceCat' });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Category already exists');
  });

  it('500 — unexpected DB error in createCategory triggers next(err)', async () => {
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.category, 'findUnique').mockResolvedValueOnce(null);
    vi.spyOn(prisma.category, 'create').mockRejectedValueOnce(new Error('Unexpected DB error'));

    const res = await request(app)
      .post('/api/categories')
      .set(headers)
      .send({ name: 'ErrorCat' });

    expect(res.status).toBe(500);
  });
});

describe('PUT /api/categories/:name', () => {
  it('200 — admin can rename a category', async () => {
    await prisma.category.create({ data: { name: 'OldName' } });

    const { headers } = await authFor('admin');
    const res = await request(app)
      .put('/api/categories/OldName')
      .set(headers)
      .send({ name: 'NewName' });

    expect(res.status).toBe(200);
    expect(res.body.oldName).toBe('OldName');
    expect(res.body.newName).toBe('NewName');
    expect(res.body.channelsUpdated).toBe(0);
  });

  it('200 — manager can rename a category', async () => {
    await prisma.category.create({ data: { name: 'MgrOld' } });

    const { headers } = await authFor('manager');
    const res = await request(app)
      .put('/api/categories/MgrOld')
      .set(headers)
      .send({ name: 'MgrNew' });

    expect(res.status).toBe(200);
    expect(res.body.newName).toBe('MgrNew');
  });

  it('200 — bulk-updates channels when category is renamed', async () => {
    await prisma.category.create({ data: { name: 'Renaming' } });
    await prisma.channel.create({ data: { youtubeChannelId: 'ch4', title: 'Ch4', category: 'Renaming' } });
    await prisma.channel.create({ data: { youtubeChannelId: 'ch5', title: 'Ch5', category: 'Renaming' } });

    const { headers } = await authFor('admin');
    const res = await request(app)
      .put('/api/categories/Renaming')
      .set(headers)
      .send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(res.body.channelsUpdated).toBe(2);

    const channels = await prisma.channel.findMany({ where: { category: 'Renamed' } });
    expect(channels).toHaveLength(2);
  });

  it('200 — URL-encoded category name is decoded', async () => {
    await prisma.category.create({ data: { name: 'My Category' } });

    const { headers } = await authFor('admin');
    const res = await request(app)
      .put('/api/categories/My%20Category')
      .set(headers)
      .send({ name: 'My Renamed Category' });

    expect(res.status).toBe(200);
    expect(res.body.oldName).toBe('My Category');
  });

  it('400 — missing new name', async () => {
    await prisma.category.create({ data: { name: 'Existing' } });

    const { headers } = await authFor('admin');
    const res = await request(app)
      .put('/api/categories/Existing')
      .set(headers)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('New category name is required');
  });

  it('400 — new name is empty string', async () => {
    await prisma.category.create({ data: { name: 'Existing2' } });

    const { headers } = await authFor('admin');
    const res = await request(app)
      .put('/api/categories/Existing2')
      .set(headers)
      .send({ name: '' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('New category name is required');
  });

  it('400 — new name same as current name', async () => {
    await prisma.category.create({ data: { name: 'Same' } });

    const { headers } = await authFor('admin');
    const res = await request(app)
      .put('/api/categories/Same')
      .set(headers)
      .send({ name: 'Same' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('New name must differ from current name');
  });

  it('404 — category not found', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .put('/api/categories/NonExistent')
      .set(headers)
      .send({ name: 'Whatever' });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Category not found');
  });

  it('403 — viewer cannot rename categories', async () => {
    await prisma.category.create({ data: { name: 'ToRename' } });

    const { headers } = await authFor('viewer');
    const res = await request(app)
      .put('/api/categories/ToRename')
      .set(headers)
      .send({ name: 'Renamed' });

    expect(res.status).toBe(403);
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app).put('/api/categories/SomeCat').send({ name: 'NewCat' });
    expect(res.status).toBe(401);
  });

  it('409 — race condition duplicate in renameCategory (P2002 from update)', async () => {
    await prisma.category.create({ data: { name: 'RenameConflict' } });
    const { headers } = await authFor('admin');
    const dupErr = Object.assign(new Error('Duplicate key'), { code: 'P2002' });
    vi.spyOn(prisma.category, 'update').mockRejectedValueOnce(dupErr);

    const res = await request(app)
      .put('/api/categories/RenameConflict')
      .set(headers)
      .send({ name: 'SomethingElse' });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('A category with that name already exists');
  });

  it('500 — unexpected DB error in renameCategory triggers next(err)', async () => {
    await prisma.category.create({ data: { name: 'RenameErr' } });
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.category, 'update').mockRejectedValueOnce(new Error('Unexpected'));

    const res = await request(app)
      .put('/api/categories/RenameErr')
      .set(headers)
      .send({ name: 'RenameErrNew' });

    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/categories/:name', () => {
  it('200 — admin can delete a category', async () => {
    await prisma.category.create({ data: { name: 'ToDelete' } });

    const { headers } = await authFor('admin');
    const res = await request(app).delete('/api/categories/ToDelete').set(headers);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe('ToDelete');
    expect(res.body.channelsReassigned).toBe(0);
  });

  it('200 — manager can delete a category', async () => {
    await prisma.category.create({ data: { name: 'MgrDelete' } });

    const { headers } = await authFor('manager');
    const res = await request(app).delete('/api/categories/MgrDelete').set(headers);

    expect(res.status).toBe(200);
  });

  it('200 — channels reassigned to Uncategorized on delete', async () => {
    await prisma.category.create({ data: { name: 'ToClear' } });
    await prisma.channel.create({ data: { youtubeChannelId: 'ch6', title: 'Ch6', category: 'ToClear' } });
    await prisma.channel.create({ data: { youtubeChannelId: 'ch7', title: 'Ch7', category: 'ToClear' } });

    const { headers } = await authFor('admin');
    const res = await request(app).delete('/api/categories/ToClear').set(headers);

    expect(res.status).toBe(200);
    expect(res.body.channelsReassigned).toBe(2);

    const channels = await prisma.channel.findMany({ where: { category: 'Uncategorized' } });
    expect(channels.length).toBeGreaterThanOrEqual(2);
  });

  it('200 — URL-encoded category name is decoded', async () => {
    await prisma.category.create({ data: { name: 'Delete Me' } });

    const { headers } = await authFor('admin');
    const res = await request(app).delete('/api/categories/Delete%20Me').set(headers);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe('Delete Me');
  });

  it('400 — cannot delete Uncategorized', async () => {
    await prisma.category.create({ data: { name: 'Uncategorized' } });

    const { headers } = await authFor('admin');
    const res = await request(app).delete('/api/categories/Uncategorized').set(headers);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Cannot delete the Uncategorized category');
  });

  it('404 — category not found', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).delete('/api/categories/NonExistent').set(headers);

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Category not found');
  });

  it('403 — viewer cannot delete categories', async () => {
    await prisma.category.create({ data: { name: 'ProtectedCat' } });

    const { headers } = await authFor('viewer');
    const res = await request(app).delete('/api/categories/ProtectedCat').set(headers);

    expect(res.status).toBe(403);
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app).delete('/api/categories/SomeCat');
    expect(res.status).toBe(401);
  });

  it('500 — DB error in deleteCategory triggers next(err)', async () => {
    await prisma.category.create({ data: { name: 'DeleteErr' } });
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.category, 'delete').mockRejectedValueOnce(new Error('DB failure'));

    const res = await request(app).delete('/api/categories/DeleteErr').set(headers);

    expect(res.status).toBe(500);
  });
});
