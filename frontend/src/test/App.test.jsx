import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const table = vi.hoisted(() => ({ rows: [] }));
vi.mock('../supabaseClient', async (importOriginal) => ({
  ...(await importOriginal()),
  supabase: (await import('./fakeSupabase')).fakeSupabase(() => table.rows),
  rowToRecord: (r) => r,
}));

import App from '../App';

beforeEach(() => {
  vi.restoreAllMocks();
  table.rows = [];
  globalThis.fetch = vi.fn((input) => {
    const u = String(input);
    if (u.endsWith('/health')) return Promise.resolve({ ok: true });
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

  it('fetchWithAuth forgets a wrong key and says so', async () => {
    const { fetchWithAuth } = await import('../api');
    vi.spyOn(window, 'prompt').mockReturnValue('wrong_key');
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem');
    globalThis.fetch = vi.fn(() => Promise.resolve({ status: 401 }));

    await expect(fetchWithAuth('/clusters/recompute', { method: 'POST' })).rejects.toThrow(/Wrong API key/);
    expect(removeItemSpy).toHaveBeenCalledWith('transcriber_api_key');
    expect(localStorage.getItem('transcriber_api_key')).toBeNull();
    expect(setItemSpy).toHaveBeenCalledTimes(1);
  });

  it('fetchWithAuth asks once when two requests need the key at the same time', async () => {
    const { fetchWithAuth } = await import('../api');
    localStorage.removeItem('transcriber_api_key');
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('good_key');
    globalThis.fetch = vi.fn((url, options) =>
      Promise.resolve({ status: options.headers?.['X-API-Key'] === 'good_key' ? 200 : 401 }));

    const results = await Promise.all([fetchWithAuth('/a', {}), fetchWithAuth('/b', {})]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    expect(promptSpy).toHaveBeenCalledTimes(1);
    localStorage.removeItem('transcriber_api_key');
  });

  it('shows the queue banner when the submitted URL is already queued', async () => {
    globalThis.fetch = vi.fn((input) => {
      const u = String(input);
      if (u.endsWith('/health')) return Promise.resolve({ ok: true });
      if (u.includes('/extract/url')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            id: 'reel_queued',
            title: null,
            url: 'https://www.instagram.com/reel/QUEUED1/',
            extracted_json: {},
            status: 'pending',
            error: null
          })
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    render(<App />);
    await screen.findByText(/No extractions found/i);

    const input = screen.getByPlaceholderText(/instagram\.com\/reel/i);
    fireEvent.change(input, { target: { value: 'https://www.instagram.com/reel/QUEUED1/' } });
    fireEvent.submit(input.closest('form'));

    expect(await screen.findByText('In Ingestion Queue')).toBeInTheDocument();
    expect(screen.getByText('QUEUED →')).toBeInTheDocument();
  });

  it('polls for new reels, fills in queued ones, and drops queued ones deleted elsewhere', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const row = (id, title, status, day) => ({
      id, title, status, url: `https://www.instagram.com/reel/${id}/`, cluster: 'Unclustered',
      created_at: new Date(Date.UTC(2026, 5, day)).toISOString(),
      extracted_json: status === 'done' ? { core_topic: `${title} topic`, key_takeaway: '', action_items: [], tools_or_resources: [] } : {},
    });
    table.rows = [row('old', 'Old reel', 'done', 1), row('queued', null, 'pending', 2), row('gone', null, 'pending', 3)];
    try {
      render(<App />);
      await screen.findByText('Old reel');

      table.rows = [row('old', 'Old reel', 'done', 1), row('queued', 'Finished reel', 'done', 2), row('new', 'Shared from phone', 'pending', 4)];
      await vi.advanceTimersByTimeAsync(5000);

      expect(await screen.findByText('Finished reel')).toBeInTheDocument();
      expect(screen.getByText('Shared from phone')).toBeInTheDocument();
      expect(screen.getAllByText('QUEUED →')).toHaveLength(1);  // only 'new'; 'gone' was dropped
    } finally {
      vi.useRealTimers();
    }
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
    table.rows = mockReels;

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
