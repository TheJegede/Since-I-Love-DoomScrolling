import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

const useSemanticSearch = vi.hoisted(() => vi.fn());
vi.mock('../supabaseClient', async (importOriginal) => ({
  ...(await importOriginal()),
  supabase: (await import('./fakeSupabase')).fakeSupabase(() => REELS),
  rowToRecord: (r) => r,
}));
vi.mock('../semanticSearch', async (importOriginal) => ({
  ...(await importOriginal()),
  useSemanticSearch,
}));

import App from '../App';

const reel = (id, title, topic, daysAgo) => ({
  id,
  title,
  url: `https://instagram.com/reel/${id}/`,
  status: 'done',
  cluster: 'Unclustered',
  created_at: new Date(Date.UTC(2026, 5, 20 - daysAgo)).toISOString(),
  extracted_json: { core_topic: topic, key_takeaway: `${topic} takeaway`, action_items: [], tools_or_resources: [] },
});
const REELS = [
  reel('skit', 'Airline food roast', 'Stand-up routine', 0),
  reel('comedy', 'Open mic night', 'Comedy writing', 1),
  reel('ai', 'Prompt tricks', 'AI tools', 2),
];
const smart = (overrides = {}) => ({ status: 'idle', scores: new Map(), retry: vi.fn(), ...overrides });
const cardTitles = () => [...document.querySelectorAll('.card-title')].map(el => el.textContent);

async function searchFor(text) {
  render(<App />);
  await screen.findByText('Airline food roast');
  fireEvent.change(screen.getByLabelText('Search'), { target: { value: text } });
}

beforeEach(() => {
  useSemanticSearch.mockReset().mockReturnValue(smart());
});

describe('App search', () => {
  it('passes the search text to smart search', async () => {
    await searchFor('comedy');
    expect(useSemanticSearch).toHaveBeenLastCalledWith('comedy');
  });

  it('shows only exact-word matches, with no status line, when smart search is idle', async () => {
    await searchFor('comedy');
    expect(cardTitles()).toEqual(['Open mic night']);
    expect(screen.queryByText(/Smart search/)).toBeNull();
    expect(screen.queryByText('Related')).toBeNull();
  });

  it('lists meaning matches after exact matches and tags them Related', async () => {
    useSemanticSearch.mockReturnValue(smart({ status: 'ready', scores: new Map([['skit', 0.62]]) }));
    await searchFor('comedy');
    expect(cardTitles()).toEqual(['Open mic night', 'Airline food roast']);
    expect(screen.getAllByText('Related')).toHaveLength(1);
    const skitCard = screen.getByText('Airline food roast').closest('article');
    expect(within(skitCard).getByText('Related')).toBeInTheDocument();
  });

  it('tags meaning matches in the table view too', async () => {
    useSemanticSearch.mockReturnValue(smart({ status: 'ready', scores: new Map([['skit', 0.62]]) }));
    await searchFor('comedy');
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    const skitRow = screen.getByText('Stand-up routine').closest('tr');
    expect(within(skitRow).getByText('Related')).toBeInTheDocument();
    expect(screen.getAllByText('Related')).toHaveLength(1);
  });

  it('says so while the model is still downloading and keeps exact matches', async () => {
    useSemanticSearch.mockReturnValue(smart({ status: 'loading' }));
    await searchFor('comedy');
    expect(screen.getByText('Smart search loading… showing exact matches for now')).toBeInTheDocument();
    expect(cardTitles()).toEqual(['Open mic night']);
  });

  it('says smart search is unavailable and offers a retry', async () => {
    const retry = vi.fn();
    useSemanticSearch.mockReturnValue(smart({ status: 'error', retry }));
    await searchFor('comedy');
    expect(screen.getByText(/Smart search unavailable — showing exact matches only/)).toBeInTheDocument();
    expect(cardTitles()).toEqual(['Open mic night']);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('ranks transcript matches as word matches and flags a failed transcript search', async () => {
    useSemanticSearch.mockReturnValue(smart({ status: 'ready', textIds: new Set(['ai']), transcriptsFailed: false }));
    await searchFor('heckler');
    expect(cardTitles()).toEqual(['Prompt tricks']);
    expect(screen.queryByText('Related')).toBeNull();

    useSemanticSearch.mockReturnValue(smart({ status: 'ready', transcriptsFailed: true }));
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'hecklers' } });
    expect(screen.getByText(/Transcript search unavailable/)).toBeInTheDocument();
  });

  it('disables date ordering only while searching', async () => {
    await searchFor('comedy');
    expect(screen.getByLabelText('Order by date')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: '' } });
    expect(screen.getByLabelText('Order by date')).toBeEnabled();
    expect(cardTitles()).toEqual(['Airline food roast', 'Open mic night', 'Prompt tricks']);
  });
});
