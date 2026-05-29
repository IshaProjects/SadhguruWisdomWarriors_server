import { prisma } from './prisma.js';
import { logger } from '../utils/logger.js';

/**
 * Open the Prisma connection used by every request. Called once from
 * src/server.js at startup. Same default-export shape as the previous
 * Mongoose connector so server.js doesn't have to change.
 */
const connectDB = async () => {
  const url = process.env.DATABASE_URL;
  try {
    if (!url) {
      throw new Error('DATABASE_URL is required');
    }
    await prisma.$connect();
    // Pull host out of the URL purely for the log line.
    let host = '(from URL)';
    try {
      host = new URL(url).host || host;
    } catch {
      // ignore — non-URL connection strings are still valid for Prisma.
    }
    logger.info(`Postgres connected via Prisma: ${host}`);
  } catch (error) {
    logger.error(`Postgres connection error: ${error.message}`);
    process.exit(1);
  }
};

export default connectDB;
