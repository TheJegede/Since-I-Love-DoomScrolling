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
    render(<InsightsTable reels={reels} onSelect={() => {}} formatDate={() => 'Jun 6'} handleDelete={() => {}} />);
    expect(screen.getByText('Topic A')).toBeInTheDocument();
    expect(screen.getByText('AI Tools')).toBeInTheDocument();
    expect(screen.getByText('Groq')).toBeInTheDocument();
  });

  it('calls onSelect when a row is clicked', () => {
    const onSelect = vi.fn();
    render(<InsightsTable reels={reels} onSelect={onSelect} formatDate={() => 'Jun 6'} handleDelete={() => {}} />);
    fireEvent.click(screen.getByText('Topic A'));
    expect(onSelect).toHaveBeenCalledWith(reels[0]);
  });
});
