import { useState, useRef } from 'react';
import {
  Clapperboard, UploadCloud, FileAudio, FileText, Link,
} from 'lucide-react';
import { queueReelUrl, queueText, queueAudio, queueBulk, FAILURE_STATUSES } from '../queue';

const INGESTION_TABS = [
  { key: 'url', label: 'Reel URL', Icon: Link },
  { key: 'file', label: 'Audio File', Icon: FileAudio },
  { key: 'text', label: 'Transcript Text', Icon: FileText },
  { key: 'bulk', label: 'Bulk Import', Icon: UploadCloud },
];

// Everything is queued for the PC worker; the reel fills in on the dashboard once it has run.
const LOADING_LABELS = {
  url: 'Queuing the reel for your PC worker...',
  file: 'Uploading the audio file...',
  text: 'Queuing the text for your PC worker...',
  bulk: 'Queuing reels from saved_posts.json...',
};

/** Bulk-import progress, read from the reels the dashboard already polls. */
function batchProgress(urls, reels) {
  const statusByUrl = new Map(reels.map(r => [r.url, r.status]));
  let ok = 0;
  let failed = 0;
  for (const url of urls) {
    const status = statusByUrl.get(url);
    if (status === 'done') ok += 1;
    else if (FAILURE_STATUSES.includes(status)) failed += 1;
  }
  return { total: urls.length, done: ok + failed, ok, failed };
}

export default function IngestionPanel({ reels, onIngested, onError, onBatchQueued }) {
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
  const [batchUrls, setBatchUrls] = useState(null);
  const [isBatchDragging, setIsBatchDragging] = useState(false);
  const progress = batchUrls && batchProgress(batchUrls, reels);
  const isBatchRunning = Boolean(progress) && progress.done < progress.total;

  const handleUrlSubmit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;

    onError(null);
    setIsLoading(true);

    try {
      const record = await queueReelUrl(url);
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

    try {
      const record = await queueAudio({ file, title: fileTitle, caption: fileCaption });
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
    onError(null);
    setIsLoading(true);

    try {
      const record = await queueText({ title: textTitle, transcript: textTranscript, caption: textCaption });
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

  const handleBatchSubmit = async (e) => {
    e.preventDefault();
    if (!batchFile) return;
    onError(null);
    let data;
    try {
      data = JSON.parse(await batchFile.text());
    } catch {
      onError('Could not parse uploaded JSON.');
      return;
    }
    setIsLoading(true);
    try {
      const { urls } = await queueBulk(data);
      setBatchUrls(urls);
      onBatchQueued();  // load the newly queued rows so progress can follow them
    } catch (err) {
      onError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

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
          <p className="input-hint">● Queued for your PC worker, which runs every 5 minutes</p>
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

          {progress && (
            <div className="batch-progress">
              <div className="batch-progress-track">
                <div
                  className="batch-progress-fill"
                  style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                />
              </div>
              <p className="batch-progress-status">
                {isBatchRunning ? 'Running' : 'Done'} — {progress.done}/{progress.total} · ok {progress.ok} · failed {progress.failed}
              </p>
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
