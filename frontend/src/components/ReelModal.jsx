import {
  X, ExternalLink, Trash2, Copy, Check, FileAudio, Info, ChevronDown,
} from 'lucide-react';

export default function ReelModal({
  reel,
  onClose,
  formatDate,
  isTranscriptOpen,
  setIsTranscriptOpen,
  isCaptionOpen,
  setIsCaptionOpen,
  checkedActions,
  toggleCheckAction,
  copiedText,
  handleCopy,
  handleDelete,
}) {
  const details = reel.extracted_json || {};
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="glass modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>
          <X size={24} />
        </button>

        <div className="modal-header-meta">
          <span className="card-topic-badge" style={{ fontSize: '0.8rem', padding: '0.35rem 0.85rem' }}>
            {(details.core_topic || 'REEL').toUpperCase()}
          </span>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Processed on {formatDate(reel.created_at)}
          </span>
          {reel.url && (
            <a
              href={reel.url}
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
            onClick={(e) => handleDelete(reel.id, e)}
          >
            Delete <Trash2 size={14} />
          </button>
        </div>

        <h2 className="modal-title">{reel.title || "Extracted Insights"}</h2>

        {reel.status && reel.status !== 'done' && (
          <div className="modal-section">
            {['pending', 'processing'].includes(reel.status) ? (
              <div className="info-banner" style={{
                padding: '1rem',
                borderRadius: 'var(--radius-sm)',
                background: 'rgba(59, 130, 246, 0.1)',
                border: '1px solid var(--accent-primary)',
                color: 'var(--text-primary)',
                fontSize: '0.9rem',
                marginBottom: '1.5rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem'
              }}>
                <span style={{ 
                  fontWeight: '700', 
                  color: 'var(--accent-primary)', 
                  textTransform: 'uppercase',
                  fontSize: '0.8rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem'
                }}>
                  {reel.status === 'processing' ? 'Processing Reel' : 'In Ingestion Queue'}
                </span>
                <p style={{ margin: 0 }}>
                  {reel.status === 'processing' 
                    ? 'The local worker is currently transcribing and extracting insights for this Reel. Please wait a moment...' 
                    : 'This Reel is waiting in the queue to be processed. The local queue worker will pick it up shortly.'}
                </p>
              </div>
            ) : (
              <div className={`error-banner ${reel.status === 'cookies_expired' ? 'warning' : reel.status === 'unsupported_format' ? 'info' : 'danger'}`} style={{
                padding: '1rem',
                borderRadius: 'var(--radius-sm)',
                background: reel.status === 'cookies_expired' ? 'rgba(245, 158, 11, 0.15)' : reel.status === 'unsupported_format' ? 'rgba(59, 130, 246, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                border: `1px solid ${reel.status === 'cookies_expired' ? '#f59e0b' : reel.status === 'unsupported_format' ? '#3b82f6' : '#ef4444'}`,
                color: 'var(--text-primary)',
                fontSize: '0.9rem',
                marginBottom: '1.5rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem'
              }}>
                <span style={{ 
                  fontWeight: '700', 
                  color: reel.status === 'cookies_expired' ? '#f59e0b' : reel.status === 'unsupported_format' ? '#3b82f6' : '#ef4444', 
                  textTransform: 'uppercase',
                  fontSize: '0.8rem'
                }}>
                  {reel.status === 'cookies_expired' ? 'Authentication Required' : reel.status === 'unsupported_format' ? 'Unsupported Format' : 'Extraction Failed'}
                </span>
                <p style={{ margin: 0 }}>{reel.error || 'An unknown error occurred during pipeline execution.'}</p>
                {reel.status === 'cookies_expired' && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                    <strong>How to fix:</strong> Log into Instagram in your browser, export your session cookies to <code>cookies.txt</code> using a browser extension, and save it at <code>backend/cookies.txt</code>.
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {details.key_takeaway && (
          <div className="modal-section">
            <div className="takeaway-banner">
              <span style={{ fontWeight: '700', color: 'var(--accent-primary)', display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', textTransform: 'uppercase' }}>
                Core Key Takeaway
              </span>
              {details.key_takeaway}
            </div>
          </div>
        )}

        {details.action_items && details.action_items.length > 0 && (
          <div className="modal-section">
            <h3 className="modal-section-title">Action Plan / Steps</h3>
            <div className="action-items-list">
              {details.action_items.map((item, index) => {
                const checkKey = `${reel.id}-${index}`;
                return (
                  <div key={index} className="action-item">
                    <input
                      type="checkbox"
                      className="action-checkbox"
                      checked={!!checkedActions[checkKey]}
                      onChange={() => toggleCheckAction(reel.id, index)}
                    />
                    <span className="action-text">{item}</span>
                    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      {copiedText === `action-${index}` && <span style={{ fontSize: '0.7rem', color: 'var(--accent-success)', fontWeight: 'bold' }}>COPIED</span>}
                      <button
                        onClick={() => handleCopy(item, `action-${index}`)}
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
                      >
                        {copiedText === `action-${index}` ? <Check size={14} style={{ color: 'var(--accent-success)' }} /> : <Copy size={14} />}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {details.tools_or_resources && details.tools_or_resources.length > 0 && (
          <div className="modal-section">
            <h3 className="modal-section-title">Referenced Tools & Resources</h3>
            <div className="tools-container">
              {details.tools_or_resources.map((tool, idx) => (
                <div key={idx} className="tool-tag">
                  <span>{tool}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    {copiedText === `tool-${idx}` && <span style={{ fontSize: '0.65rem', color: 'var(--accent-success)', fontWeight: 'bold' }}>COPIED</span>}
                    <button
                      onClick={() => handleCopy(tool, `tool-${idx}`)}
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}
                    >
                      {copiedText === `tool-${idx}` ? <Check size={12} style={{ color: 'var(--accent-success)' }} /> : <Copy size={12} className="tool-copy-icon" />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {reel.raw_transcript && (
          <div className="modal-section" style={{ marginBottom: '1rem' }}>
            <div className="transcript-accordion">
              <button className="accordion-trigger" onClick={() => setIsTranscriptOpen(!isTranscriptOpen)}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><FileAudio size={16} /> Voice Transcript</span>
                <ChevronDown className={`accordion-chevron ${isTranscriptOpen ? 'open' : ''}`} size={16} />
              </button>
              {isTranscriptOpen && (
                <div className="accordion-content">{reel.raw_transcript}</div>
              )}
            </div>
          </div>
        )}

        {reel.post_caption && (
          <div className="modal-section" style={{ marginBottom: '0' }}>
            <div className="transcript-accordion">
              <button className="accordion-trigger" onClick={() => setIsCaptionOpen(!isCaptionOpen)}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><Info size={16} /> Post Caption / Metadata</span>
                <ChevronDown className={`accordion-chevron ${isCaptionOpen ? 'open' : ''}`} size={16} />
              </button>
              {isCaptionOpen && (
                <div className="accordion-content">{reel.post_caption}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
