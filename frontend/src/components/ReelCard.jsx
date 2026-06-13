import { Trash2, Clock, ArrowRight } from 'lucide-react';

export default function ReelCard({ reel, onSelect, formatDate, handleDelete }) {
  const details = reel.extracted_json || {};

  if (reel.status && reel.status !== 'done') {
    return (
      <article className="glass reel-card" style={{ opacity: 0.7 }}>
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
    <article className="glass glass-interactive reel-card" onClick={() => onSelect(reel)}>
      <div className="card-header">
        <span className="card-topic-badge">{details.core_topic || 'Reel Extract'}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span className="card-date">{formatDate(reel.created_at)}</span>
          <button className="delete-btn" title="Delete reel" onClick={(e) => handleDelete(reel.id, e)}>
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
}
