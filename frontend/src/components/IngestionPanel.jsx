import { useState, useEffect, useRef } from 'react';
import {
  Clapperboard, UploadCloud, FileAudio, FileText, Link,
} from 'lucide-react';
import { API_BASE_URL, fetchWithAuth } from '../api';

const INGESTION_TABS = [
  { key: 'url', label: 'Reel URL', Icon: Link },
  { key: 'file', label: 'Audio File', Icon: FileAudio },
  { key: 'text', label: 'Transcript Text', Icon: FileText },
  { key: 'bulk', label: 'Bulk Import', Icon: UploadCloud },
];

// The backend reports no progress, so say what is happening instead of faking stages.
const LOADING_LABELS = {
  url: 'Downloading, transcribing and extracting. This usually takes under a minute.',
  file: 'Transcribing and extracting insights...',
  text: 'Extracting insights...',
  bulk: 'Uploading saved_posts.json...',
};

// POST to an /extract endpoint and return the saved record.
async function postExtract(path, options, fallbackMessage) {
  const response = await fetchWithAuth(`${API_BASE_URL}${path}`, { method: 'POST', ...options });
  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.detail || fallbackMessage);
  }
  return response.json();
}

export default function IngestionPanel({ onIngested, onError, onBatchFinished }) {
  const [mode, setMode] = useState('url'); // 'url', 'file', 'text', 'bulk'
  const [isLoading, setIsLoading] = useState(false);

  const [url, setUrl] = useState('');

  const [file, setFile] = useState(null);
  const [fileTitle, setFileTitle] = useState('');
  const [fileCaption, setFileCaption] = useState('');
  const fileInputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  const [textTitle, setTextTitle] = useState('');
  const [textCaption, setTextCaption] = useState('');
  const [textTranscript, setTextTranscript] = useState('');

  // Bulk import (saved_posts.json)
  const batchInputRef = useRef(null);
  const [batchFile, setBatchFile] = useState(null);
  const [batchJob, setBatchJob] = useState(null);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [isBatchDragging, setIsBatchDragging] = useState(false);

  const handleUrlSubmit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;

    onError(null);
    setIsLoading(true);

    try {
      const record = await postExtract('/extract/url', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() })
      }, "Pipeline failed during extraction.");
      onIngested(record);
      setUrl('');
    } catch (err) {
      onError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileDrop = (e) => {
    e.preventDefault();
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile && droppedFile.type.startsWith('audio/')) {
      setFile(droppedFile);
    } else {
      onError("Please drop a valid audio file.");
    }
  };

  const handleFileSelect = (e) => {
    const selected = e.target.files[0];
    if (selected) setFile(selected);
  };

  const handleFileSubmit = async (e) => {
    e.preventDefault();
    if (!file) return;

    onError(null);
    setIsLoading(true);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('title', fileTitle || file.name);
    formData.append('caption', fileCaption);

    try {
      const record = await postExtract('/extract/file', { body: formData }, "Failed to process audio file.");
      onIngested(record);
      setFile(null);
      setFileTitle('');
      setFileCaption('');
    } catch (err) {
      onError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleTextSubmit = async (e) => {
    e.preventDefault();
    if (!textTranscript.trim() && !textCaption.trim()) {
      onError("Please provide either a transcript or a description caption.");
      return;
    }

    onError(null);
    setIsLoading(true);

    try {
      const record = await postExtract('/extract/text', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: textTitle || "Manual Text Input",
          transcript: textTranscript,
          caption: textCaption
        })
      }, "Failed to extract from text.");
      onIngested(record);
      setTextTitle('');
      setTextCaption('');
      setTextTranscript('');
    } catch (err) {
      onError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleBatchSelect = (e) => {
    const selected = e.target.files[0];
    if (selected) setBatchFile(selected);
  };

  const handleBatchDrop = (e) => {
    e.preventDefault();
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile && droppedFile.name.toLowerCase().endsWith('.json')) {
      setBatchFile(droppedFile);
    } else {
      onError("Please drop your saved_posts.json file.");
    }
  };

  const pollBatchStatus = async () => {
    try {
      const res = await fetchWithAuth(`${API_BASE_URL}/extract/batch/status`);
      if (!res.ok) return;
      const job = await res.json();
      setBatchJob(job);
      if (job.status !== 'running') {
        setIsBatchRunning(false);
        onBatchFinished();
      }
    } catch (err) {
      console.error("Error polling batch status", err);
    }
  };

  const handleBatchSubmit = async (e) => {
    e.preventDefault();
    if (!batchFile) return;
    onError(null);
    setIsLoading(true);
    const formData = new FormData();
    formData.append('file', batchFile);
    try {
      const res = await fetchWithAuth(`${API_BASE_URL}/extract/batch`, { method: 'POST', body: formData });
      // 409: a job is already running — attach to it
      if (!res.ok && res.status !== 409) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Failed to start batch import.');
      }
      setIsBatchRunning(true);
    } catch (err) {
      onError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!isBatchRunning) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    pollBatchStatus();
    const id = setInterval(pollBatchStatus, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBatchRunning]);

  return (
    <section className="glass ingestion-panel">
      <div className="ingestion-tabs">
        {INGESTION_TABS.map(({ key, label, Icon }) => (
          <button
            key={key}
            className={`ingestion-tab ${mode === key ? 'active' : ''}`}
            onClick={() => setMode(key)}
          >
            <Icon size={16} /> <span>{label.toUpperCase()}</span>
          </button>
        ))}
      </div>

      {/* Input Methods */}
      {mode === 'url' && (
        <form onSubmit={handleUrlSubmit}>
          <div className="input-group">
            <Clapperboard className="input-icon" size={20} />
            <input 
              type="text" 
              className="url-input" 
              placeholder="https://www.instagram.com/reel/C7xY9..." 
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={isLoading}
            />
            <button type="submit" className="btn-primary" disabled={isLoading || !url.trim()}>
              {isLoading ? "PROCESSING..." : "EXTRACT"}
            </button>
          </div>
          <p className="input-hint">● Ready: Paste educational reel link to synthesize metrics</p>
        </form>
      )}

      {mode === 'file' && (
        <form onSubmit={handleFileSubmit}>
          <div 
            className={`upload-zone ${isDragging ? 'dragging' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
            onDrop={(e) => { setIsDragging(false); handleFileDrop(e); }}
            onClick={() => fileInputRef.current.click()}
          >
            <input 
              type="file" 
              ref={fileInputRef} 
              onChange={handleFileSelect} 
              accept="audio/*" 
              className="file-input" 
            />
            <UploadCloud size={40} className="empty-state-icon" />
            {file ? (
              <div>
                <p className="upload-file-name">{file.name}</p>
                <p className="upload-meta">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
              </div>
            ) : (
              <div>
                <p className="upload-prompt">Drag & drop audio file or click to browse</p>
                <p className="upload-meta upload-meta--spaced">MP3, WAV, M4A up to 25MB</p>
              </div>
            )}
          </div>

          {file && (
            <div className="form-stack form-stack--spaced">
              <input 
                type="text" 
                className="url-input field"
                placeholder="Audio Title (e.g. Email Automation tips)"
                value={fileTitle}
                onChange={(e) => setFileTitle(e.target.value)}
              />
              <textarea
                className="url-input field field--caption"
                placeholder="Post Caption Description (Optional metadata helper)"
                value={fileCaption}
                onChange={(e) => setFileCaption(e.target.value)}
              />
              <button type="submit" className="btn-primary btn-start" disabled={isLoading}>
                {isLoading ? "EXTRACTING..." : "PROCESS AUDIO FILE"}
              </button>
            </div>
          )}
        </form>
      )}

      {mode === 'text' && (
        <form onSubmit={handleTextSubmit}>
          <div className="form-stack">
            <input 
              type="text" 
              className="url-input field"
              placeholder="Topic Title (e.g. AI workflows)"
              value={textTitle}
              onChange={(e) => setTextTitle(e.target.value)}
            />
            <textarea
              className="field field--plain field--short"
              placeholder="Instagram Post Caption / Description"
              value={textCaption}
              onChange={(e) => setTextCaption(e.target.value)}
            />
            <textarea
              className="field field--plain field--tall"
              placeholder="Audio Transcript (Paste voice transcript if available)"
              value={textTranscript}
              onChange={(e) => setTextTranscript(e.target.value)}
            />
            <button type="submit" className="btn-primary btn-start" disabled={isLoading}>
              {isLoading ? "RUNNING LLM..." : "EXTRACT INSIGHTS"}
            </button>
          </div>
        </form>
      )}

      {mode === 'bulk' && (
        <form onSubmit={handleBatchSubmit}>
          <div 
            className={`upload-zone ${isBatchDragging ? 'dragging' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setIsBatchDragging(true); }}
            onDragLeave={(e) => { e.preventDefault(); setIsBatchDragging(false); }}
            onDrop={(e) => { setIsBatchDragging(false); handleBatchDrop(e); }}
            onClick={() => batchInputRef.current.click()}
          >
            <input 
              type="file" 
              ref={batchInputRef} 
              onChange={handleBatchSelect} 
              accept="application/json,.json" 
              className="file-input" 
            />
            <UploadCloud size={40} className="empty-state-icon" />
            {batchFile ? (
              <div>
                <p className="upload-file-name">{batchFile.name}</p>
                <p className="upload-meta">{(batchFile.size / 1024).toFixed(0)} KB</p>
              </div>
            ) : (
              <div>
                <p className="upload-prompt">Upload your Instagram saved_posts.json</p>
                <p className="upload-meta upload-meta--spaced">From "Download Your Information" → Saved (JSON). Reels only; photos skipped.</p>
              </div>
            )}
          </div>

          <button type="submit" className="btn-primary btn-start btn-start--spaced" disabled={isLoading || isBatchRunning || !batchFile}>
            {isBatchRunning ? "IMPORTING..." : "START BULK IMPORT"}
          </button>

          {batchJob && (
            <div className="batch-progress">
              <div className="batch-progress-track">
                <div
                  className="batch-progress-fill"
                  style={{ width: `${batchJob.total ? Math.round((batchJob.done / batchJob.total) * 100) : 0}%` }}
                />
              </div>
              <p className="batch-progress-status">
                {batchJob.status === 'running' ? 'Running' : batchJob.status === 'done' ? 'Done' : batchJob.status} — {batchJob.done}/{batchJob.total} · ok {batchJob.ok} · failed {batchJob.failed}
              </p>
              {batchJob.current && batchJob.status === 'running' && (
                <p className="batch-progress-current">Now: {batchJob.current}</p>
              )}
            </div>
          )}
        </form>
      )}

      {isLoading && (
        <div className="progress-container">
          <div className="progress-header">
            <span>{LOADING_LABELS[mode]}</span>
          </div>
          <div className="ingest-progress-track">
            <div className="ingest-progress-fill"></div>
          </div>
        </div>
      )}
    </section>
  );
}
