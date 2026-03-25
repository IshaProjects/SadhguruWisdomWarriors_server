import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultLogDir = path.join(__dirname, '../../logs');
const logDir = process.env.RATE_LIMIT_LOG_DIR || defaultLogDir;
const logFile = process.env.RATE_LIMIT_LOG_FILE || path.join(logDir, 'rate-limit.log');

try {
  fs.mkdirSync(logDir, { recursive: true });
} catch {
  /* ignore */
}

/**
 * JSON lines to logs/rate-limit.log (and console) whenever /api hits the global limiter.
 * Share rate-limit.log when debugging 429s.
 */
export const rateLimitFileLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'rate-limit' },
  transports: [
    new winston.transports.File({
      filename: logFile,
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
      tailable: true,
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, ...meta }) => {
          const rest = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `[rate-limit] ${level}: ${message}${rest}`;
        })
      ),
    }),
  ],
});

/**
 * @param {import('express').Request} req
 * @param {object} options - options from express-rate-limit handler
 */
function resolveLimit(options) {
  const l = options.limit ?? options.max;
  return typeof l === 'number' ? l : null;
}

export function logRateLimitExceeded(req, options = {}) {
  const rl = req.rateLimit;
  const entry = {
    event: 'rate_limit_exceeded',
    method: req.method,
    path: req.originalUrl || req.url,
    route: req.route?.path ?? null,
    ip: req.ip,
    forwardedFor: req.headers['x-forwarded-for'] || null,
    realIp: req.headers['x-real-ip'] || null,
    userAgent: req.get('user-agent') || null,
    referer: req.get('referer') || null,
    windowMs: options.windowMs,
    limitConfigured: resolveLimit(options),
    identifier: options.identifier ?? null,
    remaining: rl?.remaining,
    used: rl?.used,
    limit: rl?.limit,
    resetTime: rl?.resetTime instanceof Date ? rl.resetTime.toISOString() : rl?.resetTime ?? null,
  };
  rateLimitFileLogger.warn({ message: 'Too many requests (429)', ...entry });
  return entry;
}

export function getRateLimitLogPath() {
  return logFile;
}
