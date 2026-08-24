# ERRORS — Transcriber

Failure log. Record bugs hit, root cause, fix. Newest first.

### 2026-08-23 — /extract and /clusters 500: Groq model 404 llama-3.1-8b-instant
**Symptom:** Ingestion and clustering failed with HTTP 500 `Structured extraction failed: Error code: 404 - {'error': {'message': 'The model llama-3.1-8b-instant does not exist...', 'type': 'invalid_request_error', 'code': 'model_not_found'}}`. Worker marked reels as `failed`.
**Root cause:** Groq removed/decommissioned `llama-3.1-8b-instant` from this tier; model name was hardcoded in `backend/main.py`.
**Fix (`backend/main.py`):** Added `GROQ_LLM_MODEL = os.getenv("GROQ_LLM_MODEL", "qwen/qwen3.6-27b")` and updated `_cluster_one_chunk`, `_merge_cluster_names`, and `extract_structured_json` to use it. Reset failed reels in Supabase back to `pending`.
**Verified:** Live extraction verified with 200 OK using Groq API; full pipeline unit test suite passed.

### 2026-06-06 — Frontend blank: lucide-react has no `Instagram` export
**Symptom:** `localhost:5173` blank; console `SyntaxError: module .../lucide-react.js does not provide an export named 'Instagram' (App.jsx:3)`.
**Root cause:** lucide-react (v1.17.0 installed) dropped brand icons; `Instagram` no longer exported. App.jsx imported + rendered it (lines 3, 279, 338).
**Fix (`frontend/src/App.jsx`):** import `Clapperboard` instead, replaced both `<Instagram .../>` usages. Text strings ("Instagram Reels" / "Instagram Post Caption") left as-is. Verified Clapperboard/Film/Video exist in installed pkg; Instagram does not.
**Note:** other imported icons resolve fine (ESM would've flagged the first missing one). Hard-reload needed after fix.

### 2026-06-06 — Silent-hook guard missing on /extract/file
**Symptom:** silent/music-only audio *uploads* would run a wasted LLM call; only `/extract/url` had the <15-word short-circuit.
**Fix (`backend/main.py`):** factored the check into `guard_silent_hook(transcript, caption)` (threshold `SILENT_HOOK_MIN_WORDS=15`), applied to both `/extract/url` and `/extract/file`. `/extract/text` intentionally has no word gate (pasted text is deliberate).
**Verified:** 4-case unit test — silent+no-caption→400, silent+caption→pass, empty→400, 15+ words→pass.

### 2026-06-06 — /extract 500: action_items dicts vs List[str]
**Symptom:** live `/extract/text` returned HTTP 500 — `ReelExtraction` Pydantic validation: `action_items.N Input should be a valid string ... input_type=dict`.
**Root cause:** `llama-3.1-8b-instant` returned `action_items` as list of objects `{step, action, description}`; schema is `List[str]`. Prompt only described schema in prose. PRD "Step-by-Step" edge case — but triggered on normal input too.
**Fix (`backend/main.py`):** (1) `field_validator(mode="before")` `coerce_list_of_strings` on `action_items` + `tools_or_resources` flattens dict/non-string items to strings (backstop — 8B unreliable). (2) Added explicit JSON-shape example to system prompt forcing string arrays.
**Verified:** live call now 200; unit-tested coercer flattens dicts (`{step,action,description}` → `"action: description"`).
