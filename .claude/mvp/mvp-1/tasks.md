# MVP 1: Backend Extraction Pipeline

Status: in_progress (built, unverified end-to-end against live Groq)

- [x] FastAPI app + CORS + SQLite init (`saved_reels` table)
- [x] `download_and_extract_audio` — yt-dlp + ffmpeg → MP3, caption fallback
- [x] cookies.txt scraping-bypass lookup
- [x] `transcribe_audio` — Groq whisper-large-v3-turbo
- [x] `extract_structured_json` — Groq llama-3.1-8b-instant, forced JSON + Pydantic validation
- [x] 15-word silent-hook short-circuit → HTTP 400
- [x] `/extract/url` (+ URL cache), `/extract/file`, `/extract/text`
- [x] `/reels` list + LIKE search, `/health`
- [x] Dockerfile (HF Spaces, port 7860)
- [x] `verify_pipeline.py` mocked tests
- [x] Live Groq verify — `/extract/text` 200 (found+fixed action_items dict→List[str] 500 bug)
- [x] Edge case: Step-by-Step (chronological order preserved, dict coercion backstop)
- [x] Install ffmpeg + verify `/extract/url` end-to-end (real IG reel, 200, ~3s)
- [x] cookies.txt path verified (backend/cookies.txt → yt-dlp auth works)
- [x] Bumped yt-dlp pin (2024.5.27 → >=2026.3.17; old version broke IG extraction)
- [x] Edge case: Resource Drop — Perplexity/Cursor/ElevenLabs extracted, hook filtered
- [x] Edge case: Silent Hook — `guard_silent_hook` unit-verified (4 cases); factored out + added to `/extract/file` (was missing)
