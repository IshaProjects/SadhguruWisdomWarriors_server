import request from 'supertest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import app from '../../src/app.js';
import { prisma } from '../setup.js';
import { authFor } from '../helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// Minimal valid pages/actions for update tests
const VALID_PAGES = [
  { key: 'dashboard', label: 'Dashboard', roles: { admin: true, manager: true, viewer: true } },
];
const VALID_ACTIONS = [
  { key: 'channels.add', label: 'Add Channel', roles: { admin: true, manager: true, viewer: false } },
];

describe('GET /api/rbac', () => {
  it('200 — creates and returns default config when none exists', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/rbac').set(headers);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pages)).toBe(true);
    expect(Array.isArray(res.body.actions)).toBe(true);
    expect(res.body.pages.length).toBeGreaterThan(0);
    expect(res.body.actions.length).toBeGreaterThan(0);
    expect(res.body.updatedAt).toBeTruthy();
  });

  it('200 — returns existing config when it already exists', async () => {
    // Seed by calling the endpoint once first
    const { headers } = await authFor('admin');
    await request(app).get('/api/rbac').set(headers);

    // Call again — should return existing config without re-creating
    const res = await request(app).get('/api/rbac').set(headers);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pages)).toBe(true);
  });

  it('200 — merges missing default keys into existing config', async () => {
    // Create a config missing some default keys
    await prisma.rbacConfig.create({
      data: {
        id: 'rbac',
        pages: [{ key: 'dashboard', label: 'Dashboard', roles: { admin: true, manager: true, viewer: true } }],
        actions: [{ key: 'channels.add', label: 'Add Channel', roles: { admin: true, manager: true, viewer: false } }],
      },
    });

    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/rbac').set(headers);

    expect(res.status).toBe(200);
    // Should now include all default pages (merged)
    const pageKeys = res.body.pages.map((p) => p.key);
    expect(pageKeys).toContain('channels');
    expect(pageKeys).toContain('settings');
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app).get('/api/rbac');
    expect(res.status).toBe(401);
  });

  it('500 — DB error in getRbacConfig triggers next(err)', async () => {
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.rbacConfig, 'findUnique').mockRejectedValueOnce(new Error('DB failure'));

    const res = await request(app).get('/api/rbac').set(headers);
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/rbac', () => {
  it('200 — admin can update RBAC config', async () => {
    const { headers } = await authFor('admin');

    const res = await request(app)
      .put('/api/rbac')
      .set(headers)
      .send({ pages: VALID_PAGES, actions: VALID_ACTIONS });

    expect(res.status).toBe(200);
    expect(res.body.pages).toHaveLength(1);
    expect(res.body.pages[0].key).toBe('dashboard');
    // admin role must always be true (safety net)
    expect(res.body.pages[0].roles.admin).toBe(true);
    expect(res.body.actions[0].roles.admin).toBe(true);
    expect(res.body.updatedAt).toBeTruthy();
  });

  it('200 — ensureAdmin forces admin=true even when sent as false', async () => {
    const { headers } = await authFor('admin');

    const pages = [
      { key: 'settings', label: 'Settings', roles: { admin: false, manager: false, viewer: false } },
    ];
    const actions = [
      { key: 'channels.delete', label: 'Delete Channel', roles: { admin: false, manager: false, viewer: false } },
    ];

    const res = await request(app)
      .put('/api/rbac')
      .set(headers)
      .send({ pages, actions });

    expect(res.status).toBe(200);
    expect(res.body.pages[0].roles.admin).toBe(true);
    expect(res.body.actions[0].roles.admin).toBe(true);
  });

  it('200 — upserts (creates config) when none exists', async () => {
    const { headers } = await authFor('admin');

    const res = await request(app)
      .put('/api/rbac')
      .set(headers)
      .send({ pages: VALID_PAGES, actions: VALID_ACTIONS });

    expect(res.status).toBe(200);
    expect(res.body.pages.length).toBeGreaterThan(0);
  });

  it('400 — missing pages array', async () => {
    const { headers } = await authFor('admin');

    const res = await request(app)
      .put('/api/rbac')
      .set(headers)
      .send({ actions: VALID_ACTIONS });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('pages and actions arrays are required');
  });

  it('400 — missing actions array', async () => {
    const { headers } = await authFor('admin');

    const res = await request(app)
      .put('/api/rbac')
      .set(headers)
      .send({ pages: VALID_PAGES });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('pages and actions arrays are required');
  });

  it('400 — pages is not an array', async () => {
    const { headers } = await authFor('admin');

    const res = await request(app)
      .put('/api/rbac')
      .set(headers)
      .send({ pages: 'notAnArray', actions: VALID_ACTIONS });

    expect(res.status).toBe(400);
  });

  it('400 — entry missing key', async () => {
    const { headers } = await authFor('admin');

    const res = await request(app)
      .put('/api/rbac')
      .set(headers)
      .send({
        pages: [{ label: 'Dashboard', roles: { admin: true } }],
        actions: VALID_ACTIONS,
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Each entry needs key, label, and roles');
  });

  it('400 — entry missing label', async () => {
    const { headers } = await authFor('admin');

    const res = await request(app)
      .put('/api/rbac')
      .set(headers)
      .send({
        pages: [{ key: 'dashboard', roles: { admin: true } }],
        actions: VALID_ACTIONS,
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Each entry needs key, label, and roles');
  });

  it('400 — entry missing roles', async () => {
    const { headers } = await authFor('admin');

    const res = await request(app)
      .put('/api/rbac')
      .set(headers)
      .send({
        pages: VALID_PAGES,
        actions: [{ key: 'channels.add', label: 'Add Channel' }],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Each entry needs key, label, and roles');
  });

  it('403 — manager cannot update RBAC config', async () => {
    const { headers } = await authFor('manager');

    const res = await request(app)
      .put('/api/rbac')
      .set(headers)
      .send({ pages: VALID_PAGES, actions: VALID_ACTIONS });

    expect(res.status).toBe(403);
  });

  it('403 — viewer cannot update RBAC config', async () => {
    const { headers } = await authFor('viewer');

    const res = await request(app)
      .put('/api/rbac')
      .set(headers)
      .send({ pages: VALID_PAGES, actions: VALID_ACTIONS });

    expect(res.status).toBe(403);
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app)
      .put('/api/rbac')
      .send({ pages: VALID_PAGES, actions: VALID_ACTIONS });

    expect(res.status).toBe(401);
  });

  it('500 — DB error in updateRbacConfig triggers next(err)', async () => {
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.rbacConfig, 'upsert').mockRejectedValueOnce(new Error('DB failure'));

    const res = await request(app)
      .put('/api/rbac')
      .set(headers)
      .send({ pages: VALID_PAGES, actions: VALID_ACTIONS });

    expect(res.status).toBe(500);
  });
});
