import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../src/utils/logger.js';
import { prisma } from '../setup.js';
import connectDB from '../../src/config/db.js';

describe('connectDB (Prisma)', () => {
  let connectSpy;
  let exitSpy;
  let originalUrl;

  beforeEach(() => {
    vi.clearAllMocks();
    originalUrl = process.env.DATABASE_URL;
    connectSpy = vi.spyOn(prisma, '$connect');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    if (originalUrl !== undefined) process.env.DATABASE_URL = originalUrl;
    else delete process.env.DATABASE_URL;
    connectSpy.mockRestore();
    exitSpy.mockRestore();
  });

  describe('success path', () => {
    it('connects via Prisma and logs the host parsed from DATABASE_URL', async () => {
      process.env.DATABASE_URL = 'postgresql://postgres:pw@db.example.com:5432/postgres';
      connectSpy.mockResolvedValueOnce(undefined);

      await connectDB();

      expect(connectSpy).toHaveBeenCalledOnce();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Postgres connected via Prisma'),
      );
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('db.example.com'));
    });

    it('falls back to "(from URL)" when DATABASE_URL is not a parseable URL', async () => {
      process.env.DATABASE_URL = 'not-a-real-url';
      connectSpy.mockResolvedValueOnce(undefined);

      await connectDB();

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('(from URL)'));
    });
  });

  describe('error path', () => {
    it('exits(1) when DATABASE_URL is unset', async () => {
      delete process.env.DATABASE_URL;

      await expect(connectDB()).rejects.toThrow('process.exit(1)');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('DATABASE_URL is required'));
    });

    it('exits(1) when prisma.$connect rejects', async () => {
      process.env.DATABASE_URL = 'postgresql://postgres:pw@db.example.com:5432/postgres';
      connectSpy.mockRejectedValueOnce(new Error('connection refused'));

      await expect(connectDB()).rejects.toThrow('process.exit(1)');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
    });
  });
});
