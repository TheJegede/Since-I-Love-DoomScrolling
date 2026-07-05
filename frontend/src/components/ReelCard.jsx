import { Trash2 } from 'lucide-react';

export default function ReelCard({ reel, onSelect, formatDate, handleDelete, checkedActions = {} }) {
  const details = reel.extracted_json || {};
  
  // Topic fallback
  const topic = details.core_topic || (reel.status && reel.status !== 'done' ? reel.status : 'REEL');
  
  // First tool badge
  const mainTool = details.tools_or_resources?.[0] || '';
  
  // Checklist calculations
  const totalActions = details.action_items?.length || 0;
  const completedActions = details.action_items?.filter(
    (_, i) => checkedActions[`${reel.id}-${i}`]
  ).length || 0;

  // Status footer labels
  let statusText = 'INSPECT INDEX →';
  if (reel.status === 'processing') {
    statusText = 'PROCESSING →';
  } else if (reel.status === 'failed') {
    statusText = 'FAILED →';
  } else if (reel.status === 'pending') {
    statusText = 'QUEUED →';
  } else if (reel.status === 'unsupported_format') {
    statusText = 'UNSUPPORTED →';
  } else if (reel.status === 'cookies_expired') {
    statusText = 'BAD COOKIES →';
  }

  return (
    <article 
      className="glass glass-interactive reel-card" 
      onClick={() => onSelect(reel)}
      style={{ opacity: reel.status && reel.status !== 'done' ? 0.9 : 1 }}
    >
      <div className="card-header">
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          <span className="card-topic-badge">{topic.toUpperCase()}</span>
          {mainTool && <span className="card-tool-badge">{mainTool}</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span className="card-date">{formatDate(reel.created_at)}</span>
          <button 
            className="delete-btn" 
            title="Delete reel" 
            onClick={(e) => {
              e.stopPropagation();
              handleDelete(reel.id, e);
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      
      <h3 className="card-title">{reel.title || 'Untitled Extraction'}</h3>
      
      {reel.status && reel.status !== 'done' ? (
        <div className="card-processing-status">
          <div className="status-label">
            <span className={`status-dot-pulse ${reel.status}`}></span>
            <span>{reel.status === 'processing' ? 'Processing Reel...' : reel.status === 'failed' ? 'Failed' : 'Queued'}</span>
          </div>
          <div className="card-progress-track">
            <div className={`card-progress-fill ${reel.status}`}></div>
          </div>
        </div>
      ) : (
        <p className="card-takeaway">{details.key_takeaway || reel.post_caption || 'No description extracted.'}</p>
      )}

      <div className="card-footer">
        <span className="read-more-link">
          {statusText.toUpperCase()}
        </span>
        {reel.status === 'done' && (
          <div className="stat-item">
            <span>{completedActions}/{totalActions || 1} Check</span>
          </div>
        )}
      </div>
    </article>
  );
}

