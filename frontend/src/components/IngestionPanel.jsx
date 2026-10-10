import { useState, useEffect, useRef } from 'react';
import {
  Clapperboard, UploadCloud, Check, FileAudio, FileText, Link,
} from 'lucide-react';
import { API_BASE_URL, fetchWithAuth } from '../api';

const INGESTION_TABS = [
  { key: 'url', label: 'Reel URL', Icon: Link },
  { key: 'file', label: 'Audio File', Icon: FileAudio },
  { key: 'text', label: 'Transcript Text', Icon: FileText },
  { key: 'bulk', label: 'Bulk Import', Icon: UploadCloud },
];

const STEPS = [
  { num: 1, label: "Server Check" },
  { num: 2, label: "Fetch Video" },
  { num: 3, label: "Audio Extract" },
  { num: 4, label: "Transcribe" },
  { num: 5, label: "LLM Extract" },
  { num: 6, label: "Save DB" }
];

// Simulated stage timings for the URL pipeline: the backend reports no progress.
const URL_STEP_DELAYS = [
  { step: 1, delay: 0 },
  { step: 2, delay: 800 },
  { step: 3, delay: 4500 },
  { step: 4, delay: 6500 },
  { step: 5, delay: 8500 },
  { step: 6, delay: 10000 }
];

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
  const [currentStep, setCurrentStep] = useState(1);

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
    setCurrentStep(1);
    const progressTimers = URL_STEP_DELAYS.map(({ step, delay }) => setTimeout(() => setCurrentStep(step), delay));

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
      progressTimers.forEach(clearTimeout);
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
    setCurrentStep(4); // Skip scraping: straight to transcription

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
    setCurrentStep(5); // Jump straight to LLM extraction

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
              style={{ display: 'none' }} 
            />
            <UploadCloud size={40} className="empty-state-icon" style={{ margin: '0 auto 1rem auto' }} />
            {file ? (
              <div>
                <p style={{ fontWeight: '600', color: 'var(--accent-primary)' }}>{file.name}</p>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{(file.size / 1024 / 1024).toFixed(2)} MB</p>
              </div>
            ) : (
              <div>
                <p style={{ fontWeight: '600' }}>Drag & drop audio file or click to browse</p>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>MP3, WAV, M4A up to 25MB</p>
              </div>
            )}
          </div>

          {file && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.5rem' }}>
              <input 
                type="text" 
                className="url-input" 
                style={{ background: 'var(--bg-input)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.8rem' }}
                placeholder="Audio Title (e.g. Email Automation tips)"
                value={fileTitle}
                onChange={(e) => setFileTitle(e.target.value)}
              />
              <textarea
                className="url-input"
                style={{ background: 'var(--bg-input)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.8rem', minHeight: '80px' }}
                placeholder="Post Caption Description (Optional metadata helper)"
                value={fileCaption}
                onChange={(e) => setFileCaption(e.target.value)}
              />
              <button type="submit" className="btn-primary" style={{ alignSelf: 'flex-start' }} disabled={isLoading}>
                {isLoading ? "EXTRACTING..." : "PROCESS AUDIO FILE"}
              </button>
            </div>
          )}
        </form>
      )}

      {mode === 'text' && (
        <form onSubmit={handleTextSubmit}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <input 
              type="text" 
              className="url-input" 
              style={{ background: 'var(--bg-input)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.8rem' }}
              placeholder="Topic Title (e.g. AI workflows)"
              value={textTitle}
              onChange={(e) => setTextTitle(e.target.value)}
            />
            <textarea
              style={{ background: 'var(--bg-input)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.8rem', height: '80px', color: 'var(--text-primary)', fontFamily: 'inherit', resize: 'vertical' }}
              placeholder="Instagram Post Caption / Description"
              value={textCaption}
              onChange={(e) => setTextCaption(e.target.value)}
            />
            <textarea
              style={{ background: 'var(--bg-input)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.8rem', height: '140px', color: 'var(--text-primary)', fontFamily: 'inherit', resize: 'vertical' }}
              placeholder="Audio Transcript (Paste voice transcript if available)"
              value={textTranscript}
              onChange={(e) => setTextTranscript(e.target.value)}
            />
            <button type="submit" className="btn-primary" style={{ alignSelf: 'flex-start' }} disabled={isLoading}>
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
              style={{ display: 'none' }} 
            />
            <UploadCloud size={40} className="empty-state-icon" style={{ margin: '0 auto 1rem auto' }} />
            {batchFile ? (
              <div>
                <p style={{ fontWeight: '600', color: 'var(--accent-primary)' }}>{batchFile.name}</p>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{(batchFile.size / 1024).toFixed(0)} KB</p>
              </div>
            ) : (
              <div>
                <p style={{ fontWeight: '600' }}>Upload your Instagram saved_posts.json</p>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>From "Download Your Information" → Saved (JSON). Reels only; photos skipped.</p>
              </div>
            )}
          </div>

          <button type="submit" className="btn-primary" style={{ alignSelf: 'flex-start', marginTop: '1rem' }} disabled={isLoading || isBatchRunning || !batchFile}>
            {isBatchRunning ? "IMPORTING..." : "START BULK IMPORT"}
          </button>

          {batchJob && (
            <div style={{ marginTop: '1.5rem' }}>
              <div style={{ height: '8px', background: 'var(--bg-input)', borderRadius: '4px', overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${batchJob.total ? Math.round((batchJob.done / batchJob.total) * 100) : 0}%`,
                  background: 'var(--accent-primary)',
                  transition: 'width 0.4s ease'
                }} />
              </div>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                {batchJob.status === 'running' ? 'Running' : batchJob.status === 'done' ? 'Done' : batchJob.status} — {batchJob.done}/{batchJob.total} · ok {batchJob.ok} · failed {batchJob.failed}
              </p>
              {batchJob.current && batchJob.status === 'running' && (
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', wordBreak: 'break-all' }}>Now: {batchJob.current}</p>
              )}
            </div>
          )}
        </form>
      )}

      {/* Progress Timeline Tracker */}
      {isLoading && (
        <div className="progress-container">
          <div className="progress-header">
            <span>Pipeline Stage Executing:</span>
            <span style={{ color: 'var(--accent-primary)' }}>Stage {currentStep} of 6</span>
          </div>
          <div className="step-tracker">
            {STEPS.map((s) => (
              <div 
                key={s.num} 
                className={`step ${currentStep === s.num ? 'active' : ''} ${currentStep > s.num ? 'completed' : ''}`}
              >
                <div className="step-node">
                  {currentStep > s.num ? <Check size={16} /> : s.num}
                </div>
                <span className="step-label">{s.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
