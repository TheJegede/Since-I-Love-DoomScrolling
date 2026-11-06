import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { embedQuery, loadEmbedder } from './queryEmbedder';

// Tuned by hand against real reels (2026-10-10): topics absent from the library
// peaked at 0.39 similarity, real matches mostly sat at 0.40 and above.
export const MATCH_THRESHOLD = 0.4;
export const MATCH_COUNT = 100;
const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 300;
const NO_SCORES = new Map();
const NO_IDS = new Set();
// Transcripts and captions are not loaded into the browser, so Supabase searches them.
const TEXT_SEARCH_COLUMNS = ['raw_transcript', 'post_caption'];

// Every word of the query must appear somewhere in the reel's loaded fields, in any order.
function matchesKeyword(reel, words) {
  const ej = reel.extracted_json || {};
  const hay = [
    reel.title, ej.core_topic, ej.key_takeaway,
    ...(ej.tools_or_resources || []), ...(ej.action_items || [])
  ].filter(Boolean).join(' ').toLowerCase();
  return words.every(word => hay.includes(word));
}

/**
 * Keep the reels that match the query by exact words or by meaning, best match
 * first. `scores` maps reel id -> similarity for meaning matches; `textIds` holds
 * reels whose transcript or caption contains the words. Word matches always
 * outrank meaning-only ones; ties keep the input order.
 */
export function rankReels(reels, query, scores, textIds = NO_IDS) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const relatedIds = new Set();
  if (!words.length) return { reels, relatedIds };

  const ranked = [];
  for (const reel of reels) {
    const keyword = matchesKeyword(reel, words) || textIds.has(reel.id);
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

// shortcut: no full-text index, so Postgres scans every transcript (~0.25s at 750 reels); add a GIN index if it slows down.
async function fetchTextMatches(query) {
  const results = await Promise.all(TEXT_SEARCH_COLUMNS.map(column =>
    supabase.from('saved_reels').select('id').textSearch(column, query, { type: 'websearch', config: 'english' })));
  const ids = new Set();
  for (const { data, error } of results) {
    if (error) throw error;
    for (const row of data) ids.add(row.id);
  }
  return ids;
}

/**
 * Search help from Supabase for the search text: meaning matches (the query is
 * embedded in the browser and matched with match_reels) and transcript/caption
 * word matches (Postgres full-text search). The backend is never involved.
 *
 * status: 'idle' (not searching, or no Supabase client) | 'loading' (model
 * still downloading) | 'ready' | 'error' — for meaning matches.
 * transcriptsFailed: the transcript/caption search failed for this query.
 * `scores` and `textIds` only ever hold results for the current query.
 */
export function useSemanticSearch(query) {
  const q = query.trim();
  const active = Boolean(supabase) && q.length >= MIN_QUERY_LENGTH;
  const [modelReady, setModelReady] = useState(false);
  const [result, setResult] = useState({ query: '', scores: NO_SCORES, failed: false });
  const [text, setText] = useState({ query: '', ids: NO_IDS, failed: false });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      fetchTextMatches(q).then(
        ids => { if (!cancelled) setText({ query: q, ids, failed: false }); },
        err => {
          console.error('Transcript search failed', err);
          if (!cancelled) setText({ query: q, ids: NO_IDS, failed: true });
        },
      );
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
  const textCurrent = active && text.query === q;

  const retry = () => {
    setResult({ query: '', scores: NO_SCORES, failed: false });
    setText({ query: '', ids: NO_IDS, failed: false });
    setAttempt(n => n + 1);
  };

  return {
    status,
    scores: current && !failed ? result.scores : NO_SCORES,
    textIds: textCurrent ? text.ids : NO_IDS,
    transcriptsFailed: textCurrent && text.failed,
    retry,
  };
}
