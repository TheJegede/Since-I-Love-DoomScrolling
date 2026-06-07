# MEMORY — Transcriber

Decision log + session history. Newest first.

## Project snapshot
Instagram Reels → structured-JSON extractor. FastAPI backend (`backend/main.py`, single file) + React/Vite frontend (`frontend/src/App.jsx`, single component). SQLite storage. Groq for Whisper + Llama. Target: $0/month on HF Spaces (backend) + Vercel (frontend).

Code already substantially built — both apps exist and run. This is not a greenfield scaffold.

## Sessions

### 2026-06-06 — init + daddyshome
- Ran `/init` → created `CLAUDE.md` (technical architecture doc).
- Ran `daddyshome` (MCP server down → manual fallback): `git init`, scaffolded `.claude/`, MEMORY.md, ERRORS.md, MVP structure.
- `.claude/settings.json` write was **denied** by auto-mode classifier (broad permission wildcards). Not created — user must add permissions manually if wanted.
- Key code facts captured in CLAUDE.md: 15-word silent-hook short-circuit, forced JSON + `ReelExtraction` Pydantic contract, URL caching, cookies.txt scraping bypass, local port 8000 vs Docker/HF 7860, docs say Supabase but code uses SQLite.

### 2026-06-06 — full verification (MVP 1 complete)
Environment now set up: ffmpeg installed (winget Gyan.FFmpeg, `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\...\bin\ffmpeg.exe` — NOT on session PATH by default, prepend it when running uvicorn). Backend venv at `backend\.venv`.

Bugs found + fixed (see ERRORS.md):
1. `action_items` dict→`List[str]` 500 — validator + prompt example.
2. `/extract/file` missing silent-hook guard — factored `guard_silent_hook`, applied to url+file paths.
Also bumped `yt-dlp` 2024.5.27 → `>=2026.3.17` (old pin broke IG extraction).

Live verified end-to-end through real uvicorn HTTP: `/health`, `/reels`, `/extract/url` on real reel (DY-mNQ_PGRh) → 200 ~3s. Edge cases Resource Drop + Silent Hook pass.

**cookies:** `backend/cookies.txt` copied from user's `Downloads\www.instagram.com_cookies.txt` (has sessionid). Gitignored. WILL EXPIRE → re-export when IG 403s. Needed on HF Space too.

**Servers left running (background):** backend uvicorn :8000, frontend Vite :5173. localhost:8000 reaches backend fine (no IPv6 issue).

**Committed + pushed** — initial commit on `main` → https://github.com/TheJegede/Since-I-Love-DoomScrolling.git (remote `origin`). Secrets/db/logs gitignored, verified absent from staging pre-push. gh CLI NOT installed; push used Git Credential Manager. Default branch was `master`, renamed to `main`.

Also fixed this session: frontend lucide-react `Instagram` icon removed in v1.17.0 → swapped to `Clapperboard` (App.jsx). App now renders.

**Remaining:** MVP 2 UI gaps (detail modal, access gate), MVP 3 deploy (HF Spaces + Vercel). cookies.txt will expire.

### 2026-06-06 — tabular insights + emergent clustering (feature complete on branch `feat/tabular-clustering`)
Built from spec+plan in `docs/plans/2026-06-06-tabular-insights-clustering*.md` via subagent-driven execution (subagent hit session limit after Task 1 → finished inline).
Backend: `cluster` column (idempotent migration), `ClusterAssignment(s)` models + `cluster_topics_with_llm`, `POST /clusters/recompute`, `GET /clusters`, `cluster` in `/reels`. 7/7 mocked tests pass. Live recompute verified (real Groq).
Frontend: cards|table toggle, `InsightsTable`, in-memory filters (cluster/tool/date/search) over `filteredReels`, Recompute button. Vite compiles clean.
Tuned clustering prompt to merge near-duplicate themes (live: 7→4 clusters same data).
Commits 5fe309f, 1404911, 7a3610a, e893c6d on `feat/tabular-clustering` (branched from main; NOT yet merged/pushed).
NOT yet done: real-browser DOM verification of the table UI (only Vite-compile checked); restart backend without --reload picks up edits, so use Stop-Process on :8000 then relaunch.
local_storage.db has junk rows from repeated test seeding (Marathon/AI email) — harmless, gitignored.

### 2026-06-06 — Supabase verification + Vercel deploy (branch `feat/supabase-hybrid`)
- Resumed implementation plan from `docs/superpowers/plans/2026-06-06-vercel-dashboard.md`.
- Completed **Task 3 Step 7 (local test)**: created `frontend/.env.local` containing Supabase variables and local API URL fallback, verified client loads reels successfully from Supabase locally.
- Completed **Task 5 (Vercel deploy)**: 
  - Linked project as `reels-transcriber` under scope `thejegedes-projects` on Vercel.
  - Set production env vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) non-interactively via CLI.
  - Configured custom production domain `reels-transcriber.vercel.app` mapped to latest production deploy.
- Verified live production site in browser (loaded 343 reels directly from Supabase, zero console errors).
- Cleaned up frontend ESLint issues (unused imports and `useEffect` hook order/hoisting issues in `App.jsx`) and verified that `npm run lint` and `npm run build` now pass cleanly.
- Staged and committed changes (`frontend/.gitignore`, `frontend/src/App.jsx`) on branch `feat/supabase-hybrid`.

### 2026-06-06 — Bulk Import of Saved Reels (Task complete on main)
- Created `backend/saved_parser.py` containing the `parse_saved_posts` parser shared by the server and CLI.
- Refactored `backend/batch_import.py` to use the shared parser.
- Modified `backend/main.py` adding `POST /extract/batch`, `GET /extract/batch/status` and `POST /reels/status` to handle stateless batch imports under the Supabase hybrid queue worker model.
- Added tests to `backend/verify_pipeline.py` verifying batch endpoints and parsing logic. All 20 tests pass.
- Modified `frontend/src/App.jsx` adding the `'bulk'` mode tab, file upload zone, status polling, and a dynamic progress bar.
- Cleaned up the local git workspace (merged `feat/supabase-hybrid` into `main`, deleted local feature branch, and pushed to GitHub `origin/main`).
- Committed the Bulk Import feature to `main`, pushed to GitHub `origin/main`, and deployed the backend changes to Hugging Face Spaces (`hf/main` subtree split).
- Local backend health endpoint verified successfully.
