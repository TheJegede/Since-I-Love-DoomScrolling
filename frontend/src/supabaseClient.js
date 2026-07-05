import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Null when unconfigured (e.g. a pure-local run that still talks to FastAPI).
export const supabase = url && anonKey ? createClient(url, anonKey) : null;

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
  };
}
