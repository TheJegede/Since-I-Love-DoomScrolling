import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReelCard from '../components/ReelCard';

const doneReel = {
  id: 'r1',
  title: 'Done Reel',
  status: 'done',
  created_at: '2026-06-06T00:00:00Z',
  extracted_json: { core_topic: 'Topic', key_takeaway: 'Takeaway', action_items: ['a', 'b'] },
};

const pendingReel = { id: 'r2', title: 'Queued Reel', status: 'processing', url: 'https://x/reel/1/' };

describe('ReelCard', () => {
  it('renders a full card for done reels and fires onSelect', () => {
    const onSelect = vi.fn();
    render(<ReelCard reel={doneReel} onSelect={onSelect} formatDate={() => 'Jun 6'} handleDelete={() => {}} />);
    expect(screen.getByText('Done Reel')).toBeInTheDocument();
    expect(screen.getByText('2 tasks')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Done Reel'));
    expect(onSelect).toHaveBeenCalledWith(doneReel);
  });

  it('renders a status placeholder for non-done reels', () => {
    render(<ReelCard reel={pendingReel} onSelect={() => {}} formatDate={() => ''} handleDelete={() => {}} />);
    expect(screen.getByText('Processing…')).toBeInTheDocument();
    expect(screen.getByText('Queued Reel')).toBeInTheDocument();
  });
});
