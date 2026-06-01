import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { errorHandler } from './middleware/errorHandler.js';
import { logRateLimitExceeded } from './utils/rateLimitLog.js';

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

// Behind DigitalOcean App Platform's load balancer, which sets X-Forwarded-For.
// Trust exactly one proxy hop so req.ip reflects the real client (and
// express-rate-limit can key on it). `1` rather than `true` — `true` is
// permissive and lets clients spoof X-Forwarded-For to evade the limiter.
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json());
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

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

// Routes
app.use('/api/auth', limiter, authRoutes);
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

export default app;
