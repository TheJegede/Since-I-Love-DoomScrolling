# 🎬 Transcriber — Instagram Reels Knowledge Extractor

> **$0/month** AI pipeline that turns Instagram Reels into structured, searchable knowledge.

[![Live Dashboard](https://img.shields.io/badge/Dashboard-reels--transcriber.vercel.app-blue?style=flat-square)](https://reels-transcriber.vercel.app)
[![Backend API](https://img.shields.io/badge/API-HF%20Spaces-yellow?style=flat-square)](https://whoisluwah-transcriber.hf.space)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](#)

Educational and tool-focused short-form videos are full of high-density, actionable information — but it's locked inside audio you can't search, copy, or organize. **Transcriber** fixes that. Share a Reel from your iPhone, and within ~30 seconds you get a fully transcribed, AI-summarized card in your personal knowledge dashboard with core topics, action items, tools, and key takeaways — all searchable and clustered by theme.

---

## ✨ Features

| Feature | Description |
|---|---|
| **URL Ingestion** | Paste any Instagram Reel URL and let the pipeline handle the rest |
| **iPhone Shortcut** | Share directly from the Instagram app; Supabase queue + local worker process it silently |
| **Bulk Import** | Upload Instagram's `saved_posts.json` export to batch-process hundreds of saved reels |
| **File Upload** | Drag-and-drop an audio file if the scraper can't reach the reel |
| **Text Paste** | Copy-paste a caption or transcript directly for LLM extraction |
| **AI Extraction** | Groq Whisper transcribes audio; Llama 3.1 8B extracts structured JSON insights |
| **Clustering** | Emergent topic clustering groups your reels into themes automatically |
| **Live Dashboard** | Filter by cluster, tool, date, or keyword — all in-memory, instant |
| **Delete** | Remove any reel from the dashboard and database in one click |

---

## 🏗️ Architecture

```
iPhone Shortcut ──► Supabase REST (pending row)
                                │
                    ┌───────────▼────────────┐
                    │   local run_worker.py  │  ← residential IP required
                    │  (drains queue items)  │      for Instagram scraping
                    └───────────┬────────────┘
                                │
              yt-dlp → ffmpeg → Groq Whisper → Groq Llama → Supabase (done)
                                │
              ┌─────────────────▼─────────────────┐
              │  React/Vite Dashboard (Vercel)     │
              │  reads Supabase directly (anon)    │
              │  writes via FastAPI backend (HF)   │
              └───────────────────────────────────┘
```

### Components

| Layer | Stack | Host |
|---|---|---|
| **Backend API** | Python 3.11 · FastAPI · Uvicorn | Hugging Face Spaces (free CPU Docker) |
| **Worker** | `run_worker.py` (standalone, no server) | Your local machine |
| **Frontend** | React 19 · Vite · supabase-js | Vercel (free hobby) |
| **Database** | Supabase Postgres (`saved_reels` table) | Supabase (free tier) |
| **Transcription** | Groq Whisper (`whisper-large-v3-turbo`) | Groq (free tier) |
| **LLM** | Groq Llama (`llama-3.1-8b-instant`) | Groq (free tier) |
| **Scraping** | yt-dlp + ffmpeg + Instagram cookies | Local only |

> ⚠️ Instagram blocks datacenter IPs. Reel downloads **must** run via the local worker on a residential machine — the HF backend handles all other API routes.

---

## 📐 Data Schema

Every processed reel produces a validated JSON payload:

```json
{
  "core_topic": "string",
  "key_takeaway": "string",
  "action_items": ["string", "..."],
  "tools_or_resources": ["string", "..."]
}
```

Rows in Supabase also carry: `id` (UUID), `url`, `title`, `raw_transcript`, `post_caption`, `cluster`, `status`, `created_at`, `attempt_count`, `processing_started_at`, and `next_attempt_at`.

---

## 🚀 Quick Start

### Prerequisites

- **Python 3.11+** and **Node.js 18+**
- **ffmpeg** on your PATH (Windows: `winget install Gyan.FFmpeg`, then add the `bin/` folder to PATH)
- A free [Groq](https://console.groq.com) API key
- A free [Supabase](https://supabase.com) project with the `saved_reels` table (see [Database Setup](#database-setup))

### 1. Clone the repo

```bash
git clone https://github.com/TheJegede/Since-I-Love-DoomScrolling.git
cd Since-I-Love-DoomScrolling
```

### 2. Backend setup

```powershell
# Create and populate root .env
cp .env.example .env   # then fill in your keys (see Config section)

# Install deps + start the FastAPI server (port 8000) with auto-reload
backend/run_local.ps1
```

Or manually:

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### 3. Local worker (for iPhone Shortcut / queue processing)

```powershell
# In a separate terminal — drains pending Supabase rows
python backend/run_worker.py
```

### 4. Frontend setup

```powershell
cd frontend
cp .env.example .env.local   # fill in VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm install
npm run dev                  # opens http://localhost:5173
```

---

## ⚙️ Configuration

### Backend (`backend/.env` or root `.env`)

| Variable | Description |
|---|---|
| `GROQ_API_KEY` | Your Groq API key |
| `SUPABASE_URL` | Supabase project URL (e.g. `https://xxx.supabase.co`) |
| `SUPABASE_SERVICE_KEY` | Supabase **service role** key (`sb_secret_…`) — never expose to browser |
| `ENABLE_WORKER` | Set to `0` to disable the background worker thread inside FastAPI |
| `WORKER_STALE_MINUTES` | Recover abandoned processing claims older than this many minutes on startup (default: `30`) |

### Frontend (`frontend/.env.local`)

| Variable | Description |
|---|---|
| `VITE_SUPABASE_URL` | Same Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase **anon/publishable** key (`sb_publishable_…`) — safe for browser |
| `VITE_API_URL` | Backend URL (e.g. `https://whoisluwah-transcriber.hf.space`). Omit locally — defaults to `http://localhost:8000` |

---

## 🗄️ Database Setup

Run the following in your Supabase SQL Editor to create the table and required policies:

```sql
-- Create table
CREATE TABLE IF NOT EXISTS saved_reels (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url         TEXT UNIQUE,
  title       TEXT,
  raw_transcript TEXT,
  post_caption   TEXT,
  extracted_json TEXT,
  cluster        TEXT,
  status         TEXT DEFAULT 'done',
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- Allow anonymous reads (dashboard)
CREATE POLICY "anon select" ON saved_reels FOR SELECT TO anon USING (true);

-- Allow anonymous inserts (iPhone Shortcut via REST - restricted to pending reels only)
CREATE POLICY "anon insert" ON saved_reels FOR INSERT TO anon 
WITH CHECK (
  status = 'pending' 
  AND url LIKE 'https://%instagram.com/reel/%'
);

-- Enable RLS
ALTER TABLE saved_reels ENABLE ROW LEVEL SECURITY;

-- Worker recovery/retry metadata (run this on existing installations)
ALTER TABLE public.saved_reels
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS saved_reels_queue_ready_idx
  ON public.saved_reels (status, next_attempt_at, created_at);
```

---

## 📱 iPhone Shortcut Setup

The Shortcut lets you share any Reel directly from the Instagram app to your dashboard:

1. In the Shortcuts app, create a new shortcut triggered by the **Share Sheet** (filter: URLs).
2. Add a **"Get contents of URL"** action:
   - **URL:** `https://<your-supabase-project>.supabase.co/rest/v1/saved_reels`
   - **Method:** POST
   - **Headers:** `apikey: <anon key>`, `Content-Type: application/json`, `Prefer: return=minimal`
   - **Body (JSON):** `{ "url": <URLs variable>, "status": "pending" }`
3. The row lands in Supabase; your local `run_worker.py` picks it up and processes it within ~30 seconds.

> ⚠️ HF Spaces cold-starts take 30–60 seconds. If the Shortcut times out on first share after a period of inactivity, just try again.

---

## 🔌 API Reference

Base URL (local): `http://localhost:8000` · (production): `https://whoisluwah-transcriber.hf.space`

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check — used by the frontend to detect cold starts |
| `GET` | `/reels` | List all saved reels (optional `?search=` param) |
| `DELETE` | `/reels/{id}` | Delete a reel |
| `POST` | `/extract/url` | Full pipeline: download → transcribe → extract → save |
| `POST` | `/extract/file` | Skip download; transcribe an uploaded audio file |
| `POST` | `/extract/text` | Skip download + transcription; run LLM on pasted text |
| `POST` | `/extract/batch` | Upload `saved_posts.json`; inserts rows as `pending` for worker |
| `GET` | `/extract/batch/status` | Poll active batch job progress |
| `POST` | `/reels/status` | Check statuses for a list of reel IDs/URLs |
| `GET` | `/clusters` | List cluster names + counts |
| `POST` | `/clusters/recompute` | Re-run LLM clustering over all reels (chunked, ~30s) |

---

## 🛠️ Developer Commands

```powershell
# --- Backend ---

# Start dev server (sets up venv, installs deps, watches for changes)
backend/run_local.ps1

# Run standalone worker only (no HTTP server)
python backend/run_worker.py

# Explicit yt-dlp maintenance (never runs automatically at worker startup)
.\backend\.venv\Scripts\python.exe -m pip install --upgrade yt-dlp

# Run all pipeline tests (mocked — no real API keys or DB needed)
python backend/verify_pipeline.py

# Bulk import from Instagram export file (resumable)
python backend/batch_import.py path/to/saved_posts.json

# Inspect / clean the Supabase queue (pending/failed rows)
python backend/check_queue.py

# --- Frontend ---

cd frontend
npm run dev       # Vite dev server (http://localhost:5173)
npm run build     # Production build
npm run lint      # ESLint
npm run preview   # Serve production build locally
```

---

## 🚢 Deployment

### Backend → Hugging Face Spaces

The backend ships as a Docker container. Hugging Face uses port **7860** (not 8000).

```bash
# Push backend to HF Spaces via git subtree
git subtree push --prefix=backend hf main
```

Set these secrets in your HF Space settings: `GROQ_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.

Also upload `backend/cookies.txt` (your Instagram session cookies) as a Space secret or file — required for IG scraping. Re-export when Instagram returns 403 errors.

### Frontend → Vercel

```bash
cd frontend
npx vercel --prod
```

Set these env vars in your Vercel project dashboard:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_API_URL` (point to your HF Space URL)

---

## 🐛 Known Gotchas

| Issue | Resolution |
|---|---|
| **ffmpeg not found** | Add the ffmpeg `bin/` directory to PATH before running uvicorn/worker |
| **Instagram 403 errors** | Re-export `cookies.txt` from your browser and replace `backend/cookies.txt` |
| **HF Space cold start** | First request after idle takes 30–60s — retry if the Shortcut times out |
| **Supabase rejects service key from PowerShell** | Use `python backend/db.py` / Python scripts for admin queries, not raw PowerShell REST calls |
| **New reels have `cluster: null`** | Expected — run "Recompute Clusters" from the dashboard to assign themes |
| **DNS resolution failures (`*.supabase.co`)** | Set your network DNS to `1.1.1.1` / `8.8.8.8` |

---

## 📁 Project Structure

```
Transcriber/
├── backend/
│   ├── main.py              # FastAPI app + full pipeline logic
│   ├── db.py                # Supabase data layer (all DB ops)
│   ├── run_worker.py        # Standalone queue worker
│   ├── saved_parser.py      # Instagram saved_posts.json parser
│   ├── batch_import.py      # CLI bulk importer
│   ├── check_queue.py       # Queue diagnostic tool
│   ├── verify_pipeline.py   # Integration tests (20 tests, mocked)
│   ├── run_local.ps1        # Dev startup script (Windows)
│   ├── Dockerfile           # HF Spaces container
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.jsx          # Single-component SPA
│   │   ├── supabaseClient.js
│   │   ├── App.css
│   │   └── index.css
│   ├── package.json
│   └── vite.config.js
├── docs/                    # Plans, specs, design notes
├── CLAUDE.md                # Architecture reference for AI agents
├── MEMORY.md                # Session log / decision log
├── prd.md                   # Product Requirements Document
└── README.md
```

---

## 🤝 Contributing

This is a personal knowledge management tool but PRs and issues are welcome. Before contributing:

1. Run `python backend/verify_pipeline.py` — all 20 tests must pass.
2. Run `cd frontend && npm run lint && npm run build` — must be clean.
3. Keep `backend/main.py`'s `guard_silent_hook` behavior intact (prevents hallucinated summaries on music-only reels).

---

## 📄 License

MIT — do whatever you want, just don't blame me if Instagram blocks your cookies.
