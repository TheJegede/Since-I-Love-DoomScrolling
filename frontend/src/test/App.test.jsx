import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

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
  it('renders the header', async () => {
    render(<App />);
    expect(screen.getByText('Transcriber')).toBeInTheDocument();
    await screen.findByText(/No extractions found/i);
  });

  it('renders the four ingestion mode tabs', async () => {
    render(<App />);
    expect(screen.getByText('Reel URL')).toBeInTheDocument();
    expect(screen.getByText('Audio File')).toBeInTheDocument();
    expect(screen.getByText('Transcript Text')).toBeInTheDocument();
    expect(screen.getByText('Bulk Import')).toBeInTheDocument();
    await screen.findByText(/No extractions found/i);
  });

  it('shows the empty state once fetch resolves with no reels', async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByText(/No extractions found/i)).toBeInTheDocument()
    );
  });

  it('fetchWithAuth prompts for key and retries on 401', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('secret_auth_token');
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    
    let firstPost = true;
    globalThis.fetch = vi.fn((input, options) => {
      const u = String(input);
      if (u.endsWith('/health')) return Promise.resolve({ ok: true });
      if (u.includes('/reels')) return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      if (u.includes('/extract/url')) {
        if (firstPost) {
          firstPost = false;
          return Promise.resolve({ status: 401 });
        }
        // Second post includes header
        expect(options.headers['X-API-Key']).toBe('secret_auth_token');
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            id: 'reel_new',
            title: 'Mocked Title',
            url: 'https://instagram.com/reel/123/',
            extracted_json: {}
          })
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    render(<App />);
    await screen.findByText(/No extractions found/i);

    // Enter URL and submit
    const input = screen.getByPlaceholderText(/instagram\.com\/reel/i);
    const form = input.closest('form');
    
    fireEvent.change(input, { target: { value: 'https://instagram.com/reel/123/' } });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(promptSpy).toHaveBeenCalled();
      expect(setItemSpy).toHaveBeenCalledWith('transcriber_api_key', 'secret_auth_token');
    });
  });
});
