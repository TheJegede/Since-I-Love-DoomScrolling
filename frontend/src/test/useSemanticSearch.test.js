import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const { rpc, loadEmbedder, embedQuery } = vi.hoisted(() => ({
  rpc: vi.fn(),
  loadEmbedder: vi.fn(),
  embedQuery: vi.fn(),
}));
vi.mock('../supabaseClient', () => ({ supabase: { rpc } }));
vi.mock('../queryEmbedder', () => ({ loadEmbedder, embedQuery }));

import { useSemanticSearch, MATCH_THRESHOLD, MATCH_COUNT } from '../semanticSearch';

const search = (q) => renderHook(({ q }) => useSemanticSearch(q), { initialProps: { q } });

beforeEach(() => {
  loadEmbedder.mockReset().mockResolvedValue(undefined);
  embedQuery.mockReset().mockResolvedValue([0.1, 0.2]);
  rpc.mockReset().mockResolvedValue({ data: [{ id: 'a', similarity: 0.7 }], error: null });
});

describe('useSemanticSearch', () => {
  it('stays idle and never loads the model for empty or one-character queries', async () => {
    const { result, rerender } = search('');
    expect(result.current.status).toBe('idle');
    rerender({ q: ' a ' });
    expect(result.current.status).toBe('idle');
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(loadEmbedder).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(result.current.scores.size).toBe(0);
  });

  it('reports loading until the model is ready, then returns scores', async () => {
    let finishLoad;
    loadEmbedder.mockReturnValue(new Promise(resolve => { finishLoad = resolve; }));
    const { result } = search('comedy');
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(loadEmbedder).toHaveBeenCalled());
    expect(result.current.status).toBe('loading');

    await act(async () => { finishLoad(); });
    await waitFor(() => expect(result.current.scores.get('a')).toBe(0.7));
    expect(result.current.status).toBe('ready');
    expect(embedQuery).toHaveBeenCalledWith('comedy');
    expect(rpc).toHaveBeenCalledWith('match_reels', {
      query_embedding: [0.1, 0.2],
      match_threshold: MATCH_THRESHOLD,
      match_count: MATCH_COUNT,
    });
  });

  it('reports an error when the model cannot load, and retry tries again', async () => {
    loadEmbedder.mockRejectedValueOnce(new Error('offline'));
    const { result } = search('comedy');
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.scores.size).toBe(0);

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.scores.get('a')).toBe(0.7));
    expect(result.current.status).toBe('ready');
    expect(loadEmbedder).toHaveBeenCalledTimes(2);
  });

  it('reports an error when Supabase rejects the lookup', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { result } = search('comedy');
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.scores.size).toBe(0);
  });

  it('hides the previous query\'s scores as soon as the query changes', async () => {
    const { result, rerender } = search('comedy');
    await waitFor(() => expect(result.current.scores.get('a')).toBe(0.7));
    rerender({ q: 'cooking' });
    expect(result.current.scores.size).toBe(0);
    expect(result.current.status).toBe('ready');
  });

  it('drops a slow response for an older query', async () => {
    let finishFirst;
    embedQuery.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }));
    rpc.mockImplementation(async (_fn, args) => ({
      data: [{ id: args.query_embedding[0] === 0.9 ? 'stale' : 'fresh', similarity: 0.8 }],
      error: null,
    }));

    const { result, rerender } = search('comedy');
    await waitFor(() => expect(embedQuery).toHaveBeenCalledWith('comedy'));
    rerender({ q: 'cooking' });
    await waitFor(() => expect(result.current.scores.get('fresh')).toBe(0.8));

    await act(async () => { finishFirst([0.9, 0.9]); });
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(result.current.scores.has('stale')).toBe(false);
    expect(result.current.scores.get('fresh')).toBe(0.8);
  });
});
