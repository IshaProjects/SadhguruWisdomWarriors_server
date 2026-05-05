export function extractChannelId(input) {
  if (!input) return null;

  // Normalise: trim whitespace, ensure a protocol so URL parsing works
  let raw = input.trim();

  // Encode unicode characters in the path (e.g. Hindi channel names)
  // by leaving them as-is – they'll be treated as handles below

  // Add protocol if missing (e.g. "www.youtube.com/..." or bare paths)
  if (!raw.match(/^https?:\/\//i)) {
    raw = 'https://' + raw.replace(/^\/\//, '');
  }

  // Strip tracking / share params (?si=..., ?feature=..., etc.) and fragments
  let url;
  try {
    url = new URL(raw);
  } catch {
    // Not a valid URL – treat as raw channel ID or handle
    if (/^UC[\w-]{22}$/.test(raw)) return raw;
    if (raw.startsWith('@')) return { handle: raw.slice(1) };
    return raw;
  }

  // Remove ?si= and other tracking query params entirely
  const cleanPath = url.pathname;

  // Already a raw channel ID (starts with UC and is 24 chars)
  if (/^UC[\w-]{22}$/.test(cleanPath.replace('/', ''))) {
    return cleanPath.replace(/^\//, '');
  }

  // /channel/UCxxxx
  const channelMatch = cleanPath.match(/\/channel\/(UC[\w-]{22})/);
  if (channelMatch) return channelMatch[1];

  // /@handle  (most common modern format)
  const atMatch = cleanPath.match(/\/@([\w.\u0900-\u097F\u0600-\u06FF-]+)/u);
  if (atMatch) return { handle: atMatch[1] };

  // /c/customName or /user/username  (legacy)
  const legacyMatch = cleanPath.match(/\/(?:c|user)\/([\w.-]+)/);
  if (legacyMatch) return { handle: legacyMatch[1] };

  // Bare path like /jibonsomossarsomadhan (no @ prefix – legacy custom URLs)
  const bareMatch = cleanPath.match(/^\/([\w.-]+)$/);
  if (bareMatch && bareMatch[1] !== 'channel') {
    return { handle: bareMatch[1] };
  }

  // Fallback: return the whole cleaned path segment
  return cleanPath.replace(/^\//, '') || raw;
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

/** YouTube statistics fields are strings; strip commas so parseInt is not truncated at ",". */
export function parseYoutubeStatInt(value) {
  if (value == null || value === '') return 0;
  const n = parseInt(String(value).replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}
