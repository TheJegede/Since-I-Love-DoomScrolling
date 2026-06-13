import { useState, useEffect, useRef } from 'react';
import './App.css';
import { supabase, rowToRecord } from './supabaseClient';
import { Skeleton, TableSkeleton } from './components/Skeletons';
import ReelModal from './components/ReelModal';
import InsightsTable from './components/InsightsTable';
import ReelCard from './components/ReelCard';
import IngestionPanel from './components/IngestionPanel';
import {
  Clapperboard,
  Search,
  FileAudio, 
  FileText, 
  Link, 
  X, 
  AlertTriangle, 
  Database,
  UploadCloud,
  Sparkles
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
  const [isFetching, setIsFetching] = useState(true);
  const [isWakingUp, setIsWakingUp] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [error, setError] = useState(null);
  
  // File upload states
  const [file, setFile] = useState(null);
  const [fileTitle, setFileTitle] = useState('');
  const [fileCaption, setFileCaption] = useState('');
  const fileInputRef = useRef(null);
  const anyPendingRef = useRef(false);

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

  const ingestionTabs = [
    { key: 'url', label: 'Reel URL', Icon: Link },
    { key: 'file', label: 'Audio File', Icon: FileAudio },
    { key: 'text', label: 'Transcript Text', Icon: FileText },
    { key: 'bulk', label: 'Bulk Import', Icon: UploadCloud },
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
    } finally {
      setIsFetching(false);
    }
  };

  // Fetch reels from Supabase on mount
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchReels();
    checkBackendHealth();
  }, []);

  // Keep a ref of whether any reel is still queued/processing, so the polling
  // interval below can read the latest value without being torn down each change.
  useEffect(() => {
    anyPendingRef.current = reels.some(r => r.status && r.status !== 'done' && r.status !== 'failed');
  }, [reels]);

  // While any reel is queued/processing, poll so it fills in once the worker finishes.
  // A single stable interval reads the latest pending state from a ref each tick.
  useEffect(() => {
    const id = setInterval(() => {
      if (anyPendingRef.current) fetchReels();
    }, 5000);
    return () => clearInterval(id);
  }, []);

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
          <div className="wake-pulse"></div>
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
      <IngestionPanel
        mode={mode} setMode={setMode} ingestionTabs={ingestionTabs} isLoading={isLoading}
        url={url} setUrl={setUrl} handleUrlSubmit={handleUrlSubmit}
        file={file} setFile={setFile} fileTitle={fileTitle} setFileTitle={setFileTitle}
        fileCaption={fileCaption} setFileCaption={setFileCaption} fileInputRef={fileInputRef}
        handleFileDrop={handleFileDrop} handleFileSelect={handleFileSelect} handleFileSubmit={handleFileSubmit}
        textTitle={textTitle} setTextTitle={setTextTitle} textCaption={textCaption} setTextCaption={setTextCaption}
        textTranscript={textTranscript} setTextTranscript={setTextTranscript} handleTextSubmit={handleTextSubmit}
        batchFile={batchFile} batchInputRef={batchInputRef} handleBatchSelect={handleBatchSelect}
        handleBatchSubmit={handleBatchSubmit} isBatchRunning={isBatchRunning} batchJob={batchJob}
        currentStep={currentStep} steps={steps}
      />

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

        {isFetching ? (
          viewMode === 'table' ? (
            <TableSkeleton />
          ) : (
            <div className="reels-grid">
              {[1, 2, 3, 4, 5, 6].map(i => <Skeleton key={i} />)}
            </div>
          )
        ) : reels.length === 0 ? (
          <div className="glass empty-state">
            <Sparkles size={48} className="empty-state-icon" style={{ margin: '0 auto 1rem auto' }} />
            <p>No extractions found. Input a Reel URL above to kickstart the autonomous pipeline!</p>
          </div>
        ) : viewMode === 'table' ? (
          <InsightsTable
            reels={filteredReels}
            onSelect={(reel) => { setSelectedReel(reel); setIsTranscriptOpen(false); setIsCaptionOpen(false); }}
            formatDate={formatDate}
            handleDelete={handleDelete}
          />
        ) : (
          <div className="reels-grid">
            {filteredReels.map((reel) => (
              <ReelCard
                key={reel.id}
                reel={reel}
                onSelect={(r) => { setSelectedReel(r); setIsTranscriptOpen(false); setIsCaptionOpen(false); }}
                formatDate={formatDate}
                handleDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </section>

      {/* Reel Detail Modal */}
      {selectedReel && (
        <ReelModal
          reel={selectedReel}
          onClose={() => setSelectedReel(null)}
          formatDate={formatDate}
          isTranscriptOpen={isTranscriptOpen}
          setIsTranscriptOpen={setIsTranscriptOpen}
          isCaptionOpen={isCaptionOpen}
          setIsCaptionOpen={setIsCaptionOpen}
          checkedActions={checkedActions}
          toggleCheckAction={toggleCheckAction}
          copiedText={copiedText}
          handleCopy={handleCopy}
          handleDelete={handleDelete}
        />
      )}
    </div>
  );
}
