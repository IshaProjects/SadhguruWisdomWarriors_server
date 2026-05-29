import 'dotenv/config';

import app from './app.js';
import connectDB from './config/db.js';
import { startSyncScheduler } from './jobs/syncScheduler.js';
import { logger } from './utils/logger.js';
import { getRateLimitLogPath } from './utils/rateLimitLog.js';

const PORT = process.env.PORT || 5000;

async function start() {
  await connectDB();
  await startSyncScheduler();

  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`Rate limit 429 events append to: ${getRateLimitLogPath()}`);
  });
}

start();
