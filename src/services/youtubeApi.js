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
  const clean = handle.replace(/^@/, '').trim();
  if (!clean) return null;

  // 1. YouTube API forHandle (costs only 1 quota unit instead of 100)
  try {
    const data = await ytFetch('channels', {
      part: 'id,snippet',
      forHandle: `@${clean}`,
    });
    if (data?.items?.length > 0) {
      return data.items[0].id;
    }
  } catch (err) {
    logger.warn(`forHandle YouTube API failed for @${clean}: ${err.message}`);
  }

  // 2. HTML Scraper fallback (zero API quota used)
  try {
    const url = `https://www.youtube.com/@${clean}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (res.ok) {
      const html = await res.text();
      if (
        html.includes('This account has been terminated') ||
        html.includes("This page isn't available") ||
        html.includes('channel does not exist')
      ) {
        return null;
      }

      const m1 = html.match(/itemprop="identifier"\s+content="(UC[\w-]{22})"/i) ||
                 html.match(/content="(UC[\w-]{22})"\s+itemprop="identifier"/i);
      if (m1) return m1[1];

      const m2 = html.match(/"channelId":"(UC[\w-]{22})"/i) ||
                 html.match(/"externalId":"(UC[\w-]{22})"/i);
      if (m2) return m2[1];

      const m3 = html.match(/href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/i);
      if (m3) return m3[1];
    }
  } catch (err) {
    logger.warn(`HTML scraper fallback failed for @${clean}: ${err.message}`);
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

/**
 * Fetch a page of playlist items with optional pagination.
 * Returns { items, nextPageToken }.
 */
export async function fetchPlaylistItemsPage(playlistId, pageToken = null, maxResults = 50) {
  const params = {
    part: 'snippet,contentDetails',
    playlistId,
    maxResults: String(Math.min(maxResults, 50)),
  };
  if (pageToken) params.pageToken = pageToken;
  const data = await ytFetch('playlistItems', params);
  return {
    items: data.items || [],
    nextPageToken: data.nextPageToken || null,
  };
}

function playlistItemPublishedAtMs(item) {
  const raw =
    item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Uploads playlist is reverse-chronological. Collects items whose publish time is >= sinceDate.
 * Stops paginating once an older item is seen.
 */
export async function fetchPlaylistItemsPublishedSince(playlistId, sinceDate) {
  const sinceMs =
    sinceDate instanceof Date
      ? sinceDate.getTime()
      : new Date(sinceDate).getTime();
  const out = [];
  let pageToken = null;
  let pagesFetched = 0;
  do {
    const { items, nextPageToken } = await fetchPlaylistItemsPage(
      playlistId,
      pageToken,
      50
    );
    pagesFetched += 1;
    for (const item of items) {
      const t = playlistItemPublishedAtMs(item);
      if (t == null) continue;
      if (t >= sinceMs) {
        out.push(item);
      } else {
        return { items: out, pagesFetched };
      }
    }
    pageToken = nextPageToken;
  } while (pageToken);
  return { items: out, pagesFetched };
}

/**
 * Paginate through entire playlist and return all video IDs.
 */
export async function fetchAllPlaylistItemIds(playlistId) {
  const videoIds = [];
  let pageToken = null;
  do {
    const { items, nextPageToken } = await fetchPlaylistItemsPage(playlistId, pageToken, 50);
    for (const item of items) {
      const vid = item.contentDetails?.videoId;
      if (vid) videoIds.push(vid);
    }
    pageToken = nextPageToken;
  } while (pageToken);
  return videoIds;
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
