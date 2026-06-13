import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReelModal from '../components/ReelModal';

const reel = {
  id: 'r1',
  title: 'My Reel',
  created_at: '2026-06-06T00:00:00Z',
  extracted_json: {
    core_topic: 'AI Tools',
    key_takeaway: 'Automate everything',
    action_items: ['Step one'],
    tools_or_resources: ['Groq'],
  },
};

const noop = () => {};

function renderModal(overrides = {}) {
  return render(
    <ReelModal
      reel={reel}
      onClose={noop}
      formatDate={() => 'Jun 6, 2026'}
      isTranscriptOpen={false}
      setIsTranscriptOpen={noop}
      isCaptionOpen={false}
      setIsCaptionOpen={noop}
      checkedActions={{}}
      toggleCheckAction={noop}
      copiedText={null}
      handleCopy={noop}
      handleDelete={noop}
      {...overrides}
    />
  );
}

describe('ReelModal', () => {
  it('renders title, takeaway, action items and tools', () => {
    renderModal();
    expect(screen.getByText('My Reel')).toBeInTheDocument();
    expect(screen.getByText('Automate everything')).toBeInTheDocument();
    expect(screen.getByText('Step one')).toBeInTheDocument();
    expect(screen.getByText('Groq')).toBeInTheDocument();
  });

  it('calls onClose when the overlay is clicked', () => {
    const onClose = vi.fn();
    const { container } = renderModal({ onClose });
    fireEvent.click(container.querySelector('.modal-overlay'));
    expect(onClose).toHaveBeenCalled();
  });
});
