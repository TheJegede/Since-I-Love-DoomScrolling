# Plan 005: Optimize In-Memory Reels Loading & Exclude Transcripts from List

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9537dd6..HEAD -- backend/db.py backend/main.py frontend/src/App.jsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `9537dd6`, 2026-06-12

## Why this matters

The dashboard loads up to 500 reels at once. In both the direct Supabase read and the FastAPI backend `/reels` endpoint, the query requests all columns (`select("*")`). This includes the full `raw_transcript` and `post_caption` columns. Since transcripts can be thousands of characters long, this over-fetching transfers megabytes of redundant text data to the client, slowing down page loads and consuming excessive bandwidth.

Excluding these large fields from the initial load list and fetching them dynamically only when a user selects a reel modal significantly speeds up the dashboard.

## Current state

- Relevant files:
  - `backend/db.py` — database query definitions.
  - `backend/main.py` — API routes.
  - `frontend/src/App.jsx` — loads reels list and manages selection.
- In `backend/db.py`, `list_reels` selects all columns (line 76):
  ```python
  q = get_client().table(TABLE).select("*").order("created_at", desc=True).limit(limit)
  ```
- In `frontend/src/App.jsx`, `fetchReels` selects all columns (line 111):
  ```javascript
  const { data, error } = await supabase
    .from('saved_reels')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500);
  ```

## Commands you will need

| Purpose   | Command                                                   | Expected on success |
|-----------|-----------------------------------------------------------|---------------------|
| Backend   | `backend/.venv/Scripts/python backend/verify_pipeline.py`     | all 20+ tests pass  |
| Frontend  | `cd frontend && npm run test`                             | all tests pass      |
| Build     | `cd frontend && npm run build`                            | compiles clean      |

## Scope

**In scope**:
- `backend/db.py`
- `backend/main.py`
- `backend/verify_pipeline.py`
- `frontend/src/App.jsx`

**Out of scope**:
- The structure of the `ReelModal` and `ReelCard` component props.

## Steps

### Step 1: Update list_reels in backend/db.py to select specific columns

Open `backend/db.py` and modify `list_reels` to query only metadata columns: `id, url, title, extracted_json, created_at, cluster, status`. Exclude `raw_transcript` and `post_caption`.

Target shape:
```python
def list_reels(limit: int = 20, search: Optional[str] = None) -> list:
    q = get_client().table(TABLE).select("id, url, title, extracted_json, created_at, cluster, status").order("created_at", desc=True).limit(limit)
    if search:
        # UI filters in-memory; this server search is a coarse fallback over text cols.
        like = f"%{search}%"
        q = q.or_(f"title.ilike.{like},raw_transcript.ilike.{like},post_caption.ilike.{like}")
    res = q.execute()
    return [row_to_record(r) for r in (res.data or [])]
```

### Step 2: Implement get_reel_details in backend/db.py

Add `get_reel_details` to `backend/db.py` to allow querying only the large text fields for a specific record.

Target shape:
```python
def get_reel_details(reel_id: str) -> Optional[dict]:
    """Retrieve only raw_transcript and post_caption fields for a reel."""
    res = get_client().table(TABLE).select("raw_transcript, post_caption").eq("id", reel_id).limit(1).execute()
    rows = res.data or []
    return rows[0] if rows else None
```

### Step 3: Implement details API endpoint in backend/main.py

Add a new GET route `@app.get("/reels/{reel_id}/details")` in `backend/main.py` that utilizes `db.get_reel_details(reel_id)`.

Target shape:
```python
@app.get("/reels/{reel_id}/details")
def get_reel_details(reel_id: str):
    """Retrieve full details (transcript and caption) for a specific reel."""
    try:
        details = db.get_reel_details(reel_id)
        if not details:
            raise HTTPException(status_code=404, detail="Reel not found.")
        return details
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching reel details: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch details: {str(e)}")
```

**Verify**: Run `backend/.venv/Scripts/python backend/verify_pipeline.py` to confirm uvicorn endpoints compile and pass tests.

### Step 4: Update fetchReels direct Supabase call in frontend/src/App.jsx

Open `frontend/src/App.jsx` and modify the direct Supabase select query to request only metadata fields.

Target shape:
```javascript
      if (supabase) {
        const { data, error } = await supabase
          .from('saved_reels')
          .select('id, url, title, extracted_json, created_at, cluster, status')
          .order('created_at', { ascending: false })
          .limit(500);
        if (error) throw error;
        const mapped = (data || []).map(rowToRecord);
        setReels(mapped);
        setClusters(computeClusters(mapped));
        return;
      }
```

### Step 5: Implement lazy detail loading on selection in App.jsx

Modify the modal opening trigger inside `App.jsx`.
Currently, selecting a reel sets the state:
`onSelect={(r) => { setSelectedReel(r); setIsTranscriptOpen(false); setIsCaptionOpen(false); }}`

Replace this logic with a custom handler function `handleSelectReel(reel)` in `App.jsx`. It should open the modal immediately using the available metadata, and then query the details endpoint (or Supabase direct select) in the background to fetch `raw_transcript` and `post_caption`. Once fetched, update `selectedReel` with the loaded values and cache them in the local `reels` array to avoid fetching them again if clicked multiple times.

Target shape:
```javascript
  const handleSelectReel = async (reel) => {
    // Set basic metadata first so the modal opens instantly
    setSelectedReel(reel);
    setIsTranscriptOpen(false);
    setIsCaptionOpen(false);
    
    // If we already have the transcript cached locally, skip fetching
    if (reel.raw_transcript !== undefined || reel.post_caption !== undefined) {
      return;
    }

    try {
      let details = null;
      if (supabase) {
        const { data, error } = await supabase
          .from('saved_reels')
          .select('raw_transcript, post_caption')
          .eq('id', reel.id)
          .single();
        if (!error && data) {
          details = data;
        }
      } else {
        const res = await fetch(`${API_BASE_URL}/reels/${reel.id}/details`);
        if (res.ok) {
          details = await res.json();
        }
      }
      
      if (details) {
        const fullReel = { ...reel, ...details };
        setSelectedReel(fullReel);
        // Cache full details inside local state list
        setReels(prev => prev.map(r => r.id === reel.id ? fullReel : r));
      }
    } catch (err) {
      console.error("Failed to load reel details", err);
    }
  };
```

Update references to `onSelect` in `<InsightsTable>` and `<ReelCard>` within `App.jsx` to use `handleSelectReel` instead of direct state setters.

**Verify**: Verify that the frontend test suite runs successfully with `npm run test`, and the build compiles cleanly via `npm run build`.

## Test plan

- Run `backend/.venv/Scripts/python backend/verify_pipeline.py` to ensure backend compatibility.
- Verify dashboard renders cards correctly on mount without transcript data.
- Verify clicking a card triggers a fetch of `details` in `App.test.jsx`.

## Done criteria

- [ ] Initial list queries do not retrieve `raw_transcript` or `post_caption`.
- [ ] Detail endpoints are defined on the backend server.
- [ ] Client component queries detail fields only when selecting a row/card.
- [ ] All tests pass.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- If `db.row_to_record` crashes when fields are missing (handled by optional key checks in `row_to_record`, e.g. `r.get("raw_transcript")`).

## Maintenance notes

- Search filtering on the frontend runs in-memory over the fetched `reels` list. Because the list no longer contains raw transcripts on download, search queries matching transcript text will only match if the reel details have been loaded into memory (e.g. by opening them). However, PRD search notes indicate search should focus on title/topic/takeaways/tools which are still loaded in metadata.
