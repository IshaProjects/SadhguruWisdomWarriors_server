import Channel from '../models/Channel.js';
import ChannelSnapshot from '../models/ChannelSnapshot.js';
import Video from '../models/Video.js';
import Category from '../models/Category.js';
import { fetchSingleChannel, resolveChannelByHandle, fetchChannelByHandle } from '../services/youtubeApi.js';
import { syncChannels, pullAllChannelVideos, pullAllChannelsVideos } from '../services/syncEngine.js';
import { classifySadguruVideoBatch } from '../services/vertexAiService.js';
import { extractChannelId } from '../utils/helpers.js';
import { softDeleteChannels } from '../utils/softDelete.js';
import { parse } from 'csv-parse/sync';

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

    const filter = {};

    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { youtubeChannelId: { $regex: search, $options: 'i' } },
        { customUrl: { $regex: search, $options: 'i' } },
      ];
    }

    if (group === 'dedicated') {
      filter.category = { $regex: /^Dedicated/i };
    } else if (group === 'ihi') {
      filter.category = { $regex: /IHI/i };
    } else if (category) {
      filter.category = category;
    }
    if (status) filter.status = status;
    else filter.status = { $ne: 'archived' };

    if (tags && typeof tags === 'string' && tags.trim()) {
      const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
      if (tagList.length) filter.tags = { $in: tagList };
    }

    if (assignedTo) filter.assignedTo = assignedTo;

    if (minSubs || maxSubs) {
      filter['currentStats.subscribers'] = {};
      if (minSubs) filter['currentStats.subscribers'].$gte = parseInt(minSubs);
      if (maxSubs) filter['currentStats.subscribers'].$lte = parseInt(maxSubs);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [channels, total, channelIdsWithUnclassified] = await Promise.all([
      Channel.find(filter)
        .populate('assignedTo', 'name email')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit)),
      Channel.countDocuments(filter),
      Video.distinct('channelId', {
        deletedAt: null,
        $or: [{ classification: '' }, { classification: { $exists: false } }],
      }),
    ]);

    const unclassifiedSet = new Set(channelIdsWithUnclassified.map((id) => String(id)));
    const channelsWithFlag = channels.map((ch) => ({
      ...ch.toObject(),
      classificationDone: !unclassifiedSet.has(String(ch._id)),
    }));

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

    // If we got a handle, resolve it to a channel ID
    if (channelId && typeof channelId === 'object' && channelId.handle) {
      const resolved = await resolveChannelByHandle(channelId.handle);
      if (!resolved) {
        return res.status(404).json({ message: 'Channel not found' });
      }
      channelId = resolved;
    }

    // Check if channel already exists
    const existing = await Channel.findOne({ youtubeChannelId: channelId });
    if (existing) {
      return res.status(409).json({ message: 'Channel already tracked', channel: existing });
    }

    // Fetch channel info from YouTube
    const ytData = await fetchSingleChannel(channelId);
    if (!ytData) {
      return res.status(404).json({ message: 'Channel not found on YouTube' });
    }

    const channel = await Channel.create({
      youtubeChannelId: channelId,
      title: ytData.snippet.title,
      description: ytData.snippet.description,
      thumbnailUrl:
        ytData.snippet.thumbnails?.high?.url ||
        ytData.snippet.thumbnails?.default?.url ||
        '',
      bannerUrl: ytData.brandingSettings?.image?.bannerExternalUrl || '',
      customUrl: ytData.snippet.customUrl || '',
      country: ytData.snippet.country || '',
      publishedAt: ytData.snippet.publishedAt,
      uploadsPlaylistId:
        ytData.contentDetails?.relatedPlaylists?.uploads || '',
      category: category || 'Uncategorized',
      tags: tags || [],
      notes: notes || '',
      assignedTo: assignedTo || null,
      currentStats: {
        subscribers: parseInt(ytData.statistics.subscriberCount) || 0,
        views: parseInt(ytData.statistics.viewCount) || 0,
        videoCount: parseInt(ytData.statistics.videoCount) || 0,
      },
      lastSyncedAt: new Date(),
    });

    // Create initial snapshot
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await ChannelSnapshot.create({
      channelId: channel._id,
      date: today,
      subscribers: channel.currentStats.subscribers,
      views: channel.currentStats.views,
      videoCount: channel.currentStats.videoCount,
    });

    res.status(201).json(channel);
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

    // Pre-collect and upsert all categories from the CSV into the Category collection
    const categoryNames = [
      ...new Set(
        records
          .map((r) => (r.category || '').trim())
          .filter(Boolean)
      ),
    ];
    for (const name of categoryNames) {
      await Category.updateOne({ name }, { $setOnInsert: { name } }, { upsert: true });
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
          // Direct channel ID — cheapest lookup (1 quota unit)
          const existing = await Channel.findOne({ youtubeChannelId: parsed });
          if (existing) {
            results.skipped++;
            continue;
          }
          ytData = await fetchSingleChannel(parsed);

        } else if (typeof parsed === 'object' && parsed.handle) {
          // @handle or legacy custom URL — use forHandle endpoint (1 unit), fall back to search
          ytData = await fetchChannelByHandle(parsed.handle);
          if (ytData) {
            const existing = await Channel.findOne({ youtubeChannelId: ytData.id });
            if (existing) {
              results.skipped++;
              continue;
            }
          }

        } else {
          // Bare string that didn't match any pattern — try as channel ID
          const existing = await Channel.findOne({ youtubeChannelId: parsed });
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

        const channel = await Channel.create({
          youtubeChannelId: ytData.id,
          title:            ytData.snippet.title,
          description:      ytData.snippet.description || '',
          thumbnailUrl:     ytData.snippet.thumbnails?.high?.url || '',
          bannerUrl:        ytData.brandingSettings?.image?.bannerExternalUrl || '',
          customUrl:        ytData.snippet.customUrl || '',
          country:          ytData.snippet.country || '',
          publishedAt:      ytData.snippet.publishedAt,
          uploadsPlaylistId: ytData.contentDetails?.relatedPlaylists?.uploads || '',
          category,
          tags,
          notes:            record.notes || '',
          currentStats: {
            subscribers: parseInt(ytData.statistics?.subscriberCount) || 0,
            views:       parseInt(ytData.statistics?.viewCount)       || 0,
            videoCount:  parseInt(ytData.statistics?.videoCount)      || 0,
          },
          lastSyncedAt: new Date(),
        });

        results.added++;
        results.addedChannels.push({ title: channel.title, category, url: channelInput });

      } catch (err) {
        if (err.code === 11000) {
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
    const channel = await Channel.findById(req.params.id).populate(
      'assignedTo',
      'name email'
    );

    if (!channel) {
      return res.status(404).json({ message: 'Channel not found' });
    }

    // Get snapshots for trend data
    const snapshots = await ChannelSnapshot.find({
      channelId: channel._id,
      deletedAt: null,
    })
      .sort({ date: -1 })
      .limit(90);

    // Get recent videos
    const videos = await Video.find({ channelId: channel._id, deletedAt: null })
      .sort({ publishedAt: -1 })
      .limit(20);

    const videoCountInDb = await Video.countDocuments({ channelId: channel._id, deletedAt: null });

    res.json({ channel, snapshots: snapshots.reverse(), videos, videoCountInDb });
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
    if (assignedTo !== undefined) update.assignedTo = assignedTo || null;
    if (status !== undefined) update.status = status;
    if (notes !== undefined) update.notes = notes;

    const channel = await Channel.findByIdAndUpdate(req.params.id, update, {
      new: true,
    }).populate('assignedTo', 'name email');

    if (!channel) {
      return res.status(404).json({ message: 'Channel not found' });
    }

    res.json(channel);
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/channels/:id
 * Soft-delete a single channel and cascade to all related collections.
 */
export async function deleteChannel(req, res, next) {
  try {
    // Verify the channel exists first
    const channel = await Channel.findById(req.params.id);
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
 * Soft-delete multiple channels and cascade to all related collections.
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

export async function syncSingleChannel(req, res, next) {
  try {
    const channel = await Channel.findById(req.params.id);
    if (!channel) {
      return res.status(404).json({ message: 'Channel not found' });
    }

    const log = await syncChannels([channel._id], 'manual');
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
 * Pull all videos for a channel in batches of 100.
 */
export async function pullChannelVideos(req, res, next) {
  try {
    const channel = await Channel.findById(req.params.id);
    if (!channel) {
      return res.status(404).json({ message: 'Channel not found' });
    }
    if (channel.allVideosPulled) {
      return res.status(400).json({ message: 'All videos already pulled for this channel' });
    }

    const result = await pullAllChannelVideos(channel._id);
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
 * Pull all videos for all channels (one channel at a time, 100 videos per batch).
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
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const lim = Math.min(Math.max(parseInt(limit) || 50, 1), 100);

    const filter = { channelId: req.params.id, deletedAt: null };
    if (search && search.trim()) {
      filter.$or = [
        { title: { $regex: search.trim(), $options: 'i' } },
        { youtubeVideoId: { $regex: search.trim(), $options: 'i' } },
      ];
    }
    if (classification === 'sadhguru') filter.classification = 'sadhguru';
    else if (classification === 'non_sadhguru') filter.classification = 'non sadhguru';
    if (minViews != null && minViews !== '') filter.views = { ...filter.views, $gte: parseInt(minViews) };
    if (maxViews != null && maxViews !== '') filter.views = { ...filter.views, $lte: parseInt(maxViews) };

    const sortMap = {
      '-views': { views: -1 },
      views: { views: 1 },
      '-publishedAt': { publishedAt: -1 },
      publishedAt: { publishedAt: 1 },
      '-likes': { likes: -1 },
      likes: { likes: 1 },
      '-comments': { comments: -1 },
      comments: { comments: 1 },
    };
    const sortOpt = sortMap[sort] || sortMap['-views'];

    const [videos, total, summaryAgg] = await Promise.all([
      Video.find(filter).sort(sortOpt).skip(skip).limit(lim).lean(),
      Video.countDocuments(filter),
      Video.aggregate([
        { $match: filter },
        { $group: { _id: null, totalViews: { $sum: '$views' }, totalLikes: { $sum: '$likes' }, totalComments: { $sum: '$comments' } } },
      ]),
    ]);

    const summary = summaryAgg[0]
      ? { totalVideos: total, totalViews: summaryAgg[0].totalViews ?? 0, totalLikes: summaryAgg[0].totalLikes ?? 0, totalComments: summaryAgg[0].totalComments ?? 0 }
      : { totalVideos: 0, totalViews: 0, totalLikes: 0, totalComments: 0 };

    res.json({
      videos,
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
 * Dedicated: mark unclassified as sadguru. IHI/other: use Vertex AI / Gemini.
 * Returns result object or throws.
 */
async function classifyVideosForChannel(channel) {
  let videos = await Video.find({ channelId: channel._id, deletedAt: null });
  if (videos.length === 0) {
    return {
      totalVideos: 0,
      alreadyClassified: 0,
      newlyClassified: 0,
      failed: 0,
      sadguruCount: 0,
      nonSadguruCount: 0,
      isSadhguruChannel: false,
    };
  }

  const toMigrate = videos.filter((v) => v.isSadguruVideo != null && !v.classification);
  for (const v of toMigrate) {
    await Video.findByIdAndUpdate(v._id, {
      classification: v.isSadguruVideo ? 'sadhguru' : 'non sadhguru',
      $unset: { isSadguruVideo: 1 },
    });
  }
  if (toMigrate.length) {
    videos = await Video.find({ channelId: channel._id, deletedAt: null });
  }

  const category = (channel.category || '').toLowerCase();
  const isDedicated = category.startsWith('dedicated');
  const isEmpty = (v) => !v.classification || String(v.classification).trim() === '';

  if (isDedicated) {
    const result = await Video.updateMany(
      { channelId: channel._id, deletedAt: null, $or: [{ classification: '' }, { classification: { $exists: false } }] },
      { $set: { classification: 'sadhguru' } }
    );
    const newlyClassified = result.modifiedCount;
    return {
      totalVideos: videos.length,
      alreadyClassified: videos.length - newlyClassified,
      newlyClassified,
      failed: 0,
      sadguruCount: newlyClassified,
      nonSadguruCount: 0,
      isSadhguruChannel: true,
    };
  }

  const toClassify = videos.filter(isEmpty);
  let failed = 0;
  const classificationMap = await classifySadguruVideoBatch(toClassify);
  let sadguruCount = 0;
  for (const video of toClassify) {
    const value = classificationMap.get(String(video._id));
    if (value) {
      await Video.findByIdAndUpdate(video._id, { classification: value });
      if (value === 'sadhguru') sadguruCount++;
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
    sadguruCount,
    nonSadguruCount: newlyClassified - sadguruCount,
    isSadhguruChannel: false,
  };
}

/**
 * POST /api/channels/:id/classify-videos
 * Dedicated channels: mark all videos as Sadguru by default (no API call).
 * IHI channels: use Vertex AI to classify each video.
 */
export async function classifyChannelVideos(req, res, next) {
  try {
    const channel = await Channel.findById(req.params.id);
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
 * Classify all videos for all channels using the same logic (Dedicated = sadguru, IHI/other = AI).
 */
export async function classifyAllChannelsVideos(req, res, next) {
  try {
    const channels = await Channel.find({ status: { $ne: 'archived' } }).sort({ title: 1 });

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
        totalNonSadguru += result.nonSadguruCount;
        totalFailed += result.failed;
      } catch (err) {
        errors.push({ channelId: channel._id, title: channel.title, message: err.message });
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
