import { Parser } from '@json2csv/plainjs';
import Channel from '../models/Channel.js';

export async function exportChannelsCSV(req, res, next) {
  try {
    const channels = await Channel.find({ status: { $ne: 'archived' } })
      .populate('assignedTo', 'name email')
      .sort({ 'currentStats.subscribers': -1 });

    const data = channels.map((c) => ({
      youtube_channel_id: c.youtubeChannelId,
      title: c.title,
      custom_url: c.customUrl,
      subscribers: c.currentStats?.subscribers || 0,
      views: c.currentStats?.views || 0,
      video_count: c.currentStats?.videoCount || 0,
      category: c.category,
      tags: c.tags?.join('; ') || '',
      status: c.status,
      assigned_to: c.assignedTo?.name || '',
      country: c.country,
      notes: c.notes,
      last_synced: c.lastSyncedAt?.toISOString() || '',
    }));

    const parser = new Parser();
    const csv = parser.parse(data);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=channels-${new Date().toISOString().slice(0, 10)}.csv`
    );
    res.send(csv);
  } catch (err) {
    next(err);
  }
}
