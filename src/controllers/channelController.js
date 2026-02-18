import Channel from '../models/Channel.js';
import ChannelSnapshot from '../models/ChannelSnapshot.js';
import Video from '../models/Video.js';
import { fetchSingleChannel, resolveChannelByHandle } from '../services/youtubeApi.js';
import { syncChannels } from '../services/syncEngine.js';
import { extractChannelId } from '../utils/helpers.js';
import { parse } from 'csv-parse/sync';

export async function listChannels(req, res, next) {
  try {
    const {
      page = 1,
      limit = 25,
      search,
      category,
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

    if (category) filter.category = category;
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
    const [channels, total] = await Promise.all([
      Channel.find(filter)
        .populate('assignedTo', 'name email')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit)),
      Channel.countDocuments(filter),
    ]);

    res.json({
      channels,
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

    const results = { added: 0, skipped: 0, errors: [] };

    for (const record of records) {
      try {
        const channelInput = record.channel_id || record.channelId;
        if (!channelInput) {
          results.errors.push({ input: JSON.stringify(record), error: 'No channel_id' });
          continue;
        }

        let channelId = extractChannelId(channelInput);
        if (channelId && typeof channelId === 'object' && channelId.handle) {
          results.errors.push({ input: channelInput, error: 'Handle resolution skipped in bulk (use channel IDs)' });
          continue;
        }

        const existing = await Channel.findOne({ youtubeChannelId: channelId });
        if (existing) {
          results.skipped++;
          continue;
        }

        const ytData = await fetchSingleChannel(channelId);
        if (!ytData) {
          results.errors.push({ input: channelId, error: 'Not found on YouTube' });
          continue;
        }

        await Channel.create({
          youtubeChannelId: channelId,
          title: ytData.snippet.title,
          description: ytData.snippet.description,
          thumbnailUrl: ytData.snippet.thumbnails?.high?.url || '',
          bannerUrl: ytData.brandingSettings?.image?.bannerExternalUrl || '',
          customUrl: ytData.snippet.customUrl || '',
          country: ytData.snippet.country || '',
          publishedAt: ytData.snippet.publishedAt,
          uploadsPlaylistId: ytData.contentDetails?.relatedPlaylists?.uploads || '',
          category: record.category || 'Uncategorized',
          tags: record.tags ? record.tags.split(';').map((t) => t.trim()) : [],
          notes: record.notes || '',
          currentStats: {
            subscribers: parseInt(ytData.statistics.subscriberCount) || 0,
            views: parseInt(ytData.statistics.viewCount) || 0,
            videoCount: parseInt(ytData.statistics.videoCount) || 0,
          },
          lastSyncedAt: new Date(),
        });

        results.added++;
      } catch (err) {
        results.errors.push({ input: record.channel_id, error: err.message });
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
    })
      .sort({ date: -1 })
      .limit(90);

    // Get recent videos
    const videos = await Video.find({ channelId: channel._id })
      .sort({ publishedAt: -1 })
      .limit(20);

    res.json({ channel, snapshots: snapshots.reverse(), videos });
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

export async function deleteChannel(req, res, next) {
  try {
    const channel = await Channel.findByIdAndUpdate(
      req.params.id,
      { status: 'archived' },
      { new: true }
    );

    if (!channel) {
      return res.status(404).json({ message: 'Channel not found' });
    }

    res.json({ message: 'Channel archived', channel });
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

export async function getChannelVideos(req, res, next) {
  try {
    const { page = 1, limit = 20, sort = '-publishedAt' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [videos, total] = await Promise.all([
      Video.find({ channelId: req.params.id })
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit)),
      Video.countDocuments({ channelId: req.params.id }),
    ]);

    res.json({
      videos,
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
