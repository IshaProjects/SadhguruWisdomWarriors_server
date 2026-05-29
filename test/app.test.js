import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import app from '../src/app.js';

describe('app health check', () => {
  it('GET /api/health returns ok with a timestamp', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.timestamp).toBe('string');
  });
});

describe('app rate limiter handler', () => {
  // The global /api/auth limiter is windowMs=15min, limit=200. Once tripped within
  // a test file the in-memory store does not reset, so we hammer it just past the
  // threshold and then verify the handler shape — covering src/app.js lines 36-41
  // (the custom handler: logRateLimitExceeded → body normalisation → res.status().json()).
  it('returns 429 JSON when the limit is exceeded', async () => {
    // Fire just over the limit. /api/auth/login bails fast on missing credentials.
    let last;
    for (let i = 0; i < 210; i += 1) {
      last = await request(app).post('/api/auth/login').send({});
      if (last.status === 429) break;
    }
    expect(last.status).toBe(429);
    expect(last.body).toEqual(
      expect.objectContaining({ message: expect.any(String) }),
    );
    expect(last.body.message).toMatch(/too many requests/i);
  });

  it('still rate-limits subsequent requests within the window', async () => {
    // After the previous test trips the store, follow-up requests stay 429
    // without re-counting another 200 — this exercises the limited path
    // a second time so the handler branch (Array.isArray / typeof object) is
    // executed under a sticky-limit condition.
    const res = await request(app).post('/api/auth/login').send({});
    expect(res.status).toBe(429);
    expect(res.body.message).toBeDefined();
  });
});
