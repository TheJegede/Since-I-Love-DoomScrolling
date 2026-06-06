# Tabular Insights View + Emergent Topic Clustering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a filterable, spreadsheet-style table view of saved reels with emergent LLM topic clusters recomputed on demand.

**Architecture:** Persist a `cluster` label per reel in SQLite. A new `POST /clusters/recompute` makes one Llama call that groups all saved topics into emergent clusters and writes them back; `GET /clusters` summarizes them. The frontend loads all reels + clusters once and does table rendering, filtering, sorting, and search entirely in-memory, with a cards/table toggle.

**Tech Stack:** FastAPI + SQLite + Groq (llama-3.1-8b-instant) backend; React 19 + Vite frontend; tests via `backend/verify_pipeline.py` (FastAPI `TestClient`, LLM mocked — repo has no pytest).

Spec: `docs/plans/2026-06-06-tabular-insights-clustering-design.md`

---

## File Structure

- `backend/main.py` — modify: DB migration in `init_local_db`; add `ClusterAssignment`/`ClusterAssignments` models + `cluster_topics_with_llm` helper + `recompute_clusters` and `list_clusters` endpoints; add `cluster` to `/reels` rows.
- `backend/verify_pipeline.py` — modify: add mocked tests for migration, recompute, clusters, and reels-includes-cluster.
- `frontend/src/App.jsx` — modify: load clusters; in-memory `filteredReels`; filter/sort bar; cards/table toggle; `<InsightsTable>`; recompute button.

Conventions to match (already in `main.py`): every DB op opens its own `sqlite3.connect(DB_PATH)`, commits, closes; LLM calls use `response_format={"type": "json_object"}` then `json.loads` + Pydantic validation; failures raise `HTTPException`.

---

## Task 1: DB migration — add `cluster` column

**Files:**
- Modify: `backend/main.py` (`init_local_db`, ~lines 36–56)
- Test: `backend/verify_pipeline.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/verify_pipeline.py`:

```python
def test_cluster_column_migration():
    print("Testing cluster column migration (idempotent)...")
    import main, sqlite3
    # Run init twice — must not error and column must exist exactly once
    main.init_local_db()
    main.init_local_db()
    conn = sqlite3.connect(main.DB_PATH)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(saved_reels)").fetchall()]
    conn.close()
    assert cols.count("cluster") == 1, f"cluster column missing/duplicated: {cols}"
    print("[OK] cluster column migration passed!")
```

Register it in `__main__` (see Task 5 Step for the full runner update) — for now add `test_cluster_column_migration()` after `test_health()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `.\.venv\Scripts\python.exe verify_pipeline.py` (from `backend/`)
Expected: FAIL — `AssertionError: cluster column missing/duplicated: [...]` (no `cluster` yet).

- [ ] **Step 3: Implement the migration**

In `init_local_db`, after the `CREATE TABLE IF NOT EXISTS ...` execute and before `conn.commit()`, insert:

```python
        # Idempotent migration: add cluster column if missing
        existing_cols = [r[1] for r in cursor.execute("PRAGMA table_info(saved_reels)").fetchall()]
        if "cluster" not in existing_cols:
            cursor.execute("ALTER TABLE saved_reels ADD COLUMN cluster TEXT")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.\.venv\Scripts\python.exe verify_pipeline.py`
Expected: `[OK] cluster column migration passed!`

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/verify_pipeline.py
git commit -m "feat(db): add idempotent cluster column migration"
```

---

## Task 2: Cluster models + LLM grouping helper

**Files:**
- Modify: `backend/main.py` (after the `ReelExtraction`/`ExtractionResponse` models)
- Test: `backend/verify_pipeline.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/verify_pipeline.py`:

```python
def test_cluster_assignments_model():
    print("Testing ClusterAssignments validation...")
    from main import ClusterAssignments
    m = ClusterAssignments(assignments=[{"id": "a", "cluster": "AI Tools"},
                                         {"id": "b", "cluster": "Fitness"}])
    assert m.assignments[0].cluster == "AI Tools"
    assert m.assignments[1].id == "b"
    print("[OK] ClusterAssignments model passed!")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.\.venv\Scripts\python.exe verify_pipeline.py`
Expected: FAIL — `ImportError: cannot import name 'ClusterAssignments' from 'main'`.

- [ ] **Step 3: Implement models + helper**

In `backend/main.py`, after the `ExtractionResponse` class, add:

```python
class ClusterAssignment(BaseModel):
    id: str
    cluster: str

class ClusterAssignments(BaseModel):
    assignments: List[ClusterAssignment]

def cluster_topics_with_llm(items: List[dict]) -> List[dict]:
    """Group reel topics into emergent clusters via one Llama call.

    items: list of {"id": str, "topic": str}. Returns list of {"id", "cluster"}.
    Monkeypatched in tests to avoid a real Groq call."""
    if not groq_client:
        raise HTTPException(status_code=500, detail="Groq client is not configured on the backend server.")

    system_prompt = (
        "You are a content librarian. Group the given items into a small number of "
        "emergent topic clusters (aim for 4 to 12, fewer if there are few items). "
        "Invent a short, human-readable name for each cluster (e.g. 'AI Tools', "
        "'Cooking', 'Personal Finance'). Every item id must appear exactly once. "
        "Respond ONLY with valid JSON in exactly this shape, no markdown or prose:\n"
        '{"assignments": [{"id": "<id>", "cluster": "<cluster name>"}]}'
    )
    user_prompt = "Items to cluster (JSON):\n" + json.dumps(items)

    try:
        response = groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
        )
        content = response.choices[0].message.content
        data = json.loads(content)
        validated = ClusterAssignments(**data)
        return [a.model_dump() for a in validated.assignments]
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Clustering model returned invalid JSON.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Clustering failed: {str(e)}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.\.venv\Scripts\python.exe verify_pipeline.py`
Expected: `[OK] ClusterAssignments model passed!`

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/verify_pipeline.py
git commit -m "feat(clusters): add cluster models and LLM grouping helper"
```

---

## Task 3: `POST /clusters/recompute` endpoint

**Files:**
- Modify: `backend/main.py` (add endpoint near the other `@app` routes)
- Test: `backend/verify_pipeline.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/verify_pipeline.py`:

```python
def test_recompute_clusters_mock():
    print("Testing POST /clusters/recompute (mocked)...")
    import main, sqlite3, json, uuid
    # Seed two reels directly
    conn = sqlite3.connect(main.DB_PATH)
    ids = [str(uuid.uuid4()), str(uuid.uuid4())]
    payloads = [
        {"core_topic": "AI email tools", "key_takeaway": "k", "action_items": [], "tools_or_resources": []},
        {"core_topic": "Marathon training", "key_takeaway": "k", "action_items": [], "tools_or_resources": []},
    ]
    for rid, p in zip(ids, payloads):
        conn.execute(
            "INSERT INTO saved_reels (id, url, title, raw_transcript, post_caption, extracted_json) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (rid, None, "t", None, None, json.dumps(p)),
        )
    conn.commit(); conn.close()

    original = main.cluster_topics_with_llm
    main.cluster_topics_with_llm = lambda items: [
        {"id": items[0]["id"], "cluster": "Productivity"},
        {"id": items[1]["id"], "cluster": "Fitness"},
    ] if len(items) >= 2 else []
    try:
        r = client.post("/clusters/recompute")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["assigned"] >= 2
        conn = sqlite3.connect(main.DB_PATH)
        got = dict(conn.execute("SELECT id, cluster FROM saved_reels WHERE id IN (?, ?)", ids).fetchall())
        conn.close()
        assert set(got.values()) >= {"Productivity", "Fitness"}
        print("[OK] recompute clusters passed!")
    finally:
        main.cluster_topics_with_llm = original
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.\.venv\Scripts\python.exe verify_pipeline.py`
Expected: FAIL — 404 (route missing), assertion on `r.status_code`.

- [ ] **Step 3: Implement the endpoint**

In `backend/main.py`, add after `list_reels`:

```python
@app.post("/clusters/recompute")
def recompute_clusters():
    """Regroup all saved reels into emergent topic clusters via one LLM call."""
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        rows = cursor.execute("SELECT id, extracted_json FROM saved_reels").fetchall()
        if not rows:
            conn.close()
            return {"clusters": [], "assigned": 0}

        items = []
        for rid, ej in rows:
            try:
                topic = (json.loads(ej) or {}).get("core_topic", "")
            except Exception:
                topic = ""
            items.append({"id": rid, "topic": topic})

        assignments = cluster_topics_with_llm(items)

        valid_ids = {r[0] for r in rows}
        applied = 0
        for a in assignments:
            if a.get("id") in valid_ids and a.get("cluster"):
                cursor.execute("UPDATE saved_reels SET cluster = ? WHERE id = ?", (a["cluster"], a["id"]))
                applied += 1
        conn.commit()

        clusters = [
            {"name": name, "count": count}
            for name, count in cursor.execute(
                "SELECT COALESCE(cluster, 'Unclustered') AS c, COUNT(*) FROM saved_reels GROUP BY c ORDER BY COUNT(*) DESC"
            ).fetchall()
        ]
        conn.close()
        logger.info(f"Recomputed clusters: assigned {applied} of {len(rows)} reels.")
        return {"clusters": clusters, "assigned": applied}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Cluster recompute failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Cluster recompute failed: {str(e)}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.\.venv\Scripts\python.exe verify_pipeline.py`
Expected: `[OK] recompute clusters passed!`

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/verify_pipeline.py
git commit -m "feat(clusters): add POST /clusters/recompute endpoint"
```

---

## Task 4: `GET /clusters` endpoint

**Files:**
- Modify: `backend/main.py`
- Test: `backend/verify_pipeline.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/verify_pipeline.py`:

```python
def test_list_clusters():
    print("Testing GET /clusters...")
    r = client.get("/clusters")
    assert r.status_code == 200, r.text
    data = r.json()
    assert isinstance(data, list)
    if data:
        assert "name" in data[0] and "count" in data[0]
    print("[OK] list clusters passed!")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.\.venv\Scripts\python.exe verify_pipeline.py`
Expected: FAIL — 404, assertion on status.

- [ ] **Step 3: Implement the endpoint**

In `backend/main.py`, add after `recompute_clusters`:

```python
@app.get("/clusters")
def list_clusters():
    """Return emergent clusters with reel counts. NULL cluster -> 'Unclustered'."""
    try:
        conn = sqlite3.connect(DB_PATH)
        rows = conn.execute(
            "SELECT COALESCE(cluster, 'Unclustered') AS c, COUNT(*) FROM saved_reels GROUP BY c ORDER BY COUNT(*) DESC"
        ).fetchall()
        conn.close()
        return [{"name": name, "count": count} for name, count in rows]
    except Exception as e:
        logger.error(f"Failed to list clusters: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to list clusters: {str(e)}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.\.venv\Scripts\python.exe verify_pipeline.py`
Expected: `[OK] list clusters passed!`

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/verify_pipeline.py
git commit -m "feat(clusters): add GET /clusters endpoint"
```

---

## Task 5: Include `cluster` in `/reels` rows + wire the test runner

**Files:**
- Modify: `backend/main.py` (`list_reels`, both SELECT branches + row mapping)
- Modify: `backend/verify_pipeline.py` (`__main__` runner)
- Test: `backend/verify_pipeline.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/verify_pipeline.py`:

```python
def test_reels_include_cluster():
    print("Testing GET /reels includes cluster field...")
    r = client.get("/reels")
    assert r.status_code == 200, r.text
    data = r.json()
    if data:
        assert "cluster" in data[0], f"cluster missing from reel row: {data[0].keys()}"
    print("[OK] reels include cluster passed!")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.\.venv\Scripts\python.exe verify_pipeline.py`
Expected: FAIL — `cluster missing from reel row`.

- [ ] **Step 3: Add `cluster` to `list_reels`**

In `backend/main.py` `list_reels`, change BOTH SELECT statements to append `, cluster` to the column list:

```python
            cursor.execute(
                "SELECT id, url, title, raw_transcript, post_caption, extracted_json, created_at, cluster FROM saved_reels "
                "WHERE title LIKE ? OR raw_transcript LIKE ? OR post_caption LIKE ? OR extracted_json LIKE ? "
                "ORDER BY created_at DESC LIMIT ?",
                (like_query, like_query, like_query, like_query, limit)
            )
```
```python
            cursor.execute(
                "SELECT id, url, title, raw_transcript, post_caption, extracted_json, created_at, cluster FROM saved_reels "
                "ORDER BY created_at DESC LIMIT ?",
                (limit,)
            )
```

Then in the result-building loop, add `cluster` (index 7), defaulting NULL to "Unclustered":

```python
        results = []
        for r in rows:
            results.append({
                "id": r[0],
                "url": r[1],
                "title": r[2],
                "raw_transcript": r[3],
                "post_caption": r[4],
                "extracted_json": json.loads(r[5]),
                "created_at": r[6],
                "cluster": r[7] if r[7] else "Unclustered"
            })
        return results
```

- [ ] **Step 4: Wire all new tests into the runner**

Replace the `__main__` block in `backend/verify_pipeline.py` with:

```python
if __name__ == "__main__":
    print("--- Starting Transcriber Pipeline Test ---")
    test_health()
    test_cluster_column_migration()
    test_cluster_assignments_model()
    test_extract_text_mock()
    test_recompute_clusters_mock()
    test_list_clusters()
    test_reels_include_cluster()
    print("--- All tests completed successfully! ---")
    sys.exit(0)
```

- [ ] **Step 5: Run the full suite to verify it passes**

Run: `.\.venv\Scripts\python.exe verify_pipeline.py`
Expected: all `[OK] ...` lines, ending `--- All tests completed successfully! ---`.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/verify_pipeline.py
git commit -m "feat(reels): include cluster in /reels and wire cluster tests"
```

---

## Task 6: Frontend — load clusters + in-memory filtered list

**Files:**
- Modify: `frontend/src/App.jsx`

Note: read `App.jsx` first. State lives at the top of `App()` (~lines 28–53), data loads in `useEffect` (~line 65) via `fetchReels`, and `handleSearchChange` (~line 96) currently refetches from the server. This task switches search/filter to in-memory.

- [ ] **Step 1: Add state for clusters, view mode, and filters**

After the existing `copiedText` state (~line 53), add:

```jsx
  // Tabular view + clustering
  const [clusters, setClusters] = useState([]);          // [{name, count}]
  const [viewMode, setViewMode] = useState('cards');      // 'cards' | 'table'
  const [clusterFilter, setClusterFilter] = useState('All');
  const [toolFilter, setToolFilter] = useState('All');
  const [sortOrder, setSortOrder] = useState('newest');   // 'newest' | 'oldest'
  const [isRecomputing, setIsRecomputing] = useState(false);
```

- [ ] **Step 2: Fetch all reels (raise limit) and clusters on mount**

Change the mount effect (~line 65) and `fetchReels` so the table has the full set, and add `fetchClusters`:

```jsx
  useEffect(() => {
    fetchReels();
    fetchClusters();
    checkBackendHealth();
  }, []);
```
```jsx
  const fetchReels = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/reels?limit=500`);
      if (response.ok) {
        const data = await response.json();
        setReels(data);
      }
    } catch (err) {
      console.error("Error fetching reels", err);
    }
  };

  const fetchClusters = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/clusters`);
      if (response.ok) setClusters(await response.json());
    } catch (err) {
      console.error("Error fetching clusters", err);
    }
  };
```

- [ ] **Step 3: Make search in-memory; derive `filteredReels` and tool options**

Replace `handleSearchChange` (~line 96) with a pure state setter:

```jsx
  const handleSearchChange = (e) => setSearchQuery(e.target.value);
```

Add derived values just before the `return (` of the component:

```jsx
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
```

- [ ] **Step 4: Render the card grid from `filteredReels`**

Find where the saved reels are mapped for the card grid (search for `reels.map` in the dashboard/grid section) and change that single `reels.map(...)` to `filteredReels.map(...)`. Do not change the modal or the extract handlers.

- [ ] **Step 5: Verify in browser**

With backend (`uvicorn`, ffmpeg on PATH) and `npm run dev` running, open http://localhost:5173. Hard-reload.
Expected: cards still render; typing in search filters instantly with no network request (check DevTools Network tab — no `/reels` call on keystroke).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.jsx
git commit -m "feat(ui): load clusters and filter reels in-memory"
```

---

## Task 7: Frontend — cards/table view toggle + filter bar

**Files:**
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/App.css` (styles)

- [ ] **Step 1: Add the filter/toggle bar above the results**

Immediately before the results grid (where `filteredReels.map` renders), insert:

```jsx
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
      </div>
```

- [ ] **Step 2: Add minimal styles**

Append to `frontend/src/App.css`:

```css
.controls-bar { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin: 1rem 0; }
.controls-bar select { padding: 0.4rem 0.6rem; border-radius: 8px; }
.view-toggle button { padding: 0.4rem 0.9rem; border: 1px solid #ccc; background: #fff; cursor: pointer; }
.view-toggle button.active { background: #111; color: #fff; }
.view-toggle button:first-child { border-radius: 8px 0 0 8px; }
.view-toggle button:last-child { border-radius: 0 8px 8px 0; }
.insights-table { width: 100%; border-collapse: collapse; }
.insights-table th, .insights-table td { text-align: left; padding: 0.6rem; border-bottom: 1px solid #eee; vertical-align: top; }
.insights-table tbody tr { cursor: pointer; }
.insights-table tbody tr:hover { background: #fafafa; }
.tool-chip { display: inline-block; background: #eef; border-radius: 6px; padding: 0.1rem 0.4rem; margin: 0 0.2rem 0.2rem 0; font-size: 0.8rem; }
.cluster-pill { background: #efe; border-radius: 6px; padding: 0.1rem 0.5rem; font-size: 0.8rem; }
```

- [ ] **Step 3: Verify in browser**

Reload http://localhost:5173.
Expected: toggle + three dropdowns appear; selecting a cluster/tool filters the cards; sort order flips order. (Table view comes in Task 8 — clicking "Table" shows nothing yet, that's fine.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.jsx frontend/src/App.css
git commit -m "feat(ui): add view toggle and filter bar"
```

---

## Task 8: Frontend — InsightsTable view

**Files:**
- Modify: `frontend/src/App.jsx`

- [ ] **Step 1: Add the table render branch**

Wrap the results region so the grid shows for `cards` and the table for `table`. Where the card grid renders `filteredReels.map(...)`, gate it with `viewMode === 'cards'` and add this sibling for the table:

```jsx
      {viewMode === 'table' && (
        <table className="insights-table">
          <thead>
            <tr>
              <th>Topic</th><th>Cluster</th><th>Key takeaway</th><th>Tools</th><th>Saved</th>
            </tr>
          </thead>
          <tbody>
            {filteredReels.map(reel => {
              const ej = reel.extracted_json || {};
              return (
                <tr key={reel.id} onClick={() => setSelectedReel(reel)}>
                  <td>{ej.core_topic || reel.title}</td>
                  <td><span className="cluster-pill">{reel.cluster || 'Unclustered'}</span></td>
                  <td>{ej.key_takeaway}</td>
                  <td>{(ej.tools_or_resources || []).map((t, i) => (
                    <span className="tool-chip" key={i}>{t}</span>
                  ))}</td>
                  <td>{reel.created_at ? new Date(reel.created_at).toLocaleDateString() : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
```

- [ ] **Step 2: Verify in browser**

Reload, click "Table".
Expected: rows for each reel with Topic/Cluster/Takeaway/Tools/Saved; clicking a row opens the existing detail modal; cluster shows "Unclustered" until Task 9's recompute runs; cluster/tool/search filters affect the table too.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/App.jsx
git commit -m "feat(ui): add InsightsTable view"
```

---

## Task 9: Frontend — Recompute clusters button

**Files:**
- Modify: `frontend/src/App.jsx`

- [ ] **Step 1: Add the recompute handler**

Add near `fetchClusters`:

```jsx
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
      await fetchClusters();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsRecomputing(false);
    }
  };
```

- [ ] **Step 2: Add the button to the controls bar**

Inside the `controls-bar` div (Task 7), after the sort `<select>`, add:

```jsx
        <button className="recompute-btn" onClick={handleRecompute} disabled={isRecomputing}>
          {isRecomputing ? 'Clustering…' : 'Recompute clusters'}
        </button>
```

Append to `frontend/src/App.css`:

```css
.recompute-btn { padding: 0.4rem 0.9rem; border-radius: 8px; border: none; background: #4f46e5; color: #fff; cursor: pointer; }
.recompute-btn:disabled { opacity: 0.6; cursor: default; }
```

- [ ] **Step 3: Verify the full round-trip in browser**

Ensure `backend/cookies.txt` and a real `GROQ_API_KEY` are set, backend running. With at least 2 saved reels, click "Recompute clusters".
Expected: button shows "Clustering…", then cluster dropdown repopulates with emergent names + counts, table Cluster column fills in, and filtering by a cluster narrows the rows. On a Groq failure, an error message shows and previous clusters remain.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.jsx frontend/src/App.css
git commit -m "feat(ui): add recompute clusters button"
```

---

## Task 10: Update CLAUDE.md + design status

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/plans/2026-06-06-tabular-insights-clustering-design.md` (status line)

- [ ] **Step 1: Document the new endpoints**

In `CLAUDE.md`, under the backend endpoints list, add:

```markdown
- `POST /clusters/recompute` — one Llama call regroups all reels into emergent topic clusters, persists `cluster` per row. `GET /clusters` returns `[{name, count}]` (NULL → "Unclustered"). `/reels` rows now include `cluster`.
```

And note: "`saved_reels` has a `cluster` column (nullable); migration is idempotent in `init_local_db`."

- [ ] **Step 2: Mark the design delivered**

Change the design doc's `Status:` line to `Status: Implemented (2026-06-06)`.

- [ ] **Step 3: Run the full backend suite once more**

Run: `.\.venv\Scripts\python.exe verify_pipeline.py`
Expected: `--- All tests completed successfully! ---`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/plans/2026-06-06-tabular-insights-clustering-design.md
git commit -m "docs: document clustering endpoints and mark design implemented"
```

---

## Self-Review Notes

- **Spec coverage:** §2 data model → Task 1. §3.1 recompute → Tasks 2–3. §3.2 `/clusters` → Task 4. §3.3 `/reels` cluster → Task 5. §4.1 in-memory load → Task 6. §4.2 toggle → Task 7. §4.3 table → Task 8. §4.4 filters → Tasks 6–7. §4.5 recompute control → Task 9. §5 error handling → Tasks 2,3,9 (HTTPException + no-commit-on-failure + frontend error state). §6 testing → Tasks 1–5 (+ manual FE steps). All covered.
- **Type consistency:** `cluster_topics_with_llm(items)` takes/returns `{"id","topic"}`/`{"id","cluster"}` across Tasks 2–3 and its test mock. `ClusterAssignments.assignments[].{id,cluster}` consistent. Endpoint names `recompute_clusters`/`list_clusters` and routes `/clusters/recompute`, `/clusters` consistent across backend + frontend fetches. Frontend state names (`clusters`, `viewMode`, `clusterFilter`, `toolFilter`, `sortOrder`, `isRecomputing`, `filteredReels`, `allTools`) consistent across Tasks 6–9.
- **No placeholders:** every code step shows complete code; commands include expected output.
