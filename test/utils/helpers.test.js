import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractChannelId,
  formatNumber,
  calculateEngagementRate,
  sleep,
  parseYoutubeStatInt,
} from '../../src/utils/helpers.js';

// ─── extractChannelId ──────────────────────────────────────────────────────

describe('extractChannelId', () => {
  it('returns null for null input', () => {
    expect(extractChannelId(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(extractChannelId(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractChannelId('')).toBeNull();
  });

  it('extracts UC ID from /channel/UCxxxx URL', () => {
    const id = 'UCxxxxxxxxxxxxxxxxxxxxxx'; // 24 chars starting with UC
    const result = extractChannelId(`https://www.youtube.com/channel/${id}`);
    expect(result).toBe(id);
  });

  it('extracts handle from /@handle URL', () => {
    const result = extractChannelId('https://www.youtube.com/@sadhguru');
    expect(result).toEqual({ handle: 'sadhguru' });
  });

  it('extracts handle from /c/customName URL', () => {
    const result = extractChannelId('https://www.youtube.com/c/SadhguruOfficial');
    expect(result).toEqual({ handle: 'SadhguruOfficial' });
  });

  it('extracts handle from /user/username URL (legacy)', () => {
    const result = extractChannelId('https://www.youtube.com/user/sadhguru');
    expect(result).toEqual({ handle: 'sadhguru' });
  });

  it('adds https:// when URL has no protocol', () => {
    const result = extractChannelId('www.youtube.com/@sadhguru');
    expect(result).toEqual({ handle: 'sadhguru' });
  });

  it('strips leading // when protocol is missing', () => {
    const result = extractChannelId('//www.youtube.com/@yoga');
    expect(result).toEqual({ handle: 'yoga' });
  });

  it('handles bare path /channelname (not /channel/ keyword)', () => {
    const result = extractChannelId('https://www.youtube.com/jibonsomossarsomadhan');
    expect(result).toEqual({ handle: 'jibonsomossarsomadhan' });
  });

  it('returns the fallback string for a bare UC ID (prepends https:// which parses as a URL)', () => {
    // NOTE: bare UC IDs get 'https://' prepended, so they parse as valid URLs with the UC id
    // as the hostname, path='/', which falls through to the fallback -> returns 'https://UCaaa...'
    // The catch-block UC/@ branches are unreachable (see coverage note in summary).
    const ucId = 'UC' + 'a'.repeat(22);
    const result = extractChannelId(ucId);
    expect(result).toBe('https://' + ucId);
  });

  it('returns a fallback string for a bare @handle (prepends https:// which parses as URL)', () => {
    // '@myshannel' becomes 'https://@myshannel' - parses as URL(host=myshannel, path='/')
    // Falls through to fallback '' || 'https://@myshannel'
    const result = extractChannelId('@myshannel');
    expect(result).toBe('https://@myshannel');
  });

  it('returns the raw (with https://) for an unrecognised non-URL-like string that parses', () => {
    // 'someRandomString' becomes 'https://someRandomString' -> parses OK (host=someRandomString)
    // path='/', falls to fallback -> '' || 'https://someRandomString'
    const result = extractChannelId('someRandomString');
    expect(result).toBe('https://someRandomString');
  });

  it('returns raw string for invalid bracket URL (catch block fallback path)', () => {
    // '[::notvalid' gets prepended to 'https://[::notvalid' which fails URL parsing
    // Inside catch: raw='https://[::notvalid' - doesn't match UC/@ patterns -> return raw
    const result = extractChannelId('[::notvalid');
    expect(typeof result).toBe('string');
    expect(result).toContain('[::notvalid');
  });

  it('returns fallback cleanPath when no pattern matches on a valid URL', () => {
    // A URL with a path that is just /channel (the keyword itself, barred by the guard)
    const result = extractChannelId('https://www.youtube.com/channel');
    // The path is /channel; bareMatch matches but bareMatch[1] === 'channel' so skips
    // falls through to return cleanPath.replace(/^\//, '') = 'channel'
    expect(result).toBe('channel');
  });

  it('handles UC ID in URL path directly (no /channel/ prefix)', () => {
    const ucId = 'UC' + 'b'.repeat(22);
    const result = extractChannelId(`https://www.youtube.com/${ucId}`);
    expect(result).toBe(ucId);
  });
});

// ─── formatNumber ──────────────────────────────────────────────────────────

describe('formatNumber', () => {
  it('formats billions correctly', () => {
    expect(formatNumber(1_500_000_000)).toBe('1.5B');
  });

  it('formats exactly 1 billion', () => {
    expect(formatNumber(1_000_000_000)).toBe('1.0B');
  });

  it('formats millions correctly', () => {
    expect(formatNumber(2_500_000)).toBe('2.5M');
  });

  it('formats exactly 1 million', () => {
    expect(formatNumber(1_000_000)).toBe('1.0M');
  });

  it('formats thousands correctly', () => {
    expect(formatNumber(3_500)).toBe('3.5K');
  });

  it('formats exactly 1000', () => {
    expect(formatNumber(1_000)).toBe('1.0K');
  });

  it('formats numbers below 1000 as plain string', () => {
    expect(formatNumber(999)).toBe('999');
  });

  it('formats 0 as plain string', () => {
    expect(formatNumber(0)).toBe('0');
  });
});

// ─── calculateEngagementRate ───────────────────────────────────────────────

describe('calculateEngagementRate', () => {
  it('returns 0 when views is 0', () => {
    expect(calculateEngagementRate(0, 100, 50)).toBe(0);
  });

  it('returns 0 when views is null/falsy', () => {
    expect(calculateEngagementRate(null, 100, 50)).toBe(0);
  });

  it('returns 0 when views is undefined', () => {
    expect(calculateEngagementRate(undefined, 100, 50)).toBe(0);
  });

  it('calculates engagement rate correctly', () => {
    // (100 + 50) / 1000 * 100 = 15
    expect(calculateEngagementRate(1000, 100, 50)).toBe(15);
  });

  it('handles zero likes and comments', () => {
    expect(calculateEngagementRate(1000, 0, 0)).toBe(0);
  });

  it('returns 100 when likes+comments equals views', () => {
    expect(calculateEngagementRate(100, 50, 50)).toBe(100);
  });
});

// ─── sleep ─────────────────────────────────────────────────────────────────

describe('sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a Promise', () => {
    const p = sleep(100);
    expect(p).toBeInstanceOf(Promise);
    vi.runAllTimers();
  });

  it('resolves after the specified ms', async () => {
    const p = sleep(500);
    vi.advanceTimersByTime(500);
    await expect(p).resolves.toBeUndefined();
  });

  it('resolves with undefined', async () => {
    const p = sleep(0);
    vi.advanceTimersByTime(0);
    const result = await p;
    expect(result).toBeUndefined();
  });
});

// ─── parseYoutubeStatInt ───────────────────────────────────────────────────

describe('parseYoutubeStatInt', () => {
  it('returns 0 for null', () => {
    expect(parseYoutubeStatInt(null)).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(parseYoutubeStatInt(undefined)).toBe(0);
  });

  it('returns 0 for empty string', () => {
    expect(parseYoutubeStatInt('')).toBe(0);
  });

  it('parses a plain integer string', () => {
    expect(parseYoutubeStatInt('12345')).toBe(12345);
  });

  it('parses a string with commas (e.g. "1,234,567")', () => {
    expect(parseYoutubeStatInt('1,234,567')).toBe(1234567);
  });

  it('parses a numeric value', () => {
    expect(parseYoutubeStatInt(42)).toBe(42);
  });

  it('returns 0 for non-numeric string', () => {
    expect(parseYoutubeStatInt('abc')).toBe(0);
  });

  it('returns 0 for NaN result', () => {
    expect(parseYoutubeStatInt('not-a-number')).toBe(0);
  });

  it('parses "0" as 0', () => {
    expect(parseYoutubeStatInt('0')).toBe(0);
  });
});
