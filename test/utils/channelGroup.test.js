import { describe, it, expect } from 'vitest';
import { isDedicatedChannel, isIhiChannel } from '../../src/utils/channelGroup.js';

describe('isDedicatedChannel', () => {
  it('returns true when category starts with "Dedicated" (exact case)', () => {
    expect(isDedicatedChannel({ category: 'Dedicated Hindi' })).toBe(true);
  });

  it('returns true when category starts with "dedicated" (lowercase)', () => {
    expect(isDedicatedChannel({ category: 'dedicated channel' })).toBe(true);
  });

  it('returns true when category starts with "DEDICATED" (upper)', () => {
    expect(isDedicatedChannel({ category: 'DEDICATED main' })).toBe(true);
  });

  it('returns false when category does not start with Dedicated', () => {
    expect(isDedicatedChannel({ category: 'IHI Sadhguru' })).toBe(false);
  });

  it('returns false when category is empty string', () => {
    expect(isDedicatedChannel({ category: '' })).toBe(false);
  });

  it('returns false when category is whitespace only', () => {
    expect(isDedicatedChannel({ category: '   ' })).toBe(false);
  });

  it('returns false when channel has no category property', () => {
    expect(isDedicatedChannel({ name: 'foo' })).toBe(false);
  });

  it('returns false when channel is null', () => {
    expect(isDedicatedChannel(null)).toBe(false);
  });

  it('returns false when channel is undefined', () => {
    expect(isDedicatedChannel(undefined)).toBe(false);
  });

  it('trims whitespace before checking', () => {
    expect(isDedicatedChannel({ category: '  Dedicated Tamil' })).toBe(true);
  });
});

describe('isIhiChannel', () => {
  it('returns true for a category containing "IHI"', () => {
    expect(isIhiChannel({ category: 'IHI Sadhguru' })).toBe(true);
  });

  it('returns true for lowercase "ihi" in category', () => {
    expect(isIhiChannel({ category: 'ihi channel' })).toBe(true);
  });

  it('returns true for mixed case "Ihi"', () => {
    expect(isIhiChannel({ category: 'Ihi channel' })).toBe(true);
  });

  it('returns false for Dedicated channel even if it has IHI in name', () => {
    expect(isIhiChannel({ category: 'Dedicated IHI channel' })).toBe(false);
  });

  it('returns false when category is empty string', () => {
    expect(isIhiChannel({ category: '' })).toBe(false);
  });

  it('returns false when category is whitespace only', () => {
    expect(isIhiChannel({ category: '   ' })).toBe(false);
  });

  it('returns false when channel has no category property', () => {
    expect(isIhiChannel({ name: 'foo' })).toBe(false);
  });

  it('returns false when channel is null', () => {
    expect(isIhiChannel(null)).toBe(false);
  });

  it('returns false when category does not contain IHI or Dedicated', () => {
    expect(isIhiChannel({ category: 'General' })).toBe(false);
  });

  it('returns false when channel is undefined', () => {
    expect(isIhiChannel(undefined)).toBe(false);
  });
});
