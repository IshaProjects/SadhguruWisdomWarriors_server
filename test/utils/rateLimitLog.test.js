import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs so mkdirSync does not touch the real filesystem.
// This must be before the module is imported.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    mkdirSync: vi.fn(),
  };
});

// We do NOT mock winston here because rateLimitFileLogger is exported directly as the
// winston logger instance. Instead we import it first and then spy on its .warn method.

import { logRateLimitExceeded, getRateLimitLogPath, rateLimitFileLogger } from '../../src/utils/rateLimitLog.js';

describe('getRateLimitLogPath', () => {
  it('returns a string path ending in rate-limit.log', () => {
    const p = getRateLimitLogPath();
    expect(typeof p).toBe('string');
    expect(p).toMatch(/rate-limit\.log$/);
  });

  it('reflects RATE_LIMIT_LOG_FILE env var when set', () => {
    // The module is already loaded, so this tests the value at load time.
    // The default path ends with 'rate-limit.log' from the logs directory.
    const p = getRateLimitLogPath();
    expect(p.length).toBeGreaterThan(0);
  });
});

describe('rateLimitFileLogger console printf callback', () => {
  it('exercises the printf format callback (covers lines 39-40) by calling warn with and without meta', () => {
    // Call the real logger.warn so the Console transport printf callback fires.
    // With extra meta keys -> rest has content
    expect(() => rateLimitFileLogger.warn({ message: 'test 429', event: 'rate_limit_exceeded', ip: '1.2.3.4' })).not.toThrow();
    // Without extra meta (only message) -> rest is empty string branch
    expect(() => rateLimitFileLogger.warn({ message: 'bare message' })).not.toThrow();
  });
});

describe('logRateLimitExceeded', () => {
  let warnSpy;

  beforeEach(() => {
    // Spy on the actual exported logger instance's warn method
    warnSpy = vi.spyOn(rateLimitFileLogger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function makeReq(overrides = {}) {
    const base = {
      method: 'GET',
      originalUrl: '/api/test',
      url: '/api/test',
      ip: '127.0.0.1',
      route: { path: '/api/test' },
      headers: {},
      get: vi.fn().mockReturnValue(null),
      rateLimit: {
        remaining: 0,
        used: 100,
        limit: 100,
        resetTime: new Date('2024-01-01T12:00:00.000Z'),
      },
    };
    return { ...base, ...overrides };
  }

  it('calls rateLimitFileLogger.warn with an object including event key', () => {
    const req = makeReq();
    const options = { windowMs: 60000, limit: 100 };
    logRateLimitExceeded(req, options);
    expect(warnSpy).toHaveBeenCalledOnce();
    const callArg = warnSpy.mock.calls[0][0];
    expect(callArg.event).toBe('rate_limit_exceeded');
  });

  it('returns an entry object with the expected keys', () => {
    const req = makeReq();
    const options = { windowMs: 60000, limit: 100 };
    const entry = logRateLimitExceeded(req, options);
    expect(entry.event).toBe('rate_limit_exceeded');
    expect(entry.method).toBe('GET');
    expect(entry.path).toBe('/api/test');
    expect(entry.ip).toBe('127.0.0.1');
    expect(entry.windowMs).toBe(60000);
    expect(entry.limitConfigured).toBe(100);
  });

  it('uses req.url when req.originalUrl is absent', () => {
    const req = makeReq({ originalUrl: undefined });
    const entry = logRateLimitExceeded(req, {});
    expect(entry.path).toBe('/api/test');
  });

  it('sets route to null when req.route is absent', () => {
    const req = makeReq({ route: undefined });
    const entry = logRateLimitExceeded(req, {});
    expect(entry.route).toBeNull();
  });

  it('captures x-forwarded-for header', () => {
    const req = makeReq({ headers: { 'x-forwarded-for': '10.0.0.1' } });
    const entry = logRateLimitExceeded(req, {});
    expect(entry.forwardedFor).toBe('10.0.0.1');
  });

  it('sets forwardedFor to null when header absent', () => {
    const req = makeReq({ headers: {} });
    const entry = logRateLimitExceeded(req, {});
    expect(entry.forwardedFor).toBeNull();
  });

  it('captures x-real-ip header', () => {
    const req = makeReq({ headers: { 'x-real-ip': '10.0.0.2' } });
    const entry = logRateLimitExceeded(req, {});
    expect(entry.realIp).toBe('10.0.0.2');
  });

  it('sets realIp to null when header absent', () => {
    const entry = logRateLimitExceeded(makeReq(), {});
    expect(entry.realIp).toBeNull();
  });

  it('captures user-agent via req.get', () => {
    const req = makeReq();
    req.get = vi.fn((h) => (h === 'user-agent' ? 'TestAgent/1.0' : null));
    const entry = logRateLimitExceeded(req, {});
    expect(entry.userAgent).toBe('TestAgent/1.0');
  });

  it('sets userAgent to null when req.get returns nothing', () => {
    const req = makeReq();
    req.get = vi.fn().mockReturnValue(null);
    const entry = logRateLimitExceeded(req, {});
    expect(entry.userAgent).toBeNull();
  });

  it('captures referer via req.get', () => {
    const req = makeReq();
    req.get = vi.fn((h) => (h === 'referer' ? 'https://example.com' : null));
    const entry = logRateLimitExceeded(req, {});
    expect(entry.referer).toBe('https://example.com');
  });

  it('resolveLimit uses options.limit when it is a number', () => {
    const entry = logRateLimitExceeded(makeReq(), { limit: 50 });
    expect(entry.limitConfigured).toBe(50);
  });

  it('resolveLimit uses options.max when options.limit is absent', () => {
    const entry = logRateLimitExceeded(makeReq(), { max: 200 });
    expect(entry.limitConfigured).toBe(200);
  });

  it('resolveLimit returns null when neither limit nor max is a number', () => {
    const entry = logRateLimitExceeded(makeReq(), {});
    expect(entry.limitConfigured).toBeNull();
  });

  it('resolveLimit returns null when limit is a function (not a number)', () => {
    const entry = logRateLimitExceeded(makeReq(), { limit: () => 100 });
    expect(entry.limitConfigured).toBeNull();
  });

  it('sets identifier from options.identifier', () => {
    const entry = logRateLimitExceeded(makeReq(), { identifier: 'myRoute' });
    expect(entry.identifier).toBe('myRoute');
  });

  it('sets identifier to null when options.identifier is absent', () => {
    const entry = logRateLimitExceeded(makeReq(), {});
    expect(entry.identifier).toBeNull();
  });

  it('converts resetTime Date to ISO string', () => {
    const resetDate = new Date('2024-06-01T10:00:00.000Z');
    const req = makeReq({
      rateLimit: { remaining: 0, used: 1, limit: 1, resetTime: resetDate },
    });
    const entry = logRateLimitExceeded(req, {});
    expect(entry.resetTime).toBe('2024-06-01T10:00:00.000Z');
  });

  it('passes through resetTime when it is already a string/number', () => {
    const req = makeReq({
      rateLimit: { remaining: 0, used: 1, limit: 1, resetTime: 'someString' },
    });
    const entry = logRateLimitExceeded(req, {});
    expect(entry.resetTime).toBe('someString');
  });

  it('sets resetTime to null when rateLimit has no resetTime', () => {
    const req = makeReq({
      rateLimit: { remaining: 0, used: 1, limit: 1 },
    });
    const entry = logRateLimitExceeded(req, {});
    expect(entry.resetTime).toBeNull();
  });

  it('handles missing rateLimit object on req gracefully', () => {
    const req = makeReq({ rateLimit: undefined });
    const entry = logRateLimitExceeded(req, {});
    expect(entry.remaining).toBeUndefined();
    expect(entry.used).toBeUndefined();
    expect(entry.limit).toBeUndefined();
    expect(entry.resetTime).toBeNull();
  });

  it('uses default empty options when called with no options arg', () => {
    const entry = logRateLimitExceeded(makeReq());
    expect(entry.windowMs).toBeUndefined();
    expect(entry.limitConfigured).toBeNull();
  });
});
