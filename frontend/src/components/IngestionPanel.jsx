import { useState } from 'react';
import {
  Clapperboard, UploadCloud, Check,
} from 'lucide-react';

export default function IngestionPanel(props) {
  const {
    mode, setMode, ingestionTabs, isLoading,
    url, setUrl, handleUrlSubmit,
    file, fileTitle, setFileTitle, fileCaption, setFileCaption,
    fileInputRef, handleFileDrop, handleFileSelect, handleFileSubmit,
    textTitle, setTextTitle, textCaption, setTextCaption,
    textTranscript, setTextTranscript, handleTextSubmit,
    batchFile, batchInputRef, handleBatchSelect, handleBatchSubmit,
    isBatchRunning, batchJob,
    currentStep, steps,
  } = props;

  const [isDragging, setIsDragging] = useState(false);
  const [isBatchDragging, setIsBatchDragging] = useState(false);

  return (
    <section className="glass ingestion-panel">
      <div className="ingestion-tabs">
        {ingestionTabs.map(({ key, label, Icon }) => (
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
              {isLoading ? "RUNNING GROQ LLAMA..." : "EXTRACT INSIGHTS"}
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
            onDrop={(e) => { setIsBatchDragging(false); handleFileDrop(e); }} // reusable file drop trigger
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
            {steps.map((s) => (
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
