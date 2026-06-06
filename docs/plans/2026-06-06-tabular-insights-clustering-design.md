# Design: Tabular Insights View with Emergent Topic Clustering

Date: 2026-06-06
Status: Approved (Approach A) — pending spec review
Component: Transcriber (backend `backend/main.py`, frontend `frontend/src/App.jsx`)

## 1. Goal

Present saved reel insights in a filterable, spreadsheet-style table (alongside
the existing card grid) and let the user group reels into emergent topic
clusters discovered by the LLM, recomputed on demand. Filter/sort by cluster,
tools, date, and free-text.

Decisions locked in brainstorming:
- Clustering = **AI-driven, emergent** (LLM names the groups; no fixed taxonomy).
- Recompute = **on-demand** (explicit button), not per-reel.
- View = **toggle** between cards and table (cards stay).
- Filter axes: **cluster, tools_or_resources, date saved, free-text search**.
- Architecture = **Approach A**: clusters persisted in SQLite; frontend filters in-memory.

Constraint: Groq offers no embeddings API, so grouping is LLM categorization in a
single chat call, not vector clustering. Keeps the stack $0 and avoids shipping ML
deps to the HF free CPU tier.

## 2. Data model

`saved_reels` gains one nullable column:

- `cluster TEXT` — emergent cluster name for the reel. `NULL` = "Unclustered"
  (state before the first recompute, or a reel saved after the last recompute).

Migration lives in `init_local_db()`, idempotent and non-destructive:

1. `PRAGMA table_info(saved_reels)` → check whether `cluster` exists.
2. If absent: `ALTER TABLE saved_reels ADD COLUMN cluster TEXT`.

No separate `clusters` table. The cluster list is derived from the rows
(`SELECT cluster, COUNT(*) ... GROUP BY cluster`). Emergent names live on the rows.

## 3. Backend

Reuse the existing `groq_client`, `response_format={"type": "json_object"}`, and the
Pydantic-validation pattern from `extract_structured_json`.

### 3.1 `POST /clusters/recompute`

The only new heavy path. One LLM call regroups everything.

1. Fetch `id, core_topic, key_takeaway` for all reels.
2. If 0 reels → return `{ "clusters": [], "assigned": 0 }` (no LLM call).
3. Build a compact list of `{id, topic}` (topic = `core_topic`; `key_takeaway`
   appended only if it adds signal). Send to `llama-3.1-8b-instant` with a system
   prompt: group items into a small number (aim 4–12) of emergent, concisely-named
   topic clusters; every id assigned exactly once; respond ONLY as JSON:
   `{ "assignments": [ { "id": "<id>", "cluster": "<name>" } ] }`.
4. Validate with a Pydantic model (`ClusterAssignments`). Coerce/guard like the
   existing `ReelExtraction` validator.
5. Apply in a single transaction: `UPDATE saved_reels SET cluster=? WHERE id=?`
   for each assignment. Ids returned by the model but not in the DB are ignored;
   reels the model omitted keep their previous cluster (logged).
6. Return `{ "clusters": [ {"name", "count"} ], "assigned": N }`.

Failure (Groq down, invalid JSON) → `HTTPException(500)` with a clear message;
the transaction is not committed, so existing clusters are left intact.

### 3.2 `GET /clusters`

`SELECT cluster, COUNT(*) FROM saved_reels GROUP BY cluster ORDER BY COUNT(*) DESC`.
Returns `[ {"name", "count"} ]`. `NULL` cluster surfaced as `"Unclustered"`.
Drives the filter dropdown.

### 3.3 `GET /reels` (extend)

Add `cluster` to each returned row. Existing `limit` + LIKE `search` behavior
unchanged. Frontend raises `limit` (e.g. 500) to load the full set for in-memory
filtering. No new query params.

### 3.4 Scaling ceiling

All topics go in one prompt. Fine for tens–hundreds of reels (well within the
128k context). Not designed for thousands. Acceptable for a personal tool; noted
here as the known limit. If it ever matters: paginate/segment the recompute later.

## 4. Frontend (`frontend/src/App.jsx`)

Single component today; keep it, add a view-mode section. If the file grows
unwieldy, extract the table into a child component during implementation.

### 4.1 Data loading

- On load (and after recompute), fetch all reels (`/reels?limit=500`) and
  `/clusters` once into state.
- All filtering/sorting/search happens **in-memory** over the loaded array —
  instant, no per-keystroke network calls. (The server LIKE search is no longer
  the filter path; left in place but unused by the table.)

### 4.2 View toggle

Header gets a `cards | table` switch. Cards = current grid, unchanged. Table =
new view. Selected view in component state.

### 4.3 Table

Columns: **Topic** (`core_topic`), **Cluster**, **Key takeaway** (truncated),
**Tools** (chips from `tools_or_resources`), **Saved** (`created_at`, formatted).
Row click opens the existing detail modal (reused as-is).

### 4.4 Filter/sort bar (applies to both views)

- **Cluster** dropdown — from `/clusters`, plus "All" and "Unclustered".
- **Tool** dropdown — distinct tools derived client-side from loaded reels; filter
  to rows whose `tools_or_resources` contains the pick.
- **Date** sort — newest / oldest (`created_at`).
- **Search** — existing free-text box, now filtering in-memory across
  title/topic/takeaway/transcript/tools.
- Filters compose (AND). Active filters shown; clearable.

### 4.5 Recompute control

A **"Recompute clusters"** button. Click → `POST /clusters/recompute`, show a
loading state, on success re-fetch reels + clusters and surface
`assigned: N`. Empty state when no clusters yet ("Run Recompute to group your
reels"). Reuses the app's existing status/loader patterns.

## 5. Error handling

- **Migration:** guarded by PRAGMA check; safe to run on every startup.
- **Recompute LLM failure:** 500 + message; no DB write (transaction rolled back);
  frontend shows the error, keeps prior clusters.
- **Partial assignments:** unknown ids ignored; omitted reels keep prior cluster
  (logged), so a flaky response degrades gracefully instead of wiping data.
- **Empty library:** recompute and `/clusters` return empty without an LLM call.
- **Unclustered reels:** always filterable as their own group.

## 6. Testing

Extend `backend/verify_pipeline.py` (FastAPI `TestClient`, LLM mocked — pattern
already there):

- `init_local_db()` idempotency: call twice, assert `cluster` column present once,
  no error, existing rows preserved.
- `POST /clusters/recompute` with mocked Llama returning a fixed assignment map →
  assert rows updated, response shape `{clusters, assigned}`.
- `GET /clusters` → counts match seeded rows incl. an `Unclustered` group.
- `GET /reels` → each row includes `cluster`.
- `ClusterAssignments` validation: malformed item / unknown id handled without 500
  beyond the intended failure path.

Frontend: manual browser verification (no FE test infra in repo) — toggle views,
each filter, compose filters, recompute round-trip.

## 7. Out of scope (YAGNI)

- Per-reel auto-clustering on save (explicitly deferred — on-demand chosen).
- Fixed/editable taxonomy UI.
- Vector embeddings / local ML.
- Manual cluster rename/merge (could be a later iteration).
- Pagination / thousands-of-reels scaling.

## 8. Units & boundaries

- `init_local_db` — owns schema + migration. Input: none. Depends on: SQLite file.
- `recompute_clusters` endpoint — owns the LLM grouping + persistence transaction.
  Input: DB rows. Output: cluster summary. Depends on: `groq_client`, SQLite.
- `GET /clusters`, `GET /reels` — read-only projections. Depend on: SQLite.
- Frontend `<InsightsTable>` (+ filter bar) — owns presentation/filtering. Input:
  reels[] + clusters[] from state. Depends on: fetch layer only.
