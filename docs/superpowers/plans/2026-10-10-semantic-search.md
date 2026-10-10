# Semantic Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard search bar finds reels by meaning ("comedy" finds funny reels that never say "comedy"), on top of today's exact-word search, with no AI provider call at search time.

**Architecture:** The backend stores a 384-number embedding per reel (local fastembed, already used for clustering) in a new `saved_reels.embedding` pgvector column. The browser embeds the search text with the same MiniLM model (transformers.js), calls a Supabase SQL function `match_reels` for the closest reels, and merges those with exact-word matches client-side. Any failure degrades to today's exact-word search with a visible status line.

**Tech Stack:** Python 3 / FastAPI / fastembed / supabase-py / pytest · React 19 / Vite / Vitest / supabase-js / `@huggingface/transformers` · Supabase Postgres + pgvector.

**Spec:** `docs/superpowers/specs/2026-10-10-semantic-search-design.md`

## Global Constraints

- Paths are relative to the repo root `C:\Users\jeged\Downloads\Transcriber`. Commands are Git Bash syntax, run from the repo root unless a step says otherwise.
- Python is always `backend/.venv/Scripts/python.exe` (fastembed 0.9.0, pytest 9.1.1 are installed there).
- All work happens on branch `feat/semantic-search`. **No push, merge, or deploy without the user's explicit go-ahead** — pushing `main` auto-deploys the live frontend.
- Every commit message ends with the trailer line `Claude-Session: https://claude.ai/code/session_01MV2z14HLUeGpAd4apqTpCh`.
- **Rollout order is a hard rule:** Task 1 (SQL) must be finished before Task 2 or 3 edits `backend/db.py` / `backend/main.py`. The scheduled local worker runs `run_worker.py --drain` from this working tree every 5 minutes, so backend edits are live the moment they are saved; writing `embedding` to a column that does not exist would mark real reels as failed.
- Model pair is fixed: backend `sentence-transformers/all-MiniLM-L6-v2` (fastembed), browser `Xenova/all-MiniLM-L6-v2` with `dtype: 'q8'`, `pooling: 'mean'`, `normalize: true`. Vectors are 384 numbers.
- `embed_reel` never raises. A reel must save even when embedding is unavailable.
- Tests never touch the real Supabase DB and never load a real embedding model.
- No AI provider (Groq) call at search time.
- Frontend: no inline `style`; CSS goes in `frontend/src/App.css`.
- UI copy, verbatim: `Smart search loading… showing exact matches for now` · `Smart search unavailable — showing exact matches only` · `Retry` · `Related`.
- Starting constants: `MATCH_THRESHOLD = 0.3`, `MATCH_COUNT = 100`, debounce 300 ms, minimum query length 2.

**Deliberate differences from the spec** (same behaviour, better shape):
- The model loader lives in its own file `frontend/src/queryEmbedder.js` so the hook can be tested without module-level state.
- `db.reels_missing_embedding()` returns every row with a null embedding (not only `status = 'done'`), because older rows have a null status. The backfill skips rows with nothing extracted.
- The "Order by date" select is disabled while the search box has text, because results are then ordered by best match.

## Review Focus

1. **Fast typing:** a slow response for an older query arrives after a newer query was typed → it must be dropped, not shown. (Task 7)
2. **Query changed, new results not in yet:** meaning matches for the previous query must disappear immediately, not sit under the new query. (Task 7)
3. **One character or only spaces typed:** no model download, no Supabase call, no status line. (Task 7)
4. **Model download fails (offline), user clicks Retry:** it must really try again, not replay a cached failure. (Tasks 5 and 7)
5. **Old rows in the backfill:** `extracted_json` stored as a JSON string, and queued/failed rows with nothing extracted, must not crash it. (Task 4)

Also pinned: `match_reels` returning an id that is not among the loaded reels is ignored (Task 6).

## File Structure

| File | Responsibility |
|---|---|
| `backend/db.py` (modify) | Optional `embedding` on the two save functions; `reels_missing_embedding`, `set_embedding` |
| `backend/main.py` (modify) | `_reel_embedding_text`, `embed_reel`; four save sites pass an embedding |
| `backend/backfill_embeddings.py` (create) | One-off / repair script: embed rows missing an embedding |
| `backend/test_pipeline.py` (modify) | Tests for all of the above |
| `frontend/src/queryEmbedder.js` (create) | Load the browser model, embed a string |
| `frontend/src/semanticSearch.js` (create) | `rankReels` (pure) and `useSemanticSearch` (hook) |
| `frontend/src/App.jsx` (modify) | Use both; status line; disable date order while searching |
| `frontend/src/components/ReelCard.jsx`, `InsightsTable.jsx` (modify) | "Related" tag |
| `frontend/src/App.css` (modify) | `.search-status*`, `.related-badge` |
| `frontend/src/test/*.test.js(x)` (create/modify) | Tests |
| `CLAUDE.md`, `AGENTS.md`, `README.md` (modify) | Docs |

---

### Task 0: Branch and model compatibility check (gate)

**[main session]** Nothing else starts until this passes.

**Files:** none in the repo. Throwaway scripts go in the session scratchpad directory (below: `$SCRATCH`), in a new folder `$SCRATCH/compat`.

**Interfaces:**
- Produces: a pass/fail answer, and the exact `@huggingface/transformers` version that passed (Task 5 installs that same version).

- [ ] **Step 1: Create the branch and commit the spec and plan**

```bash
git checkout -b feat/semantic-search
git add docs/superpowers/specs/2026-10-10-semantic-search-design.md docs/superpowers/plans/2026-10-10-semantic-search.md
git commit -m "docs: semantic search spec and plan

Claude-Session: https://claude.ai/code/session_01MV2z14HLUeGpAd4apqTpCh"
```

- [ ] **Step 2: Write the sample texts** to `$SCRATCH/compat/texts.json`

```json
[
  "comedy",
  "jokes",
  "AI tools",
  "Notion",
  "how to make money online",
  "workout routine for beginners",
  "a quote about discipline and showing up every day",
  "Stand-up comedian roasts airline food in a two minute skit",
  "Using ChatGPT prompts to automate client emails ChatGPT, Zapier",
  "Meal prep high protein lunches for the week in under an hour"
]
```

- [ ] **Step 3: Write the backend embedder** to `$SCRATCH/compat/embed_backend.py`

```python
import json
import sys

from fastembed import TextEmbedding

texts = json.load(open(sys.argv[1], encoding="utf-8"))
model = TextEmbedding(model_name="sentence-transformers/all-MiniLM-L6-v2")
vectors = [[float(x) for x in vector] for vector in model.embed(texts)]
json.dump(vectors, open(sys.argv[2], "w", encoding="utf-8"))
print(f"embedded {len(vectors)} texts, {len(vectors[0])} dimensions")
```

- [ ] **Step 4: Run it**

```bash
backend/.venv/Scripts/python.exe "$SCRATCH/compat/embed_backend.py" "$SCRATCH/compat/texts.json" "$SCRATCH/compat/backend.json"
```

Expected: `embedded 10 texts, 384 dimensions`

- [ ] **Step 5: Write the comparison script** to `$SCRATCH/compat/compare.mjs`

```js
import { readFileSync } from 'node:fs';
import { pipeline } from '@huggingface/transformers';

const texts = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const backend = JSON.parse(readFileSync(process.argv[3], 'utf8'));
// Same call the browser will make.
const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });

const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const cosine = (a, b) => dot(a, b) / Math.sqrt(dot(a, a) * dot(b, b));

const browser = [];
let worst = 1;
for (const [i, text] of texts.entries()) {
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  const vector = Array.from(output.data);
  browser.push(vector);
  const similarity = cosine(vector, backend[i]);
  worst = Math.min(worst, similarity);
  console.log(similarity.toFixed(4), JSON.stringify(text));
}

// Does a browser-made query vector pick the same best match as a backend-made one?
const bestMatch = (queryVector, self) => texts
  .map((_, i) => i)
  .filter(i => i !== self)
  .sort((a, b) => cosine(queryVector, backend[b]) - cosine(queryVector, backend[a]))[0];
const agree = texts.filter((_, i) => bestMatch(browser[i], i) === bestMatch(backend[i], i)).length;

console.log(`dimensions: browser ${browser[0].length}, backend ${backend[0].length}`);
console.log(`worst cosine: ${worst.toFixed(4)} (pass needs >= 0.98)`);
console.log(`same best match: ${agree}/${texts.length}`);
process.exit(worst >= 0.98 ? 0 : 1);
```

- [ ] **Step 6: Install transformers.js in the scratch folder and run the comparison**

```bash
cd "$SCRATCH/compat" && npm init -y >/dev/null && npm install @huggingface/transformers && node compare.mjs texts.json backend.json; echo "exit=$?"
npm ls @huggingface/transformers
```

Expected: ten lines each starting with a number ≥ 0.98, `dimensions: browser 384, backend 384`, `worst cosine: 0.9xxx`, `exit=0`. Note the installed version printed by `npm ls`.

- [ ] **Step 7: Gate**

- `exit=0` → record the version, continue to Task 1.
- `exit=1`, or the `pipeline(...)` call itself errors → **STOP.** Report the printed numbers to the user. Do not start Task 1. (The fallback the spec names is embedding the query on the backend; that is a design change the user must approve.)

---

### Task 1: Supabase schema (pgvector column + `match_reels`)

**[main session — needs the user's Chrome and a confirmation]** Only after Task 0 passed.

**Files:** none in the repo (schema is managed in Supabase, not in code).

**Interfaces:**
- Produces: column `saved_reels.embedding vector(384)` (nullable) and SQL function `match_reels(query_embedding vector(384), match_threshold float, match_count int) returns table (id text, similarity float)`.

The SQL:

```sql
create extension if not exists vector;

alter table saved_reels add column if not exists embedding vector(384);

create or replace function match_reels(
  query_embedding vector(384),
  match_threshold float,
  match_count int
)
returns table (id text, similarity float)
language sql stable
as $$
  select id::text, 1 - (embedding <=> query_embedding) as similarity
  from saved_reels
  where embedding is not null
    and 1 - (embedding <=> query_embedding) >= match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;
```

- [ ] **Step 1: Ask the user to confirm** — "About to run the SQL on your live Supabase. It adds one column and one function and changes no existing data. Are you logged into Supabase in Chrome? OK to run?" Wait for a yes.

- [ ] **Step 2: Open the SQL editor.** Invoke the `claude-in-chrome` skill, load the Chrome tools in one ToolSearch call, call `tabs_context_mcp`, create a new tab, and navigate to
`https://supabase.com/dashboard/project/jljhgvrmyfntiqmizjfg/sql/new`

- [ ] **Step 3: Put the SQL in the editor and read it back.** The editor auto-indents and auto-closes brackets, so typed text can be mangled. After entering the SQL, read the editor's full text and compare it with the SQL above. Do not click Run until they match exactly. If the editor cannot be driven reliably after 2–3 attempts, stop and give the user the snippet to paste themselves.

- [ ] **Step 4: Click Run.** Expected result panel: `Success. No rows returned`.

- [ ] **Step 5: Verify from Python (read-only)**

```bash
cd backend && .venv/Scripts/python.exe -c "
import main, db
c = db.get_client()
print(c.table('saved_reels').select('id, embedding').limit(1).execute().data)
print(c.rpc('match_reels', {'query_embedding': [0.1] * 384, 'match_threshold': 0.0, 'match_count': 1}).execute().data)
"; cd ..
```

Expected: one row whose `embedding` is `None`, then `[]`.
If the second call fails with "Could not find the function … in the schema cache", run `notify pgrst, 'reload schema';` in the SQL editor and repeat this step.

---

### Task 2: Data layer — store and find embeddings

**Files:**
- Modify: `backend/db.py` (`_select_newest_first` at 38–49, `insert_reel` at 80–94, `update_reel_result` at 181–193; two new functions after `reels_for_clustering`)
- Test: `backend/test_pipeline.py`

**Interfaces:**
- Consumes: the `embedding` column from Task 1.
- Produces:
  - `db.insert_reel(url, title, raw_transcript, post_caption, extracted_json, status="done", source=None, embedding=None) -> dict`
  - `db.update_reel_result(reel_id, title, raw_transcript, post_caption, extracted_json, status="done", embedding=None) -> None`
  - `db.reels_missing_embedding() -> list` of `{"id", "extracted_json"}`
  - `db.set_embedding(reel_id: str, embedding: list) -> None`

- [ ] **Step 1: Write the failing tests.** In `backend/test_pipeline.py`, add this class directly after the existing `FakeTable` class:

```python
class RecordingTable:
    """Stand-in for a Supabase table query that records payloads and filters."""
    def __init__(self, rows=None):
        self.rows = rows or []
        self.payloads = []
        self.filters = []
        self.window = (0, 999)

    def select(self, *args, **kwargs):
        return self

    def insert(self, payload):
        self.payloads.append(payload)
        return self

    def update(self, payload):
        self.payloads.append(payload)
        return self

    def eq(self, *args):
        self.filters.append(("eq", args))
        return self

    def is_(self, *args):
        self.filters.append(("is", args))
        return self

    def order(self, *args, **kwargs):
        return self

    def range(self, start, end):
        self.window = (start, end)
        return self

    def execute(self):
        start, end = self.window
        return type("Result", (), {"data": self.rows[start:end + 1]})()
```

And append these tests at the end of the file (the `data layer` section):

```python
def test_insert_reel_stores_embedding_only_when_given(monkeypatch):
    table = RecordingTable()
    monkeypatch.setattr(db, "get_client", fake_client(table))
    record = db.insert_reel("u", "t", "tr", "cap", {"core_topic": "x"}, embedding=[0.1, 0.2])
    db.insert_reel("u2", "t", "tr", "cap", {"core_topic": "x"})
    assert table.payloads[0]["embedding"] == [0.1, 0.2]
    assert "embedding" not in table.payloads[1]
    assert "embedding" not in record  # never leaks into the API record


def test_update_reel_result_stores_embedding_only_when_given(monkeypatch):
    table = RecordingTable()
    monkeypatch.setattr(db, "get_client", fake_client(table))
    db.update_reel_result("r1", "t", "tr", "cap", {"core_topic": "x"}, embedding=[0.3])
    db.update_reel_result("r2", "t", "tr", "cap", {"core_topic": "x"})
    assert table.payloads[0]["embedding"] == [0.3]
    assert "embedding" not in table.payloads[1]


def test_embedding_queue_helpers(monkeypatch):
    table = RecordingTable([{"id": "a", "extracted_json": {}}, {"id": "b", "extracted_json": {}}])
    monkeypatch.setattr(db, "get_client", fake_client(table))
    assert [row["id"] for row in db.reels_missing_embedding()] == ["a", "b"]
    assert ("is", ("embedding", "null")) in table.filters

    db.set_embedding("a", [0.5])
    assert table.payloads == [{"embedding": [0.5]}]
    assert ("eq", ("id", "a")) in table.filters
```

- [ ] **Step 2: Run them to verify they fail**

Run: `backend/.venv/Scripts/python.exe -m pytest backend -q -k "embedding"`
Expected: 3 failed — `TypeError: insert_reel() got an unexpected keyword argument 'embedding'`, the same for `update_reel_result`, and `AttributeError: module 'db' has no attribute 'reels_missing_embedding'`.

- [ ] **Step 3: Implement.** In `backend/db.py`:

Replace `_select_newest_first` with:

```python
def _select_newest_first(columns: str, limit: Optional[int] = None, refine=None) -> list:
    """Select rows newest-first, paging past PostgREST's per-request row cap.

    refine, if given, adds filters to each page's query."""
    rows = []
    while limit is None or len(rows) < limit:
        last = len(rows) + 999 if limit is None else limit - 1
        query = get_client().table(TABLE).select(columns)
        if refine:
            query = refine(query)
        page = (query.order("created_at", desc=True).order("id")
                .range(len(rows), last).execute().data or [])
        if not page:
            break
        rows.extend(page)
    return rows
```

Replace `insert_reel` with:

```python
def insert_reel(url, title, raw_transcript, post_caption, extracted_json,
                status="done", source=None, embedding=None) -> dict:
    row = {
        "id": str(uuid.uuid4()),
        "url": url,
        "title": title,
        "raw_transcript": raw_transcript,
        "post_caption": post_caption,
        "extracted_json": extracted_json,  # dict -> jsonb
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "source": source,
    }
    if embedding is not None:
        row["embedding"] = embedding  # list -> pgvector
    get_client().table(TABLE).insert(row).execute()
    return row_to_record(row)
```

Replace `update_reel_result` with:

```python
def update_reel_result(reel_id: str, title: str, raw_transcript, post_caption,
                       extracted_json, status: str = "done", embedding=None) -> None:
    """Write pipeline results back onto an existing (claimed) row."""
    payload = {
        "title": title,
        "raw_transcript": raw_transcript,
        "post_caption": post_caption,
        "extracted_json": extracted_json,
        "status": status,
        "error": None,
        "processing_started_at": None,
        "next_attempt_at": None,
    }
    if embedding is not None:
        payload["embedding"] = embedding
    get_client().table(TABLE).update(payload).eq("id", reel_id).execute()
```

Add directly after `reels_for_clustering`:

```python
def reels_missing_embedding() -> list:
    """Rows with no search embedding yet, as [{id, extracted_json}]."""
    return _select_newest_first("id, extracted_json", refine=lambda q: q.is_("embedding", "null"))


def set_embedding(reel_id: str, embedding: list) -> None:
    get_client().table(TABLE).update({"embedding": embedding}).eq("id", reel_id).execute()
```

- [ ] **Step 4: Run the whole backend suite**

Run: `backend/.venv/Scripts/python.exe -m pytest backend -q`
Expected: all pass (the 3 new tests plus every existing one).

- [ ] **Step 5: Commit**

```bash
git add backend/db.py backend/test_pipeline.py
git commit -m "feat(backend): store and query reel embeddings in the data layer

Claude-Session: https://claude.ai/code/session_01MV2z14HLUeGpAd4apqTpCh"
```

---

### Task 3: Pipeline — embed every reel on save

**Files:**
- Modify: `backend/main.py` (new helpers after `_get_embedding_model`, ~line 247; save sites at ~717, ~757, ~880, ~908)
- Test: `backend/test_pipeline.py`

**Interfaces:**
- Consumes: `db.insert_reel(..., embedding=None)`, `db.update_reel_result(..., embedding=None)` from Task 2; existing `main._get_embedding_model()` (returns an object with `.embed(list_of_texts)` yielding one vector per text).
- Produces: `main.embed_reel(extracted_json: dict) -> Optional[List[float]]` — never raises; `None` when there is nothing to embed or the model is unavailable.

- [ ] **Step 1: Write the failing tests.** In `backend/test_pipeline.py`:

Change the existing `fake_insert_reel` signature (line 31) to accept the new argument:

```python
def fake_insert_reel(url, title, raw_transcript, post_caption, extracted_json, embedding=None):
    return {"id": "id-1", "url": url, "title": title, "raw_transcript": raw_transcript,
            "post_caption": post_caption, "extracted_json": extracted_json,
            "created_at": "2026-06-06T00:00:00Z"}
```

In `test_worker_tick_success`, change the `update_reel_result` lambda to:

```python
    monkeypatch.setattr(main.db, "update_reel_result",
                        lambda reel_id, title, raw_transcript, post_caption, extracted_json, embedding=None:
                        saved.update(id=reel_id, title=title))
```

Add after the `RecordingTable` class:

```python
class FakeEmbeddingModel:
    """Stand-in for fastembed's TextEmbedding: records texts, returns fixed vectors."""
    def __init__(self):
        self.texts = []

    def embed(self, texts):
        self.texts.extend(texts)
        return ([0.25, 0.5] for _ in texts)


@pytest.fixture(autouse=True)
def no_embedding_model(monkeypatch):
    """Never load the real embedding model in tests; embed_reel then returns None."""
    monkeypatch.setattr(main, "_get_embedding_model", raiser(RuntimeError("no embedding model in tests")))


@pytest.fixture
def embedding_model(monkeypatch, no_embedding_model):
    model = FakeEmbeddingModel()
    monkeypatch.setattr(main, "_get_embedding_model", lambda: model)
    return model
```

Add a new section before the `# ---- worker` divider:

```python
# ---------------------------------------------------------------- search embeddings

def test_embed_reel_uses_topic_takeaway_and_tools(embedding_model):
    vector = main.embed_reel({
        "core_topic": "AI email tools", "key_takeaway": "Automate replies",
        "tools_or_resources": ["Zapier", "ChatGPT"], "action_items": ["not embedded"]})
    assert vector == [0.25, 0.5]
    assert embedding_model.texts == ["AI email tools Automate replies Zapier, ChatGPT"]


def test_embed_reel_skips_reels_with_nothing_extracted(embedding_model):
    assert main.embed_reel({}) is None  # queued/failed reel
    assert main.embed_reel(None) is None
    assert embedding_model.texts == []


def test_embed_reel_returns_none_when_model_unavailable():
    assert main.embed_reel({"core_topic": "AI"}) is None


def test_every_save_path_stores_an_embedding(monkeypatch, pipeline, embedding_model):
    saved = []

    def record_insert(url, title, raw_transcript, post_caption, extracted_json, embedding=None):
        saved.append(embedding)
        return fake_insert_reel(url, title, raw_transcript, post_caption, extracted_json)

    monkeypatch.setattr(main.db, "get_reel_by_url", lambda url: None)
    monkeypatch.setattr(main.db, "insert_reel", record_insert)
    monkeypatch.setattr(main.db, "claim_next_pending", lambda: {"id": "row1", "url": REEL_URL})
    monkeypatch.setattr(main.db, "update_reel_result", lambda **kwargs: saved.append(kwargs["embedding"]))
    monkeypatch.setattr(main.db, "mark_failed", raiser(AssertionError("should not be marked failed")))

    assert client.post("/extract/url", json={"url": REEL_URL}).status_code == 200
    assert client.post("/extract/text", json={"transcript": "hello there"}).status_code == 200
    files = {"file": ("clip.mp3", io.BytesIO(b"audio"), "audio/mpeg")}
    assert client.post("/extract/file", files=files).status_code == 200
    assert main.worker_tick() is True
    assert saved == [[0.25, 0.5]] * 4


def test_reel_still_saves_when_embedding_fails(monkeypatch):
    saved = {}

    def record_insert(url, title, raw_transcript, post_caption, extracted_json, embedding=None):
        saved["embedding"] = embedding
        return fake_insert_reel(url, title, raw_transcript, post_caption, extracted_json)

    monkeypatch.setattr(main, "extract_structured_json", lambda transcript, caption: EXTRACTION)
    monkeypatch.setattr(main.db, "insert_reel", record_insert)
    r = client.post("/extract/text", json={"transcript": "hello there"})
    assert r.status_code == 200, r.text
    assert saved == {"embedding": None}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `backend/.venv/Scripts/python.exe -m pytest backend -q -k "embed or save_path or embedding_fails"`
Expected: 4 failed, 1 passed — `AttributeError: module 'main' has no attribute 'embed_reel'` for the first three, and `AssertionError: should not be marked failed` for the save-path test (the worker's missing `embedding` argument surfaces through the mocked `mark_failed`, which also keeps the test off the real database). `test_reel_still_saves_when_embedding_fails` already passes (nothing passes an embedding yet); it is there to pin that behaviour once Step 4 lands.

- [ ] **Step 3: Implement the helpers.** In `backend/main.py`, directly after the `_get_embedding_model` function (before `_target_cluster_count`), add:

```python
def _reel_embedding_text(extracted_json: Optional[dict]) -> str:
    """The text a reel is fingerprinted from for semantic search."""
    ej = extracted_json or {}
    tools = ", ".join(str(tool) for tool in ej.get("tools_or_resources") or [])
    parts = (ej.get("core_topic"), ej.get("key_takeaway"), tools)
    return " ".join(str(part).strip() for part in parts if part and str(part).strip())


def embed_reel(extracted_json: Optional[dict]) -> Optional[List[float]]:
    """Fingerprint a reel for semantic search.

    Never raises: a reel must still save when embedding is unavailable
    (backfill_embeddings.py repairs it later). Returns None when there is
    nothing to embed."""
    text = _reel_embedding_text(extracted_json)
    if not text:
        return None
    try:
        vector = next(iter(_get_embedding_model().embed([text])))
        return [float(x) for x in vector]
    except Exception as e:
        logger.warning(f"Could not embed reel for search: {getattr(e, 'detail', e)}")
        return None
```

- [ ] **Step 4: Pass the embedding at the four save sites.** In `backend/main.py`:

In `process_reel_url`, replace the final `return db.insert_reel(...)` with:

```python
    extracted_json = extracted.model_dump()
    return db.insert_reel(
        url=clean_url,
        title=title,
        raw_transcript=raw_transcript,
        post_caption=post_caption,
        extracted_json=extracted_json,
        embedding=embed_reel(extracted_json),
    )
```

In `process_pending_reel`, replace the `db.update_reel_result(...)` call with:

```python
        extracted_json = extracted.model_dump()
        db.update_reel_result(
            reel_id=reel_id,
            title=title,
            raw_transcript=raw_transcript,
            post_caption=post_caption,
            extracted_json=extracted_json,
            embedding=embed_reel(extracted_json),
        )
```

In `extract_file`, replace the `return db.insert_reel(...)` under `# 4. Commit to Database` with:

```python
        extracted_json = extracted_data.model_dump()
        return db.insert_reel(
            url=None,  # No URL for manual upload
            title=title,
            raw_transcript=raw_transcript,
            post_caption=caption,
            extracted_json=extracted_json,
            embedding=embed_reel(extracted_json),
        )
```

In `extract_text`, replace the `return db.insert_reel(...)` under `# Save to database` with:

```python
    extracted_json = extracted_data.model_dump()
    return db.insert_reel(
        url=None,
        title=title,
        raw_transcript=transcript,
        post_caption=caption,
        extracted_json=extracted_json,
        embedding=embed_reel(extracted_json),
    )
```

- [ ] **Step 5: Run the whole backend suite**

Run: `backend/.venv/Scripts/python.exe -m pytest backend -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/test_pipeline.py
git commit -m "feat(backend): embed every reel on save for semantic search

Claude-Session: https://claude.ai/code/session_01MV2z14HLUeGpAd4apqTpCh"
```

---

### Task 4: Backfill script

**Files:**
- Create: `backend/backfill_embeddings.py`
- Test: `backend/test_pipeline.py`

**Interfaces:**
- Consumes: `db.reels_missing_embedding()`, `db.set_embedding(reel_id, embedding)`, `db.row_to_record(row)` (parses string `extracted_json`), `main.embed_reel(extracted_json)`, `main._get_embedding_model()`.
- Produces: `backfill_embeddings.backfill() -> tuple` of `(updated, skipped)`; CLI `python backend/backfill_embeddings.py`.

- [ ] **Step 1: Write the failing test.** Append to the `search embeddings` section of `backend/test_pipeline.py`:

```python
def test_backfill_embeds_only_rows_with_content(monkeypatch, embedding_model):
    import backfill_embeddings
    monkeypatch.setattr(db, "reels_missing_embedding", lambda: [
        {"id": "a", "extracted_json": {"core_topic": "AI tools"}},
        {"id": "b", "extracted_json": {}},  # queued/failed reel: nothing to embed
        {"id": "c", "extracted_json": '{"key_takeaway": "stored as a JSON string"}'},
    ])
    saved = {}
    monkeypatch.setattr(db, "set_embedding", lambda reel_id, embedding: saved.update({reel_id: embedding}))
    assert backfill_embeddings.backfill() == (2, 1)
    assert saved == {"a": [0.25, 0.5], "c": [0.25, 0.5]}


def test_backfill_fails_loudly_without_a_model(monkeypatch):
    import backfill_embeddings
    monkeypatch.setattr(db, "reels_missing_embedding", raiser(AssertionError("must not read rows without a model")))
    with pytest.raises(RuntimeError, match="no embedding model"):
        backfill_embeddings.backfill()
```

- [ ] **Step 2: Run to verify it fails**

Run: `backend/.venv/Scripts/python.exe -m pytest backend -q -k backfill`
Expected: 2 failed with `ModuleNotFoundError: No module named 'backfill_embeddings'`.

- [ ] **Step 3: Implement.** Create `backend/backfill_embeddings.py`:

```python
"""Fingerprint reels that have no search embedding yet. Safe to re-run.

Run from the repo root:  python backend/backfill_embeddings.py
"""
import db
import main  # importing main loads .env and configures logging


def backfill() -> tuple:
    """Embed every row missing an embedding. Returns (updated, skipped)."""
    main._get_embedding_model()  # fail loudly here rather than skip every row
    updated = skipped = 0
    for row in db.reels_missing_embedding():
        embedding = main.embed_reel(db.row_to_record(row)["extracted_json"])
        if embedding is None:
            skipped += 1  # queued/failed reel: nothing extracted to embed
            continue
        db.set_embedding(row["id"], embedding)
        updated += 1
    return updated, skipped


if __name__ == "__main__":
    updated, skipped = backfill()
    print(f"Embedded {updated} reel(s); skipped {skipped} with nothing to embed.")
```

- [ ] **Step 4: Run the whole backend suite**

Run: `backend/.venv/Scripts/python.exe -m pytest backend -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/backfill_embeddings.py backend/test_pipeline.py
git commit -m "feat(backend): backfill script for reel search embeddings

Claude-Session: https://claude.ai/code/session_01MV2z14HLUeGpAd4apqTpCh"
```

- [ ] **Step 6: [main session] Run it for real.** This writes only the new `embedding` column on the live table.

```bash
backend/.venv/Scripts/python.exe backend/backfill_embeddings.py
```

Expected: `Embedded N reel(s); skipped M with nothing to embed.` with N close to the number of extracted reels. One HTTP update per reel, so allow a few minutes.

- [ ] **Step 7: [main session] Verify coverage**

```bash
cd backend && .venv/Scripts/python.exe -c "
import main, db
t = lambda: db.get_client().table('saved_reels').select('id', count='exact').limit(1)
print('with embedding:', t().not_.is_('embedding', 'null').execute().count)
print('without:', t().is_('embedding', 'null').execute().count)
"; cd ..
```

Expected: `with embedding` equals N from Step 6; `without` equals M.

---

### Task 5: Browser model loader

**Files:**
- Modify: `frontend/package.json`, `frontend/package-lock.json` (new dependency)
- Create: `frontend/src/queryEmbedder.js`
- Test: `frontend/src/test/queryEmbedder.test.js`

**Interfaces:**
- Consumes: the `@huggingface/transformers` version that passed Task 0.
- Produces:
  - `loadEmbedder() -> Promise` — resolves once the model is ready; a failed load is not cached.
  - `embedQuery(text: string) -> Promise<number[]>` — 384 numbers.

- [ ] **Step 1: Install the dependency** (replace `<version>` with the version recorded in Task 0)

```bash
cd frontend && npm install @huggingface/transformers@<version>; cd ..
```

Expected: `added N packages`; `frontend/package.json` lists `@huggingface/transformers` under `dependencies`.

- [ ] **Step 2: Write the failing test.** Create `frontend/src/test/queryEmbedder.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';

const pipeline = vi.hoisted(() => vi.fn());
vi.mock('@huggingface/transformers', () => ({ pipeline }));

import { embedQuery } from '../queryEmbedder';

describe('queryEmbedder', () => {
  it('retries a failed model load, then reuses the loaded model', async () => {
    const embedder = vi.fn(async () => ({ data: Float32Array.from([0.5, 0.25]) }));
    pipeline.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(embedder);

    await expect(embedQuery('comedy')).rejects.toThrow('offline');
    expect(await embedQuery('comedy')).toEqual([0.5, 0.25]);
    expect(await embedQuery('jokes')).toEqual([0.5, 0.25]);

    expect(pipeline).toHaveBeenCalledTimes(2);
    expect(pipeline).toHaveBeenLastCalledWith(
      'feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
    expect(embedder).toHaveBeenLastCalledWith('jokes', { pooling: 'mean', normalize: true });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd frontend && npm test -- src/test/queryEmbedder.test.js; cd ..`
Expected: FAIL — cannot resolve `../queryEmbedder`.

- [ ] **Step 4: Implement.** Create `frontend/src/queryEmbedder.js`:

```js
// The same MiniLM model the backend embeds reels with (fastembed), so a query
// vector is comparable with the stored reel vectors. Changing either side
// means re-embedding every reel.
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

let embedderPromise = null;

/** Download (first use on a device) and initialise the model. A failed load can be retried. */
export function loadEmbedder() {
  if (!embedderPromise) {
    // Dynamic import keeps the model runtime out of the main bundle.
    embedderPromise = import('@huggingface/transformers')
      .then(({ pipeline }) => pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' }))
      .catch((err) => {
        embedderPromise = null;
        throw err;
      });
  }
  return embedderPromise;
}

/** Embed search text as a unit-length vector. */
export async function embedQuery(text) {
  const embedder = await loadEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd frontend && npm test -- src/test/queryEmbedder.test.js; cd ..`
Expected: 1 passed.

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/queryEmbedder.js frontend/src/test/queryEmbedder.test.js
git commit -m "feat(frontend): in-browser query embedder

Claude-Session: https://claude.ai/code/session_01MV2z14HLUeGpAd4apqTpCh"
```

---

### Task 6: Ranking (`rankReels`)

**Files:**
- Create: `frontend/src/semanticSearch.js`
- Test: `frontend/src/test/rankReels.test.js`

**Interfaces:**
- Produces: `rankReels(reels: object[], query: string, scores: Map<string, number>) -> { reels: object[], relatedIds: Set<string> }`
  - Empty/whitespace query → `reels` returned unchanged, `relatedIds` empty.
  - A reel is kept if it matches by exact words or has a score. Rank = `(exact match ? 1 : 0) + (score or 0)`, highest first; ties keep the input order.
  - `relatedIds` holds reels kept by score only.

- [ ] **Step 1: Write the failing tests.** Create `frontend/src/test/rankReels.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { rankReels } from '../semanticSearch';

const reel = (id, topic, extra = {}) => ({
  id,
  title: `Title ${id}`,
  extracted_json: { core_topic: topic, key_takeaway: '', action_items: [], tools_or_resources: [], ...extra },
});
const ids = (result) => result.reels.map(r => r.id);
const NONE = new Map();

describe('rankReels', () => {
  const reels = [
    reel('a', 'Stand-up routine'),
    reel('b', 'Comedy writing'),
    reel('c', 'AI tools'),
    reel('d', 'Comedy podcast'),
  ];

  it('returns every reel untouched for an empty or whitespace query', () => {
    expect(rankReels(reels, '', NONE).reels).toBe(reels);
    expect(rankReels(reels, '   ', new Map([['a', 0.9]])).reels).toBe(reels);
    expect(rankReels(reels, '', NONE).relatedIds.size).toBe(0);
  });

  it('keeps exact-word matches in their original order when there are no scores', () => {
    const result = rankReels(reels, 'COMEDY ', NONE);
    expect(ids(result)).toEqual(['b', 'd']);
    expect(result.relatedIds.size).toBe(0);
  });

  it('searches title, takeaway, tools and action items', () => {
    const rich = [
      reel('t', 'x', { tools_or_resources: ['Notion'] }),
      reel('k', 'x', { key_takeaway: 'Use notion daily' }),
      reel('n', 'x', { action_items: ['Open Notion'] }),
      reel('z', 'x'),
    ];
    expect(ids(rankReels(rich, 'notion', NONE))).toEqual(['t', 'k', 'n']);
    expect(ids(rankReels(rich, 'title z', NONE))).toEqual(['z']);
  });

  it('adds meaning-only matches after exact matches and flags them as related', () => {
    const result = rankReels(reels, 'comedy', new Map([['a', 0.95], ['b', 0.4]]));
    expect(ids(result)).toEqual(['b', 'd', 'a']);
    expect([...result.relatedIds]).toEqual(['a']);
  });

  it('orders exact matches by closeness when both have scores', () => {
    const result = rankReels(reels, 'comedy', new Map([['b', 0.4], ['d', 0.8]]));
    expect(ids(result)).toEqual(['d', 'b']);
  });

  it('ignores scores for reels that are not loaded', () => {
    const result = rankReels(reels, 'comedy', new Map([['ghost', 0.99]]));
    expect(ids(result)).toEqual(['b', 'd']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npm test -- src/test/rankReels.test.js; cd ..`
Expected: FAIL — cannot resolve `../semanticSearch`.

- [ ] **Step 3: Implement.** Create `frontend/src/semanticSearch.js`:

```js
function matchesKeyword(reel, q) {
  const ej = reel.extracted_json || {};
  const hay = [
    reel.title, reel.raw_transcript, reel.post_caption, ej.core_topic, ej.key_takeaway,
    ...(ej.tools_or_resources || []), ...(ej.action_items || [])
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

/**
 * Keep the reels that match the query by exact words or by meaning, best match
 * first. `scores` maps reel id -> similarity for meaning matches. Exact-word
 * matches always outrank meaning-only ones; ties keep the input order.
 */
export function rankReels(reels, query, scores) {
  const q = query.trim().toLowerCase();
  const relatedIds = new Set();
  if (!q) return { reels, relatedIds };

  const ranked = [];
  for (const reel of reels) {
    const keyword = matchesKeyword(reel, q);
    const similarity = scores.get(reel.id);
    if (!keyword && similarity === undefined) continue;
    if (!keyword) relatedIds.add(reel.id);
    ranked.push({ reel, rank: (keyword ? 1 : 0) + (similarity ?? 0) });
  }
  ranked.sort((a, b) => b.rank - a.rank);
  return { reels: ranked.map(entry => entry.reel), relatedIds };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npm test -- src/test/rankReels.test.js; cd ..`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/semanticSearch.js frontend/src/test/rankReels.test.js
git commit -m "feat(frontend): rank reels by exact words then meaning

Claude-Session: https://claude.ai/code/session_01MV2z14HLUeGpAd4apqTpCh"
```

---

### Task 7: `useSemanticSearch` hook

**Files:**
- Modify: `frontend/src/semanticSearch.js`
- Test: `frontend/src/test/useSemanticSearch.test.js`

**Interfaces:**
- Consumes: `loadEmbedder()`, `embedQuery(text)` from `./queryEmbedder` (Task 5); `supabase` from `./supabaseClient` (`null` when unconfigured); SQL function `match_reels` (Task 1), which returns rows `{ id, similarity }`.
- Produces:
  - `export const MATCH_THRESHOLD = 0.3`, `export const MATCH_COUNT = 100`
  - `useSemanticSearch(query: string) -> { status, scores, retry }`
    - `status`: `'idle'` (no Supabase client, or trimmed query shorter than 2 characters) · `'loading'` (model not ready yet) · `'ready'` · `'error'` (the model or Supabase failed for the current query)
    - `scores`: `Map<id, similarity>` for the **current** query only; empty otherwise
    - `retry()`: run the current query again

- [ ] **Step 1: Write the failing tests.** Create `frontend/src/test/useSemanticSearch.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const { rpc, loadEmbedder, embedQuery } = vi.hoisted(() => ({
  rpc: vi.fn(),
  loadEmbedder: vi.fn(),
  embedQuery: vi.fn(),
}));
vi.mock('../supabaseClient', () => ({ supabase: { rpc } }));
vi.mock('../queryEmbedder', () => ({ loadEmbedder, embedQuery }));

import { useSemanticSearch, MATCH_THRESHOLD, MATCH_COUNT } from '../semanticSearch';

const search = (q) => renderHook(({ q }) => useSemanticSearch(q), { initialProps: { q } });

beforeEach(() => {
  loadEmbedder.mockReset().mockResolvedValue(undefined);
  embedQuery.mockReset().mockResolvedValue([0.1, 0.2]);
  rpc.mockReset().mockResolvedValue({ data: [{ id: 'a', similarity: 0.7 }], error: null });
});

describe('useSemanticSearch', () => {
  it('stays idle and never loads the model for empty or one-character queries', async () => {
    const { result, rerender } = search('');
    expect(result.current.status).toBe('idle');
    rerender({ q: ' a ' });
    expect(result.current.status).toBe('idle');
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(loadEmbedder).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(result.current.scores.size).toBe(0);
  });

  it('reports loading until the model is ready, then returns scores', async () => {
    let finishLoad;
    loadEmbedder.mockReturnValue(new Promise(resolve => { finishLoad = resolve; }));
    const { result } = search('comedy');
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(loadEmbedder).toHaveBeenCalled());
    expect(result.current.status).toBe('loading');

    await act(async () => { finishLoad(); });
    await waitFor(() => expect(result.current.scores.get('a')).toBe(0.7));
    expect(result.current.status).toBe('ready');
    expect(embedQuery).toHaveBeenCalledWith('comedy');
    expect(rpc).toHaveBeenCalledWith('match_reels', {
      query_embedding: [0.1, 0.2],
      match_threshold: MATCH_THRESHOLD,
      match_count: MATCH_COUNT,
    });
  });

  it('reports an error when the model cannot load, and retry tries again', async () => {
    loadEmbedder.mockRejectedValueOnce(new Error('offline'));
    const { result } = search('comedy');
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.scores.size).toBe(0);

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.scores.get('a')).toBe(0.7));
    expect(result.current.status).toBe('ready');
    expect(loadEmbedder).toHaveBeenCalledTimes(2);
  });

  it('reports an error when Supabase rejects the lookup', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { result } = search('comedy');
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.scores.size).toBe(0);
  });

  it('hides the previous query\'s scores as soon as the query changes', async () => {
    const { result, rerender } = search('comedy');
    await waitFor(() => expect(result.current.scores.get('a')).toBe(0.7));
    rerender({ q: 'cooking' });
    expect(result.current.scores.size).toBe(0);
    expect(result.current.status).toBe('ready');
  });

  it('drops a slow response for an older query', async () => {
    let finishFirst;
    embedQuery.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }));
    rpc.mockImplementation(async (_fn, args) => ({
      data: [{ id: args.query_embedding[0] === 0.9 ? 'stale' : 'fresh', similarity: 0.8 }],
      error: null,
    }));

    const { result, rerender } = search('comedy');
    await waitFor(() => expect(embedQuery).toHaveBeenCalledWith('comedy'));
    rerender({ q: 'cooking' });
    await waitFor(() => expect(result.current.scores.get('fresh')).toBe(0.8));

    await act(async () => { finishFirst([0.9, 0.9]); });
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(result.current.scores.has('stale')).toBe(false);
    expect(result.current.scores.get('fresh')).toBe(0.8);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npm test -- src/test/useSemanticSearch.test.js; cd ..`
Expected: FAIL — `useSemanticSearch is not a function` (and `MATCH_THRESHOLD` undefined).

- [ ] **Step 3: Implement.** In `frontend/src/semanticSearch.js`, add at the very top of the file:

```js
import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { embedQuery, loadEmbedder } from './queryEmbedder';

// Tuned by hand against real reels; see docs/superpowers/specs/2026-10-10-semantic-search-design.md.
export const MATCH_THRESHOLD = 0.3;
export const MATCH_COUNT = 100;
const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 300;
const NO_SCORES = new Map();
```

And append at the end of the file:

```js
async function fetchScores(query) {
  const { data, error } = await supabase.rpc('match_reels', {
    query_embedding: await embedQuery(query),
    match_threshold: MATCH_THRESHOLD,
    match_count: MATCH_COUNT,
  });
  if (error) throw error;
  return new Map(data.map(row => [row.id, row.similarity]));
}

/**
 * Meaning matches for the search text. The query is embedded in the browser
 * and matched in Supabase, so the backend is never involved.
 *
 * status: 'idle' (not searching, or no Supabase client) | 'loading' (model
 * still downloading) | 'ready' | 'error'. `scores` only ever holds results
 * for the current query.
 */
export function useSemanticSearch(query) {
  const q = query.trim();
  const active = Boolean(supabase) && q.length >= MIN_QUERY_LENGTH;
  const [modelReady, setModelReady] = useState(false);
  const [result, setResult] = useState({ query: '', scores: NO_SCORES, failed: false });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        await loadEmbedder();
        if (cancelled) return;
        setModelReady(true);
        const scores = await fetchScores(q);
        if (!cancelled) setResult({ query: q, scores, failed: false });
      } catch (err) {
        console.error('Smart search failed', err);
        if (!cancelled) setResult({ query: q, scores: NO_SCORES, failed: true });
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, active, attempt]);

  const current = active && result.query === q;
  const failed = current && result.failed;
  let status = 'idle';
  if (active) status = failed ? 'error' : modelReady ? 'ready' : 'loading';

  const retry = () => {
    setResult({ query: '', scores: NO_SCORES, failed: false });
    setAttempt(n => n + 1);
  };

  return { status, scores: current && !failed ? result.scores : NO_SCORES, retry };
}
```

- [ ] **Step 4: Run the new tests and the ranking tests**

Run: `cd frontend && npm test -- src/test/useSemanticSearch.test.js src/test/rankReels.test.js; cd ..`
Expected: 12 passed (6 + 6).

- [ ] **Step 5: Lint**

Run: `cd frontend && npm run lint; cd ..`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/semanticSearch.js frontend/src/test/useSemanticSearch.test.js
git commit -m "feat(frontend): useSemanticSearch hook over Supabase match_reels

Claude-Session: https://claude.ai/code/session_01MV2z14HLUeGpAd4apqTpCh"
```

---

### Task 8: Wire search into the dashboard

**Files:**
- Modify: `frontend/src/App.jsx` (imports ~line 9; hook call after the state declarations ~line 80; `filteredReels` at 277–293; search bar at 341–353; sort select at 375–381; `InsightsTable`/`ReelCard` usage at 448–464)
- Modify: `frontend/src/components/ReelCard.jsx`, `frontend/src/components/InsightsTable.jsx`
- Modify: `frontend/src/App.css`
- Test: `frontend/src/test/App.search.test.jsx` (create), `frontend/src/test/App.test.jsx`, `frontend/src/test/ReelCard.test.jsx`, `frontend/src/test/InsightsTable.test.jsx`

**Interfaces:**
- Consumes: `rankReels(reels, query, scores) -> { reels, relatedIds }` (Task 6); `useSemanticSearch(query) -> { status, scores, retry }` (Task 7).
- Produces: `ReelCard` prop `related` (boolean, default `false`); `InsightsTable` prop `relatedIds` (`Set`, default empty).

- [ ] **Step 1: Write the failing tests.**

Create `frontend/src/test/App.search.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

const useSemanticSearch = vi.hoisted(() => vi.fn());
vi.mock('../supabaseClient', () => ({ supabase: null, rowToRecord: (r) => r }));
vi.mock('../semanticSearch', async (importOriginal) => ({
  ...(await importOriginal()),
  useSemanticSearch,
}));

import App from '../App';

const reel = (id, title, topic, daysAgo) => ({
  id,
  title,
  url: `https://instagram.com/reel/${id}/`,
  status: 'done',
  cluster: 'Unclustered',
  created_at: new Date(Date.UTC(2026, 5, 20 - daysAgo)).toISOString(),
  extracted_json: { core_topic: topic, key_takeaway: `${topic} takeaway`, action_items: [], tools_or_resources: [] },
});
const REELS = [
  reel('skit', 'Airline food roast', 'Stand-up routine', 0),
  reel('comedy', 'Open mic night', 'Comedy writing', 1),
  reel('ai', 'Prompt tricks', 'AI tools', 2),
];
const smart = (overrides = {}) => ({ status: 'idle', scores: new Map(), retry: vi.fn(), ...overrides });
const cardTitles = () => [...document.querySelectorAll('.card-title')].map(el => el.textContent);

async function searchFor(text) {
  render(<App />);
  await screen.findByText('Airline food roast');
  fireEvent.change(screen.getByLabelText('Search'), { target: { value: text } });
}

beforeEach(() => {
  useSemanticSearch.mockReset().mockReturnValue(smart());
  globalThis.fetch = vi.fn((input) => {
    const u = String(input);
    if (u.endsWith('/health')) return Promise.resolve({ ok: true });
    if (u.includes('/reels')) return Promise.resolve({ ok: true, json: () => Promise.resolve(REELS) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
});

describe('App search', () => {
  it('passes the search text to smart search', async () => {
    await searchFor('comedy');
    expect(useSemanticSearch).toHaveBeenLastCalledWith('comedy');
  });

  it('shows only exact-word matches, with no status line, when smart search is idle', async () => {
    await searchFor('comedy');
    expect(cardTitles()).toEqual(['Open mic night']);
    expect(screen.queryByText(/Smart search/)).toBeNull();
    expect(screen.queryByText('Related')).toBeNull();
  });

  it('lists meaning matches after exact matches and tags them Related', async () => {
    useSemanticSearch.mockReturnValue(smart({ status: 'ready', scores: new Map([['skit', 0.62]]) }));
    await searchFor('comedy');
    expect(cardTitles()).toEqual(['Open mic night', 'Airline food roast']);
    expect(screen.getAllByText('Related')).toHaveLength(1);
    const skitCard = screen.getByText('Airline food roast').closest('article');
    expect(within(skitCard).getByText('Related')).toBeInTheDocument();
  });

  it('tags meaning matches in the table view too', async () => {
    useSemanticSearch.mockReturnValue(smart({ status: 'ready', scores: new Map([['skit', 0.62]]) }));
    await searchFor('comedy');
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    const skitRow = screen.getByText('Stand-up routine').closest('tr');
    expect(within(skitRow).getByText('Related')).toBeInTheDocument();
    expect(screen.getAllByText('Related')).toHaveLength(1);
  });

  it('says so while the model is still downloading and keeps exact matches', async () => {
    useSemanticSearch.mockReturnValue(smart({ status: 'loading' }));
    await searchFor('comedy');
    expect(screen.getByText('Smart search loading… showing exact matches for now')).toBeInTheDocument();
    expect(cardTitles()).toEqual(['Open mic night']);
  });

  it('says smart search is unavailable and offers a retry', async () => {
    const retry = vi.fn();
    useSemanticSearch.mockReturnValue(smart({ status: 'error', retry }));
    await searchFor('comedy');
    expect(screen.getByText(/Smart search unavailable — showing exact matches only/)).toBeInTheDocument();
    expect(cardTitles()).toEqual(['Open mic night']);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('disables date ordering only while searching', async () => {
    await searchFor('comedy');
    expect(screen.getByLabelText('Order by date')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: '' } });
    expect(screen.getByLabelText('Order by date')).toBeEnabled();
    expect(cardTitles()).toEqual(['Airline food roast', 'Open mic night', 'Prompt tricks']);
  });
});
```

Append inside the `describe('App baseline', …)` block of `frontend/src/test/App.test.jsx` (this runs the real hook with no Supabase client):

```jsx
  it('searches by exact words without Supabase and shows no smart-search status', async () => {
    const mockReels = ['Comedy writing', 'AI tools'].map((topic, i) => ({
      id: `reel_${i}`,
      title: `Reel Title ${i}`,
      url: `https://instagram.com/reel/abc_${i}/`,
      extracted_json: { core_topic: topic, key_takeaway: '', action_items: [], tools_or_resources: [] },
      created_at: new Date(2026, 5, 20 - i).toISOString(),
      cluster: 'Unclustered',
      status: 'done'
    }));
    globalThis.fetch = vi.fn((input) => {
      const u = String(input);
      if (u.endsWith('/health')) return Promise.resolve({ ok: true });
      if (u.includes('/reels')) return Promise.resolve({ ok: true, json: () => Promise.resolve(mockReels) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    render(<App />);
    await screen.findByText('Reel Title 0');
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'comedy' } });

    expect(screen.getByText('Reel Title 0')).toBeInTheDocument();
    expect(screen.queryByText('Reel Title 1')).toBeNull();
    expect(screen.queryByText(/Smart search/)).toBeNull();
  });
```

Append inside the `describe('ReelCard', …)` block of `frontend/src/test/ReelCard.test.jsx`:

```jsx
  it('shows a Related tag only for meaning matches', () => {
    const { rerender } = render(<ReelCard reel={doneReel} onSelect={() => {}} handleDelete={() => {}} />);
    expect(screen.queryByText('Related')).toBeNull();
    rerender(<ReelCard reel={doneReel} related onSelect={() => {}} handleDelete={() => {}} />);
    expect(screen.getByText('Related')).toBeInTheDocument();
  });
```

Append inside the `describe('InsightsTable', …)` block of `frontend/src/test/InsightsTable.test.jsx`:

```jsx
  it('shows a Related tag only for meaning matches', () => {
    const { rerender } = render(<InsightsTable reels={reels} onSelect={() => {}} handleDelete={() => {}} />);
    expect(screen.queryByText('Related')).toBeNull();
    rerender(<InsightsTable reels={reels} relatedIds={new Set(['r1'])} onSelect={() => {}} handleDelete={() => {}} />);
    expect(screen.getByText('Related')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npm test; cd ..`
Expected: the new tests fail (no `Related` tag, no status line, `Order by date` not disabled, `useSemanticSearch` never called). The new `App.test.jsx` test already passes (exact-word search exists today) — that is fine; it is there to keep that behaviour pinned. Everything that existed before still passes.

- [ ] **Step 3: Implement `ReelCard`.** In `frontend/src/components/ReelCard.jsx`:

Change the signature to:

```jsx
export default function ReelCard({ reel, onSelect, handleDelete, onRetry, checkedActions = {}, related = false }) {
```

Change the `card-badges` block to:

```jsx
        <div className="card-badges">
          <span className="card-topic-badge">{topic.toUpperCase()}</span>
          {mainTool && <span className="card-tool-badge">{mainTool}</span>}
          {related && <span className="related-badge">Related</span>}
        </div>
```

- [ ] **Step 4: Implement `InsightsTable`.** In `frontend/src/components/InsightsTable.jsx`:

Change the signature to:

```jsx
export default function InsightsTable({ reels, onSelect, handleDelete, relatedIds = new Set() }) {
```

Change the topic cell to:

```jsx
                <td>
                  {ej.core_topic || reel.title}
                  {relatedIds.has(reel.id) && <span className="related-badge">Related</span>}
                </td>
```

- [ ] **Step 5: Implement `App.jsx`.**

Add to the imports, after the `IngestionPanel` import:

```jsx
import { rankReels, useSemanticSearch } from './semanticSearch';
```

Directly after the `const [isRecomputing, setIsRecomputing] = useState(false);` line, add:

```jsx
  const smartSearch = useSemanticSearch(searchQuery);
```

Replace the whole `const filteredReels = reels … ;` statement (the three `.filter` calls and the `.sort`) with:

```jsx
  const isSearching = Boolean(searchQuery.trim());
  const dateSortedReels = reels
    .filter(r => clusterFilter === 'All' || (r.cluster || 'Unclustered') === clusterFilter)
    .filter(r => toolFilter === 'All' || (r.extracted_json?.tools_or_resources || []).includes(toolFilter))
    .sort((a, b) => {
      const da = new Date(a.created_at || 0), db = new Date(b.created_at || 0);
      return sortOrder === 'newest' ? db - da : da - db;
    });
  // While searching: exact-word matches first, then meaning matches by closeness.
  const { reels: filteredReels, relatedIds } = rankReels(dateSortedReels, searchQuery, smartSearch.scores);
```

Replace the search `rail-section` block with:

```jsx
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
          </div>
```

Replace the sort `<select>` opening tag with:

```jsx
                <select
                  id="sort-order"
                  value={sortOrder}
                  disabled={isSearching}
                  title={isSearching ? 'Search results are ordered by best match' : undefined}
                  onChange={e => { setSortOrder(e.target.value); setCurrentPage(1); }}
                >
```

Add the `relatedIds` prop to `InsightsTable`:

```jsx
              <InsightsTable
                reels={paginatedReels}
                relatedIds={relatedIds}
                onSelect={handleSelectReel}
                handleDelete={handleDelete}
              />
```

Add the `related` prop to `ReelCard`:

```jsx
                  <ReelCard
                    key={reel.id}
                    reel={reel}
                    related={relatedIds.has(reel.id)}
                    onSelect={handleSelectReel}
                    handleDelete={handleDelete}
                    onRetry={handleRetry}
                    checkedActions={checkedActions}
                  />
```

- [ ] **Step 6: Add the styles.** In `frontend/src/App.css`:

Directly after the `.search-bar svg { … }` rule, add:

```css
.search-status {
  margin: 0.45rem 0 0;
  color: var(--text-muted);
  font-size: 0.75rem;
  line-height: 1.35;
}

.search-status--error {
  color: var(--accent-warning);
}

.search-status-retry {
  margin-left: 0.4rem;
  padding: 0;
  background: none;
  border: 0;
  color: var(--accent-primary);
  font: inherit;
  font-weight: 700;
  text-decoration: underline;
  cursor: pointer;
}
```

Directly after the `.card-topic-badge { color: var(--text-primary); }` rule, add:

```css
.related-badge {
  display: inline-flex;
  align-items: center;
  border: 1px dashed var(--accent-primary);
  border-radius: var(--radius-sm);
  color: var(--accent-primary);
  padding: 0.22rem 0.5rem;
  font-size: 0.68rem;
  font-weight: 800;
  text-transform: uppercase;
  line-height: 1.2;
}

.insights-table .related-badge {
  margin-left: 0.4rem;
}
```

- [ ] **Step 7: Run everything**

Run: `cd frontend && npm test && npm run lint && npm run build; cd ..`
Expected: all tests pass; lint clean; build succeeds and the output lists the transformers runtime as its own chunk, separate from the main `index-*.js` (the dynamic import worked).

- [ ] **Step 8: Commit**

```bash
git add frontend/src
git commit -m "feat(frontend): search by meaning with status line and Related tags

Claude-Session: https://claude.ai/code/session_01MV2z14HLUeGpAd4apqTpCh"
```

---

### Task 9: Real-data check, threshold tuning, docs

**[main session — uses the real database (read-only) and the browser]**

**Files:**
- Modify (only if tuning says so): `frontend/src/semanticSearch.js` (`MATCH_THRESHOLD`)
- Modify: `CLAUDE.md`, `AGENTS.md`, `README.md`

- [ ] **Step 1: Look at real similarity numbers.** Write `$SCRATCH/tune_threshold.py`:

```python
"""Print the closest reels to a query with their similarity. Read-only."""
import json
import sys

import db
import main

query = sys.argv[1]
vector = [float(x) for x in next(iter(main._get_embedding_model().embed([query])))]
client = db.get_client()
matches = client.rpc("match_reels", {
    "query_embedding": vector, "match_threshold": 0.0, "match_count": 40}).execute().data
rows = client.table("saved_reels").select("id, extracted_json").in_(
    "id", [m["id"] for m in matches]).execute().data
topics = {r["id"]: db.row_to_record(r)["extracted_json"].get("core_topic") for r in rows}
print(f"--- {query}")
for m in matches:
    print(f"{m['similarity']:.3f}  {topics.get(m['id'])}")
```

Run it for five searches:

```bash
cd backend && for q in "comedy" "AI" "money" "fitness" "Notion"; do PYTHONPATH=. .venv/Scripts/python.exe "$SCRATCH/tune_threshold.py" "$q"; done; cd ..
```

- [ ] **Step 2: Pick the cut-off.** For each query, find the similarity where the topics stop being about the query. Set `MATCH_THRESHOLD` in `frontend/src/semanticSearch.js` to the value (rounded to 0.05) that keeps the relevant topics for most queries and drops the unrelated tail. If no single value works, prefer slightly too strict: exact-word matches are never affected by the threshold. If it changes from 0.3, no test needs editing (tests import the constant).

- [ ] **Step 3: Try it in the real dashboard.** Start the dev server in the background (`cd frontend && npm run dev`), open the printed localhost URL in Chrome with the `claude-in-chrome` tools, and check:
  - Type `comedy`: the line "Smart search loading… showing exact matches for now" appears on the first search, then goes away; results with a dashed "Related" tag appear below any exact matches.
  - Type a tool name that exists (for example `Notion`): exact matches are listed first.
  - Type one letter: no status line, nothing breaks.
  - Switch to Table view while searching: "Related" tags show in the Topic column.
  - Light and dark theme: the status line and tag are readable in both.
  - Browser console: no errors from the model load or `match_reels`.

  If `match_reels` fails here with a permission error (the dashboard uses the anon key; Task 1 verified with the service key), run in the Supabase SQL editor — after asking the user — `grant execute on function match_reels(vector, float, int) to anon;` and re-check.

  Stop the dev server afterwards.

- [ ] **Step 4: Update `CLAUDE.md` and `AGENTS.md`** (they mirror each other — make the same edits in both).

In "Key behaviors to preserve when editing", add this bullet after the **Transcription failures** bullet:

```markdown
- **Search embeddings:** every save path stores `embed_reel(extracted_json)` (local fastembed over topic + takeaway + tools) in the `embedding` column. It never raises — a reel saves without one and `backfill_embeddings.py` repairs it later. The browser embeds queries with the same model (`Xenova/all-MiniLM-L6-v2`, q8) in `frontend/src/queryEmbedder.js`; changing `EMBEDDING_MODEL_NAME` or the browser model means re-embedding every reel.
```

In "Data layer", after the sentence listing the queue primitives, add:

```markdown
Search embeddings: `reels_missing_embedding`, `set_embedding`, and the optional `embedding` argument on `insert_reel` / `update_reel_result`.
```

In "Frontend", add this bullet after the `api.js` bullet:

```markdown
- `semanticSearch.js` — `rankReels` (exact-word matches first, then meaning matches) and `useSemanticSearch` (embeds the query in the browser via `queryEmbedder.js`, then calls the Supabase `match_reels` function). Without Supabase config, search is exact-word only.
```

Replace the sentence `All filters run **in-memory** over `filteredReels`.` with:

```markdown
Cluster/tool/date filters and exact-word search run **in-memory**; meaning matches come from Supabase (`match_reels`) and are merged in by `rankReels`. A status line under the search bar says when smart search is still loading or unavailable.
```

In "Commands → Backend", add to the code block:

```powershell
# Fingerprint reels that have no search embedding yet (safe to re-run)
python backend/backfill_embeddings.py
```

In "Gotchas", add:

```markdown
- Semantic search needs the `embedding vector(384)` column and the `match_reels` SQL function in Supabase (SQL in `docs/superpowers/specs/2026-10-10-semantic-search-design.md`). The column must exist before backend code that writes it runs.
```

- [ ] **Step 5: Update `README.md`.**

In the features table, after the `**Live Dashboard**` row, add:

```markdown
| **Smart Search** | Search by meaning, not just exact words — the query is embedded in the browser and matched in Supabase (pgvector) |
```

Next to the existing `python backend/check_queue.py` command, add:

```
python backend/backfill_embeddings.py
```

In the file tree, next to the `check_queue.py` line, add:

```
│   ├── backfill_embeddings.py  # Fingerprint reels missing a search embedding
```

- [ ] **Step 6: Final full run**

```bash
backend/.venv/Scripts/python.exe -m pytest backend -q && (cd frontend && npm test && npm run lint && npm run build)
```

Expected: everything passes.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md AGENTS.md README.md frontend/src/semanticSearch.js
git commit -m "docs: semantic search; tune match threshold

Claude-Session: https://claude.ai/code/session_01MV2z14HLUeGpAd4apqTpCh"
```

---

## Rollout (after all tasks — each step only on the user's go-ahead)

1. Merge `feat/semantic-search` into `main` and push to `origin` → Vercel auto-deploys the frontend. Smart search works immediately for every reel that already has an embedding.
2. Deploy the backend to Hugging Face: `git subtree push --prefix=backend hf main`. Until this happens, reels ingested through the hosted backend (URL / file / text from the dashboard) save without an embedding; the local worker (iPhone Shortcut and bulk import) already embeds because it runs from this working tree.
3. Re-run `python backend/backfill_embeddings.py` once after step 2 to catch any reels saved in between.
