import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const queueBulk = vi.hoisted(() => vi.fn());
vi.mock('../queue', async (importOriginal) => ({ ...(await importOriginal()), queueBulk }));

import IngestionPanel from '../components/IngestionPanel';

const baseProps = { reels: [], onIngested: vi.fn(), onError: vi.fn(), onBatchQueued: vi.fn() };
const reel = (id, status) => ({ id, url: `https://www.instagram.com/reel/${id}/`, status });

describe('IngestionPanel', () => {
  it('renders all four mode tabs', () => {
    render(<IngestionPanel {...baseProps} />);
    expect(screen.getByText(/Reel URL/i)).toBeInTheDocument();
    expect(screen.getByText(/Bulk Import/i)).toBeInTheDocument();
  });

  it('switches mode when a tab is clicked', () => {
    render(<IngestionPanel {...baseProps} />);
    fireEvent.click(screen.getByText(/Audio File/i));
    expect(screen.getByText(/Drag & drop audio file/i)).toBeInTheDocument();
  });

  it('shows the URL input in url mode', () => {
    render(<IngestionPanel {...baseProps} />);
    expect(screen.getByPlaceholderText(/instagram.com\/reel/i)).toBeInTheDocument();
  });

  it('bulk progress counts come from the reels prop', async () => {
    const urls = ['A', 'B', 'C'].map(id => `https://www.instagram.com/reel/${id}/`);
    queueBulk.mockResolvedValue({ total: 3, enqueued: 2, existing: 1, urls });
    const onBatchQueued = vi.fn();
    const { rerender } = render(<IngestionPanel {...baseProps} onBatchQueued={onBatchQueued} />);

    fireEvent.click(screen.getByText(/Bulk Import/i));
    const file = new File(['[]'], 'saved_posts.json', { type: 'application/json' });
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'START BULK IMPORT' }));

    rerender(<IngestionPanel {...baseProps} onBatchQueued={onBatchQueued} reels={[reel('A', 'done'), reel('B', 'failed'), reel('C', 'pending')]} />);
    expect(await screen.findByText('Running — 2/3 · ok 1 · failed 1')).toBeInTheDocument();
    expect(queueBulk).toHaveBeenCalledWith([]);
    expect(onBatchQueued).toHaveBeenCalledTimes(1);

    rerender(<IngestionPanel {...baseProps} onBatchQueued={onBatchQueued} reels={[reel('A', 'done'), reel('B', 'failed'), reel('C', 'done')]} />);
    expect(screen.getByText('Done — 3/3 · ok 2 · failed 1')).toBeInTheDocument();
  });

  it('says so when the bulk file is not valid JSON', async () => {
    const onError = vi.fn();
    render(<IngestionPanel {...baseProps} onError={onError} />);
    fireEvent.click(screen.getByText(/Bulk Import/i));
    const file = new File(['{oops'], 'saved_posts.json', { type: 'application/json' });
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'START BULK IMPORT' }));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('Could not parse uploaded JSON.'));
  });
});
