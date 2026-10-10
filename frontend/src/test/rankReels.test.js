import { describe, it, expect } from 'vitest';
import { rankReels } from '../semanticSearch';

const reel = (id, topic, extra = {}) => ({
  id,
  title: `Title ${id}`,
  extracted_json: { core_topic: topic, key_takeaway: '', action_items: [], tools_or_resources: [], ...extra },
});
const ids = (result) => result.reels.map(r => r.id);
const NONE = new Map();

describe('rankReels', () => {
  const reels = [
    reel('a', 'Stand-up routine'),
    reel('b', 'Comedy writing'),
    reel('c', 'AI tools'),
    reel('d', 'Comedy podcast'),
  ];

  it('returns every reel untouched for an empty or whitespace query', () => {
    expect(rankReels(reels, '', NONE).reels).toBe(reels);
    expect(rankReels(reels, '   ', new Map([['a', 0.9]])).reels).toBe(reels);
    expect(rankReels(reels, '', NONE).relatedIds.size).toBe(0);
  });

  it('keeps exact-word matches in their original order when there are no scores', () => {
    const result = rankReels(reels, 'COMEDY ', NONE);
    expect(ids(result)).toEqual(['b', 'd']);
    expect(result.relatedIds.size).toBe(0);
  });

  it('searches title, takeaway, tools and action items', () => {
    const rich = [
      reel('t', 'x', { tools_or_resources: ['Notion'] }),
      reel('k', 'x', { key_takeaway: 'Use notion daily' }),
      reel('n', 'x', { action_items: ['Open Notion'] }),
      reel('z', 'x'),
    ];
    expect(ids(rankReels(rich, 'notion', NONE))).toEqual(['t', 'k', 'n']);
    expect(ids(rankReels(rich, 'title z', NONE))).toEqual(['z']);
  });

  it('adds meaning-only matches after exact matches and flags them as related', () => {
    const result = rankReels(reels, 'comedy', new Map([['a', 0.95], ['b', 0.4]]));
    expect(ids(result)).toEqual(['b', 'd', 'a']);
    expect([...result.relatedIds]).toEqual(['a']);
  });

  it('orders exact matches by closeness when both have scores', () => {
    const result = rankReels(reels, 'comedy', new Map([['b', 0.4], ['d', 0.8]]));
    expect(ids(result)).toEqual(['d', 'b']);
  });

  it('ignores scores for reels that are not loaded', () => {
    const result = rankReels(reels, 'comedy', new Map([['ghost', 0.99]]));
    expect(ids(result)).toEqual(['b', 'd']);
  });
});
