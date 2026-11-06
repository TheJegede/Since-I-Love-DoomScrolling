import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const table = vi.hoisted(() => ({ rows: [] }));
vi.mock('../supabaseClient', async (importOriginal) => {
  const { createFakeSupabase } = await import('./fakeSupabase');
  const fake = createFakeSupabase({ getTable: name => (name === 'saved_reels' ? table.rows : undefined) });
  return { ...(await importOriginal()), supabase: fake.client, rowToRecord: (r) => r, __fake: fake };
});

import { __fake as fake } from '../supabaseClient';
import App from '../App';

const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

beforeEach(() => {
  vi.restoreAllMocks();
  table.rows = [];
  fake.tables = { cluster_jobs: [], worker_status: [{ id: 1, last_seen: minutesAgo(1) }] };
  fake.defaults = { cluster_jobs: () => ({ id: crypto.randomUUID(), status: 'pending', created_at: new Date().toISOString() }) };
  fake.session = { user: { id: 'owner' } };
});

describe('App baseline', () => {
  it('renders the header', async () => {
    render(<App />);
    expect(await screen.findByText(/Transcriber/i)).toBeInTheDocument();
    await screen.findByText(/No extractions found/i);
  });

  it('renders the four ingestion mode tabs', async () => {
    render(<App />);
    expect(await screen.findByText(/Reel URL/i)).toBeInTheDocument();
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

  it('queues a pasted URL and opens it as queued', async () => {
    render(<App />);
    await screen.findByText(/No extractions found/i);

    const input = screen.getByPlaceholderText(/instagram\.com\/reel/i);
    fireEvent.change(input, { target: { value: 'https://www.instagram.com/reel/QUEUED1/?igsh=1' } });
    fireEvent.submit(input.closest('form'));

    expect(await screen.findByText('In Ingestion Queue')).toBeInTheDocument();
    expect(screen.getByText('QUEUED →')).toBeInTheDocument();
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({ url: 'https://www.instagram.com/reel/QUEUED1/', status: 'pending', source: 'dashboard' });
  });

  it('opens an already-saved URL instead of queuing it again', async () => {
    table.rows = [{ id: 'q1', url: 'https://www.instagram.com/reel/QUEUED1/', status: 'pending', extracted_json: {}, created_at: minutesAgo(3) }];
    render(<App />);
    await screen.findByText('QUEUED →');

    const input = screen.getByPlaceholderText(/instagram\.com\/reel/i);
    fireEvent.change(input, { target: { value: 'https://www.instagram.com/reel/QUEUED1/' } });
    fireEvent.submit(input.closest('form'));

    expect(await screen.findByText('In Ingestion Queue')).toBeInTheDocument();
    expect(table.rows).toHaveLength(1);
  });

  it('retries a failed reel from the card', async () => {
    table.rows = [{ id: 'f1', title: 'Broken reel', url: 'https://www.instagram.com/reel/F1/', status: 'cookies_expired', error: '403', attempt_count: 3, extracted_json: {}, created_at: minutesAgo(5) }];
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(table.rows[0]).toMatchObject({ status: 'pending', attempt_count: 0, error: null }));
    expect(await screen.findByText('QUEUED →')).toBeInTheDocument();
  });

  it('deletes a reel', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    table.rows = [{ id: 'd1', title: 'Doomed reel', url: 'https://www.instagram.com/reel/D1/', status: 'done', extracted_json: { core_topic: 'x' }, created_at: minutesAgo(5) }];
    render(<App />);
    fireEvent.click(await screen.findByTitle('Delete reel'));
    await waitFor(() => expect(screen.queryByText('Doomed reel')).toBeNull());
    expect(table.rows).toHaveLength(0);
  });

  it('recompute shows Queued, then refreshes when the job is done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    table.rows = [{ id: 'r1', title: 'Some reel', url: 'https://www.instagram.com/reel/R1/', status: 'done', cluster: null, extracted_json: { core_topic: 'x' }, created_at: minutesAgo(5) }];
    try {
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: 'Recompute clusters' }));
      expect(await screen.findByRole('button', { name: 'Queued…' })).toBeDisabled();
      expect(fake.tables.cluster_jobs).toHaveLength(1);

      Object.assign(fake.tables.cluster_jobs[0], { status: 'done', assigned: 1 });
      table.rows[0].cluster = 'Fresh Cluster';
      await vi.advanceTimersByTimeAsync(3000);

      expect(await screen.findByRole('button', { name: 'Recompute clusters' })).toBeEnabled();
      expect(await screen.findByRole('option', { name: /Fresh Cluster/ })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the worker banner when the worker is stale and something is queued', async () => {
    fake.tables.worker_status = [{ id: 1, last_seen: minutesAgo(120) }];
    table.rows = [{ id: 'p1', url: 'https://www.instagram.com/reel/P1/', status: 'pending', extracted_json: {}, created_at: minutesAgo(1) }];
    render(<App />);
    expect(await screen.findByText(/Your PC worker last ran 2 hours ago/)).toBeInTheDocument();
  });

  it('hides the worker banner when the worker ran a minute ago', async () => {
    table.rows = [{ id: 'p1', url: 'https://www.instagram.com/reel/P1/', status: 'pending', extracted_json: {}, created_at: minutesAgo(1) }];
    render(<App />);
    await screen.findByText('QUEUED →');
    await waitFor(() => expect(screen.getByText(/WORKER RAN 1 MINUTE AGO/i)).toBeInTheDocument());
    expect(screen.queryByText(/Your PC worker/)).toBeNull();
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
