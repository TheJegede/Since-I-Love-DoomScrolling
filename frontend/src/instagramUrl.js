// Mirrors backend/saved_parser.py (normalize_instagram_url) and main.is_valid_instagram_reel.
// The worker re-normalizes every URL, but duplicate checks compare these strings: change both together.

const REEL_PATH = /instagram\.com\/(reel|reels|p)\/([A-Za-z0-9_-]+)/;
const CANONICAL_REEL = /^https?:\/\/(www\.)?instagram\.com\/(?:reel|reels|p)\/[A-Za-z0-9_-]+\/?$/;

/** Strip query strings and normalize Instagram reel/post links to https://www.instagram.com/<reel|p>/<id>/. */
export function normalizeInstagramUrl(url) {
  if (!url) return '';
  const trimmed = url.trim();
  const match = trimmed.match(REEL_PATH);
  if (match) return `https://www.instagram.com/${match[1] === 'p' ? 'p' : 'reel'}/${match[2]}/`;
  return trimmed.split('?')[0];
}

export function isValidInstagramReel(url) {
  return Boolean(url) && CANONICAL_REEL.test(normalizeInstagramUrl(url));
}

/** [{url, caption, title}] for every reel in an Instagram saved_posts.json export; photos and repeats dropped. */
export function parseSavedPosts(data) {
  const items = [];
  const seen = new Set();
  for (const entry of Array.isArray(data) ? data : []) {
    const fields = Object.fromEntries((entry?.label_values || []).map(lv => [lv.label, lv.value || '']));
    const url = fields.URL || '';
    if (!url.includes('/reel/') && !url.includes('/reels/')) continue;
    const clean = normalizeInstagramUrl(url);
    if (seen.has(clean)) continue;  // a reel saved to two collections is listed twice
    seen.add(clean);
    items.push({ url: clean, caption: fields.Caption || '', title: fields.Title || '' });
  }
  return items;
}
