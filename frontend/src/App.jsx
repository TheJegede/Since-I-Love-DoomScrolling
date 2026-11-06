import { useState, useEffect, useRef } from 'react';
import './App.css';
import { supabase, rowToRecord, REEL_COLUMNS } from './supabaseClient';
import { deleteReel, retryReel, requestClusterRecompute, latestClusterJob } from './queue';
import { useWorkerStatus, isWorkerStale, timeSince } from './useWorkerStatus';
import { Skeleton, TableSkeleton } from './components/Skeletons';
import ReelModal from './components/ReelModal';
import InsightsTable from './components/InsightsTable';
import ReelCard from './components/ReelCard';
import IngestionPanel from './components/IngestionPanel';
import Login from './components/Login';
import { useSession } from './useSession';
import { rankReels, useSemanticSearch } from './semanticSearch';
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
  Moon,
  LogOut
} from 'lucide-react';

const ITEMS_PER_PAGE = 25;
// shortcut: refreshes only the oldest 100 queued reels per tick (the worker claims oldest first); fine at ~1 reel/min.
const MAX_REFRESH_IDS = 100;

// Supabase caps rows per request, so page through until the whole library is loaded.
async function fetchAllReelRows() {
  const rows = [];
  for (;;) {
    const { data, error, count } = await supabase
      .from('saved_reels')
      .select(REEL_COLUMNS, { count: 'exact' })
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


// Row-level security returns empty results (not errors) to a signed-out browser,
// so the library is only shown once a session exists; otherwise the login screen.
export default function App() {
  const { session, loading } = useSession();
  if (supabase && loading) return <main className="login-shell" aria-busy="true" />;
  if (supabase && !session) return <Login />;
  return <Dashboard />;
}

function Dashboard() {
  const [reels, setReels] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isFetching, setIsFetching] = useState(true);
  const [error, setError] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [theme, setTheme] = useState(() => localStorage.getItem('transcriber_theme') || 'dark');
  const activeIdsRef = useRef([]);
  const newestCreatedAtRef = useRef(null);

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
  const [clusterJob, setClusterJob] = useState(null);  // latest cluster_jobs row
  const smartSearch = useSemanticSearch(searchQuery);
  const worker = useWorkerStatus();

  const fetchReels = async () => {
    try {
      if (!supabase) throw new Error('Supabase is not configured: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
      setReels((await fetchAllReelRows()).map(rowToRecord));
    } catch (err) {
      console.error("Error fetching reels", err);
      setError(`Could not load your reels. ${err.message}`);
    } finally {
      setIsFetching(false);
    }
  };

  // Load the library, and any recompute already queued or running, on mount.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchReels();
    latestClusterJob().then(setClusterJob, err => console.error("Error reading recompute status", err));
  }, []);

  // While a recompute is queued or running, follow it; reload the library once it is done.
  const clusterJobStatus = clusterJob?.status;
  useEffect(() => {
    if (clusterJobStatus !== 'pending' && clusterJobStatus !== 'running') return;
    const id = setInterval(async () => {
      try {
        const job = await latestClusterJob();
        setClusterJob(job);
        if (job?.status === 'done') fetchReels();
        if (job?.status === 'error') setError(`Recompute failed: ${job.error || 'unknown error'}`);
      } catch (err) {
        console.error("Error polling recompute status", err);
      }
    }, 3000);
    return () => clearInterval(id);
  }, [clusterJobStatus]);

  // Keep refs of the queued/processing reel ids and the newest reel's timestamp,
  // so the polling interval below reads the latest values without being torn down each change.
  useEffect(() => {
    activeIdsRef.current = reels.filter(r => r.status === 'pending' || r.status === 'processing').map(r => r.id);
    newestCreatedAtRef.current = reels.reduce((newest, r) =>
      r.created_at && (!newest || new Date(r.created_at) > new Date(newest)) ? r.created_at : newest, null);
  }, [reels]);

  // Every 5s: pick up reels added elsewhere (e.g. shared from the phone) and re-fetch queued ones
  // so they fill in once the worker finishes; a queued reel deleted elsewhere drops out.
  useEffect(() => {
    const id = setInterval(async () => {
      if (!supabase) return;
      const ids = activeIdsRef.current.slice(-MAX_REFRESH_IDS);
      const newest = newestCreatedAtRef.current;
      const table = () => supabase.from('saved_reels').select(REEL_COLUMNS);
      const [queued, added] = await Promise.all([
        ids.length ? table().in('id', ids) : { data: [] },
        newest ? table().gt('created_at', newest) : { data: [] },
      ]);
      const error = queued.error || added.error;
      if (error) return console.error("Error refreshing reels", error);
      const fresh = new Map([...queued.data, ...added.data].map(r => [r.id, rowToRecord(r)]));
      if (!fresh.size && !ids.length) return;
      const requested = new Set(ids);
      setReels(prev => {
        const known = new Set(prev.map(r => r.id));
        const kept = prev
          .filter(r => !requested.has(r.id) || fresh.has(r.id))
          .map(r => fresh.get(r.id) || r);
        return [...[...fresh.values()].filter(r => !known.has(r.id)), ...kept];
      });
    }, 5000);
    return () => clearInterval(id);
  }, []);

  // 'local' signs out this browser only; the default would also sign out the owner's other devices.
  const handleSignOut = async () => {
    const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
    if (signOutError) setError(`Could not sign out: ${signOutError.message}`);
  };

  const handleRecompute = async () => {
    setError(null);
    try {
      await requestClusterRecompute();
      setClusterJob(await latestClusterJob());
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id, e) => {
    if (e) e.stopPropagation();
    if (!window.confirm('Delete this reel? This cannot be undone.')) return;
    try {
      await deleteReel(reels.find(r => r.id === id) || { id });
      setReels(prev => prev.filter(r => r.id !== id));
      if (selectedReel && selectedReel.id === id) setSelectedReel(null);
    } catch (err) {
      setError(err.message);
    }
  };



  const handleRetry = async (id, e) => {
    if (e) e.stopPropagation();
    try {
      await retryReel(id);
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
      const { data: details, error } = await supabase
        .from('saved_reels')
        .select('raw_transcript, post_caption')
        .eq('id', reel.id)
        .single();
      if (!error && details) {
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

  const isSearching = Boolean(searchQuery.trim());
  const dateSortedReels = reels
    .filter(r => clusterFilter === 'All' || (r.cluster || 'Unclustered') === clusterFilter)
    .filter(r => toolFilter === 'All' || (r.extracted_json?.tools_or_resources || []).includes(toolFilter))
    .sort((a, b) => {
      const da = new Date(a.created_at || 0), db = new Date(b.created_at || 0);
      return sortOrder === 'newest' ? db - da : da - db;
    });
  // While searching: exact-word matches first, then meaning matches by closeness.
  const { reels: filteredReels, relatedIds } = rankReels(dateSortedReels, searchQuery, smartSearch.scores, smartSearch.textIds);

  const totalPages = Math.ceil(filteredReels.length / ITEMS_PER_PAGE) || 1;
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const paginatedReels = filteredReels.slice(startIndex, endIndex);
  const completedCount = reels.filter(r => !r.status || r.status === 'done').length;
  const activeCount = reels.filter(r => r.status && r.status !== 'done').length;
  const isRecomputeActive = clusterJobStatus === 'pending' || clusterJobStatus === 'running';
  const isQueueWaiting = isRecomputeActive || reels.some(r => r.status === 'pending' || r.status === 'processing');
  const workerStale = worker.loaded && isWorkerStale(worker.lastSeen);

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
          {worker.loaded && (
            <span className="system-status">
              <span className={`status-dot${workerStale ? ' waking' : ''}`}>●</span>
              {worker.lastSeen ? `WORKER RAN ${timeSince(worker.lastSeen).toUpperCase()} AGO` : 'WORKER NOT SEEN YET'}
            </span>
          )}
          <button 
            className="theme-toggle-btn" 
            onClick={() => setTheme(prev => prev === 'light' ? 'dark' : 'light')}
            aria-label="Toggle theme"
          >
            {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
            <span>{theme === 'light' ? 'Dark' : 'Light'}</span>
          </button>
          {supabase && (
            <button className="theme-toggle-btn" onClick={handleSignOut}>
              <LogOut size={15} />
              <span>Sign out</span>
            </button>
          )}
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
            {smartSearch.status === 'loading' && (
              <p className="search-status" role="status">
                Smart search loading… showing exact matches for now
              </p>
            )}
            {smartSearch.status === 'error' && (
              <p className="search-status search-status--error" role="status">
                Smart search unavailable — showing exact matches only
                <button type="button" className="search-status-retry" onClick={smartSearch.retry}>Retry</button>
              </p>
            )}
            {smartSearch.transcriptsFailed && smartSearch.status !== 'error' && (
              <p className="search-status search-status--error" role="status">
                Transcript search unavailable — not searching transcripts or captions
                <button type="button" className="search-status-retry" onClick={smartSearch.retry}>Retry</button>
              </p>
            )}
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
                <select
                  id="sort-order"
                  value={sortOrder}
                  disabled={isSearching}
                  title={isSearching ? 'Search results are ordered by best match' : undefined}
                  onChange={e => { setSortOrder(e.target.value); setCurrentPage(1); }}
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                </select>
              </div>

              <button className="recompute-btn" onClick={handleRecompute} disabled={isRecomputeActive}>
                {clusterJobStatus === 'pending' ? 'Queued…' : clusterJobStatus === 'running' ? 'Clustering…' : 'Recompute clusters'}
              </button>
            </>
          )}
        </aside>

        <main className="workspace-main">
          {workerStale && isQueueWaiting && (
            <div className="wake-alert" role="status">
              <div className="wake-pulse"></div>
              <div>
                {worker.lastSeen
                  ? `Your PC worker last ran ${timeSince(worker.lastSeen)} ago — queued items will be processed when it runs again.`
                  : "Your PC worker hasn't checked in yet — queued items will be processed once it runs."}
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

          <IngestionPanel reels={reels} onIngested={handleIngested} onError={setError} onBatchQueued={fetchReels} />

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
                relatedIds={relatedIds}
                onSelect={handleSelectReel}
                handleDelete={handleDelete}
              />
            ) : (
              <div className="reels-grid">
                {paginatedReels.map((reel) => (
                  <ReelCard
                    key={reel.id}
                    reel={reel}
                    related={relatedIds.has(reel.id)}
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
