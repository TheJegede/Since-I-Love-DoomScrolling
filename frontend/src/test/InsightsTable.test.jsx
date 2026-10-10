import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import InsightsTable from '../components/InsightsTable';

const reels = [
  {
    id: 'r1',
    title: 'Fallback Title',
    cluster: 'AI Tools',
    created_at: '2026-06-06T00:00:00Z',
    extracted_json: { core_topic: 'Topic A', key_takeaway: 'Takeaway A', tools_or_resources: ['Groq'] },
  },
];

describe('InsightsTable', () => {
  it('renders a row per reel with topic, cluster and tools', () => {
    render(<InsightsTable reels={reels} onSelect={() => {}} handleDelete={() => {}} />);
    expect(screen.getByText('Topic A')).toBeInTheDocument();
    expect(screen.getByText('AI Tools')).toBeInTheDocument();
    expect(screen.getByText('Groq')).toBeInTheDocument();
  });

  it('calls onSelect when a row is clicked', () => {
    const onSelect = vi.fn();
    render(<InsightsTable reels={reels} onSelect={onSelect} handleDelete={() => {}} />);
    fireEvent.click(screen.getByText('Topic A'));
    expect(onSelect).toHaveBeenCalledWith(reels[0]);
  });

  it('shows a Related tag only for meaning matches', () => {
    const { rerender } = render(<InsightsTable reels={reels} onSelect={() => {}} handleDelete={() => {}} />);
    expect(screen.queryByText('Related')).toBeNull();
    rerender(<InsightsTable reels={reels} relatedIds={new Set(['r1'])} onSelect={() => {}} handleDelete={() => {}} />);
    expect(screen.getByText('Related')).toBeInTheDocument();
  });
});
