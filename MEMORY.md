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

**Still uncommitted** — nothing git-committed yet. MVP 2 UI gaps (detail modal, access gate) + MVP 3 deploy remain.
