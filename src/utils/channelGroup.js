/**
 * Channel grouping for sync jobs (aligned with dashboard filters).
 * Dedicated wins: a channel whose category starts with "Dedicated" is never treated as IHI-only.
 */

export function isDedicatedChannel(channel) {
  const cat = (channel?.category || '').trim();
  if (!cat) return false;
  return /^Dedicated/i.test(cat);
}

export function isIhiChannel(channel) {
  const cat = (channel?.category || '').trim();
  if (!cat) return false;
  if (isDedicatedChannel(channel)) return false;
  return /IHI/i.test(cat);
}
