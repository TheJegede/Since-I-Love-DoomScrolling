import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// supabase null => App falls back to fetch('/reels'); we mock fetch instead.
vi.mock('../supabaseClient', () => ({
  supabase: null,
  rowToRecord: (r) => r,
}));

import App from '../App';

beforeEach(() => {
  vi.restoreAllMocks();
  // /health ok, /reels empty by default
  globalThis.fetch = vi.fn((input) => {
    const u = String(input);
    if (u.endsWith('/health')) return Promise.resolve({ ok: true });
    if (u.includes('/reels')) return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
});

describe('App baseline', () => {
  it('renders the header', () => {
    render(<App />);
    expect(screen.getByText('Transcriber')).toBeInTheDocument();
  });

  it('renders the four ingestion mode tabs', () => {
    render(<App />);
    expect(screen.getByText('Reel URL')).toBeInTheDocument();
    expect(screen.getByText('Audio File')).toBeInTheDocument();
    expect(screen.getByText('Transcript Text')).toBeInTheDocument();
    expect(screen.getByText('Bulk Import')).toBeInTheDocument();
  });

  it('shows the empty state once fetch resolves with no reels', async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByText(/No extractions found/i)).toBeInTheDocument()
    );
  });
});
