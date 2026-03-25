import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import connectDB from './config/db.js';
import { errorHandler } from './middleware/errorHandler.js';
import { startSyncScheduler } from './jobs/syncScheduler.js';
import { logger } from './utils/logger.js';
import { logRateLimitExceeded, getRateLimitLogPath } from './utils/rateLimitLog.js';

import authRoutes from './routes/auth.js';
import channelRoutes from './routes/channels.js';
import dashboardRoutes from './routes/dashboard.js';
import syncRoutes from './routes/sync.js';
import exportRoutes from './routes/export.js';
import rbacRoutes from './routes/rbac.js';
import videoSnapshotRoutes from './routes/videoSnapshots.js';
import categoryRoutes from './routes/categories.js';
import videoQueueRoutes from './routes/videoQueue.js';
import microUnitRoutes from './routes/microUnits.js';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  message: { message: 'Too many requests, please try again later' },
  identifier: 'global-api-15m',
  handler: (req, res, next, options) => {
    logRateLimitExceeded(req, options);
    const body =
      options.message && typeof options.message === 'object' && !Array.isArray(options.message)
        ? options.message
        : { message: String(options.message ?? 'Too many requests, please try again later') };
    res.status(options.statusCode).json(body);
  },
});
app.use('/api/', limiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/rbac', rbacRoutes);
app.use('/api/video-snapshots', videoSnapshotRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/video-queue', videoQueueRoutes);
app.use('/api/micro-units', microUnitRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use(errorHandler);

// Start server
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
