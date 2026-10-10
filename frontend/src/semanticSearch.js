function matchesKeyword(reel, q) {
  const ej = reel.extracted_json || {};
  const hay = [
    reel.title, reel.raw_transcript, reel.post_caption, ej.core_topic, ej.key_takeaway,
    ...(ej.tools_or_resources || []), ...(ej.action_items || [])
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

/**
 * Keep the reels that match the query by exact words or by meaning, best match
 * first. `scores` maps reel id -> similarity for meaning matches. Exact-word
 * matches always outrank meaning-only ones; ties keep the input order.
 */
export function rankReels(reels, query, scores) {
  const q = query.trim().toLowerCase();
  const relatedIds = new Set();
  if (!q) return { reels, relatedIds };

  const ranked = [];
  for (const reel of reels) {
    const keyword = matchesKeyword(reel, q);
    const similarity = scores.get(reel.id);
    if (!keyword && similarity === undefined) continue;
    if (!keyword) relatedIds.add(reel.id);
    ranked.push({ reel, rank: (keyword ? 1 : 0) + (similarity ?? 0) });
  }
  ranked.sort((a, b) => b.rank - a.rank);
  return { reels: ranked.map(entry => entry.reel), relatedIds };
}
