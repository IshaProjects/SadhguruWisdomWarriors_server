import { YT_API_BASE, YT_BATCH_SIZE } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';

let quotaUsedToday = 0;
let quotaResetDate = new Date().toDateString();

export function getQuotaUsage() {
  const today = new Date().toDateString();
  if (today !== quotaResetDate) {
    quotaUsedToday = 0;
    quotaResetDate = today;
  }
  return {
    used: quotaUsedToday,
    limit: parseInt(process.env.DAILY_QUOTA_LIMIT) || 10000,
    remaining:
      (parseInt(process.env.DAILY_QUOTA_LIMIT) || 10000) - quotaUsedToday,
  };
}

function trackQuota(units) {
  const today = new Date().toDateString();
  if (today !== quotaResetDate) {
    quotaUsedToday = 0;
    quotaResetDate = today;
  }
  quotaUsedToday += units;
}

async function ytFetch(endpoint, params, retries = 3) {
  const url = new URL(`${YT_API_BASE}/${endpoint}`);
  params.key = process.env.YOUTUBE_API_KEY;
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url.toString());

      if (res.status === 403) {
        const body = await res.json();
        const reason = body?.error?.errors?.[0]?.reason;
        if (reason === 'quotaExceeded') {
          logger.error('YouTube API quota exceeded');
          throw new Error('QUOTA_EXCEEDED');
        }
      }

      if (res.status === 429 || res.status >= 500) {
        const delay = Math.pow(2, attempt) * 1000;
        logger.warn(`YouTube API ${res.status}, retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          `YouTube API error ${res.status}: ${JSON.stringify(body)}`
        );
      }

      trackQuota(1);
      return await res.json();
    } catch (err) {
      if (err.message === 'QUOTA_EXCEEDED') throw err;
      if (attempt === retries - 1) throw err;
      const delay = Math.pow(2, attempt) * 1000;
      logger.warn(`Fetch error, retrying in ${delay}ms: ${err.message}`);
      await sleep(delay);
    }
  }
}

export async function fetchChannelsBatch(channelIds) {
  const results = [];
  for (let i = 0; i < channelIds.length; i += YT_BATCH_SIZE) {
    const batch = channelIds.slice(i, i + YT_BATCH_SIZE);
    const data = await ytFetch('channels', {
      part: 'snippet,statistics,brandingSettings,contentDetails',
      id: batch.join(','),
    });
    if (data.items) results.push(...data.items);
  }
  return results;
}

export async function resolveChannelByHandle(handle) {
  const data = await ytFetch('search', {
    part: 'snippet',
    q: handle,
    type: 'channel',
    maxResults: 1,
  });
  // search costs 100 quota units
  trackQuota(99); // already tracked 1 in ytFetch
  if (data.items?.length > 0) {
    return data.items[0].snippet.channelId;
  }
  return null;
}

/**
 * Fetch a channel directly by its @handle using the channels endpoint
 * (costs only 1 quota unit vs 100 for search).
 * Returns the full channel item or null.
 */
export async function fetchChannelByHandle(handle) {
  // Try forHandle first (works for @handles on the channels endpoint)
  const h = handle.startsWith('@') ? handle : `@${handle}`;
  try {
    const data = await ytFetch('channels', {
      part: 'snippet,statistics,brandingSettings,contentDetails',
      forHandle: h,
    });
    if (data.items?.length > 0) return data.items[0];
  } catch {
    // forHandle may not work for legacy custom URLs — fall back to search
  }

  // Fallback: search (100 quota units)
  const channelId = await resolveChannelByHandle(handle);
  if (!channelId) return null;
  return fetchSingleChannel(channelId);
}

export async function fetchPlaylistItems(playlistId, maxResults = 10) {
  const data = await ytFetch('playlistItems', {
    part: 'snippet,contentDetails',
    playlistId,
    maxResults: String(maxResults),
  });
  return data.items || [];
}

export async function fetchVideosBatch(videoIds) {
  const results = [];
  for (let i = 0; i < videoIds.length; i += YT_BATCH_SIZE) {
    const batch = videoIds.slice(i, i + YT_BATCH_SIZE);
    const data = await ytFetch('videos', {
      part: 'statistics,contentDetails,snippet',
      id: batch.join(','),
    });
    if (data.items) results.push(...data.items);
  }
  return results;
}

export async function fetchSingleChannel(channelId) {
  const data = await ytFetch('channels', {
    part: 'snippet,statistics,brandingSettings,contentDetails',
    id: channelId,
  });
  return data.items?.[0] || null;
}
