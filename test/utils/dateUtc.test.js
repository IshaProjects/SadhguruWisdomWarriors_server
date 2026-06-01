import { describe, it, expect } from 'vitest';
import {
  utcStartOfDay,
  utcEndOfDay,
  parseYmdToUtcStart,
  parseYmdToUtcEnd,
  utcDateString,
} from '../../src/utils/dateUtc.js';

describe('utcStartOfDay', () => {
  it('returns midnight UTC for a given date string', () => {
    const result = utcStartOfDay('2024-03-15');
    expect(result.toISOString()).toBe('2024-03-15T00:00:00.000Z');
  });

  it('returns midnight UTC for a Date object', () => {
    const d = new Date('2024-06-01T12:34:56.000Z');
    const result = utcStartOfDay(d);
    expect(result.toISOString()).toBe('2024-06-01T00:00:00.000Z');
  });

  it('defaults to today when no argument given', () => {
    const result = utcStartOfDay();
    const today = new Date();
    expect(result.getUTCHours()).toBe(0);
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCSeconds()).toBe(0);
    expect(result.getUTCMilliseconds()).toBe(0);
    expect(result.getUTCFullYear()).toBe(today.getUTCFullYear());
  });

  it('returns a Date instance', () => {
    expect(utcStartOfDay('2024-01-01')).toBeInstanceOf(Date);
  });
});

describe('utcEndOfDay', () => {
  it('returns 23:59:59.999 UTC for a given date string', () => {
    const result = utcEndOfDay('2024-03-15');
    expect(result.toISOString()).toBe('2024-03-15T23:59:59.999Z');
  });

  it('returns 23:59:59.999 UTC for a Date object', () => {
    const d = new Date('2024-06-01T00:00:00.000Z');
    const result = utcEndOfDay(d);
    expect(result.toISOString()).toBe('2024-06-01T23:59:59.999Z');
  });

  it('defaults to today when no argument given', () => {
    const result = utcEndOfDay();
    expect(result.getUTCHours()).toBe(23);
    expect(result.getUTCMinutes()).toBe(59);
    expect(result.getUTCSeconds()).toBe(59);
    expect(result.getUTCMilliseconds()).toBe(999);
  });

  it('returns a Date instance', () => {
    expect(utcEndOfDay('2024-12-31')).toBeInstanceOf(Date);
  });
});

describe('parseYmdToUtcStart', () => {
  it('returns the correct start of day UTC Date for a YYYY-MM-DD string', () => {
    const result = parseYmdToUtcStart('2024-07-04');
    expect(result.toISOString()).toBe('2024-07-04T00:00:00.000Z');
  });

  it('returns null when argument is null', () => {
    expect(parseYmdToUtcStart(null)).toBeNull();
  });

  it('returns null when argument is undefined', () => {
    expect(parseYmdToUtcStart(undefined)).toBeNull();
  });

  it('returns null when argument is empty string', () => {
    expect(parseYmdToUtcStart('')).toBeNull();
  });

  it('returns a Date instance for a valid ymd', () => {
    expect(parseYmdToUtcStart('2023-01-01')).toBeInstanceOf(Date);
  });
});

describe('parseYmdToUtcEnd', () => {
  it('returns end of day UTC Date for a YYYY-MM-DD string', () => {
    const result = parseYmdToUtcEnd('2024-07-04');
    expect(result.toISOString()).toBe('2024-07-04T23:59:59.999Z');
  });

  it('returns null when argument is null', () => {
    expect(parseYmdToUtcEnd(null)).toBeNull();
  });

  it('returns null when argument is undefined', () => {
    expect(parseYmdToUtcEnd(undefined)).toBeNull();
  });

  it('returns null when argument is empty string', () => {
    expect(parseYmdToUtcEnd('')).toBeNull();
  });

  it('returns a Date instance for a valid ymd', () => {
    expect(parseYmdToUtcEnd('2023-12-31')).toBeInstanceOf(Date);
  });
});

describe('utcDateString', () => {
  it('returns YYYY-MM-DD for a given date string', () => {
    expect(utcDateString('2024-05-20T15:00:00.000Z')).toBe('2024-05-20');
  });

  it('returns YYYY-MM-DD for a Date object', () => {
    expect(utcDateString(new Date('2024-01-01T00:00:00.000Z'))).toBe('2024-01-01');
  });

  it('defaults to today when no argument given', () => {
    const result = utcDateString();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
