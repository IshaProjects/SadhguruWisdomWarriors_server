export function extractChannelId(input) {
  if (!input) return null;
  const trimmed = input.trim();

  // Already a raw channel ID (starts with UC and is 24 chars)
  if (/^UC[\w-]{22}$/.test(trimmed)) return trimmed;

  // URL patterns
  const patterns = [
    /youtube\.com\/channel\/(UC[\w-]{22})/,
    /youtube\.com\/@([\w.-]+)/,
    /youtube\.com\/c\/([\w.-]+)/,
    /youtube\.com\/user\/([\w.-]+)/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) {
      // If it's a direct channel ID URL, return it
      if (match[1] && match[1].startsWith('UC')) return match[1];
      // Otherwise return the handle/username for resolution via API
      return { handle: match[1] };
    }
  }

  // If it looks like a handle (@something), strip the @
  if (trimmed.startsWith('@')) {
    return { handle: trimmed.slice(1) };
  }

  // Treat as potential channel ID or custom URL
  return trimmed;
}

export function formatNumber(num) {
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + 'B';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return String(num);
}

export function calculateEngagementRate(views, likes, comments) {
  if (!views || views === 0) return 0;
  return ((likes + comments) / views) * 100;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
