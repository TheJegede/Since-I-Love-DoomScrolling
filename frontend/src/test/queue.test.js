import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../supabaseClient', async (importOriginal) => {
  const { createFakeSupabase } = await import('./fakeSupabase');
  const fake = createFakeSupabase();
  return { ...(await importOriginal()), supabase: fake.client, __fake: fake };
});

import { __fake as fake } from '../supabaseClient';
import {
  queueReelUrl, queueText, queueAudio, queueBulk, retryReel, deleteReel, requestClusterRecompute,
} from '../queue';

const reels = () => fake.tables.saved_reels;
const audioFile = (size = 1000, name = 'memo.m4a') => ({ name, size, type: 'audio/mp4' });

beforeEach(() => {
  fake.tables = { saved_reels: [], cluster_jobs: [] };
  fake.uploads.length = 0;
  fake.removed.length = 0;
  fake.log.length = 0;
  fake.failures.length = 0;
});

describe('queue', () => {
  it('queueReelUrl returns the saved row instead of inserting a duplicate', async () => {
    reels().push({ id: 'old', url: 'https://www.instagram.com/reel/ABC/', status: 'done', extracted_json: {} });
    const record = await queueReelUrl('https://instagram.com/reels/ABC/?igsh=9');
    expect(record.id).toBe('old');
    expect(reels()).toHaveLength(1);
  });

  it('queueReelUrl inserts a normalized pending dashboard row', async () => {
    const record = await queueReelUrl(' https://www.instagram.com/reel/NEW1/?igsh=1 ');
    expect(reels()).toHaveLength(1);
    expect(reels()[0]).toMatchObject({ url: 'https://www.instagram.com/reel/NEW1/', status: 'pending', source: 'dashboard' });
    expect(record).toMatchObject({ id: reels()[0].id, status: 'pending' });
    await expect(queueReelUrl('https://google.com')).rejects.toThrow('Invalid Instagram Reel URL format.');
  });

  it('queueText requires a transcript or caption and keeps the title', async () => {
    await expect(queueText({ title: '', transcript: ' ', caption: '' }))
      .rejects.toThrow('Please provide either a transcript or a description caption.');
    await queueText({ title: '', transcript: 'spoken words', caption: 'cap' });
    expect(reels()[0]).toMatchObject({ title: 'Manual Text Input', raw_transcript: 'spoken words', post_caption: 'cap', source: 'text', status: 'pending' });
  });

  it('queueAudio rejects files over 25 MB without uploading', async () => {
    await expect(queueAudio({ file: audioFile(26214401) })).rejects.toThrow('Audio files must be 25 MB or smaller.');
    expect(fake.uploads).toHaveLength(0);
    expect(reels()).toHaveLength(0);
  });

  it('queueAudio uploads the file and queues a row pointing at it', async () => {
    await queueAudio({ file: audioFile(), title: '', caption: 'cap' });
    const [{ bucket, path }] = fake.uploads;
    expect(bucket).toBe('audio-uploads');
    expect(path).toMatch(/^[0-9a-f-]{36}\.m4a$/);
    expect(reels()[0]).toMatchObject({ audio_path: path, title: 'memo.m4a', post_caption: 'cap', source: 'audio', status: 'pending' });
  });

  it('queueAudio removes the uploaded file when the row insert fails', async () => {
    fake.failNext('saved_reels', 'insert', { message: 'permission denied' });
    await expect(queueAudio({ file: audioFile() })).rejects.toThrow(/permission denied/);
    expect(fake.removed).toEqual([{ bucket: 'audio-uploads', path: fake.uploads[0].path }]);
    expect(reels()).toHaveLength(0);
  });

  it('queueBulk skips repeats and saved reels across chunks', async () => {
    const entry = (id) => ({ label_values: [{ label: 'URL', value: `https://www.instagram.com/reel/R${id}/` }] });
    const data = [...Array.from({ length: 148 }, (_, i) => entry(i)), entry(0), entry(1)];  // 150 entries, 2 repeats
    for (const id of [5, 77, 140]) reels().push({ id: `saved${id}`, url: `https://www.instagram.com/reel/R${id}/`, status: 'done' });

    const result = await queueBulk(data);
    expect(result).toMatchObject({ total: 148, enqueued: 145, existing: 3 });
    expect(result.urls).toHaveLength(148);
    expect(reels()).toHaveLength(148);
    expect(reels().filter(r => r.source === 'batch').every(r => r.status === 'pending')).toBe(true);
    const lookups = fake.log.filter(c => c.method === 'in' && c.args[0] === 'url');
    expect(lookups.length).toBeGreaterThan(1);
    expect(lookups.every(c => c.args[1].length <= 100)).toBe(true);
    await expect(queueBulk([])).rejects.toThrow('No reel URLs found in the uploaded file.');
  });

  it('retryReel requeues a failed reel and throws when no failed reel matched', async () => {
    reels().push({ id: 'f1', status: 'cookies_expired', attempt_count: 3, error: 'x' }, { id: 'd1', status: 'done' });
    await retryReel('f1');
    expect(reels()[0]).toMatchObject({ status: 'pending', attempt_count: 0, error: null });
    await expect(retryReel('d1')).rejects.toThrow('Reel not found or not in a retryable failure state.');
  });

  it('deleteReel removes the audio file after the row', async () => {
    reels().push({ id: 'a1', audio_path: 'a1.m4a', status: 'failed' });
    await deleteReel({ id: 'a1', audio_path: 'a1.m4a' });
    expect(reels()).toHaveLength(0);
    expect(fake.removed).toEqual([{ bucket: 'audio-uploads', path: 'a1.m4a' }]);
  });

  it('requestClusterRecompute treats an already-active job as success', async () => {
    await requestClusterRecompute();
    expect(fake.tables.cluster_jobs).toHaveLength(1);
    fake.failNext('cluster_jobs', 'insert', { code: '23505', message: 'duplicate key value violates unique constraint' });
    await expect(requestClusterRecompute()).resolves.toBeUndefined();
    fake.failNext('cluster_jobs', 'insert', { code: '42501', message: 'permission denied' });
    await expect(requestClusterRecompute()).rejects.toThrow(/permission denied/);
  });
});
