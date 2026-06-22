import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { Link, FileAudio, FileText, UploadCloud } from 'lucide-react';
import IngestionPanel from '../components/IngestionPanel';

const tabs = [
  { key: 'url', label: 'Reel URL', Icon: Link },
  { key: 'file', label: 'Audio File', Icon: FileAudio },
  { key: 'text', label: 'Transcript Text', Icon: FileText },
  { key: 'bulk', label: 'Bulk Import', Icon: UploadCloud },
];

const baseProps = {
  mode: 'url', setMode: vi.fn(), ingestionTabs: tabs, isLoading: false,
  url: '', setUrl: vi.fn(), handleUrlSubmit: vi.fn((e) => e.preventDefault()),
  file: null, setFile: vi.fn(), fileTitle: '', setFileTitle: vi.fn(),
  fileCaption: '', setFileCaption: vi.fn(), fileInputRef: createRef(),
  handleFileDrop: vi.fn(), handleFileSelect: vi.fn(), handleFileSubmit: vi.fn(),
  textTitle: '', setTextTitle: vi.fn(), textCaption: '', setTextCaption: vi.fn(),
  textTranscript: '', setTextTranscript: vi.fn(), handleTextSubmit: vi.fn(),
  batchFile: null, batchInputRef: createRef(), handleBatchSelect: vi.fn(),
  handleBatchSubmit: vi.fn(), isBatchRunning: false, batchJob: null,
  currentStep: 1, steps: [{ num: 1, label: 'Server Check' }],
};

describe('IngestionPanel', () => {
  it('renders all four mode tabs', () => {
    render(<IngestionPanel {...baseProps} />);
    expect(screen.getByText(/Reel URL/i)).toBeInTheDocument();
    expect(screen.getByText(/Bulk Import/i)).toBeInTheDocument();
  });

  it('switches mode when a tab is clicked', () => {
    const setMode = vi.fn();
    render(<IngestionPanel {...baseProps} setMode={setMode} />);
    fireEvent.click(screen.getByText(/Audio File/i));
    expect(setMode).toHaveBeenCalledWith('file');
  });

  it('shows the URL input in url mode', () => {
    render(<IngestionPanel {...baseProps} />);
    expect(screen.getByPlaceholderText(/instagram.com\/reel/i)).toBeInTheDocument();
  });
});
