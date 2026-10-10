# MEMORY — Transcriber

Decision log + session history. Newest first.

## Project snapshot
Instagram Reels → structured-JSON extractor. FastAPI backend (`backend/main.py`, single file) + React/Vite frontend (`frontend/src/App.jsx`, single component). **Supabase** (Postgres) for storage. Groq for Whisper + Llama. Target: $0/month on HF Spaces (backend) + Vercel (frontend).

**End-to-end pipeline is fully live:**
- iPhone Shortcut → Supabase REST insert (pending row) → local worker (`run_worker.py`) processes → transcript + insights → status: done
- Dashboard: `reels-transcriber.vercel.app` reads Supabase directly via supabase-js
- Backend API: `https://whoisluwah-transcriber.hf.space` (HF Spaces, Docker, port 7860)
- Git remotes: `origin` = GitHub, `hf` = HF Spaces

Code already substantially built — both apps exist and run. This is not a greenfield scaffold.

## Gotchas
- HF Space cold-starts take 30–60s after inactivity. Shortcut may time out on first share after a period of idle — just try again.
- `run_worker.py` is the standalone worker (no FastAPI server needed). The FastAPI server (`run_local.ps1`) is separate and needed for Recompute Clusters (LLM call).
- Supabase rejects the service key (`sb_secret_`) when called from PowerShell (detects as browser context). Use Python + db.py for admin queries.
- `backend/check_queue.py` is a handy diagnostic script to inspect pending/failed rows and clean up test inserts.
- New reels have `cluster: null` until the next manual Recompute Clusters — expected.
- `backend/cookies.txt` (Instagram session, gitignored) expires — re-export when IG returns 403. Needed on the HF Space too.

## Sessions

Older session notes were trimmed on 2026-10-10; see git history for the full log.

### 2026-08-24 — Queue error diagnosis, model resilience & recovery
- Diagnosed all 20 non-done/failed rows in Supabase:
  - 5 valid reels had previously failed due to Windows temp/path `[Errno 22]` on query-string URLs.
  - 1 valid reel (`DcJCiNdBv07`) failed on Groq due to `qwen/qwen3.6-27b` reasoning token limit during JSON mode.
  - 13 rows were photo carousels (no video stream); 10 legacy rows were misclassified as `failed` instead of `unsupported_format`.
  - 1 reel (`Dbgrazri4AU`) blocked by Instagram rate limit / 400.
- Updated `backend/main.py`:
  - Default `GROQ_LLM_MODEL` changed to `openai/gpt-oss-120b` with fallback to `openai/gpt-oss-20b` and `qwen/qwen3.6-27b` on extraction and cluster naming failures.
- Updated Supabase statuses:
  - Reclassified 10 photo carousels to `unsupported_format`.
  - Reset the 6 recoverable reels to `pending` and ran `run_worker.py --drain`.
- Verified all 6 reels processed to `status: done` with high-quality transcripts and extracted JSON (total done rows increased from 632 to 638). All 32 pipeline tests in `verify_pipeline.py` pass.
