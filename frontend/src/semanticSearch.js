import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { embedQuery, loadEmbedder } from './queryEmbedder';

// Tuned by hand against real reels; see docs/superpowers/specs/2026-10-10-semantic-search-design.md.
export const MATCH_THRESHOLD = 0.3;
export const MATCH_COUNT = 100;
const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 300;
const NO_SCORES = new Map();

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

async function fetchScores(query) {
  const { data, error } = await supabase.rpc('match_reels', {
    query_embedding: await embedQuery(query),
    match_threshold: MATCH_THRESHOLD,
    match_count: MATCH_COUNT,
  });
  if (error) throw error;
  return new Map(data.map(row => [row.id, row.similarity]));
}

/**
 * Meaning matches for the search text. The query is embedded in the browser
 * and matched in Supabase, so the backend is never involved.
 *
 * status: 'idle' (not searching, or no Supabase client) | 'loading' (model
 * still downloading) | 'ready' | 'error'. `scores` only ever holds results
 * for the current query.
 */
export function useSemanticSearch(query) {
  const q = query.trim();
  const active = Boolean(supabase) && q.length >= MIN_QUERY_LENGTH;
  const [modelReady, setModelReady] = useState(false);
  const [result, setResult] = useState({ query: '', scores: NO_SCORES, failed: false });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        await loadEmbedder();
        if (cancelled) return;
        setModelReady(true);
        const scores = await fetchScores(q);
        if (!cancelled) setResult({ query: q, scores, failed: false });
      } catch (err) {
        console.error('Smart search failed', err);
        if (!cancelled) setResult({ query: q, scores: NO_SCORES, failed: true });
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, active, attempt]);

  const current = active && result.query === q;
  const failed = current && result.failed;
  let status = 'idle';
  if (active) status = failed ? 'error' : modelReady ? 'ready' : 'loading';

  const retry = () => {
    setResult({ query: '', scores: NO_SCORES, failed: false });
    setAttempt(n => n + 1);
  };

  return { status, scores: current && !failed ? result.scores : NO_SCORES, retry };
}
