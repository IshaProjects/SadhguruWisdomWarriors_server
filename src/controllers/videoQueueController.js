import axios from 'axios';
import { prisma } from '../config/prisma.js';

const PYTHON_URL = process.env.PYTHON_SERVER_URL || 'http://localhost:8000';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Priority sort order for processing: high → normal → low, then oldest first */
function priorityOrder(p) {
  return p === 'high' ? 0 : p === 'low' ? 2 : 1;
}

// ── GET /api/video-queue ──────────────────────────────────────────────────────

export async function listQueue(req, res, next) {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const where = {};
    if (status) where.status = status;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const [items, total] = await Promise.all([
      prisma.videoQueueItem.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.videoQueueItem.count({ where }),
    ]);

    res.json({ items, total, page: pageNum, pages: Math.ceil(total / limitNum) });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/video-queue ─────────────────────────────────────────────────────

export async function addToQueue(req, res, next) {
  try {
    const { urls, url, videoType, eventName, notes, priority } = req.body;

    // Accept either a single url or a urls[] array (bulk paste)
    const rawUrls = urls ?? (url ? [url] : []);
    if (!rawUrls.length) {
      return res.status(400).json({ message: 'url or urls[] is required' });
    }

    const data = rawUrls.map((u) => ({
      url: u.trim(),
      videoType: videoType || 'normal',
      eventName: eventName || '',
      notes: notes || '',
      priority: priority || 'normal',
      addedBy: req.user?.name || req.user?.email || '',
    }));

    // createMany doesn't return rows; insert one-by-one so the response can
    // include the created items (mirrors the legacy `insertMany(...)` shape).
    // If any create rejects, the loop aborts and the error propagates to
    // next(err) → 500, matching the legacy behaviour.
    const created = [];
    for (const d of data) {
      created.push(await prisma.videoQueueItem.create({ data: d }));
    }

    res.status(201).json({ added: created.length, items: created });
  } catch (err) {
    next(err);
  }
}

// ── DELETE /api/video-queue/:id ───────────────────────────────────────────────

export async function removeFromQueue(req, res, next) {
  try {
    try {
      await prisma.videoQueueItem.delete({ where: { id: req.params.id } });
    } catch (err) {
      if (err.code === 'P2025') return res.status(404).json({ message: 'Item not found' });
      throw err;
    }
    res.json({ message: 'Removed', id: req.params.id });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /api/video-queue/:id/status ────────────────────────────────────────

export async function updateStatus(req, res, next) {
  try {
    const { status, errorMessage, title } = req.body;
    const update = { status };
    if (title) update.title = title;
    if (status === 'processing') update.startedAt = new Date();
    if (status === 'completed' || status === 'failed') update.completedAt = new Date();
    if (errorMessage) update.errorMessage = errorMessage;

    try {
      const item = await prisma.videoQueueItem.update({
        where: { id: req.params.id },
        data: update,
      });
      res.json(item);
    } catch (err) {
      if (err.code === 'P2025') return res.status(404).json({ message: 'Item not found' });
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

// ── POST /api/video-queue/process ────────────────────────────────────────────
/**
 * Triggers sequential processing of all queued items.
 * Responds immediately with the list of items being processed.
 * Each item is sent one-by-one to the Python /ingest endpoint.
 * Status updates are written to the DB so the client can poll.
 */
export async function processQueue(req, res, next) {
  try {
    // Fetch all queued items, sorted by priority then age
    const items = await prisma.videoQueueItem.findMany({ where: { status: 'queued' } });

    if (items.length === 0) {
      return res.json({ message: 'No queued items to process', processed: 0 });
    }

    items.sort((a, b) => {
      const pd = priorityOrder(a.priority) - priorityOrder(b.priority);
      return pd !== 0 ? pd : new Date(a.createdAt) - new Date(b.createdAt);
    });

    // Acknowledge immediately so the client doesn't time-out waiting
    res.json({ message: 'Processing started', queued: items.length, items });

    // Process sequentially in the background (fire-and-forget)
    ;(async () => {
      for (const item of items) {
        try {
          await prisma.videoQueueItem.update({
            where: { id: item.id },
            data: { status: 'processing', startedAt: new Date() },
          });

          const response = await axios.post(
            `${PYTHON_URL}/ingest`,
            {
              url:       item.url,
              videoType: item.videoType,
              eventName: item.eventName,
              notes:     item.notes,
              priority:  item.priority,
            },
            { timeout: 300_000 } // 5 min — transcription can be slow
          );

          await prisma.videoQueueItem.update({
            where: { id: item.id },
            data: {
              status:      'completed',
              completedAt: new Date(),
              title:       response.data?.title || '',
              errorMessage: '',
            },
          });
        } catch (err) {
          const msg =
            err.response?.data?.detail ||
            err.response?.data?.message ||
            err.message ||
            'Unknown error';

          try {
            await prisma.videoQueueItem.update({
              where: { id: item.id },
              data: {
                status:       'failed',
                completedAt:  new Date(),
                errorMessage: msg,
              },
            });
          } catch {
            // Row may have been deleted concurrently — swallow to keep the
            // background loop running for the remaining items.
          }
        }
      }
    })();
  } catch (err) {
    next(err);
  }
}

// ── POST /api/video-queue/chat ────────────────────────────────────────────────
/**
 * Proxy to Python /chat. Keeps auth in one place and avoids CORS from client.
 */
export async function chatProxy(req, res, next) {
  try {
    const { message, history } = req.body;
    if (!message) return res.status(400).json({ message: 'message is required' });

    const response = await axios.post(
      `${PYTHON_URL}/chat`,
      { message, history: history || [] },
      { timeout: 60_000 }
    );

    res.json(response.data);
  } catch (err) {
    const status  = err.response?.status  || 502;
    const message = err.response?.data?.detail || err.message || 'Python server error';
    res.status(status).json({ message });
  }
}
