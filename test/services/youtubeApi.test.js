/**
 * Unit tests for src/services/youtubeApi.js
 *
 * The module uses the native `fetch` API (not axios).  We replace the global
 * `fetch` with a vi.fn() before every test so no real HTTP calls are made.
 *
 * The sleep() helper is also replaced so retry-delay loops complete instantly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock sleep so retry loops don't stall the test suite ────────────────────
vi.mock('../../src/utils/helpers.js', () => ({
  sleep: vi.fn(() => Promise.resolve()),
}));

// ── Mock logger to suppress output in tests ─────────────────────────────────
vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  getQuotaUsage,
  fetchChannelsBatch,
  resolveChannelByHandle,
  fetchChannelByHandle,
  fetchPlaylistItems,
  fetchPlaylistItemsPage,
  fetchPlaylistItemsPublishedSince,
  fetchAllPlaylistItemIds,
  fetchVideosBatch,
  fetchSingleChannel,
} from '../../src/services/youtubeApi.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal Response-like object that fetch() would return. */
function makeFetchResponse({ status = 200, ok = true, body = {} } = {}) {
  return {
    status,
    ok,
    json: vi.fn().mockResolvedValue(body),
  };
}

/** Replace global fetch with a vi.fn() that resolves to `response`. */
function mockFetch(response) {
  const fn = vi.fn().mockResolvedValue(response);
  global.fetch = fn;
  return fn;
}

/** Replace global fetch so that it rejects with `error` (simulates network failure). */
function mockFetchReject(error) {
  const fn = vi.fn().mockRejectedValue(error);
  global.fetch = fn;
  return fn;
}

// ── quota state helpers ───────────────────────────────────────────────────────
//
// The module keeps two module-level variables (quotaUsedToday, quotaResetDate)
// that persist across tests.  We re-import the module for each describe block
// where quota state matters, but the simplest approach is to call getQuotaUsage()
// after each test that modifies quota so we can reason about the accumulated total.
//
// For isolation the important thing is: tests that verify quota counts set up
// their own known fetch mocks and check the *delta* rather than the absolute total.

// ── getQuotaUsage ─────────────────────────────────────────────────────────────

describe('getQuotaUsage', () => {
  it('returns used / limit / remaining with default limit 10000', () => {
    delete process.env.DAILY_QUOTA_LIMIT;
    const q = getQuotaUsage();
    expect(q).toHaveProperty('used');
    expect(q).toHaveProperty('limit', 10000);
    expect(q.remaining).toBe(10000 - q.used);
  });

  it('honours DAILY_QUOTA_LIMIT env var', () => {
    process.env.DAILY_QUOTA_LIMIT = '5000';
    const q = getQuotaUsage();
    expect(q.limit).toBe(5000);
    delete process.env.DAILY_QUOTA_LIMIT;
  });

  it('resets quota when the date has changed', async () => {
    // Seed a successful fetch so trackQuota() adds to the counter
    mockFetch(makeFetchResponse({ body: { items: [{ id: 'c1' }] } }));
    process.env.YOUTUBE_API_KEY = 'test-key';
    await fetchSingleChannel('UCtest');

    // Verify at least one unit was tracked
    const before = getQuotaUsage().used;
    expect(before).toBeGreaterThan(0);

    // Simulate a day-change by patching Date.prototype.toDateString
    const realToDateString = Date.prototype.toDateString;
    Date.prototype.toDateString = function () { return 'Mon Jan 01 2099'; };
    try {
      const q = getQuotaUsage();
      expect(q.used).toBe(0);
    } finally {
      Date.prototype.toDateString = realToDateString;
    }
  });
});

// ── ytFetch (indirectly via public functions) ─────────────────────────────────

describe('ytFetch error handling', () => {
  beforeEach(() => {
    process.env.YOUTUBE_API_KEY = 'test-key';
  });

  it('throws QUOTA_EXCEEDED when 403 + quotaExceeded reason', async () => {
    mockFetch(
      makeFetchResponse({
        status: 403,
        ok: false,
        body: { error: { errors: [{ reason: 'quotaExceeded' }] } },
      })
    );
    await expect(fetchSingleChannel('UCabc')).rejects.toThrow('QUOTA_EXCEEDED');
  });

  it('does NOT throw QUOTA_EXCEEDED when 403 with different reason', async () => {
    // Second call succeeds so we don't retry forever
    const forbidden = makeFetchResponse({
      status: 403,
      ok: false,
      body: { error: { errors: [{ reason: 'forbidden' }] } },
    });
    global.fetch = vi.fn().mockResolvedValue(forbidden);
    await expect(fetchSingleChannel('UCabc')).rejects.toThrow(/YouTube API error 403/);
  });

  it('retries on 429 and eventually throws after exhausting retries', async () => {
    const tooMany = makeFetchResponse({ status: 429, ok: false });
    global.fetch = vi.fn().mockResolvedValue(tooMany);
    await expect(fetchSingleChannel('UCabc')).rejects.toThrow();
    // Should have tried 3 times (default retries)
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('retries on 500 server error', async () => {
    const serverErr = makeFetchResponse({ status: 500, ok: false });
    global.fetch = vi.fn().mockResolvedValue(serverErr);
    await expect(fetchSingleChannel('UCabc')).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('retries on network error and throws on last attempt', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network failure'));
    await expect(fetchSingleChannel('UCabc')).rejects.toThrow('network failure');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('succeeds on second attempt after transient 500', async () => {
    const serverErr = makeFetchResponse({ status: 500, ok: false });
    const ok = makeFetchResponse({ body: { items: [{ id: 'UCok' }] } });
    global.fetch = vi.fn()
      .mockResolvedValueOnce(serverErr)
      .mockResolvedValueOnce(ok);
    const result = await fetchSingleChannel('UCok');
    expect(result).toEqual({ id: 'UCok' });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('throws a descriptive error for non-ok, non-retried status', async () => {
    mockFetch(
      makeFetchResponse({ status: 400, ok: false, body: { error: 'Bad Request' } })
    );
    await expect(fetchSingleChannel('UCabc')).rejects.toThrow(
      /YouTube API error 400/
    );
  });

  it('handles json() failure gracefully on non-ok response', async () => {
    const badResponse = {
      status: 400,
      ok: false,
      json: vi.fn().mockRejectedValue(new Error('not json')),
    };
    global.fetch = vi.fn().mockResolvedValue(badResponse);
    await expect(fetchSingleChannel('UCabc')).rejects.toThrow(
      /YouTube API error 400/
    );
  });

  it('builds the URL with the API key and provided params', async () => {
    const ok = makeFetchResponse({ body: { items: [] } });
    const fn = mockFetch(ok);
    await fetchSingleChannel('UC12345');
    const calledUrl = fn.mock.calls[0][0];
    expect(calledUrl).toContain('key=test-key');
    expect(calledUrl).toContain('id=UC12345');
    expect(calledUrl).toContain('/channels');
  });
});

// ── fetchSingleChannel ────────────────────────────────────────────────────────

describe('fetchSingleChannel', () => {
  beforeEach(() => { process.env.YOUTUBE_API_KEY = 'test-key'; });

  it('returns the first channel item', async () => {
    mockFetch(makeFetchResponse({ body: { items: [{ id: 'UC1', title: 'Chan' }] } }));
    const result = await fetchSingleChannel('UC1');
    expect(result).toEqual({ id: 'UC1', title: 'Chan' });
  });

  it('returns null when items is missing', async () => {
    mockFetch(makeFetchResponse({ body: {} }));
    const result = await fetchSingleChannel('UC1');
    expect(result).toBeNull();
  });

  it('returns null when items is empty', async () => {
    mockFetch(makeFetchResponse({ body: { items: [] } }));
    const result = await fetchSingleChannel('UC1');
    expect(result).toBeNull();
  });
});

// ── fetchChannelsBatch ────────────────────────────────────────────────────────

describe('fetchChannelsBatch', () => {
  beforeEach(() => { process.env.YOUTUBE_API_KEY = 'test-key'; });

  it('returns all items from a single batch', async () => {
    mockFetch(makeFetchResponse({ body: { items: [{ id: 'UC1' }, { id: 'UC2' }] } }));
    const result = await fetchChannelsBatch(['UC1', 'UC2']);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('UC1');
  });

  it('batches IDs in groups of YT_BATCH_SIZE (50)', async () => {
    // Create 55 fake channel IDs to force two batches
    const ids = Array.from({ length: 55 }, (_, i) => `UC${String(i).padStart(22, '0')}`);
    const fn = vi.fn()
      .mockResolvedValueOnce(makeFetchResponse({ body: { items: [{ id: 'first-batch' }] } }))
      .mockResolvedValueOnce(makeFetchResponse({ body: { items: [{ id: 'second-batch' }] } }));
    global.fetch = fn;
    const result = await fetchChannelsBatch(ids);
    // fetch is called once per batch
    expect(fn).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
  });

  it('handles missing items field gracefully', async () => {
    mockFetch(makeFetchResponse({ body: {} }));
    const result = await fetchChannelsBatch(['UC1']);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty input', async () => {
    const fn = vi.fn();
    global.fetch = fn;
    const result = await fetchChannelsBatch([]);
    expect(result).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ── resolveChannelByHandle ────────────────────────────────────────────────────

describe('resolveChannelByHandle', () => {
  beforeEach(() => { process.env.YOUTUBE_API_KEY = 'test-key'; });

  it('returns channelId from search results', async () => {
    mockFetch(
      makeFetchResponse({
        body: { items: [{ snippet: { channelId: 'UC_abc123' } }] },
      })
    );
    const id = await resolveChannelByHandle('sadhguru');
    expect(id).toBe('UC_abc123');
  });

  it('returns null when no items in search results', async () => {
    mockFetch(makeFetchResponse({ body: { items: [] } }));
    const id = await resolveChannelByHandle('unknownHandle');
    expect(id).toBeNull();
  });

  it('returns null when items is missing', async () => {
    mockFetch(makeFetchResponse({ body: {} }));
    const id = await resolveChannelByHandle('unknownHandle');
    expect(id).toBeNull();
  });

  it('requests type=channel and maxResults=1', async () => {
    const fn = mockFetch(makeFetchResponse({ body: {} }));
    await resolveChannelByHandle('test');
    const url = fn.mock.calls[0][0];
    expect(url).toContain('type=channel');
    expect(url).toContain('maxResults=1');
    expect(url).toContain('/search');
  });
});

// ── fetchChannelByHandle ──────────────────────────────────────────────────────

describe('fetchChannelByHandle', () => {
  beforeEach(() => { process.env.YOUTUBE_API_KEY = 'test-key'; });

  it('returns channel item when forHandle succeeds', async () => {
    mockFetch(
      makeFetchResponse({ body: { items: [{ id: 'UC_handle' }] } })
    );
    const result = await fetchChannelByHandle('sadhguru');
    expect(result).toEqual({ id: 'UC_handle' });
  });

  it('prepends @ if handle does not start with it', async () => {
    const fn = mockFetch(
      makeFetchResponse({ body: { items: [{ id: 'UC_handle' }] } })
    );
    await fetchChannelByHandle('sadhguru');
    const url = fn.mock.calls[0][0];
    expect(url).toContain('forHandle=%40sadhguru');
  });

  it('does not double-prepend @ if handle already starts with @', async () => {
    const fn = mockFetch(
      makeFetchResponse({ body: { items: [{ id: 'UC_handle' }] } })
    );
    await fetchChannelByHandle('@sadhguru');
    const url = fn.mock.calls[0][0];
    expect(url).toContain('forHandle=%40sadhguru');
    // Should NOT have @@sadhguru
    expect(url).not.toContain('%40%40sadhguru');
  });

  it('falls back to search when forHandle throws, returns channel', async () => {
    // ytFetch retries 3 times by default, so we need 3 rejections for the forHandle call,
    // then the search call succeeds, then fetchSingleChannel succeeds.
    global.fetch = vi.fn()
      .mockRejectedValueOnce(new Error('forHandle failed'))
      .mockRejectedValueOnce(new Error('forHandle failed'))
      .mockRejectedValueOnce(new Error('forHandle failed'))
      // search call
      .mockResolvedValueOnce(
        makeFetchResponse({ body: { items: [{ snippet: { channelId: 'UC_found' } }] } })
      )
      // fetchSingleChannel call
      .mockResolvedValueOnce(
        makeFetchResponse({ body: { items: [{ id: 'UC_found', title: 'Chan' }] } })
      );
    const result = await fetchChannelByHandle('legacy');
    expect(result).toEqual({ id: 'UC_found', title: 'Chan' });
  });

  it('falls back to search when forHandle returns empty items', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(
        makeFetchResponse({ body: { items: [] } })  // forHandle: empty items
      )
      .mockResolvedValueOnce(
        makeFetchResponse({ body: { items: [{ snippet: { channelId: 'UC_srch' } }] } })
      )
      .mockResolvedValueOnce(
        makeFetchResponse({ body: { items: [{ id: 'UC_srch' }] } })
      );
    const result = await fetchChannelByHandle('legacy');
    expect(result).toEqual({ id: 'UC_srch' });
  });

  it('returns null when fallback search finds no channel', async () => {
    // 3 rejections for the forHandle ytFetch retries, then search returns empty
    global.fetch = vi.fn()
      .mockRejectedValueOnce(new Error('forHandle failed'))
      .mockRejectedValueOnce(new Error('forHandle failed'))
      .mockRejectedValueOnce(new Error('forHandle failed'))
      .mockResolvedValueOnce(makeFetchResponse({ body: { items: [] } })); // search: no results
    const result = await fetchChannelByHandle('ghost');
    expect(result).toBeNull();
  });
});

// ── fetchPlaylistItems ────────────────────────────────────────────────────────

describe('fetchPlaylistItems', () => {
  beforeEach(() => { process.env.YOUTUBE_API_KEY = 'test-key'; });

  it('returns items array', async () => {
    mockFetch(
      makeFetchResponse({ body: { items: [{ id: 'vi1' }, { id: 'vi2' }] } })
    );
    const result = await fetchPlaylistItems('PL123', 2);
    expect(result).toHaveLength(2);
  });

  it('returns empty array when items is missing', async () => {
    mockFetch(makeFetchResponse({ body: {} }));
    const result = await fetchPlaylistItems('PL123');
    expect(result).toEqual([]);
  });

  it('uses maxResults=10 by default', async () => {
    const fn = mockFetch(makeFetchResponse({ body: { items: [] } }));
    await fetchPlaylistItems('PL123');
    const url = fn.mock.calls[0][0];
    expect(url).toContain('maxResults=10');
  });
});

// ── fetchPlaylistItemsPage ────────────────────────────────────────────────────

describe('fetchPlaylistItemsPage', () => {
  beforeEach(() => { process.env.YOUTUBE_API_KEY = 'test-key'; });

  it('returns items and nextPageToken', async () => {
    mockFetch(
      makeFetchResponse({
        body: { items: [{ id: 'i1' }], nextPageToken: 'tok2' },
      })
    );
    const { items, nextPageToken } = await fetchPlaylistItemsPage('PL1', null, 10);
    expect(items).toHaveLength(1);
    expect(nextPageToken).toBe('tok2');
  });

  it('returns null nextPageToken when absent', async () => {
    mockFetch(makeFetchResponse({ body: { items: [] } }));
    const { nextPageToken } = await fetchPlaylistItemsPage('PL1');
    expect(nextPageToken).toBeNull();
  });

  it('passes pageToken param when provided', async () => {
    const fn = mockFetch(makeFetchResponse({ body: { items: [] } }));
    await fetchPlaylistItemsPage('PL1', 'myToken', 20);
    const url = fn.mock.calls[0][0];
    expect(url).toContain('pageToken=myToken');
  });

  it('caps maxResults at 50', async () => {
    const fn = mockFetch(makeFetchResponse({ body: { items: [] } }));
    await fetchPlaylistItemsPage('PL1', null, 200);
    const url = fn.mock.calls[0][0];
    expect(url).toContain('maxResults=50');
  });

  it('omits pageToken when null', async () => {
    const fn = mockFetch(makeFetchResponse({ body: { items: [] } }));
    await fetchPlaylistItemsPage('PL1', null, 20);
    const url = fn.mock.calls[0][0];
    expect(url).not.toContain('pageToken');
  });

  it('returns empty items array when data.items is undefined', async () => {
    mockFetch(makeFetchResponse({ body: {} }));
    const { items } = await fetchPlaylistItemsPage('PL1', null, 10);
    expect(items).toEqual([]);
  });
});

// ── fetchPlaylistItemsPublishedSince ──────────────────────────────────────────

describe('fetchPlaylistItemsPublishedSince', () => {
  beforeEach(() => { process.env.YOUTUBE_API_KEY = 'test-key'; });

  const makeItem = (isoDate, videoId = 'v1') => ({
    contentDetails: { videoPublishedAt: isoDate, videoId },
    snippet: { publishedAt: isoDate },
  });

  it('returns all items published on or after sinceDate', async () => {
    const since = new Date('2024-01-01T00:00:00Z');
    const items = [
      makeItem('2024-06-01T00:00:00Z', 'v3'),
      makeItem('2024-03-01T00:00:00Z', 'v2'),
      makeItem('2024-01-01T00:00:00Z', 'v1'),
    ];
    mockFetch(makeFetchResponse({ body: { items } }));
    const result = await fetchPlaylistItemsPublishedSince('PL1', since);
    expect(result.items).toHaveLength(3);
    expect(result.pagesFetched).toBe(1);
  });

  it('stops paginating early when an older item is encountered', async () => {
    const since = new Date('2024-01-01T00:00:00Z');
    const items = [
      makeItem('2024-06-01T00:00:00Z', 'v2'),
      makeItem('2023-12-01T00:00:00Z', 'v1'), // older than sinceDate → stop
    ];
    mockFetch(makeFetchResponse({ body: { items } }));
    const result = await fetchPlaylistItemsPublishedSince('PL1', since);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].contentDetails.videoId).toBe('v2');
  });

  it('follows pagination until nextPageToken is null', async () => {
    const since = new Date('2024-01-01T00:00:00Z');
    const page1Items = [makeItem('2024-06-01T00:00:00Z', 'v2')];
    const page2Items = [makeItem('2024-03-01T00:00:00Z', 'v1')];
    global.fetch = vi.fn()
      .mockResolvedValueOnce(
        makeFetchResponse({ body: { items: page1Items, nextPageToken: 'page2' } })
      )
      .mockResolvedValueOnce(
        makeFetchResponse({ body: { items: page2Items } })
      );
    const result = await fetchPlaylistItemsPublishedSince('PL1', since);
    expect(result.items).toHaveLength(2);
    expect(result.pagesFetched).toBe(2);
  });

  it('accepts a string date instead of a Date object', async () => {
    const items = [makeItem('2024-06-01T00:00:00Z', 'v1')];
    mockFetch(makeFetchResponse({ body: { items } }));
    const result = await fetchPlaylistItemsPublishedSince('PL1', '2024-01-01T00:00:00Z');
    expect(result.items).toHaveLength(1);
  });

  it('skips items with no publish date', async () => {
    const since = new Date('2024-01-01T00:00:00Z');
    const items = [
      { contentDetails: {}, snippet: {} }, // no date
      makeItem('2024-06-01T00:00:00Z', 'v1'),
    ];
    mockFetch(makeFetchResponse({ body: { items } }));
    const result = await fetchPlaylistItemsPublishedSince('PL1', since);
    expect(result.items).toHaveLength(1);
  });

  it('skips items with invalid date string (NaN)', async () => {
    const since = new Date('2024-01-01T00:00:00Z');
    const items = [
      { contentDetails: { videoPublishedAt: 'not-a-date' }, snippet: {} },
      makeItem('2024-06-01T00:00:00Z', 'v1'),
    ];
    mockFetch(makeFetchResponse({ body: { items } }));
    const result = await fetchPlaylistItemsPublishedSince('PL1', since);
    expect(result.items).toHaveLength(1);
  });

  it('returns empty items when playlist is empty', async () => {
    mockFetch(makeFetchResponse({ body: { items: [] } }));
    const result = await fetchPlaylistItemsPublishedSince('PL1', new Date('2024-01-01'));
    expect(result.items).toEqual([]);
    expect(result.pagesFetched).toBe(1);
  });
});

// ── fetchAllPlaylistItemIds ────────────────────────────────────────────────────

describe('fetchAllPlaylistItemIds', () => {
  beforeEach(() => { process.env.YOUTUBE_API_KEY = 'test-key'; });

  it('returns all video IDs across pages', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(
        makeFetchResponse({
          body: {
            items: [{ contentDetails: { videoId: 'v1' } }, { contentDetails: { videoId: 'v2' } }],
            nextPageToken: 'tok2',
          },
        })
      )
      .mockResolvedValueOnce(
        makeFetchResponse({
          body: { items: [{ contentDetails: { videoId: 'v3' } }] },
        })
      );
    const ids = await fetchAllPlaylistItemIds('PL1');
    expect(ids).toEqual(['v1', 'v2', 'v3']);
  });

  it('skips items without contentDetails.videoId', async () => {
    mockFetch(
      makeFetchResponse({
        body: { items: [{ contentDetails: {} }, { contentDetails: { videoId: 'v1' } }] },
      })
    );
    const ids = await fetchAllPlaylistItemIds('PL1');
    expect(ids).toEqual(['v1']);
  });

  it('returns empty array for empty playlist', async () => {
    mockFetch(makeFetchResponse({ body: { items: [] } }));
    const ids = await fetchAllPlaylistItemIds('PL1');
    expect(ids).toEqual([]);
  });
});

// ── fetchVideosBatch ──────────────────────────────────────────────────────────

describe('fetchVideosBatch', () => {
  beforeEach(() => { process.env.YOUTUBE_API_KEY = 'test-key'; });

  it('returns items from a single batch', async () => {
    mockFetch(
      makeFetchResponse({ body: { items: [{ id: 'v1' }, { id: 'v2' }] } })
    );
    const result = await fetchVideosBatch(['v1', 'v2']);
    expect(result).toHaveLength(2);
  });

  it('batches video IDs in groups of YT_BATCH_SIZE (50)', async () => {
    const ids = Array.from({ length: 55 }, (_, i) => `video_${i}`);
    const fn = vi.fn()
      .mockResolvedValueOnce(makeFetchResponse({ body: { items: [{ id: 'batch1' }] } }))
      .mockResolvedValueOnce(makeFetchResponse({ body: { items: [{ id: 'batch2' }] } }));
    global.fetch = fn;
    const result = await fetchVideosBatch(ids);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
  });

  it('handles missing items field', async () => {
    mockFetch(makeFetchResponse({ body: {} }));
    const result = await fetchVideosBatch(['v1']);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty input', async () => {
    const fn = vi.fn();
    global.fetch = fn;
    const result = await fetchVideosBatch([]);
    expect(result).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ── quota tracking increments on successful fetch ─────────────────────────────

describe('quota tracking', () => {
  beforeEach(() => { process.env.YOUTUBE_API_KEY = 'test-key'; });

  it('trackQuota is called for a successful fetch call (used increases)', async () => {
    const before = getQuotaUsage().used;
    mockFetch(makeFetchResponse({ body: { items: [] } }));
    await fetchSingleChannel('UC1');
    const after = getQuotaUsage().used;
    expect(after).toBeGreaterThan(before);
  });

  it('resolveChannelByHandle tracks extra 99 quota units (search = 100 total)', async () => {
    const before = getQuotaUsage().used;
    mockFetch(makeFetchResponse({ body: { items: [] } }));
    await resolveChannelByHandle('testhandle');
    const after = getQuotaUsage().used;
    // 1 from ytFetch + 99 extra = 100 total for a search call
    expect(after - before).toBe(100);
  });

  it('trackQuota resets when day has changed mid-tracking', async () => {
    const realToDateString = Date.prototype.toDateString;
    // Override so every new Date().toDateString() returns a "future" date
    Date.prototype.toDateString = function () { return 'Tue Jan 02 2100'; };
    try {
      mockFetch(makeFetchResponse({ body: { items: [] } }));
      await fetchSingleChannel('UC1');
      const q = getQuotaUsage();
      // After the reset the counter should be 1 (the tracking call that also triggered reset)
      expect(q.used).toBe(1);
    } finally {
      Date.prototype.toDateString = realToDateString;
    }
  });
});
