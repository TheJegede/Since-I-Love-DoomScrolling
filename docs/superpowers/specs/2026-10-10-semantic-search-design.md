# Semantic search — design

Date: 2026-10-10
Status: awaiting review

## In plain words

Today the search bar only finds reels that contain the exact words you type.
After this change it also finds reels that are *about* what you typed — search
"comedy" and get the funny reels even if none of them say "comedy".

How: every reel gets a "meaning fingerprint" (an embedding — a list of 384
numbers; reels about similar things get similar numbers). When you search, the
browser fingerprints your text the same way and asks Supabase for the reels
with the closest fingerprints.

No AI provider is called at search time. Cost stays $0.

## What was agreed

- Search returns related reels. No AI-written answers (that would be RAG and
  needs an LLM call per question — out of scope).
- The search text is fingerprinted **in the browser**, not on the backend, so
  search never waits on a sleeping Hugging Face Space.
- Exact-word matching stays and ranks first.
- The user is always told which mode search is in (loading / failed). Search
  never blocks or breaks.

## Step 0 — compatibility check (do this first)

The backend fingerprints reels with fastembed
(`sentence-transformers/all-MiniLM-L6-v2`). The browser will fingerprint the
query with transformers.js (`Xenova/all-MiniLM-L6-v2`, mean pooling,
normalized). These are the same model in two packagings; they must produce
near-identical vectors or results will be garbage.

Throwaway check: embed ~10 sample strings with both, compare pairwise.
**Pass:** cosine similarity ≥ 0.98 for every string.
**Fail:** stop. Do not build the rest; revisit the design (most likely fall
back to fingerprinting the query on the backend).

## Database (Supabase SQL Editor — run by hand, before deploying code)

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

- The function runs with the caller's permissions, so the anon key sees only
  what it can already read from `saved_reels`. No new exposure.
- No vector index. A plain scan is fast at this library size; add one only if
  search gets slow.
- **Rollout order matters:** the column must exist before the backend change
  ships, otherwise inserts that include `embedding` fail.

## Backend

**`main.py`**
- `_reel_embedding_text(extracted_json) -> str` — joins `core_topic`,
  `key_takeaway` and `tools_or_resources`.
- `embed_reel(extracted_json) -> Optional[List[float]]` — reuses the existing
  cached `_get_embedding_model()`. Any failure (missing dependency, model load
  error, empty text) is logged as a warning and returns `None`. It never
  raises: a reel must still save if fingerprinting breaks.
- The four save sites (`process_reel_url`, the worker's `update_reel_result`
  call, `/extract/file`, `/extract/text`) pass `embedding=embed_reel(...)`.
- Clustering is left as is.

**`db.py`**
- `insert_reel` and `update_reel_result` take an optional `embedding`. It is
  added to the payload only when not `None`.
- `reels_missing_embedding() -> list` — `done` rows where `embedding` is null
  (`id, extracted_json`), paged.
- `set_embedding(reel_id, embedding) -> None`.

**`backfill_embeddings.py`** (new, standalone like `check_queue.py`)
- Fingerprints every reel returned by `reels_missing_embedding()` in batches
  and writes them back. Safe to re-run; it only touches rows still missing one.
  Also the repair tool for reels whose fingerprint failed at save time.

## Frontend

**Dependency:** `@huggingface/transformers`, loaded with a dynamic `import()`
so the main bundle does not grow. The model files (~25MB) download on the
first search on a device and are cached by the browser after that.

**`src/semanticSearch.js`** (new)
- `rankReels(reels, query, scores)` — pure function. A reel is kept if it
  matches by keyword (today's rule) or has a score. Rank =
  `(keyword match ? 1 : 0) + (similarity or 0)`, highest first. Returns the
  reels plus which ones matched by meaning only.
- `useSemanticSearch(query)` — hook returning
  `{ status, scores, retry }` where `status` is
  `idle | loading | ready | error` and `scores` is a `Map<id, similarity>`.
  - Model loading starts on the first non-empty query, not on page load.
  - Queries are debounced (300ms); responses for an outdated query are dropped.
  - Calls `supabase.rpc('match_reels', …)` with `MATCH_THRESHOLD` (start 0.3)
    and `MATCH_COUNT` (100) — constants at the top of the file.
  - Without a Supabase client (the `GET /reels` fallback mode) it stays `idle`
    and search is keyword-only.

**`App.jsx`**
- The search step of `filteredReels` uses `rankReels`. Cluster / tool / date
  filters still apply on top.
- While the search box has text, results are ordered by rank. The
  newest/oldest order applies again when the box is empty.
- Status line under the search bar:
  - `loading` → "Smart search loading… showing exact matches for now"
  - `error` → "Smart search unavailable — showing exact matches only" + Retry
  - `ready` / `idle` → nothing
- Styles go in `App.css` (no inline styles).

**`ReelCard.jsx`, `InsightsTable.jsx`**
- Reels that matched by meaning only get a small "related" tag.

## Failure behaviour

| What breaks | What the user sees |
|---|---|
| Model still downloading | Loading line; exact-word results |
| Model fails to load | Error line + Retry; exact-word results |
| Supabase RPC errors | Error line + Retry; exact-word results |
| Reel has no fingerprint yet | It is simply found by exact words only |
| Fingerprinting fails at save | Reel saves normally; backfill fixes it later |

## Testing

- **pytest (mocked, no real DB):** every save path passes an embedding;
  `embed_reel` failure returns `None` and the reel still saves; backfill only
  updates rows missing an embedding.
- **Vitest:** `rankReels` ordering and the keyword-only case; hook states
  (`loading` → `ready`, `error` → `retry`) with the model and RPC mocked;
  App renders the status line and the "related" tag.
- **By hand, on real data:** tune `MATCH_THRESHOLD` using a few real searches
  ("comedy", "AI", a tool name). Expect the first value to be too loose or too
  tight.

## Out of scope

- AI-written answers over the reels (RAG).
- Searching inside transcripts. Note: today's keyword search lists
  `raw_transcript` and `post_caption`, but the dashboard never loads those
  columns from Supabase, so transcript text is not actually searched. Left
  alone here.
- Reusing stored fingerprints to speed up cluster recompute.
