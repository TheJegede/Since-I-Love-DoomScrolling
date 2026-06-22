import {
  X, ExternalLink, Trash2, Copy, Check, FileAudio, Info, ChevronUp, ChevronDown,
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

        <div className="modal-section">
          <div className="takeaway-banner">
            <span style={{ fontWeight: '700', color: 'var(--accent-primary)', display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', textTransform: 'uppercase' }}>
              Core Key Takeaway
            </span>
            {details.key_takeaway}
          </div>
        </div>

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

        {details.tools_or_resources && details.tools_or_resources.length > 0 && (
          <div className="modal-section">
            <h3 className="modal-section-title">Referenced Tools & Resources</h3>
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

        {reel.raw_transcript && (
          <div className="modal-section" style={{ marginBottom: '1rem' }}>
            <div className="transcript-accordion">
              <button className="accordion-trigger" onClick={() => setIsTranscriptOpen(!isTranscriptOpen)}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><FileAudio size={16} /> Voice Transcript</span>
                {isTranscriptOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
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
                {isCaptionOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
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
