import request from 'supertest';
import jwt from 'jsonwebtoken';
import { describe, it, expect } from 'vitest';
import app from '../../src/app.js';
import { authFor, createUser } from '../helpers.js';

describe('authenticate middleware', () => {
  it('401 when no Authorization header is present', async () => {
    const res = await request(app).get('/api/channels');
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('No token provided');
  });

  it('401 when the token is malformed/invalid', async () => {
    const res = await request(app)
      .get('/api/channels')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid token');
  });

  it('401 when the token is valid but the user no longer exists', async () => {
    // CUID-shaped id that doesn't correspond to any row.
    const token = jwt.sign({ id: 'cnonexistentuser000000001' }, process.env.JWT_SECRET);
    const res = await request(app).get('/api/channels').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('User not found');
  });

  it('401 when the token is expired', async () => {
    const user = await createUser();
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: -1 });
    const res = await request(app).get('/api/channels').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Token expired');
  });

  it('passes an authenticated user through to the route', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).get('/api/channels').set(headers);
    expect(res.status).toBe(200);
  });
});

describe('authorize middleware', () => {
  it('403 when the user role is not permitted', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).post('/api/channels').set(headers).send({});
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Insufficient permissions');
  });

  it('calls next() for a permitted role (not a 403)', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).post('/api/channels').set(headers).send({});
    expect(res.status).not.toBe(403);
  });
});
