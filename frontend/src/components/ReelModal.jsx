import { useState } from 'react';
import {
  X, ExternalLink, RefreshCw, Trash2, Copy, Check, FileAudio, Info, ChevronDown,
} from 'lucide-react';
import { formatDate } from '../formatDate';

const FAILURE_BANNERS = {
  cookies_expired: { tone: 'warning', title: 'Authentication Required' },
  unsupported_format: { tone: 'info', title: 'Unsupported Format' },
};
const DEFAULT_FAILURE_BANNER = { tone: 'danger', title: 'Extraction Failed' };

export default function ReelModal({
  reel,
  onClose,
  checkedActions,
  toggleCheckAction,
  handleDelete,
  onRetry,
}) {
  const [isTranscriptOpen, setIsTranscriptOpen] = useState(false);
  const [isCaptionOpen, setIsCaptionOpen] = useState(false);
  const [copiedText, setCopiedText] = useState(null); // key of the item just copied

  const handleCopy = (text, key) => {
    navigator.clipboard.writeText(text);
    setCopiedText(key);
    setTimeout(() => setCopiedText(null), 1500);
  };

  const details = reel.extracted_json || {};
  const failure = FAILURE_BANNERS[reel.status] || DEFAULT_FAILURE_BANNER;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="glass modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>
          <X size={24} />
        </button>

        <div className="modal-header-meta">
          <span className="card-topic-badge modal-topic-badge">
            {(details.core_topic || 'REEL').toUpperCase()}
          </span>
          <span className="modal-processed-on">
            Processed on {formatDate(reel.created_at)}
          </span>
          {reel.url && (
            <a
              href={reel.url}
              target="_blank"
              rel="noreferrer"
              className="alt-input-btn modal-meta-btn"
            >
              View Original <ExternalLink size={14} />
            </a>
          )}
          <button
            className="alt-input-btn delete-btn modal-meta-btn"
            onClick={(e) => handleDelete(reel.id, e)}
          >
            Delete <Trash2 size={14} />
          </button>
        </div>

        <h2 className="modal-title">{reel.title || "Extracted Insights"}</h2>

        {reel.status && reel.status !== 'done' && (
          <div className="modal-section">
            {['pending', 'processing'].includes(reel.status) ? (
              <div className="status-banner status-banner--queue">
                <span className="status-banner-title">
                  {reel.status === 'processing' ? 'Processing Reel' : 'In Ingestion Queue'}
                </span>
                <p className="status-banner-text">
                  {reel.status === 'processing'
                    ? 'The local worker is currently transcribing and extracting insights for this Reel. Please wait a moment...'
                    : 'This Reel is waiting in the queue to be processed. The local queue worker will pick it up shortly.'}
                </p>
              </div>
            ) : (
              <div className={`status-banner status-banner--${failure.tone}`}>
                <span className="status-banner-title">{failure.title}</span>
                <p className="status-banner-text">{reel.error || 'An unknown error occurred during pipeline execution.'}</p>
                {onRetry && (
                  <button className="alt-input-btn status-banner-retry" onClick={(e) => onRetry(reel.id, e)}>
                    <RefreshCw size={14} /> Retry extraction
                  </button>
                )}
                {reel.status === 'cookies_expired' && (
                  <div className="status-banner-help">
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
              <span className="takeaway-label">
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
                    <div className="copy-cluster copy-cluster--end">
                      {copiedText === `action-${index}` && <span className="copied-label">COPIED</span>}
                      <button
                        onClick={() => handleCopy(item, `action-${index}`)}
                        className="copy-btn"
                      >
                        {copiedText === `action-${index}` ? <Check size={14} className="copied-icon" /> : <Copy size={14} />}
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
                  <div className="copy-cluster">
                    {copiedText === `tool-${idx}` && <span className="copied-label copied-label--small">COPIED</span>}
                    <button
                      onClick={() => handleCopy(tool, `tool-${idx}`)}
                      className="copy-btn copy-btn--flex"
                    >
                      {copiedText === `tool-${idx}` ? <Check size={12} className="copied-icon" /> : <Copy size={12} className="tool-copy-icon" />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {reel.raw_transcript && (
          <div className="modal-section modal-section--tight">
            <div className="transcript-accordion">
              <button className="accordion-trigger" onClick={() => setIsTranscriptOpen(!isTranscriptOpen)}>
                <span className="accordion-label"><FileAudio size={16} /> Voice Transcript</span>
                <ChevronDown className={`accordion-chevron ${isTranscriptOpen ? 'open' : ''}`} size={16} />
              </button>
              {isTranscriptOpen && (
                <div className="accordion-content">{reel.raw_transcript}</div>
              )}
            </div>
          </div>
        )}

        {reel.post_caption && (
          <div className="modal-section modal-section--last">
            <div className="transcript-accordion">
              <button className="accordion-trigger" onClick={() => setIsCaptionOpen(!isCaptionOpen)}>
                <span className="accordion-label"><Info size={16} /> Post Caption / Metadata</span>
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
