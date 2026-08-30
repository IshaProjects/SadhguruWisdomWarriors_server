import { prisma } from '../config/prisma.js';
import { fetchSingleChannel, resolveChannelByHandle, fetchChannelByHandle } from '../services/youtubeApi.js';
import { syncChannels, pullAllChannelVideos, pullAllChannelsVideos } from '../services/syncEngine.js';
import { classifySadguruVideoBatch } from '../services/vertexAiService.js';
import { extractChannelId, parseYoutubeStatInt } from '../utils/helpers.js';
import { softDeleteChannels } from '../utils/softDelete.js';
import { parse } from 'csv-parse/sync';
import { utcStartOfDay } from '../utils/dateUtc.js';
import { isDedicatedChannel, isIhiChannel } from '../utils/channelGroup.js';
import {
  findFirstMissingGoogleSheetChannel,
  addFirstMissingGoogleSheetChannel,
  syncAllGoogleSheetChannels,
  previewGoogleSheetSync,
  importApprovedSheetChannels,
} from '../services/googleSheetSync.js';

// ---------------------------------------------------------------------------
// Helpers — shape Prisma rows to the legacy (Mongoose) API contract so the
// existing API consumers (and the parity tests) keep working unchanged.
// ---------------------------------------------------------------------------

/** Pull a value from either a flattened or nested ("currentStats.x") field */
function bigIntToNumber(v) {
  if (v == null) return v;
  if (typeof v === 'bigint') return Number(v);
  return v;
}

/** Reshape a Prisma channel row to the legacy Mongoose JSON shape. */
function serializeChannel(c) {
  if (!c) return c;
  const {
    id,
    assignedToId,
    assignedTo,
    currentSubscribers,
    currentViews,
    currentVideoCount,
    ...rest
  } = c;

  // assignedTo: when included, return { _id, name, email }; when absent or
  // explicitly null, return null. Old API surfaced an ObjectId hex string for
  // un-populated relations — for parity we collapse to null when no related
  // user object is present (callers that need the raw id can use assignedToId).
  let assignedToOut = null;
  if (assignedTo && typeof assignedTo === 'object') {
    assignedToOut = { _id: assignedTo.id, name: assignedTo.name, email: assignedTo.email };
  }

  return {
    ...rest,
    _id: id,
    id,
    assignedTo: assignedToOut,
    currentStats: {
      subscribers: currentSubscribers ?? 0,
      views: bigIntToNumber(currentViews) ?? 0,
      videoCount: currentVideoCount ?? 0,
    },
  };
}

function serializeVideo(v) {
  if (!v) return v;
  return {
    ...v,
    _id: v.id,
    views: bigIntToNumber(v.views) ?? 0,
    // likes/comments are Int already — no conversion needed.
  };
}

function serializeSnapshot(s) {
  if (!s) return s;
  return {
    ...s,
    _id: s.id,
    views: bigIntToNumber(s.views) ?? 0,
  };
}

/**
 * Validate a Prisma channel id. Cuids are reasonably long alphanumeric strings;
 * anything else (e.g. "not-an-id") triggers a 400 to mirror the Mongoose
 * CastError → 400 behaviour the old controller relied on.
 */
function isValidId(id) {
  return typeof id === 'string' && /^[a-z0-9]{20,}$/i.test(id);
}

/** Translate a Mongo-style sort string (e.g. "-currentStats.subscribers") to Prisma orderBy. */
function parseChannelSort(sort) {
  const raw = (sort || '-currentStats.subscribers').trim();
  const desc = raw.startsWith('-');
  const field = desc ? raw.slice(1) : raw;
  const dir = desc ? 'desc' : 'asc';

  const fieldMap = {
    'currentStats.subscribers': 'currentSubscribers',
    'currentStats.views': 'currentViews',
    'currentStats.videoCount': 'currentVideoCount',
    title: 'title',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    lastSyncedAt: 'lastSyncedAt',
    publishedAt: 'publishedAt',
    category: 'category',
    status: 'status',
  };
  const prismaField = fieldMap[field] || 'currentSubscribers';
  return [{ [prismaField]: dir }];
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

export async function listChannels(req, res, next) {
  try {
    const {
      page = 1,
      limit = 25,
      search,
      category,
      group,
      tags,
      status,
      assignedTo,
      sort = '-currentStats.subscribers',
      minSubs,
      maxSubs,
    } = req.query;

    const where = { deletedAt: null };

    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { youtubeChannelId: { contains: search, mode: 'insensitive' } },
        { customUrl: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (category) {
      where.category = category;
    } else if (group === 'dedicated') {
      where.category = { startsWith: 'Dedicated', mode: 'insensitive' };
    } else if (group === 'ihi') {
      where.category = { contains: 'IHI', mode: 'insensitive' };
    }

    if (status) {
      where.status = status;
    } else {
      where.status = { not: 'archived' };
    }

    if (tags && typeof tags === 'string' && tags.trim()) {
      const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
      if (tagList.length) where.tags = { hasSome: tagList };
    }

    if (assignedTo) where.assignedToId = assignedTo;

    if (minSubs || maxSubs) {
      where.currentSubscribers = {};
      if (minSubs) where.currentSubscribers.gte = parseInt(minSubs);
      if (maxSubs) where.currentSubscribers.lte = parseInt(maxSubs);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const orderBy = parseChannelSort(sort);

    const [channels, total, unclassifiedRows] = await Promise.all([
      prisma.channel.findMany({
        where,
        orderBy,
        skip,
        take: parseInt(limit),
        include: { assignedTo: { select: { id: true, name: true, email: true } } },
      }),
      prisma.channel.count({ where }),
      prisma.video.findMany({
        where: { deletedAt: null, classification: '' },
        distinct: ['channelId'],
        select: { channelId: true },
      }),
    ]);

    const unclassifiedSet = new Set(unclassifiedRows.map((r) => String(r.channelId)));
    const channelsWithFlag = channels.map((ch) => {
      // IHI channels must always show '-' (classificationDone: false)
      if (isIhiChannel(ch)) {
        return {
          ...serializeChannel(ch),
          classificationDone: false,
        };
      }
      // Dedicated channels always show '✓' (classificationDone: true)
      if (isDedicatedChannel(ch)) {
        return {
          ...serializeChannel(ch),
          classificationDone: true,
        };
      }
      // Other categories: based on remaining unclassified videos
      return {
        ...serializeChannel(ch),
        classificationDone: !unclassifiedSet.has(String(ch.id)),
      };
    });

    res.json({
      channels: channelsWithFlag,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function addChannel(req, res, next) {
  try {
    const { channelInput, category, tags, notes, assignedTo } = req.body;

    if (!channelInput) {
      return res.status(400).json({ message: 'Channel ID or URL is required' });
    }

    let channelId = extractChannelId(channelInput);

    if (channelId && typeof channelId === 'object' && channelId.handle) {
      const resolved = await resolveChannelByHandle(channelId.handle);
      if (!resolved) {
        return res.status(404).json({ message: 'Channel not found' });
      }
      channelId = resolved;
    }

    const existing = await prisma.channel.findFirst({ where: { youtubeChannelId: channelId } });
    if (existing) {
      return res
        .status(409)
        .json({ message: 'Channel already tracked', channel: serializeChannel(existing) });
    }

    const ytData = await fetchSingleChannel(channelId);
    if (!ytData) {
      return res.status(404).json({ message: 'Channel not found on YouTube' });
    }

    const channel = await prisma.channel.create({
      data: {
        youtubeChannelId: channelId,
        title: ytData.snippet.title || '',
        description: ytData.snippet.description || '',
        thumbnailUrl:
          ytData.snippet.thumbnails?.high?.url ||
          ytData.snippet.thumbnails?.default?.url ||
          '',
        bannerUrl: ytData.brandingSettings?.image?.bannerExternalUrl || '',
        customUrl: ytData.snippet.customUrl || '',
        country: ytData.snippet.country || '',
        publishedAt: ytData.snippet.publishedAt ? new Date(ytData.snippet.publishedAt) : null,
        uploadsPlaylistId:
          ytData.contentDetails?.relatedPlaylists?.uploads || '',
        category: category || 'Uncategorized',
        tags: tags || [],
        notes: notes || '',
        assignedToId: assignedTo || null,
        currentSubscribers: parseYoutubeStatInt(ytData.statistics?.subscriberCount),
        currentViews: BigInt(parseYoutubeStatInt(ytData.statistics?.viewCount)),
        currentVideoCount: parseYoutubeStatInt(ytData.statistics?.videoCount),
        lastSyncedAt: new Date(),
      },
    });

    const today = utcStartOfDay();
    await prisma.channelSnapshot.create({
      data: {
        channelId: channel.id,
        date: today,
        subscribers: channel.currentSubscribers,
        views: channel.currentViews,
        videoCount: channel.currentVideoCount,
      },
    });

    res.status(201).json(serializeChannel(channel));
  } catch (err) {
    next(err);
  }
}

export async function bulkImport(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'CSV file is required' });
    }

    const csvContent = req.file.buffer.toString('utf-8');
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    const results = { added: 0, skipped: 0, errors: [], addedChannels: [] };

    // Pre-collect and upsert all categories from the CSV.
    const categoryNames = [
      ...new Set(
        records
          .map((r) => (r.category || '').trim())
          .filter(Boolean)
      ),
    ];
    for (const name of categoryNames) {
      await prisma.category.upsert({
        where: { name },
        update: {},
        create: { name },
      });
    }

    for (const record of records) {
      const channelInput = (record.channel_id || record.channelId || '').trim();
      if (!channelInput) {
        results.errors.push({ input: JSON.stringify(record), error: 'Missing channel_id column' });
        continue;
      }

      try {
        const parsed = extractChannelId(channelInput);

        let ytData = null;

        if (typeof parsed === 'string' && /^UC[\w-]{22}$/.test(parsed)) {
          // Direct channel ID — cheapest lookup
          const existing = await prisma.channel.findFirst({ where: { youtubeChannelId: parsed } });
          if (existing) {
            results.skipped++;
            continue;
          }
          ytData = await fetchSingleChannel(parsed);

        } else if (typeof parsed === 'object' && parsed.handle) {
          // @handle or legacy custom URL
          ytData = await fetchChannelByHandle(parsed.handle);
          if (ytData) {
            const existing = await prisma.channel.findFirst({ where: { youtubeChannelId: ytData.id } });
            if (existing) {
              results.skipped++;
              continue;
            }
          }

        } else {
          // Bare string that didn't match any pattern — try as channel ID
          const existing = await prisma.channel.findFirst({ where: { youtubeChannelId: parsed } });
          if (existing) {
            results.skipped++;
            continue;
          }
          ytData = await fetchSingleChannel(parsed);
        }

        if (!ytData) {
          results.errors.push({ input: channelInput, error: 'Channel not found on YouTube' });
          continue;
        }

        const category = (record.category || '').trim() || 'Uncategorized';
        const tags     = record.tags ? record.tags.split(';').map((t) => t.trim()).filter(Boolean) : [];

        const channel = await prisma.channel.create({
          data: {
            youtubeChannelId: ytData.id,
            title:            ytData.snippet.title || '',
            description:      ytData.snippet.description || '',
            thumbnailUrl:     ytData.snippet.thumbnails?.high?.url || '',
            bannerUrl:        ytData.brandingSettings?.image?.bannerExternalUrl || '',
            customUrl:        ytData.snippet.customUrl || '',
            country:          ytData.snippet.country || '',
            publishedAt:      ytData.snippet.publishedAt ? new Date(ytData.snippet.publishedAt) : null,
            uploadsPlaylistId: ytData.contentDetails?.relatedPlaylists?.uploads || '',
            category,
            tags,
            notes:            record.notes || '',
            currentSubscribers: parseYoutubeStatInt(ytData.statistics?.subscriberCount),
            currentViews:      BigInt(parseYoutubeStatInt(ytData.statistics?.viewCount)),
            currentVideoCount: parseYoutubeStatInt(ytData.statistics?.videoCount),
            lastSyncedAt: new Date(),
          },
        });

        results.added++;
        results.addedChannels.push({ title: channel.title, category, url: channelInput });

      } catch (err) {
        if (err.code === 'P2002') {
          results.skipped++; // duplicate key — already exists
        } else {
          results.errors.push({ input: channelInput, error: err.message });
        }
      }
    }

    res.json(results);
  } catch (err) {
    next(err);
  }
}

export async function getChannel(req, res, next) {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid ID format' });
    }

    const channel = await prisma.channel.findUnique({
      where: { id: req.params.id },
      include: { assignedTo: { select: { id: true, name: true, email: true } } },
    });

    if (!channel) {
      return res.status(404).json({ message: 'Channel not found' });
    }

    const snapshots = await prisma.channelSnapshot.findMany({
      where: { channelId: channel.id, deletedAt: null },
      orderBy: { date: 'desc' },
      take: 90,
    });

    const videos = await prisma.video.findMany({
      where: { channelId: channel.id, deletedAt: null },
      orderBy: { publishedAt: 'desc' },
      take: 20,
    });

    const videoCountInDb = await prisma.video.count({
      where: { channelId: channel.id, deletedAt: null },
    });

    res.json({
      channel: serializeChannel(channel),
      snapshots: snapshots.reverse().map(serializeSnapshot),
      videos: videos.map(serializeVideo),
      videoCountInDb,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateChannel(req, res, next) {
  try {
    const { category, tags, assignedTo, status, notes } = req.body;
    const update = {};

    if (category !== undefined) update.category = category;
    if (tags !== undefined) update.tags = tags;
    if (assignedTo !== undefined) update.assignedToId = assignedTo || null;
    if (status !== undefined) {
      update.status = status;
      update.autoArchivedForInactivity = false;
    }
    if (notes !== undefined) update.notes = notes;

    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid ID format' });
    }

    // Check existence first so a missing record yields a clean 404 (not P2025).
    const existing = await prisma.channel.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      return res.status(404).json({ message: 'Channel not found' });
    }

    const channel = await prisma.channel.update({
      where: { id: req.params.id },
      data: update,
      include: { assignedTo: { select: { id: true, name: true, email: true } } },
    });

    res.json(serializeChannel(channel));
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/channels/:id
 * Soft-delete a single channel and cascade to all related rows.
 */
export async function deleteChannel(req, res, next) {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid ID format' });
    }

    const channel = await prisma.channel.findUnique({ where: { id: req.params.id } });
    if (!channel) {
      return res.status(404).json({ message: 'Channel not found' });
    }

    await softDeleteChannels([req.params.id]);

    res.json({ message: 'Channel archived', channelId: req.params.id });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/channels/bulk
 * Soft-delete multiple channels and cascade.
 */
export async function bulkDeleteChannels(req, res, next) {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'ids array is required' });
    }

    const { archived } = await softDeleteChannels(ids);

    res.json({ archived });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/channels/reclassify-bulk
 * Force re-classify ALL videos for selected channels.
 */
export async function bulkReclassifyChannelVideos(req, res, next) {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'ids array is required' });
    }

    const channels = await prisma.channel.findMany({
      where: { id: { in: ids }, status: { not: 'archived' } },
      orderBy: { title: 'asc' },
    });

    let channelsProcessed = 0;
    let totalVideos = 0;
    let totalNewlyClassified = 0;
    let totalSadguru = 0;
    let totalNonSadguru = 0;
    let totalFailed = 0;
    const errors = [];

    for (const channel of channels) {
      try {
        await prisma.video.updateMany({
          where: { channelId: channel.id, deletedAt: null },
          data: { classification: '' },
        });

        const result = await classifyVideosForChannel(channel);
        channelsProcessed++;
        totalVideos += result.totalVideos;
        totalNewlyClassified += result.newlyClassified;
        totalSadguru += result.sadhguruCount;
        totalNonSadguru += result.nonSadhguruCount;
        totalFailed += result.failed;
      } catch (err) {
        errors.push({ channelId: channel.id, title: channel.title, message: err.message });
      }
    }

    res.json({
      channelsRequested: ids.length,
      channelsProcessed,
      totalVideos,
      totalNewlyClassified,
      totalSadguru,
      totalNonSadguru,
      totalFailed,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    if (err.message?.includes('GEMINI_API_KEY') || err.message?.includes('GOOGLE_CLOUD_PROJECT')) {
      return res.status(503).json({ message: 'AI not configured. Set GEMINI_API_KEY (from aistudio.google.com) or GOOGLE_CLOUD_PROJECT for Vertex AI.' });
    }
    next(err);
  }
}

export async function syncSingleChannel(req, res, next) {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid ID format' });
    }
    const channel = await prisma.channel.findUnique({ where: { id: req.params.id } });
    if (!channel) {
      return res.status(404).json({ message: 'Channel not found' });
    }

    const log = await syncChannels([channel.id], 'manual');
    res.json(log);
  } catch (err) {
    if (err.message === 'Sync already in progress') {
      return res.status(409).json({ message: err.message });
    }
    next(err);
  }
}

/**
 * POST /api/channels/:id/pull-videos
 */
export async function pullChannelVideos(req, res, next) {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid ID format' });
    }
    const channel = await prisma.channel.findUnique({ where: { id: req.params.id } });
    if (!channel) {
      return res.status(404).json({ message: 'Channel not found' });
    }
    if (channel.allVideosPulled) {
      return res.status(400).json({ message: 'All videos already pulled for this channel' });
    }

    const result = await pullAllChannelVideos(channel.id);
    res.json(result);
  } catch (err) {
    if (err.message === 'Pull all videos already in progress') {
      return res.status(409).json({ message: err.message });
    }
    if (err.message === 'QUOTA_EXCEEDED') {
      return res.status(429).json({ message: 'YouTube API quota exceeded' });
    }
    next(err);
  }
}

export async function syncAllChannels(req, res, next) {
  try {
    const log = await syncChannels(null, 'manual');
    res.json(log);
  } catch (err) {
    if (err.message === 'Sync already in progress') {
      return res.status(409).json({ message: err.message });
    }
    next(err);
  }
}

/**
 * POST /api/channels/pull-all-videos
 */
export async function pullAllChannelsVideosHandler(req, res, next) {
  try {
    const result = await pullAllChannelsVideos();
    res.json(result);
  } catch (err) {
    if (err.message === 'Pull all videos already in progress') {
      return res.status(409).json({ message: err.message });
    }
    if (err.message === 'QUOTA_EXCEEDED') {
      return res.status(429).json({ message: 'YouTube API quota exceeded' });
    }
    next(err);
  }
}

export async function getChannelVideos(req, res, next) {
  try {
    const { page = 1, limit = 50, sort = '-views', search, classification, minViews, maxViews } = req.query;
    const lim = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
    // Use the clamped `lim` for skip so a NaN limit (e.g. ?limit=abc) doesn't
    // poison Prisma's required-int `skip` argument.
    const skip = (parseInt(page) - 1) * lim;

    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid channel id' });
    }

    const where = { channelId: req.params.id, deletedAt: null };
    if (search && search.trim()) {
      where.OR = [
        { title: { contains: search.trim(), mode: 'insensitive' } },
        { youtubeVideoId: { contains: search.trim(), mode: 'insensitive' } },
      ];
    }
    if (classification === 'sadhguru') where.classification = 'sadhguru';
    else if (classification === 'non_sadhguru') where.classification = 'non sadhguru';
    if (minViews != null && minViews !== '') where.views = { ...(where.views || {}), gte: parseInt(minViews) };
    if (maxViews != null && maxViews !== '') where.views = { ...(where.views || {}), lte: parseInt(maxViews) };

    const sortMap = {
      '-views':       [{ views: 'desc' }],
      views:          [{ views: 'asc' }],
      '-publishedAt': [{ publishedAt: 'desc' }],
      publishedAt:    [{ publishedAt: 'asc' }],
      '-likes':       [{ likes: 'desc' }],
      likes:          [{ likes: 'asc' }],
      '-comments':    [{ comments: 'desc' }],
      comments:       [{ comments: 'asc' }],
    };
    const orderBy = sortMap[sort] || sortMap['-views'];

    // Summary aggregates over ALL videos of the channel (no search/classification filters)
    // — matches the legacy aggregation that used summaryFilter = {channelId, deletedAt:null}.
    const summaryWhere = { channelId: req.params.id, deletedAt: null };

    const [videos, total, summaryAgg] = await Promise.all([
      prisma.video.findMany({ where, orderBy, skip, take: lim }),
      prisma.video.count({ where }),
      prisma.video.aggregate({
        where: summaryWhere,
        _sum: { views: true, likes: true, comments: true },
      }),
    ]);

    const sums = summaryAgg?._sum;
    const summary = sums
      ? {
          totalVideos: total,
          totalViews: bigIntToNumber(sums.views) ?? 0,
          totalLikes: sums.likes ?? 0,
          totalComments: sums.comments ?? 0,
        }
      : { totalVideos: 0, totalViews: 0, totalLikes: 0, totalComments: 0 };

    res.json({
      videos: videos.map(serializeVideo),
      pagination: {
        page: parseInt(page),
        limit: lim,
        total,
        pages: Math.ceil(total / lim),
      },
      summary,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Classify videos for a single channel.
 * Dedicated: mark unclassified as sadhguru. IHI/other: use Vertex AI / Gemini.
 */
async function classifyVideosForChannel(channel) {
  let videos = await prisma.video.findMany({ where: { channelId: channel.id, deletedAt: null } });
  if (videos.length === 0) {
    return {
      totalVideos: 0,
      alreadyClassified: 0,
      newlyClassified: 0,
      failed: 0,
      sadhguruCount: 0,
      nonSadhguruCount: 0,
      isSadhguruChannel: false,
    };
  }

  // Legacy migration: any rows still carrying the deprecated `isSadguruVideo`
  // boolean (Mongo-era) get their classification derived from it. The Prisma
  // schema doesn't declare this field, so this branch is normally a no-op —
  // it stays here so tests that fabricate the legacy shape can still verify it.
  const toMigrate = videos.filter((v) => v.isSadguruVideo != null && !v.classification);
  for (const v of toMigrate) {
    await prisma.video.update({
      where: { id: v.id },
      data: { classification: v.isSadguruVideo ? 'sadhguru' : 'non sadhguru' },
    });
  }
  if (toMigrate.length) {
    videos = await prisma.video.findMany({ where: { channelId: channel.id, deletedAt: null } });
  }

  const category = (channel.category || '').toLowerCase();
  const isDedicated = category.startsWith('dedicated');
  const isEmpty = (v) => !v.classification || String(v.classification).trim() === '';

  if (isDedicated) {
    const result = await prisma.video.updateMany({
      where: { channelId: channel.id, deletedAt: null, classification: '' },
      data: { classification: 'sadhguru' },
    });
    const newlyClassified = result.count;
    return {
      totalVideos: videos.length,
      alreadyClassified: videos.length - newlyClassified,
      newlyClassified,
      failed: 0,
      sadhguruCount: newlyClassified,
      nonSadhguruCount: 0,
      isSadhguruChannel: true,
    };
  }

  const toClassify = videos.filter(isEmpty);
  let failed = 0;
  const classificationMap = await classifySadguruVideoBatch(toClassify);
  let sadhguruCount = 0;
  for (const video of toClassify) {
    const value = classificationMap.get(String(video.id));
    if (value) {
      await prisma.video.update({ where: { id: video.id }, data: { classification: value } });
      if (value === 'sadhguru') sadhguruCount++;
    } else {
      failed++;
    }
  }
  const newlyClassified = toClassify.length - failed;
  return {
    totalVideos: videos.length,
    alreadyClassified: videos.length - toClassify.length,
    newlyClassified,
    failed,
    sadhguruCount,
    nonSadhguruCount: newlyClassified - sadhguruCount,
    isSadhguruChannel: false,
  };
}

/**
 * POST /api/channels/:id/reclassify-videos
 */
export async function reclassifyChannelVideos(req, res, next) {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid ID format' });
    }
    const channel = await prisma.channel.findUnique({ where: { id: req.params.id } });
    if (!channel) {
      return res.status(404).json({ message: 'Channel not found' });
    }

    await prisma.video.updateMany({
      where: { channelId: channel.id, deletedAt: null },
      data: { classification: '' },
    });

    const result = await classifyVideosForChannel(channel);
    res.json({ ...result, reclassified: true });
  } catch (err) {
    if (err.message?.includes('GEMINI_API_KEY') || err.message?.includes('GOOGLE_CLOUD_PROJECT')) {
      return res.status(503).json({ message: 'AI not configured. Set GEMINI_API_KEY (from aistudio.google.com) or GOOGLE_CLOUD_PROJECT for Vertex AI.' });
    }
    console.error('Reclassification failed:', err.message);
    return res.status(500).json({ message: err.message || 'Reclassification failed' });
  }
}

/**
 * POST /api/channels/:id/classify-videos
 */
export async function classifyChannelVideos(req, res, next) {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid ID format' });
    }
    const channel = await prisma.channel.findUnique({ where: { id: req.params.id } });
    if (!channel) {
      return res.status(404).json({ message: 'Channel not found' });
    }
    const result = await classifyVideosForChannel(channel);
    res.json(result);
  } catch (err) {
    if (err.message?.includes('GEMINI_API_KEY') || err.message?.includes('GOOGLE_CLOUD_PROJECT')) {
      return res.status(503).json({ message: 'AI not configured. Set GEMINI_API_KEY (from aistudio.google.com) or GOOGLE_CLOUD_PROJECT for Vertex AI.' });
    }
    console.error('Classification failed:', err.message);
    return res.status(500).json({ message: err.message || 'Classification failed' });
  }
}

/**
 * POST /api/channels/classify-all
 */
export async function classifyAllChannelsVideos(req, res, next) {
  try {
    const channels = await prisma.channel.findMany({
      where: { status: { not: 'archived' } },
      orderBy: { title: 'asc' },
    });

    let channelsProcessed = 0;
    let totalVideos = 0;
    let totalNewlyClassified = 0;
    let totalSadguru = 0;
    let totalNonSadguru = 0;
    let totalFailed = 0;
    const errors = [];

    for (const channel of channels) {
      try {
        const result = await classifyVideosForChannel(channel);
        channelsProcessed++;
        totalVideos += result.totalVideos;
        totalNewlyClassified += result.newlyClassified;
        totalSadguru += result.sadhguruCount;
        totalNonSadguru += result.nonSadhguruCount;
        totalFailed += result.failed;
      } catch (err) {
        errors.push({ channelId: channel.id, title: channel.title, message: err.message });
      }
    }

    res.json({
      channelsProcessed,
      totalVideos,
      totalNewlyClassified,
      totalSadguru,
      totalNonSadguru,
      totalFailed,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    if (err.message?.includes('GEMINI_API_KEY') || err.message?.includes('GOOGLE_CLOUD_PROJECT')) {
      return res.status(503).json({ message: 'AI not configured. Set GEMINI_API_KEY (from aistudio.google.com) or GOOGLE_CLOUD_PROJECT for Vertex AI.' });
    }
    next(err);
  }
}

export async function findFirstMissingSheetChannelHandler(req, res, next) {
  try {
    const result = await findFirstMissingGoogleSheetChannel();
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function addFirstMissingSheetChannelHandler(req, res, next) {
  try {
    const result = await addFirstMissingGoogleSheetChannel();
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function syncGoogleSheetChannelsHandler(req, res, next) {
  try {
    const result = await syncAllGoogleSheetChannels();
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function previewGoogleSheetSyncHandler(req, res, next) {
  try {
    const { sheetType = 'dedicated' } = req.query;
    const result = await previewGoogleSheetSync({ sheetType });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function importApprovedSheetChannelsHandler(req, res, next) {
  try {
    const { approvedItems } = req.body;
    const result = await importApprovedSheetChannels(approvedItems);
    res.json(result);
  } catch (err) {
    next(err);
  }
}
