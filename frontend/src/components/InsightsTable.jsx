import { Trash2 } from 'lucide-react';

export default function InsightsTable({ reels, onSelect, formatDate, handleDelete }) {
  return (
    <div className="table-scroll">
      <table className="insights-table glass">
        <thead>
          <tr>
            <th>Topic</th><th>Cluster</th><th>Key takeaway</th><th>Tools</th><th>Saved</th><th></th>
          </tr>
        </thead>
        <tbody>
          {reels.map(reel => {
            const ej = reel.extracted_json || {};
            return (
              <tr key={reel.id} onClick={() => onSelect(reel)}>
                <td>{ej.core_topic || reel.title}</td>
                <td><span className="cluster-pill">{reel.cluster || 'Unclustered'}</span></td>
                <td>{ej.key_takeaway}</td>
                <td>{(ej.tools_or_resources || []).map((t, i) => (
                  <span className="tool-chip" key={i}>{t}</span>
                ))}</td>
                <td>{formatDate(reel.created_at) || '—'}</td>
                <td>
                  <button className="delete-btn" title="Delete reel" onClick={(e) => handleDelete(reel.id, e)}>
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
