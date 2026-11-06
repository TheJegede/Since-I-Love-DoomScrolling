// Every dashboard action is a row in Supabase; the home worker (backend/run_worker.py) does the work.
import { supabase, rowToRecord, REEL_COLUMNS } from './supabaseClient';
import { normalizeInstagramUrl, isValidInstagramReel, parseSavedPosts } from './instagramUrl';

const TABLE = 'saved_reels';
const AUDIO_BUCKET = 'audio-uploads';
const MAX_AUDIO_BYTES = 26214400;  // 25 MB: Groq Whisper's upload limit
export const FAILURE_STATUSES = ['failed', 'cookies_expired', 'unsupported_format'];  // = db.FAILURE_STATUSES

const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

const pendingRow = (fields) => ({
  id: crypto.randomUUID(), status: 'pending', raw_transcript: '', extracted_json: {}, ...fields,
});

async function insertPending(fields) {
  const { data, error } = await supabase.from(TABLE).insert(pendingRow(fields)).select(REEL_COLUMNS).single();
  if (error) throw new Error(`Could not queue it: ${error.message}`);
  return rowToRecord(data);
}

export async function queueReelUrl(rawUrl) {
  const url = normalizeInstagramUrl(rawUrl);
  if (!isValidInstagramReel(url)) throw new Error('Invalid Instagram Reel URL format.');
  const { data: saved, error } = await supabase.from(TABLE).select(REEL_COLUMNS).eq('url', url).limit(1).maybeSingle();
  if (error) throw new Error(`Could not check for an existing reel: ${error.message}`);
  return saved ? rowToRecord(saved) : insertPending({ url, source: 'dashboard' });
}

export async function queueText({ title, transcript, caption }) {
  if (!transcript?.trim() && !caption?.trim()) {
    throw new Error('Please provide either a transcript or a description caption.');
  }
  return insertPending({ title: title || 'Manual Text Input', raw_transcript: transcript, post_caption: caption, source: 'text' });
}

export async function queueAudio({ file, title, caption }) {
  if (file.size > MAX_AUDIO_BYTES) throw new Error('Audio files must be 25 MB or smaller.');
  const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || 'mp3').toLowerCase();
  const path = `${crypto.randomUUID()}.${ext}`;
  const bucket = supabase.storage.from(AUDIO_BUCKET);
  // The bucket only accepts audio/*; some browsers leave file.type empty.
  const { error: uploadError } = await bucket.upload(path, file, { contentType: file.type || 'audio/mpeg' });
  if (uploadError) throw new Error(`Could not upload the audio file: ${uploadError.message}`);
  try {
    return await insertPending({ title: title || file.name, post_caption: caption, audio_path: path, source: 'audio' });
  } catch (err) {
    const { error: removeError } = await bucket.remove([path]);  // never leave an upload no row points at
    if (removeError) console.error(`Could not remove the orphan upload ${path} from ${AUDIO_BUCKET}`, removeError);
    throw err;
  }
}

/** Queue every new reel in an Instagram saved_posts.json export. */
export async function queueBulk(data) {
  const reels = parseSavedPosts(data);
  if (!reels.length) throw new Error('No reel URLs found in the uploaded file.');
  const urls = reels.map(r => r.url);
  const saved = new Set();
  for (const chunk of chunks(urls, 100)) {  // keeps each request URL short
    const { data: rows, error } = await supabase.from(TABLE).select('url').in('url', chunk);
    if (error) throw new Error(`Could not check which reels are already saved: ${error.message}`);
    rows.forEach(r => saved.add(r.url));
  }
  const fresh = reels.filter(r => !saved.has(r.url));
  let queued = 0;
  for (const chunk of chunks(fresh, 50)) {
    const rows = chunk.map(r => pendingRow({ url: r.url, title: r.title || null, post_caption: r.caption || null, source: 'batch' }));
    const { error } = await supabase.from(TABLE).insert(rows);
    if (error) throw new Error(`Queued ${queued} of ${fresh.length} new reels, then failed: ${error.message}`);
    queued += rows.length;
  }
  return { total: urls.length, enqueued: fresh.length, existing: saved.size, urls };
}

export async function retryReel(id) {
  const { data, error } = await supabase.from(TABLE)
    .update({ status: 'pending', error: null, processing_started_at: null, next_attempt_at: null, attempt_count: 0 })
    .eq('id', id).in('status', FAILURE_STATUSES).select('id');
  if (error) throw new Error(`Retry failed: ${error.message}`);
  if (!data.length) throw new Error('Reel not found or not in a retryable failure state.');
}

export async function deleteReel(reel) {
  // Row-level security refuses silently (zero rows, no error), so count what was deleted.
  const { data, error } = await supabase.from(TABLE).delete().eq('id', reel.id).select('id');
  if (error) throw new Error(`Delete failed: ${error.message}`);
  if (!data.length) throw new Error('Nothing was deleted: the reel is already gone, or this account may not delete it. Reload to check.');
  if (reel.audio_path) {
    const { error: removeError } = await supabase.storage.from(AUDIO_BUCKET).remove([reel.audio_path]);
    if (removeError) console.warn('Reel deleted, but its audio file was not', removeError);
  }
}

export async function requestClusterRecompute() {
  const { error } = await supabase.from('cluster_jobs').insert({});
  // 23505: the cluster_jobs_one_active index says one is already queued or running, which is what we want.
  if (error && error.code !== '23505') throw new Error(`Could not start recompute: ${error.message}`);
}

export async function latestClusterJob() {
  const { data, error } = await supabase.from('cluster_jobs')
    .select('id, status, error, assigned, created_at, finished_at')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`Could not read recompute status: ${error.message}`);
  return data;
}
