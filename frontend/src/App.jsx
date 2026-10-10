import { useState, useEffect, useRef } from 'react';
import './App.css';
import { supabase, rowToRecord } from './supabaseClient';
import { API_BASE_URL, fetchWithAuth } from './api';
import { Skeleton, TableSkeleton } from './components/Skeletons';
import ReelModal from './components/ReelModal';
import InsightsTable from './components/InsightsTable';
import ReelCard from './components/ReelCard';
import IngestionPanel from './components/IngestionPanel';
import {
  Clapperboard,
  Search,
  X,
  AlertTriangle,
  Database,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  Sun,
  Moon
} from 'lucide-react';

const ITEMS_PER_PAGE = 25;

// Supabase caps rows per request, so page through until the whole library is loaded.
async function fetchAllReelRows() {
  const rows = [];
  for (;;) {
    const { data, error, count } = await supabase
      .from('saved_reels')
      .select('id, url, title, extracted_json, created_at, cluster, status, error', { count: 'exact' })
      .order('created_at', { ascending: false })
      .order('id')
      .range(rows.length, rows.length + 999);
    if (error) throw error;
    rows.push(...data);
    if (!data.length || rows.length >= count) return rows;
  }
}

function computeClusters(reels) {
  const counts = {};
  for (const r of reels) {
    const c = r.cluster || 'Unclustered';
    counts[c] = (counts[c] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => {
      if (a.name === 'Unclustered') return 1;
      if (b.name === 'Unclustered') return -1;
      return a.name.localeCompare(b.name);
    });
}


export default function App() {
  const [reels, setReels] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isFetching, setIsFetching] = useState(true);
  const [isWakingUp, setIsWakingUp] = useState(false);
  const [error, setError] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [theme, setTheme] = useState(() => localStorage.getItem('transcriber_theme') || 'dark');
  const anyPendingRef = useRef(false);

  useEffect(() => {
    document.documentElement.className = theme;
    localStorage.setItem('transcriber_theme', theme);
  }, [theme]);

  const [selectedReel, setSelectedReel] = useState(null);
  const [checkedActions, setCheckedActions] = useState({}); // { 'reelId-index': boolean }

  // Tabular view + clustering
  const [viewMode, setViewMode] = useState('cards');      // 'cards' | 'table'
  const [clusterFilter, setClusterFilter] = useState('All');
  const [toolFilter, setToolFilter] = useState('All');
  const [sortOrder, setSortOrder] = useState('newest');   // 'newest' | 'oldest'
  const [isRecomputing, setIsRecomputing] = useState(false);

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
        const mapped = (await fetchAllReelRows()).map(rowToRecord);
        setReels(mapped);
        return;
      }
      // Fallback: local FastAPI backend
      const response = await fetch(`${API_BASE_URL}/reels?limit=10000`);
      if (response.ok) {
        const data = await response.json();
        setReels(data);
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
    anyPendingRef.current = reels.some(r => r.status === 'pending' || r.status === 'processing');
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
      const res = await fetchWithAuth(`${API_BASE_URL}/clusters/recompute`, { method: 'POST' });
      if (res.status === 409) {
        // Already running, start polling
        startRecomputePolling();
        return;
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || 'Recompute failed.');
      }
      
      startRecomputePolling();
    } catch (err) {
      setError(err.message);
      setIsRecomputing(false);
    }
  };

  const startRecomputePolling = () => {
    const poll = async () => {
      try {
        const res = await fetchWithAuth(`${API_BASE_URL}/clusters/recompute/status`);
        if (!res.ok) return;
        const job = await res.json();
        if (job.status !== 'running') {
          clearInterval(intervalId);
          setIsRecomputing(false);
          if (job.status === 'error') {
            setError(job.error || 'Recompute failed in background.');
          } else {
            await fetchReels();
          }
        }
      } catch (err) {
        console.error("Error polling cluster recompute status", err);
      }
    };

    const intervalId = setInterval(poll, 3000);
    poll(); // run immediately
  };

  const handleDelete = async (id, e) => {
    if (e) e.stopPropagation();
    if (!window.confirm('Delete this reel? This cannot be undone.')) return;
    try {
      const res = await fetchWithAuth(`${API_BASE_URL}/reels/${id}`, { method: 'DELETE' });
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



  const handleRetry = async (id, e) => {
    if (e) e.stopPropagation();
    try {
      const res = await fetchWithAuth(API_BASE_URL + '/reels/' + id + '/retry', { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Retry failed.');
      }
      const updated = { status: 'pending', error: null };
      setReels(prev => prev.map(r => r.id === id ? { ...r, ...updated } : r));
      setSelectedReel(prev => prev && prev.id === id ? { ...prev, ...updated } : prev);
    } catch (err) {
      setError(err.message);
    }
  };
  const handleSelectReel = async (reel) => {
    // Set basic metadata first so the modal opens instantly
    setSelectedReel(reel);
    
    // If we already have the transcript cached locally, skip fetching
    if (reel.raw_transcript !== undefined || reel.post_caption !== undefined) {
      return;
    }

    try {
      let details = null;
      if (supabase) {
        const { data, error } = await supabase
          .from('saved_reels')
          .select('raw_transcript, post_caption')
          .eq('id', reel.id)
          .single();
        if (!error && data) {
          details = data;
        }
      } else {
        const res = await fetchWithAuth(`${API_BASE_URL}/reels/${reel.id}/details`);
        if (res.ok) {
          details = await res.json();
        }
      }
      
      if (details) {
        const fullReel = { ...reel, ...details };
        setSelectedReel(fullReel);
        // Cache full details inside local state list
        setReels(prev => prev.map(r => r.id === reel.id ? fullReel : r));
      }
    } catch (err) {
      console.error("Failed to load reel details", err);
    }
  };

  const handleSearchChange = (e) => {
    setSearchQuery(e.target.value);
    setCurrentPage(1);
  };

  const handleIngested = (record) => {
    setReels(prev => [record, ...prev.filter(r => !record.url || r.url !== record.url)]);
    setSelectedReel(record);
  };

  const toggleCheckAction = (reelId, index) => {
    const key = `${reelId}-${index}`;
    setCheckedActions(prev => ({
      ...prev,
      [key]: !prev[key]
    }));
  };

  const clusters = computeClusters(reels);
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

  const totalPages = Math.ceil(filteredReels.length / ITEMS_PER_PAGE) || 1;
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const paginatedReels = filteredReels.slice(startIndex, endIndex);
  const completedCount = reels.filter(r => !r.status || r.status === 'done').length;
  const activeCount = reels.filter(r => r.status && r.status !== 'done').length;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <div className="logo-container">
            <Clapperboard className="logo-icon" size={32} />
            <h1 className="logo-text">REEL TRANSCRIBER</h1>
          </div>
          <p className="app-subtitle">
            Extract structured key insights, tools, and checklist actions from saved short-form media.
          </p>
        </div>
        <div className="header-meta">
          <span className="system-status">
            <span className="status-dot">●</span> LOCAL CORP V2.0
          </span>
          <button 
            className="theme-toggle-btn" 
            onClick={() => setTheme(prev => prev === 'light' ? 'dark' : 'light')}
            aria-label="Toggle theme"
          >
            {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
            <span>{theme === 'light' ? 'Dark' : 'Light'}</span>
          </button>
        </div>
      </header>

      <div className="workspace-layout">
        <aside className="workspace-rail" aria-label="Insight filters">
          <div className="rail-section rail-summary">
            <span className="control-label">Library</span>
            <strong>{reels.length}</strong>
            <div className="rail-metrics" aria-label="Library status">
              <span>{completedCount} indexed</span>
              <span>{activeCount} active</span>
            </div>
          </div>

          <div className="rail-section">
            <label className="control-label" htmlFor="insight-search">Search</label>
            <div className="search-bar">
              <Search size={18} />
              <input
                id="insight-search"
                type="text"
                placeholder="Search topics, actions, tools..."
                value={searchQuery}
                onChange={handleSearchChange}
              />
            </div>
          </div>

          {reels.length > 0 && (
            <>
              <div className="control-group">
                <label className="control-label" htmlFor="cluster-filter">Cluster tag</label>
                <select id="cluster-filter" value={clusterFilter} onChange={e => { setClusterFilter(e.target.value); setCurrentPage(1); }}>
                  <option value="All">All clusters</option>
                  {clusters.map(c => (
                    <option key={c.name} value={c.name}>{c.name} ({c.count})</option>
                  ))}
                </select>
              </div>

              <div className="control-group">
                <label className="control-label" htmlFor="tool-filter">Tool filter</label>
                <select id="tool-filter" value={toolFilter} onChange={e => { setToolFilter(e.target.value); setCurrentPage(1); }}>
                  <option value="All">All tools</option>
                  {allTools.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>

              <div className="control-group">
                <label className="control-label" htmlFor="sort-order">Order by date</label>
                <select id="sort-order" value={sortOrder} onChange={e => { setSortOrder(e.target.value); setCurrentPage(1); }}>
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                </select>
              </div>

              {!isWakingUp && (
                <button className="recompute-btn" onClick={handleRecompute} disabled={isRecomputing}>
                  {isRecomputing ? 'Clustering...' : 'Recompute clusters'}
                </button>
              )}
            </>
          )}
        </aside>

        <main className="workspace-main">
          {isWakingUp && (
            <div className="wake-alert">
              <div className="wake-pulse"></div>
              <div>
                <strong>Connecting to local extraction server...</strong> Ingestion and cluster recomputation require the backend to be running locally.
              </div>
            </div>
          )}

          {error && (
            <div className="wake-alert error-alert">
              <AlertTriangle size={18} />
              <div className="alert-copy">{error}</div>
              <button className="alert-close" onClick={() => setError(null)} aria-label="Dismiss error">
                <X size={16} />
              </button>
            </div>
          )}

          <IngestionPanel onIngested={handleIngested} onError={setError} onBatchFinished={fetchReels} />

          <section className="insights-section">
            <div className="dashboard-controls">
              <div>
                <h2 className="dashboard-title">
                  <Database size={20} className="logo-icon" />
                  Saved Extracted Insights
                </h2>
                <p className="dashboard-subtitle">
                  {filteredReels.length} result{filteredReels.length === 1 ? '' : 's'} in the current view
                </p>
              </div>

              {reels.length > 0 && (
                <div className="view-toggle" aria-label="View layout">
                  <button className={viewMode === 'cards' ? 'active' : ''} onClick={() => setViewMode('cards')}>Cards</button>
                  <button className={viewMode === 'table' ? 'active' : ''} onClick={() => setViewMode('table')}>Table</button>
                </div>
              )}
            </div>

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
                <Sparkles size={48} className="empty-state-icon" />
                <p>No extractions found. Input a Reel URL above to kickstart the autonomous pipeline!</p>
              </div>
            ) : viewMode === 'table' ? (
              <InsightsTable
                reels={paginatedReels}
                onSelect={handleSelectReel}
                handleDelete={handleDelete}
              />
            ) : (
              <div className="reels-grid">
                {paginatedReels.map((reel) => (
                  <ReelCard
                    key={reel.id}
                    reel={reel}
                    onSelect={handleSelectReel}
                    handleDelete={handleDelete}
                    onRetry={handleRetry}
                    checkedActions={checkedActions}
                  />
                ))}
              </div>
            )}

            {!isFetching && filteredReels.length > ITEMS_PER_PAGE && (
              <div className="pagination-container glass">
                <div className="pagination-info">
                  Showing <span className="highlight">{startIndex + 1}</span>–
                  <span className="highlight">{Math.min(endIndex, filteredReels.length)}</span> of{' '}
                  <span className="highlight">{filteredReels.length}</span> Reels
                </div>
                <div className="pagination-buttons">
                  <button
                    className="pagination-btn"
                    onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                    disabled={currentPage === 1}
                    aria-label="Previous page"
                  >
                    <ChevronLeft size={16} />
                    <span>Prev</span>
                  </button>
                  
                  <span className="page-indicator">
                    Page <span className="highlight">{currentPage}</span> of {totalPages}
                  </span>
                  
                  <button
                    className="pagination-btn"
                    onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                    disabled={currentPage === totalPages}
                    aria-label="Next page"
                  >
                    <span>Next</span>
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            )}
          </section>
        </main>
      </div>
      {/* Reel Detail Modal */}
      {selectedReel && (
        <ReelModal
          key={selectedReel.id}
          reel={selectedReel}
          onClose={() => setSelectedReel(null)}
          checkedActions={checkedActions}
          toggleCheckAction={toggleCheckAction}
          handleDelete={handleDelete}
          onRetry={handleRetry}
        />
      )}
    </div>
  );
}
