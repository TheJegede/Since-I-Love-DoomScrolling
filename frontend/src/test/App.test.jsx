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
    expect(screen.getByText(/Transcriber/i)).toBeInTheDocument();
    await screen.findByText(/No extractions found/i);
  });

  it('renders the four ingestion mode tabs', async () => {
    render(<App />);
    expect(screen.getByText(/Reel URL/i)).toBeInTheDocument();
    expect(screen.getByText(/Audio File/i)).toBeInTheDocument();
    expect(screen.getByText(/Transcript Text/i)).toBeInTheDocument();
    expect(screen.getByText(/Bulk Import/i)).toBeInTheDocument();
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

  it('paginates reels list to 25 items and updates page on clicking Next/Prev', async () => {
    // Generate 30 mock reels
    const mockReels = Array.from({ length: 30 }, (_, i) => ({
      id: `reel_${i}`,
      title: `Reel Title ${i}`,
      url: `https://instagram.com/reel/abc_${i}/`,
      extracted_json: {
        core_topic: `Topic ${i}`,
        key_takeaway: `Takeaway ${i}`,
        action_items: [`Action ${i}`],
        tools_or_resources: [`Tool ${i}`]
      },
      created_at: new Date(2026, 5, 20 - i).toISOString(),
      cluster: 'Unclustered',
      status: 'done'
    }));

    globalThis.fetch = vi.fn((input) => {
      const u = String(input);
      if (u.endsWith('/health')) return Promise.resolve({ ok: true });
      if (u.includes('/reels')) return Promise.resolve({ ok: true, json: () => Promise.resolve(mockReels) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    render(<App />);

    // Wait for the reels to load and check that the first 25 titles are present
    await screen.findByText('Reel Title 0');
    expect(screen.getByText('Reel Title 24')).toBeInTheDocument();
    
    // The 26th title should NOT be present on page 1
    expect(screen.queryByText('Reel Title 25')).toBeNull();

    // Check pagination info
    expect(screen.getByText((content, node) => node.textContent === 'Showing 1–25 of 30 Reels')).toBeInTheDocument();
    expect(screen.getByText((content, node) => node.textContent === 'Page 1 of 2')).toBeInTheDocument();

    // Click 'Next' button
    const nextBtn = screen.getByRole('button', { name: /Next page/i });
    fireEvent.click(nextBtn);

    // Now Reel Title 25 (the 26th item) should be visible, but Reel Title 0 should be gone
    await screen.findByText('Reel Title 25');
    expect(screen.queryByText('Reel Title 0')).toBeNull();
    expect(screen.getByText((content, node) => node.textContent === 'Showing 26–30 of 30 Reels')).toBeInTheDocument();
    expect(screen.getByText((content, node) => node.textContent === 'Page 2 of 2')).toBeInTheDocument();

    // Click 'Prev' button
    const prevBtn = screen.getByRole('button', { name: /Previous page/i });
    fireEvent.click(prevBtn);

    // Page 1 items should be back
    await screen.findByText('Reel Title 0');
    expect(screen.queryByText('Reel Title 25')).toBeNull();
  });
});
