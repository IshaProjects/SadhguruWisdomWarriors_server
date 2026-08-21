import 'dotenv/config';

import app from './app.js';
import connectDB from './config/db.js';
import { startSyncScheduler } from './jobs/syncScheduler.js';
import { logger } from './utils/logger.js';
import { getRateLimitLogPath } from './utils/rateLimitLog.js';

const PORT = process.env.PORT || 5000;

async function start() {
  try {
    await connectDB();
  } catch (err) {
    logger.error('Database connection error during startup:', err);
  }

  try {
    await startSyncScheduler();
  } catch (err) {
    logger.error('Sync scheduler error during startup:', err);
  }

  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`Rate limit 429 events append to: ${getRateLimitLogPath()}`);
  });
}

start();
