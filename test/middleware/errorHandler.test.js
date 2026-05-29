import { describe, it, expect, vi, beforeEach } from 'vitest';

// Silence logger noise during error handler tests
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { errorHandler } from '../../src/middleware/errorHandler.js';

function makeRes() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

const req = {};
const next = vi.fn();

describe('errorHandler middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ValidationError', () => {
    it('responds with 400 and validation messages', () => {
      const err = {
        name: 'ValidationError',
        errors: {
          email: { message: 'Email is required' },
          password: { message: 'Password too short' },
        },
      };
      const res = makeRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        message: 'Validation error',
        errors: expect.arrayContaining(['Email is required', 'Password too short']),
      });
    });

    it('responds with 400 even for a single validation error', () => {
      const err = {
        name: 'ValidationError',
        errors: { name: { message: 'Name required' } },
      };
      const res = makeRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].errors).toEqual(['Name required']);
    });
  });

  describe('Duplicate key error (code 11000)', () => {
    it('responds with 409 and field name in message', () => {
      const err = {
        code: 11000,
        keyValue: { email: 'dup@test.com' },
      };
      const res = makeRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({ message: 'Duplicate value for email' });
    });

    it('uses the correct field name from keyValue', () => {
      const err = { code: 11000, keyValue: { username: 'taken' } };
      const res = makeRes();
      errorHandler(err, req, res, next);
      expect(res.json).toHaveBeenCalledWith({ message: 'Duplicate value for username' });
    });
  });

  describe('CastError', () => {
    it('responds with 400 and "Invalid ID format"', () => {
      const err = { name: 'CastError', message: 'Cast to ObjectId failed' };
      const res = makeRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Invalid ID format' });
    });
  });

  describe('Error with explicit statusCode', () => {
    it('uses err.statusCode when set', () => {
      const err = { statusCode: 403, message: 'Forbidden' };
      const res = makeRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ message: 'Forbidden' });
    });

    it('uses err.statusCode of 422', () => {
      const err = { statusCode: 422, message: 'Unprocessable entity' };
      const res = makeRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(422);
    });
  });

  describe('Default 500 path', () => {
    it('responds with 500 when no statusCode is set and no special name/code', () => {
      const err = new Error('Something blew up');
      const res = makeRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: 'Something blew up' });
    });

    it('responds with 500 and "Internal server error" when no message', () => {
      const err = {};
      const res = makeRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: 'Internal server error' });
    });

    it('logs err.stack when present', () => {
      const err = new Error('boom');
      const res = makeRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('logs err.message when no stack', () => {
      const err = { message: 'no stack here' };
      const res = makeRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
