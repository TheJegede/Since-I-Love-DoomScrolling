import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import IngestionPanel from '../components/IngestionPanel';

const baseProps = { onIngested: vi.fn(), onError: vi.fn(), onBatchFinished: vi.fn() };

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
});
