import { useState, useEffect, useRef } from 'react';
import './App.css';
import { supabase, rowToRecord } from './supabaseClient';
import {
  Clapperboard,
  Search,
  FileAudio, 
  FileText, 
  Link, 
  ArrowRight, 
  Clock, 
  ExternalLink, 
  Copy, 
  Check, 
  ChevronDown, 
  ChevronUp, 
  X, 
  AlertTriangle, 
  Database,
  UploadCloud,
  Sparkles,
  Info,
  Trash2
} from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_URL || (window.location.hostname === 'localhost' ? 'http://localhost:8000' : '');

function computeClusters(reels) {
  const counts = {};
  for (const r of reels) {
    const c = r.cluster || 'Unclustered';
    counts[c] = (counts[c] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

export default function App() {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState('url'); // 'url', 'file', 'text'
  const [reels, setReels] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isWakingUp, setIsWakingUp] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [error, setError] = useState(null);
  
  // File upload states
  const [file, setFile] = useState(null);
  const [fileTitle, setFileTitle] = useState('');
  const [fileCaption, setFileCaption] = useState('');
  const fileInputRef = useRef(null);

  // Bulk import (saved_posts.json)
  const batchInputRef = useRef(null);
  const [batchFile, setBatchFile] = useState(null);
  const [batchJob, setBatchJob] = useState(null);
  const [isBatchRunning, setIsBatchRunning] = useState(false);

  // Text inputs states
  const [textTitle, setTextTitle] = useState('');
  const [textCaption, setTextCaption] = useState('');
  const [textTranscript, setTextTranscript] = useState('');

  // Selected reel for detail modal
  const [selectedReel, setSelectedReel] = useState(null);
  const [isTranscriptOpen, setIsTranscriptOpen] = useState(false);
  const [isCaptionOpen, setIsCaptionOpen] = useState(false);
  const [checkedActions, setCheckedActions] = useState({}); // { 'reelId-index': boolean }
  const [copiedText, setCopiedText] = useState(null); // tracking tool/action copy state

  // Tabular view + clustering
  const [clusters, setClusters] = useState([]);          // [{name, count}]
  const [viewMode, setViewMode] = useState('cards');      // 'cards' | 'table'
  const [clusterFilter, setClusterFilter] = useState('All');
  const [toolFilter, setToolFilter] = useState('All');
  const [sortOrder, setSortOrder] = useState('newest');   // 'newest' | 'oldest'
  const [isRecomputing, setIsRecomputing] = useState(false);

  const steps = [
    { num: 1, label: "Server Check" },
    { num: 2, label: "Fetch Video" },
    { num: 3, label: "Audio Extract" },
    { num: 4, label: "Transcribe" },
    { num: 5, label: "Llama Extract" },
    { num: 6, label: "Save DB" }
  ];

  const checkBackendHealth = async () => {
    try {
      setIsWakingUp(true);
      const res = await fetch(`${API_BASE_URL}/health`);
      if (res.ok) {
        setIsWakingUp(false);
      }
    } catch (err) {
      console.log("Backend server is warming up or unreachable", err);
      // Keep waking up state active as a warning
    }
  };

  const fetchReels = async () => {
    try {
      if (supabase) {
        const { data, error } = await supabase
          .from('saved_reels')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(500);
        if (error) throw error;
        const mapped = (data || []).map(rowToRecord);
        setReels(mapped);
        setClusters(computeClusters(mapped));
        return;
      }
      // Fallback: local FastAPI backend
      const response = await fetch(`${API_BASE_URL}/reels?limit=500`);
      if (response.ok) {
        const data = await response.json();
        setReels(data);
        setClusters(computeClusters(data));
      }
    } catch (err) {
      console.error("Error fetching reels", err);
    }
  };

  const fetchClusters = async () => {
    // Clusters are derived from the loaded reels (see fetchReels/computeClusters).
    // Kept as a callable so existing call sites (e.g. after recompute) still work.
  };

  // Fetch reels from Supabase on mount
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchReels();
    fetchClusters();
    checkBackendHealth();
  }, []);

  // While any reel is queued/processing, poll so it fills in once the worker finishes.
  useEffect(() => {
    const anyPending = reels.some(r => r.status && r.status !== 'done' && r.status !== 'failed');
    if (!anyPending) return;
    const id = setInterval(fetchReels, 5000);
    return () => clearInterval(id);
  }, [reels]);

  const handleRecompute = async () => {
    setIsRecomputing(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/clusters/recompute`, { method: 'POST' });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || 'Recompute failed.');
      }
      await fetchReels();
      await fetchClusters();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsRecomputing(false);
    }
  };

  const handleDelete = async (id, e) => {
    if (e) e.stopPropagation();
    if (!window.confirm('Delete this reel? This cannot be undone.')) return;
    try {
      const res = await fetch(`${API_BASE_URL}/reels/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Delete failed.');
      }
      setReels(prev => prev.filter(r => r.id !== id));
      if (selectedReel && selectedReel.id === id) setSelectedReel(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSearchChange = (e) => setSearchQuery(e.target.value);

  const handleUrlSubmit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;

    setError(null);
    setIsLoading(true);
    setCurrentStep(1);

    // Simulate progress updates for visual clarity (FastAPI executes quickly, but scraping takes a few seconds)
    const stepIntervals = [
      { step: 1, delay: 0 },
      { step: 2, delay: 800 },
      { step: 3, delay: 4500 },
      { step: 4, delay: 6500 },
      { step: 5, delay: 8500 },
      { step: 6, delay: 10000 }
    ];

    const progressTimers = stepIntervals.map(({ step, delay }) => {
      return setTimeout(() => setCurrentStep(step), delay);
    });

    try {
      const response = await fetch(`${API_BASE_URL}/extract/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() })
      });

      progressTimers.forEach(clearTimeout);

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.detail || "Pipeline failed during extraction.");
      }

      setCurrentStep(6);
      const data = await response.json();
      
      // Update local reels list and open the new modal
      setReels(prev => [data, ...prev.filter(r => r.url !== data.url)]);
      setSelectedReel(data);
      setUrl('');
      
    } catch (err) {
      setError(err.message);
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
      setError("Please drop a valid audio file.");
    }
  };

  const handleFileSelect = (e) => {
    const selected = e.target.files[0];
    if (selected) setFile(selected);
  };

  const handleFileSubmit = async (e) => {
    e.preventDefault();
    if (!file) return;

    setError(null);
    setIsLoading(true);
    setCurrentStep(3); // Skip scraping and start at audio stage

    const formData = new FormData();
    formData.append('file', file);
    formData.append('title', fileTitle || file.name);
    formData.append('caption', fileCaption);

    try {
      setCurrentStep(4); // Transcribe
      const response = await fetch(`${API_BASE_URL}/extract/file`, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.detail || "Failed to process audio file.");
      }

      setCurrentStep(5); // Structure
      const data = await response.json();
      
      setCurrentStep(6);
      setReels(prev => [data, ...prev]);
      setSelectedReel(data);
      setFile(null);
      setFileTitle('');
      setFileCaption('');
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleTextSubmit = async (e) => {
    e.preventDefault();
    if (!textTranscript.trim() && !textCaption.trim()) {
      setError("Please provide either a transcript or a description caption.");
      return;
    }

    setError(null);
    setIsLoading(true);
    setCurrentStep(5); // Jump straight to LLM extraction

    try {
      const response = await fetch(`${API_BASE_URL}/extract/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: textTitle || "Manual Text Input",
          transcript: textTranscript,
          caption: textCaption
        })
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.detail || "Failed to extract from text.");
      }

      setCurrentStep(6);
      const data = await response.json();
      setReels(prev => [data, ...prev]);
      setSelectedReel(data);
      setTextTitle('');
      setTextCaption('');
      setTextTranscript('');
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleBatchSelect = (e) => {
    const selected = e.target.files[0];
    if (selected) setBatchFile(selected);
  };

  const pollBatchStatus = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/extract/batch/status`);
      if (!res.ok) return;
      const job = await res.json();
      setBatchJob(job);
      if (job.status !== 'running') {
        setIsBatchRunning(false);
        fetchReels();
        fetchClusters();
      }
    } catch (err) {
      console.error("Error polling batch status", err);
    }
  };

  const handleBatchSubmit = async (e) => {
    e.preventDefault();
    if (!batchFile) return;
    setError(null);
    setIsLoading(true);
    const formData = new FormData();
    formData.append('file', batchFile);
    try {
      const res = await fetch(`${API_BASE_URL}/extract/batch`, { method: 'POST', body: formData });
      if (res.status === 409) {
        // a job is already running — attach to it
        setIsBatchRunning(true);
        setIsLoading(false);
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Failed to start batch import.');
      }
      setIsBatchRunning(true);
    } catch (err) {
      setError(err.message);
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

  const handleCopy = (text, key) => {
    navigator.clipboard.writeText(text);
    setCopiedText(key);
    setTimeout(() => setCopiedText(null), 1500);
  };

  const toggleCheckAction = (reelId, index) => {
    const key = `${reelId}-${index}`;
    setCheckedActions(prev => ({
      ...prev,
      [key]: !prev[key]
    }));
  };

  const formatDate = (dateString) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  const allTools = Array.from(
    new Set(reels.flatMap(r => r.extracted_json?.tools_or_resources || []))
  ).sort();

  const filteredReels = reels
    .filter(r => clusterFilter === 'All' || (r.cluster || 'Unclustered') === clusterFilter)
    .filter(r => toolFilter === 'All' || (r.extracted_json?.tools_or_resources || []).includes(toolFilter))
    .filter(r => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      const ej = r.extracted_json || {};
      const hay = [
        r.title, r.raw_transcript, r.post_caption, ej.core_topic, ej.key_takeaway,
        ...(ej.tools_or_resources || []), ...(ej.action_items || [])
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => {
      const da = new Date(a.created_at || 0), db = new Date(b.created_at || 0);
      return sortOrder === 'newest' ? db - da : da - db;
    });

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="logo-container">
          <Clapperboard className="logo-icon" size={36} />
          <span className="logo-text">Transcriber</span>
        </div>
        <p className="app-subtitle">
          Extract structured key insights, tool lists, and checklist action items automatically from educational Instagram Reels.
        </p>
      </header>

      {/* Backend Wake-up Notice */}
      {isWakingUp && (
        <div className="wake-alert">
          <div className="wake-spinner"></div>
          <div>
            <strong>Connecting to local extraction server...</strong> Ingestion and cluster recomputation require the backend to be running locally.
          </div>
        </div>
      )}

      {/* Error Alert */}
      {error && (
        <div className="wake-alert" style={{ background: 'rgba(239, 68, 68, 0.08)', borderColor: 'rgba(239, 68, 68, 0.2)', color: 'hsl(0, 84%, 60%)' }}>
          <AlertTriangle size={18} />
          <div style={{ flex: 1 }}>{error}</div>
          <button onClick={() => setError(null)} style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer' }}>
            <X size={16} />
          </button>
        </div>
      )}

      {/* Extraction Ingestion Panel */}
      <section className="glass ingestion-panel">
        <div style={{ display: 'flex', gap: '1rem', borderBottom: '1px solid var(--glass-border)', paddingBottom: '1rem', marginBottom: '1.5rem' }}>
          <button 
            className={`alt-input-btn ${mode === 'url' ? 'active' : ''}`}
            onClick={() => setMode('url')}
            style={{ borderBottom: mode === 'url' ? '2px solid var(--accent-primary)' : 'none', paddingBottom: '0.5rem', color: mode === 'url' ? 'var(--text-primary)' : 'var(--text-muted)' }}
          >
            <Link size={16} /> Reel URL
          </button>
          <button 
            className={`alt-input-btn ${mode === 'file' ? 'active' : ''}`}
            onClick={() => setMode('file')}
            style={{ borderBottom: mode === 'file' ? '2px solid var(--accent-primary)' : 'none', paddingBottom: '0.5rem', color: mode === 'file' ? 'var(--text-primary)' : 'var(--text-muted)' }}
          >
            <FileAudio size={16} /> Audio File
          </button>
          <button 
            className={`alt-input-btn ${mode === 'text' ? 'active' : ''}`}
            onClick={() => setMode('text')}
            style={{ borderBottom: mode === 'text' ? '2px solid var(--accent-primary)' : 'none', paddingBottom: '0.5rem', color: mode === 'text' ? 'var(--text-primary)' : 'var(--text-muted)' }}
          >
            <FileText size={16} /> Transcript Text
          </button>
          <button 
            className={`alt-input-btn ${mode === 'bulk' ? 'active' : ''}`}
            onClick={() => setMode('bulk')}
            style={{ borderBottom: mode === 'bulk' ? '2px solid var(--accent-primary)' : 'none', paddingBottom: '0.5rem', color: mode === 'bulk' ? 'var(--text-primary)' : 'var(--text-muted)' }}
          >
            <UploadCloud size={16} /> Bulk Import
          </button>
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
                {isLoading ? "Processing..." : "Extract"}
                <ArrowRight size={16} />
              </button>
            </div>
          </form>
        )}

        {mode === 'file' && (
          <form onSubmit={handleFileSubmit}>
            <div 
              className="upload-zone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleFileDrop}
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
                  {isLoading ? "Extracting..." : "Process Audio File"}
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
                style={{ background: 'var(--bg-input)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.8rem', height: '80px', color: 'white', fontFamily: 'inherit', resize: 'vertical' }}
                placeholder="Instagram Post Caption / Description"
                value={textCaption}
                onChange={(e) => setTextCaption(e.target.value)}
              />
              <textarea
                style={{ background: 'var(--bg-input)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.8rem', height: '140px', color: 'white', fontFamily: 'inherit', resize: 'vertical' }}
                placeholder="Audio Transcript (Paste voice transcript if available)"
                value={textTranscript}
                onChange={(e) => setTextTranscript(e.target.value)}
              />
              <button type="submit" className="btn-primary" style={{ alignSelf: 'flex-start' }} disabled={isLoading}>
                {isLoading ? "Running Groq Llama..." : "Extract Insights"}
              </button>
            </div>
          </form>
        )}

        {mode === 'bulk' && (
          <form onSubmit={handleBatchSubmit}>
            <div 
              className="upload-zone"
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
              {isBatchRunning ? "Importing..." : "Start Bulk Import"}
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

      {/* Dashboard Section */}
      <section>
        <div className="dashboard-controls">
          <h2 className="dashboard-title">
            <Database size={20} className="logo-icon" />
            Saved Extracted Insights
          </h2>
          <div className="search-bar">
            <Search size={18} />
            <input 
              type="text" 
              placeholder="Search topics, actions, tools..." 
              value={searchQuery}
              onChange={handleSearchChange}
            />
          </div>
        </div>

        {reels.length > 0 && (
          <div className="controls-bar">
            <div className="view-toggle">
              <button className={viewMode === 'cards' ? 'active' : ''} onClick={() => setViewMode('cards')}>Cards</button>
              <button className={viewMode === 'table' ? 'active' : ''} onClick={() => setViewMode('table')}>Table</button>
            </div>

            <select value={clusterFilter} onChange={e => setClusterFilter(e.target.value)}>
              <option value="All">All clusters</option>
              {clusters.map(c => (
                <option key={c.name} value={c.name}>{c.name} ({c.count})</option>
              ))}
            </select>

            <select value={toolFilter} onChange={e => setToolFilter(e.target.value)}>
              <option value="All">All tools</option>
              {allTools.map(t => <option key={t} value={t}>{t}</option>)}
            </select>

            <select value={sortOrder} onChange={e => setSortOrder(e.target.value)}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>

            {!isWakingUp && (
              <button className="recompute-btn" onClick={handleRecompute} disabled={isRecomputing}>
                {isRecomputing ? 'Clustering…' : 'Recompute clusters'}
              </button>
            )}
          </div>
        )}

        {reels.length === 0 ? (
          <div className="glass empty-state">
            <Sparkles size={48} className="empty-state-icon" style={{ margin: '0 auto 1rem auto' }} />
            <p>No extractions found. Input a Reel URL above to kickstart the autonomous pipeline!</p>
          </div>
        ) : viewMode === 'table' ? (
          <div className="table-scroll">
          <table className="insights-table glass">
            <thead>
              <tr>
                <th>Topic</th><th>Cluster</th><th>Key takeaway</th><th>Tools</th><th>Saved</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filteredReels.map(reel => {
                const ej = reel.extracted_json || {};
                return (
                  <tr key={reel.id} onClick={() => { setSelectedReel(reel); setIsTranscriptOpen(false); setIsCaptionOpen(false); }}>
                    <td>{ej.core_topic || reel.title}</td>
                    <td><span className="cluster-pill">{reel.cluster || 'Unclustered'}</span></td>
                    <td>{ej.key_takeaway}</td>
                    <td>{(ej.tools_or_resources || []).map((t, i) => (
                      <span className="tool-chip" key={i}>{t}</span>
                    ))}</td>
                    <td>{formatDate(reel.created_at) || '—'}</td>
                    <td>
                      <button
                        className="delete-btn"
                        title="Delete reel"
                        onClick={(e) => handleDelete(reel.id, e)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        ) : (
          <div className="reels-grid">
            {filteredReels.map((reel) => {
              const details = reel.extracted_json || {};
              if (reel.status && reel.status !== 'done') {
                return (
                  <article key={reel.id} className="glass reel-card" style={{ opacity: 0.7 }}>
                    <div className="card-header">
                      <span className="card-topic-badge">
                        {reel.status === 'processing' ? 'Processing…' : reel.status === 'failed' ? 'Failed' : 'Queued'}
                      </span>
                      <button className="delete-btn" title="Delete reel" onClick={(e) => handleDelete(reel.id, e)}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                    <h3 className="card-title">{reel.title || 'Queued reel'}</h3>
                    {reel.url && (
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', wordBreak: 'break-all' }}>{reel.url}</p>
                    )}
                  </article>
                );
              }
              return (
                <article
                  key={reel.id}
                  className="glass glass-interactive reel-card"
                  onClick={() => {
                    setSelectedReel(reel);
                    setIsTranscriptOpen(false);
                    setIsCaptionOpen(false);
                  }}
                >
                  <div className="card-header">
                    <span className="card-topic-badge">{details.core_topic || 'Reel Extract'}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span className="card-date">{formatDate(reel.created_at)}</span>
                      <button
                        className="delete-btn"
                        title="Delete reel"
                        onClick={(e) => handleDelete(reel.id, e)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                  <h3 className="card-title">{reel.title || 'Untitled Extraction'}</h3>
                  <p className="card-takeaway">{details.key_takeaway}</p>
                  
                  <div className="card-footer">
                    <div className="stat-item">
                      <Clock size={14} />
                      <span>{details.action_items?.length || 0} tasks</span>
                    </div>
                    <span className="read-more-link">
                      View details <ArrowRight size={14} />
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Reel Detail Modal */}
      {selectedReel && (() => {
        const details = selectedReel.extracted_json || {};
        return (
          <div className="modal-overlay" onClick={() => setSelectedReel(null)}>
            <div className="glass modal-content" onClick={(e) => e.stopPropagation()}>
              <button className="modal-close" onClick={() => setSelectedReel(null)}>
                <X size={24} />
              </button>

              <div className="modal-header-meta">
                <span className="card-topic-badge" style={{ fontSize: '0.8rem', padding: '0.35rem 0.85rem' }}>
                  {details.core_topic}
                </span>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  Processed on {formatDate(selectedReel.created_at)}
                </span>
                {selectedReel.url && (
                  <a 
                    href={selectedReel.url} 
                    target="_blank" 
                    rel="noreferrer" 
                    className="alt-input-btn"
                    style={{ fontSize: '0.85rem' }}
                  >
                    View Original <ExternalLink size={14} />
                  </a>
                )}
                <button
                  className="alt-input-btn delete-btn"
                  style={{ fontSize: '0.85rem' }}
                  onClick={(e) => handleDelete(selectedReel.id, e)}
                >
                  Delete <Trash2 size={14} />
                </button>
              </div>

              <h2 className="modal-title">{selectedReel.title || "Extracted Insights"}</h2>

              {/* Key Takeaway */}
              <div className="modal-section">
                <div className="takeaway-banner">
                  <span style={{ fontWeight: '700', color: 'var(--accent-primary)', display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', textTransform: 'uppercase' }}>
                    Core Key Takeaway
                  </span>
                  {details.key_takeaway}
                </div>
              </div>

              {/* Action items checklist */}
              {details.action_items && details.action_items.length > 0 && (
                <div className="modal-section">
                  <h3 className="modal-section-title">
                    Action Plan / Steps
                  </h3>
                  <div className="action-items-list">
                    {details.action_items.map((item, index) => {
                      const checkKey = `${selectedReel.id}-${index}`;
                      return (
                        <div key={index} className="action-item">
                          <input 
                            type="checkbox" 
                            className="action-checkbox" 
                            checked={!!checkedActions[checkKey]}
                            onChange={() => toggleCheckAction(selectedReel.id, index)}
                          />
                          <span className="action-text">{item}</span>
                          <button 
                            onClick={() => handleCopy(item, `action-${index}`)}
                            style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
                          >
                            {copiedText === `action-${index}` ? <Check size={14} style={{ color: 'var(--accent-success)' }} /> : <Copy size={14} />}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Tools & Resources */}
              {details.tools_or_resources && details.tools_or_resources.length > 0 && (
                <div className="modal-section">
                  <h3 className="modal-section-title">
                    Referenced Tools & Resources
                  </h3>
                  <div className="tools-container">
                    {details.tools_or_resources.map((tool, idx) => (
                      <div key={idx} className="tool-tag">
                        <span>{tool}</span>
                        <button 
                          onClick={() => handleCopy(tool, `tool-${idx}`)}
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}
                        >
                          {copiedText === `tool-${idx}` ? <Check size={12} style={{ color: 'var(--accent-success)' }} /> : <Copy size={12} className="tool-copy-icon" />}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Raw Transcript (Accordion) */}
              {selectedReel.raw_transcript && (
                <div className="modal-section" style={{ marginBottom: '1rem' }}>
                  <div className="transcript-accordion">
                    <button 
                      className="accordion-trigger" 
                      onClick={() => setIsTranscriptOpen(!isTranscriptOpen)}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><FileAudio size={16} /> Voice Transcript</span>
                      {isTranscriptOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </button>
                    {isTranscriptOpen && (
                      <div className="accordion-content">
                        {selectedReel.raw_transcript}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Post Caption (Accordion) */}
              {selectedReel.post_caption && (
                <div className="modal-section" style={{ marginBottom: '0' }}>
                  <div className="transcript-accordion">
                    <button 
                      className="accordion-trigger" 
                      onClick={() => setIsCaptionOpen(!isCaptionOpen)}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><Info size={16} /> Post Caption / Metadata</span>
                      {isCaptionOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </button>
                    {isCaptionOpen && (
                      <div className="accordion-content">
                        {selectedReel.post_caption}
                      </div>
                    )}
                  </div>
                </div>
              )}

            </div>
          </div>
        );
      })()}
    </div>
  );
}
