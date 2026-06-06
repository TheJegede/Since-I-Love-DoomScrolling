# Product Requirements Document (PRD): Instagram Reels Information Extractor ("Transcriber")

## 1. Overview & Motivation
Educational and tool-focused short-form videos (e.g., Instagram Reels, TikToks, YouTube Shorts) contain high-density, actionable information (workflows, software lists, coding tips, life hacks). However, this content is highly ephemeral and unstructured:
* Saving and organizing videos manually is tedious.
* Users cannot search, copy, or index the text within the videos.
* Manually transcribing and extracting details is a bottleneck.

**The Solution:** An autonomous, AI-driven data extraction pipeline that consumes a video URL, automatically downloads and transcribes the audio, and uses a Large Language Model (LLM) to extract structured, schema-validated JSON insights (core topics, action items, tools, and takeaways) into a searchable dashboard.

---

## 2. Target Architecture & Budget Constraints
To ensure accessibility and zero operational cost for self-hosters or developers:
* **Operating Cost:** Exactly **$0/month** by using generous free tiers as of 2026.
* **Stack Components:**
  * **Backend Host:** Dockerized Python (FastAPI) on **Hugging Face Spaces** (Free CPU Tier).
  * **Frontend Host:** React (Vite) + Tailwind CSS on **Vercel** (Free Hobby Tier).
  * **Database:** Embedded SQLite database (local storage file, zero configuration required).
  * **Inference APIs:** **Groq** (Free Tier for Whisper-large-v3-turbo and Llama-3.1-8b-instant).

---

## 3. Core Features

### 3.1 Ingestion Layer
* **URL Input:** Accept standard Instagram Reel URLs.
* **Scraping Engine:** Utilize `yt-dlp` to fetch media.
* **Authentication Bypass:** Allow mounting of Instagram session cookies (`cookies.txt`) in the backend environment to bypass Instagram's scraping guards.
* **Audio Extractor:** Use `ffmpeg` to extract the audio payload as a lightweight MP3 in `/tmp` storage.
* **Resilience Fallbacks (Crucial):**
  * **Caption/Metadata Extraction:** Extract post captions/descriptions via `yt-dlp` as a text fallback.
  * **Manual File Upload:** Allow users to drag-and-drop an audio file directly if the automated scraper fails.
  * **Manual Text Input:** Allow copy-pasting raw transcripts or video descriptions directly.

### 3.2 AI Extraction Pipeline
* **Transcription:** Audio is sent to Groq's Whisper API (`whisper-large-v3-turbo`).
* **Structured Summarization:** Raw transcripts and captions are sent to Llama 3.1 8B on Groq using strict JSON response formats.
* **Data Schema:**
  ```json
  {
    "core_topic": "string",
    "key_takeaway": "string",
    "action_items": ["string"],
    "tools_or_resources": ["string"]
  }
  ```
* **Short-Transcript Handling:** If Whisper returns fewer than 15 words:
  * Check if post caption/description is available. If yes, run LLM summarization on the description.
  * If no caption is available, flag the entry as "Needs Review" and allow the user to type/paste text.

### 3.3 Persistence & Storage
* **Database:** SQLite.
* **Table Schema:** `saved_reels`
  * `id`: Text (UUID Primary Key)
  * `url`: Text (Unique index, nullable for manual uploads)
  * `title`: Text (Optional, fetched from video caption/first line of transcript)
  * `raw_transcript`: Text (Nullable)
  * `post_caption`: Text (Nullable)
  * `extracted_json`: Text (JSON string strictly matching schema)
  * `created_at`: Timestamp
* **Search:** SQL LIKE-based search query filtering across title, transcript, caption, and JSON highlights.

### 3.4 Web Dashboard UI
* **Minimalist Input:** Prominent input bar for URLs, file upload zone for fallback, and progress loaders.
* **Real-time Status Log:** Visual indicators for scraping, transcribing, summarizing, and saving stages.
* **HF Space Wake-up Alert:** UI checks and displays a warming-up status if the Hugging Face Space backend is sleeping.
* **Interactive Grid:** Card layout showing extracted summaries.
  * Search bar to query titles, topics, tools, or transcripts.
  * Detail View modal for expanding card content, copying action items to the clipboard, and viewing the raw transcript.
* **Basic Access Gate:** Simple authentication token parameter or password prompt to secure public deployments from unauthorized API consumption.

---

## 4. Non-Functional Requirements
* **Response Times:**
  * LLM extraction & validation: < 2 seconds via Groq.
  * Audio transcription: < 3 seconds for standard 60-second reels.
* **Reliability:** Graceful error handling for missing audio, empty transcript outputs, network timeouts, and scraper rate-limits.
* **Device Responsiveness:** Tailwind-styled layout designed for desktop review and mobile quick-view.
