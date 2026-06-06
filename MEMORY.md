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
