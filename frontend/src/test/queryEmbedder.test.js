import { describe, it, expect, vi } from 'vitest';

const pipeline = vi.hoisted(() => vi.fn());
vi.mock('@huggingface/transformers', () => ({ pipeline }));

import { embedQuery } from '../queryEmbedder';

describe('queryEmbedder', () => {
  it('retries a failed model load, then reuses the loaded model', async () => {
    const embedder = vi.fn(async () => ({ data: Float32Array.from([0.5, 0.25]) }));
    pipeline.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(embedder);

    await expect(embedQuery('comedy')).rejects.toThrow('offline');
    expect(await embedQuery('comedy')).toEqual([0.5, 0.25]);
    expect(await embedQuery('jokes')).toEqual([0.5, 0.25]);

    expect(pipeline).toHaveBeenCalledTimes(2);
    expect(pipeline).toHaveBeenLastCalledWith(
      'feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
    expect(embedder).toHaveBeenLastCalledWith('jokes', { pooling: 'mean', normalize: true });
  });
});
