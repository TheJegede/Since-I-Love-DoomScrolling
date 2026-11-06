import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Null when unconfigured; the dashboard then shows a configuration error.
// Implicit flow: the sign-in link carries the session itself, so it works when opened
// on another device or browser than the one that asked for it (PKCE would not).
export const supabase = url && anonKey
  ? createClient(url, anonKey, { auth: { flowType: 'implicit', persistSession: true, detectSessionInUrl: true } })
  : null;

// The list view's columns; transcripts and captions are fetched per reel when opened.
export const REEL_COLUMNS = 'id, url, title, extracted_json, created_at, cluster, status, error, audio_path';

/** Map a Supabase row to the record shape the UI already renders. */
export function rowToRecord(r) {
  let ej = r.extracted_json;
  if (typeof ej === 'string') {
    try { ej = JSON.parse(ej); } catch { ej = {}; }
  }
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    raw_transcript: r.raw_transcript,
    post_caption: r.post_caption,
    extracted_json: ej || {},
    created_at: r.created_at,
    cluster: r.cluster || 'Unclustered',
    status: r.status || 'done',
    error: r.error || null,
    audio_path: r.audio_path || null,
  };
}
