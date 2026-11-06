import { describe, it, expect } from 'vitest';
import { normalizeInstagramUrl, isValidInstagramReel, parseSavedPosts } from '../instagramUrl';

// Mirrors backend/saved_parser.py and main.is_valid_instagram_reel: change them together.
describe('instagramUrl', () => {
  it('normalizes reel links to the canonical form', () => {
    expect(normalizeInstagramUrl('https://instagram.com/reels/ABC/?igsh=1')).toBe('https://www.instagram.com/reel/ABC/');
    expect(normalizeInstagramUrl('  https://www.instagram.com/reel/A_b-1  ')).toBe('https://www.instagram.com/reel/A_b-1/');
    expect(normalizeInstagramUrl('https://www.instagram.com/p/XYZ/?x=1')).toBe('https://www.instagram.com/p/XYZ/');
    expect(normalizeInstagramUrl('https://google.com/a?b=1')).toBe('https://google.com/a');
    expect(normalizeInstagramUrl('')).toBe('');
  });

  it('accepts only Instagram reel and post links', () => {
    expect(isValidInstagramReel('https://instagram.com/reel/ABC?igsh=1')).toBe(true);
    expect(isValidInstagramReel('https://www.instagram.com/p/XYZ/')).toBe(true);
    expect(isValidInstagramReel('https://google.com')).toBe(false);
    expect(isValidInstagramReel('')).toBe(false);
  });

  it('parses saved posts: reels only, first occurrence wins', () => {
    const sample = [
      { label_values: [
        { label: 'URL', value: 'https://www.instagram.com/reel/AAA/' },
        { label: 'Caption', value: 'hello' },
        { label: 'Title', value: 'T1' }] },
      { label_values: [{ label: 'URL', value: 'https://www.instagram.com/p/BBB/' }, { label: 'Caption', value: 'photo' }] },
      { label_values: [{ label: 'URL', value: 'https://www.instagram.com/reel/AAA/?igsh=xyz' }] },
      { no_labels: true },
    ];
    expect(parseSavedPosts(sample)).toEqual([{ url: 'https://www.instagram.com/reel/AAA/', caption: 'hello', title: 'T1' }]);
    expect(parseSavedPosts({ not: 'a list' })).toEqual([]);
  });
});
