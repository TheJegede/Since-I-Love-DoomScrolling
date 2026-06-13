export function Skeleton() {
  return (
    <div className="glass reel-card skeleton-card">
      <div className="skeleton-header">
        <div className="skeleton-avatar shimmer"></div>
        <div className="skeleton-badge shimmer"></div>
      </div>
      <div className="skeleton-title shimmer"></div>
      <div className="skeleton-text shimmer"></div>
      <div className="skeleton-text short shimmer"></div>
      <div className="skeleton-footer">
        <div className="skeleton-line shimmer" style={{ width: '60px' }}></div>
        <div className="skeleton-line shimmer" style={{ width: '80px' }}></div>
      </div>
    </div>
  );
}

export function TableSkeleton() {
  return (
    <div className="table-scroll">
      <table className="insights-table glass skeleton-table">
        <thead>
          <tr>
            <th>Topic</th><th>Cluster</th><th>Key takeaway</th><th>Tools</th><th>Saved</th><th></th>
          </tr>
        </thead>
        <tbody>
          {[1, 2, 3, 4, 5].map(i => (
            <tr key={i} className="skeleton-row">
              <td><div className="skeleton-line shimmer" style={{ width: '120px', height: '16px' }}></div></td>
              <td><div className="skeleton-badge shimmer" style={{ width: '80px' }}></div></td>
              <td><div className="skeleton-line shimmer" style={{ width: '90%', height: '14px' }}></div></td>
              <td>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <div className="skeleton-line shimmer" style={{ width: '50px', height: '18px', borderRadius: '4px' }}></div>
                  <div className="skeleton-line shimmer" style={{ width: '65px', height: '18px', borderRadius: '4px' }}></div>
                </div>
              </td>
              <td><div className="skeleton-line shimmer" style={{ width: '75px', height: '14px' }}></div></td>
              <td><div className="skeleton-line shimmer" style={{ width: '20px', height: '20px', borderRadius: '4px' }}></div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
