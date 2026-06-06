# Sub-project A: SQLite → Supabase Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all persistence from local SQLite (`local_storage.db`) to Supabase Postgres behind a thin `db.py` data layer, adding the `status`/`source`/`error` columns that turn the table into the hybrid queue.

**Architecture:** Introduce `backend/db.py` wrapping the `supabase-py` client. All data access in `main.py` (cache lookup, save, `/reels`, `/clusters`, recompute) routes through `db.py`. A one-time script copies existing SQLite rows into Supabase. The backend uses the **service role key** (bypasses RLS). Anon keys + RLS policies are added later in sub-projects C/D.

**Tech Stack:** FastAPI, `supabase-py`, Supabase Postgres. Tests via `verify_pipeline.py` — DB layer is **mocked** (monkeypatch `db.*`); `db.py` itself is verified manually against the real Supabase project.

---

## Prerequisites (do before Task 1)

1. **Bulk-import Tasks 1–2 merged** — this plan assumes `process_reel_url` exists in `main.py` (extracted from `extract_url`). If not yet done, complete those first.
2. **Supabase project created** (free tier). Note `SUPABASE_URL`, the **service_role** key (Settings → API), and the **anon** key (for later C/D).
3. **Run the schema DDL** in Supabase SQL Editor:

```sql
create table if not exists saved_reels (
  id text primary key,
  url text unique,
  title text,
  raw_transcript text,
  post_caption text,
  extracted_json jsonb not null,
  created_at timestamptz not null default now(),
  cluster text,
  status text not null default 'done',   -- pending | processing | done | failed
  source text,                           -- share | bulk | url | file | text
  error text
);
create index if not exists saved_reels_status_idx on saved_reels (status);
create index if not exists saved_reels_created_idx on saved_reels (created_at desc);
```

RLS stays **disabled** for now (service key bypasses it anyway). Policies for the anon insert/select keys land in sub-projects C and D.

---

### Task 1: Dependency, config, and `db.py` skeleton

**Files:**
- Modify: `backend/requirements.txt`
- Create: `backend/db.py`
- Modify: `backend/.env` / repo `.env` (add Supabase config — not committed)
- Test: `backend/verify_pipeline.py`

- [ ] **Step 1: Add the dependency**

In `backend/requirements.txt`, add a line:

```
supabase
```

Then install into the venv:

Run: `backend/.venv/Scripts/python.exe -m pip install supabase`
Expected: installs `supabase` + deps successfully.

- [ ] **Step 2: Write the failing test**

Add to `backend/verify_pipeline.py` (before `__main__`):

```python
def test_db_module_surface():
    print("Testing db.py exposes the expected data-layer functions...")
    import db
    for fn in ("get_reel_by_url", "insert_reel", "list_reels",
               "reels_for_clustering", "set_cluster", "cluster_counts",
               "row_to_record"):
        assert hasattr(db, fn), f"db.{fn} missing"
    print("[OK] db module surface passed!")
```

Register in `__main__`:

```python
    test_db_module_surface()
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python backend/verify_pipeline.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'db'`.

- [ ] **Step 4: Create `backend/db.py`**

```python
"""Supabase-backed data layer for Transcriber.

All persistence goes through this module so main.py never touches the DB driver
directly. The backend authenticates with the Supabase SERVICE ROLE key (bypasses
RLS) and must only ever run on a trusted machine.
"""
import json
import os
import uuid
from collections import Counter
from datetime import datetime, timezone
from typing import Optional

from supabase import create_client, Client

TABLE = "saved_reels"
_client: Optional[Client] = None


def get_client() -> Client:
    """Lazily create the Supabase client so importing db.py never needs creds."""
    global _client
    if _client is None:
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_SERVICE_KEY")
        if not url or not key:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.")
        _client = create_client(url, key)
    return _client


def row_to_record(r: dict) -> dict:
    """Map a raw DB row to the API record shape the frontend expects."""
    ej = r.get("extracted_json")
    if isinstance(ej, str):
        ej = json.loads(ej)
    return {
        "id": r["id"],
        "url": r.get("url"),
        "title": r.get("title"),
        "raw_transcript": r.get("raw_transcript"),
        "post_caption": r.get("post_caption"),
        "extracted_json": ej,
        "created_at": r.get("created_at"),
        "cluster": r.get("cluster") or "Unclustered",
    }


def get_reel_by_url(url: str) -> Optional[dict]:
    res = get_client().table(TABLE).select("*").eq("url", url).limit(1).execute()
    rows = res.data or []
    return row_to_record(rows[0]) if rows else None


def insert_reel(url, title, raw_transcript, post_caption, extracted_json,
                status="done", source=None) -> dict:
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
    get_client().table(TABLE).insert(row).execute()
    return row_to_record(row)


def list_reels(limit: int = 20, search: Optional[str] = None) -> list:
    q = get_client().table(TABLE).select("*").order("created_at", desc=True).limit(limit)
    if search:
        # UI filters in-memory; this server search is a coarse fallback over text cols.
        like = f"%{search}%"
        q = q.or_(f"title.ilike.{like},raw_transcript.ilike.{like},post_caption.ilike.{like}")
    res = q.execute()
    return [row_to_record(r) for r in (res.data or [])]


def reels_for_clustering() -> list:
    res = get_client().table(TABLE).select("id, extracted_json").execute()
    return res.data or []


def set_cluster(reel_id: str, cluster: str) -> None:
    get_client().table(TABLE).update({"cluster": cluster}).eq("id", reel_id).execute()


def cluster_counts() -> list:
    res = get_client().table(TABLE).select("cluster").execute()
    counts = Counter((r.get("cluster") or "Unclustered") for r in (res.data or []))
    return [{"name": name, "count": n}
            for name, n in sorted(counts.items(), key=lambda kv: -kv[1])]
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python backend/verify_pipeline.py`
Expected: PASS — `[OK] db module surface passed!` (no Supabase connection needed; functions exist).

- [ ] **Step 6: Commit**

```bash
git add backend/requirements.txt backend/db.py backend/verify_pipeline.py
git commit -m "feat(backend): add Supabase db.py data layer (no wiring yet)"
```

---

### Task 2: Wire `main.py` to `db.py`

**Files:**
- Modify: `backend/main.py` — remove `sqlite3` usage; call `db.*`. Affected: imports + `init_local_db` (`main.py:32-65`), `save_to_database` (`323-371`), `process_reel_url` cache check, `/reels` (`379-422`), `/clusters/recompute` (`424-466`), `/clusters` (`468-480`)
- Modify: `backend/verify_pipeline.py` — rework DB-dependent tests to mock `db.*`

- [ ] **Step 1: Update the DB-dependent tests first**

In `backend/verify_pipeline.py`:

(a) **Delete** `test_cluster_column_migration` (no more PRAGMA/SQLite) and its call in `__main__`.

(b) **Replace** `test_recompute_clusters_mock` with a db-mocked version:

```python
def test_recompute_clusters_mock():
    print("Testing POST /clusters/recompute (db + llm mocked)...")
    import main
    fake_rows = [
        {"id": "a", "extracted_json": {"core_topic": "AI email tools"}},
        {"id": "b", "extracted_json": {"core_topic": "Marathon training"}},
    ]
    applied = []
    orig_for = main.db.reels_for_clustering
    orig_set = main.db.set_cluster
    orig_counts = main.db.cluster_counts
    orig_llm = main.cluster_topics_with_llm
    main.db.reels_for_clustering = lambda: fake_rows
    main.db.set_cluster = lambda rid, cluster: applied.append((rid, cluster))
    main.db.cluster_counts = lambda: [{"name": "Productivity", "count": 1},
                                      {"name": "Fitness", "count": 1}]
    main.cluster_topics_with_llm = lambda items: [
        {"id": "a", "cluster": "Productivity"}, {"id": "b", "cluster": "Fitness"}]
    try:
        r = client.post("/clusters/recompute")
        assert r.status_code == 200, r.text
        assert r.json()["assigned"] == 2, r.text
        assert ("a", "Productivity") in applied
        print("[OK] recompute clusters passed!")
    finally:
        main.db.reels_for_clustering = orig_for
        main.db.set_cluster = orig_set
        main.db.cluster_counts = orig_counts
        main.cluster_topics_with_llm = orig_llm
```

(c) **Replace** `test_list_clusters` and `test_reels_include_cluster` with db-mocked versions:

```python
def test_list_clusters():
    print("Testing GET /clusters (db mocked)...")
    import main
    orig = main.db.cluster_counts
    main.db.cluster_counts = lambda: [{"name": "AI Tools", "count": 3}]
    try:
        r = client.get("/clusters")
        assert r.status_code == 200, r.text
        assert r.json()[0]["name"] == "AI Tools"
        print("[OK] list clusters passed!")
    finally:
        main.db.cluster_counts = orig


def test_reels_include_cluster():
    print("Testing GET /reels includes cluster (db mocked)...")
    import main
    orig = main.db.list_reels
    main.db.list_reels = lambda limit=20, search=None: [{
        "id": "x", "url": None, "title": "t", "raw_transcript": None,
        "post_caption": None, "extracted_json": {"core_topic": "c"},
        "created_at": "2026-06-06T00:00:00Z", "cluster": "Unclustered"}]
    try:
        r = client.get("/reels")
        assert r.status_code == 200, r.text
        assert "cluster" in r.json()[0]
        print("[OK] reels include cluster passed!")
    finally:
        main.db.list_reels = orig
```

(d) **Update** `test_extract_text_mock`: replace the `main.save_to_database` monkeypatch target — it stays the same function, but it now calls `db.insert_reel`. Simplest: keep mocking `main.save_to_database` exactly as today (it still exists as a function). **No change needed** to `test_extract_text_mock` since it already replaces `main.save_to_database` wholesale.

(e) **Update** `test_extract_url_regression` (from bulk-import Task 2): it already mocks `main.save_to_database` and `main.download_and_extract_audio`. The only DB call left in `process_reel_url` is the cache check. Add a mock for it:

```python
    orig_cache = main.db.get_reel_by_url
    main.db.get_reel_by_url = lambda url: None
```

and restore it in the `finally` block:

```python
    main.db.get_reel_by_url = orig_cache
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python backend/verify_pipeline.py`
Expected: FAIL — `AttributeError: module 'main' has no attribute 'db'` (main.py doesn't import db yet).

- [ ] **Step 3: Rewire imports + remove SQLite init**

In `backend/main.py`:

(a) Remove `import sqlite3` (line 32) and add near the other local imports:

```python
import db
```

(b) Replace the `DB_PATH = ...` line and the whole `init_local_db` function (`main.py:34-60`) with:

```python
def init_local_db():
    """Schema is managed in Supabase (see docs). This only verifies config presence."""
    if not os.getenv("SUPABASE_URL") or not os.getenv("SUPABASE_SERVICE_KEY"):
        logger.warning("SUPABASE_URL / SUPABASE_SERVICE_KEY not set — DB calls will fail.")
    else:
        logger.info("Supabase configuration detected.")
```

(The call `init_local_db()` at line 65 stays.)

- [ ] **Step 4: Rewrite `save_to_database`**

Replace the whole `save_to_database` function (`main.py:323-371`) with:

```python
def save_to_database(
    url: Optional[str],
    title: str,
    raw_transcript: Optional[str],
    post_caption: Optional[str],
    extracted: ReelExtraction,
) -> dict:
    """Persist a record via the Supabase data layer, returning the saved record.
    If the URL already exists, returns the existing row (cache/idempotency)."""
    if url:
        existing = db.get_reel_by_url(url)
        if existing:
            logger.info(f"Reel already exists. ID: {existing['id']}")
            return existing
    return db.insert_reel(
        url=url,
        title=title,
        raw_transcript=raw_transcript,
        post_caption=post_caption,
        extracted_json=extracted.model_dump(),
        source=None,
    )
```

- [ ] **Step 5: Rewrite the cache check in `process_reel_url`**

In `process_reel_url`, replace the SQLite cache-lookup `try/except` block (the `sqlite3.connect` ... `SELECT ... WHERE url = ?` section) with:

```python
    # Cache: skip inference if we already have this URL
    cached = db.get_reel_by_url(url)
    if cached:
        logger.info(f"Returning cached record for URL: {url}")
        return cached
```

- [ ] **Step 6: Rewrite `/reels`**

Replace the body of `list_reels` (`main.py:379-422`) with:

```python
@app.get("/reels")
def list_reels(
    limit: int = Query(20, description="Max number of items to return"),
    search: Optional[str] = Query(None, description="Search across title/transcript/caption"),
):
    """Retrieve saved reels from Supabase."""
    try:
        return db.list_reels(limit=limit, search=search)
    except Exception as e:
        logger.error(f"Error fetching reels: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch reels: {str(e)}")
```

- [ ] **Step 7: Rewrite `/clusters/recompute` and `/clusters`**

Replace `recompute_clusters` (`main.py:424-466`) with:

```python
@app.post("/clusters/recompute")
def recompute_clusters():
    """Regroup all saved reels into emergent topic clusters via one LLM call."""
    try:
        rows = db.reels_for_clustering()
        if not rows:
            return {"clusters": [], "assigned": 0}

        items = []
        for r in rows:
            ej = r.get("extracted_json")
            if isinstance(ej, str):
                try:
                    ej = json.loads(ej)
                except Exception:
                    ej = {}
            items.append({"id": r["id"], "topic": (ej or {}).get("core_topic", "")})

        assignments = cluster_topics_with_llm(items)
        valid_ids = {r["id"] for r in rows}
        applied = 0
        for a in assignments:
            if a.get("id") in valid_ids and a.get("cluster"):
                db.set_cluster(a["id"], a["cluster"])
                applied += 1

        logger.info(f"Recomputed clusters: assigned {applied} of {len(rows)} reels.")
        return {"clusters": db.cluster_counts(), "assigned": applied}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Cluster recompute failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Cluster recompute failed: {str(e)}")
```

Replace `list_clusters` (`main.py:468-480`) with:

```python
@app.get("/clusters")
def list_clusters():
    """Return emergent clusters with reel counts."""
    try:
        return db.cluster_counts()
    except Exception as e:
        logger.error(f"Failed to list clusters: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to list clusters: {str(e)}")
```

> Note: the recompute rollback-on-failure behavior changes — updates are now per-row, not one transaction. Acceptable for personal scale; partial assignment on a mid-call failure is harmless (clusters are advisory). Flag in commit message.

- [ ] **Step 8: Run tests to verify they pass**

Run: `python backend/verify_pipeline.py`
Expected: PASS — all tests green, including the reworked recompute/clusters/reels and the regression test.

- [ ] **Step 9: Commit**

```bash
git add backend/main.py backend/verify_pipeline.py
git commit -m "refactor(backend): route all persistence through Supabase db.py (drop SQLite)

Recompute now updates clusters per-row instead of one transaction."
```

---

### Task 3: One-time SQLite → Supabase migration script

**Files:**
- Create: `backend/migrate_sqlite_to_supabase.py`

- [ ] **Step 1: Write the migration script**

```python
"""One-time copy of existing local_storage.db rows into Supabase.

Run once after the Supabase schema exists and .env has SUPABASE creds:
    backend/.venv/Scripts/python.exe backend/migrate_sqlite_to_supabase.py

Idempotent: skips URLs already present in Supabase. Rows are imported as
status='done', source='migrated'.
"""
import json
import os
import sqlite3
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from dotenv import load_dotenv
load_dotenv()
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

import db  # noqa: E402

SQLITE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "local_storage.db")


def main():
    if not os.path.exists(SQLITE_PATH):
        print(f"No SQLite DB at {SQLITE_PATH}; nothing to migrate.")
        return 0
    conn = sqlite3.connect(SQLITE_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, url, title, raw_transcript, post_caption, extracted_json, created_at, cluster "
        "FROM saved_reels"
    ).fetchall()
    conn.close()
    print(f"Found {len(rows)} local rows.")

    client = db.get_client()
    migrated = skipped = failed = 0
    for r in rows:
        url = r["url"]
        if url and db.get_reel_by_url(url):
            skipped += 1
            continue
        try:
            ej = r["extracted_json"]
            ej = json.loads(ej) if isinstance(ej, str) else ej
            client.table(db.TABLE).insert({
                "id": r["id"],
                "url": url,
                "title": r["title"],
                "raw_transcript": r["raw_transcript"],
                "post_caption": r["post_caption"],
                "extracted_json": ej,
                "created_at": r["created_at"],
                "cluster": r["cluster"],
                "status": "done",
                "source": "migrated",
            }).execute()
            migrated += 1
        except Exception as e:
            print(f"  failed {r['id']}: {e}")
            failed += 1
    print(f"Done. migrated={migrated} skipped={skipped} failed={failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run the migration (manual, against real Supabase)**

Ensure `.env` has `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`, then:

Run: `backend/.venv/Scripts/python.exe backend/migrate_sqlite_to_supabase.py`
Expected: `Found N local rows.` then `Done. migrated=N skipped=0 failed=0`. Re-running prints `skipped=N` (idempotent).

- [ ] **Step 3: Verify in Supabase**

In the Supabase Table Editor, confirm `saved_reels` row count matches the local DB. Spot-check one row's `extracted_json` renders as JSON (jsonb), not a string.

- [ ] **Step 4: Commit**

```bash
git add backend/migrate_sqlite_to_supabase.py
git commit -m "feat(backend): one-time SQLite to Supabase migration script"
```

---

### Task 4: Manual end-to-end verification

No code — confirm the live app works on Supabase.

- [ ] **Step 1: Start the backend**

Run: `backend/run_local.ps1`
Expected: logs `Supabase configuration detected.` and boots with no SQLite references.

- [ ] **Step 2: Exercise the endpoints**

Run: `curl -s "http://localhost:8000/reels?limit=3"`
Expected: returns migrated rows as JSON with `cluster` fields.

Run: `curl -s "http://localhost:8000/clusters"`
Expected: returns `[{name, count}, ...]`.

- [ ] **Step 3: Process one new reel end-to-end**

Run: `curl -s -X POST "http://localhost:8000/extract/url" -H "Content-Type: application/json" -d "{\"url\": \"https://www.instagram.com/reel/<a-saved-one>/\"}"`
Expected: 200 with an extracted record; the row appears in Supabase. Re-POSTing the same URL returns the cached row instantly (cache works against Supabase).

- [ ] **Step 4: Confirm tests still pass**

Run: `python backend/verify_pipeline.py`
Expected: all green.

---

## Self-Review

- **Spec coverage (sub-project A):** storage swap to Supabase ✓ (`db.py` + main wiring, Tasks 1–2); `status`/`source`/`error` columns ✓ (DDL prereq); existing rows imported as `done` ✓ (Task 3, source='migrated'); config `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` service-role local-only ✓; `LIKE`/jsonb risk addressed ✓ (server search reduced to text cols, noted UI filters in-memory). RLS/anon keys explicitly deferred to C/D ✓.
- **Placeholder scan:** none — every step has full code/commands. `<a-saved-one>` in Task 4 Step 3 is a deliberate user-supplied URL, not a code placeholder.
- **Type consistency:** `db.list_reels(limit, search)`, `db.get_reel_by_url(url)`, `db.insert_reel(...)`, `db.reels_for_clustering()`, `db.set_cluster(id, cluster)`, `db.cluster_counts()`, `db.row_to_record(r)` — signatures match across `db.py`, `main.py` callers, the migration script, and the test mocks. Record shape from `row_to_record` matches `ExtractionResponse` / frontend expectations (`id,url,title,raw_transcript,post_caption,extracted_json,created_at,cluster`).
- **Dependency note:** assumes `process_reel_url` exists (bulk-import Task 2). Stated in Prerequisites.
```
