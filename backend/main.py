import os
import json
import time
import tempfile
import logging
from typing import List, Optional
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
import yt_dlp
from groq import Groq
from dotenv import load_dotenv

# Load local environment variables if present (for local dev)
load_dotenv()
# Also fallback to parent project root directory .env
parent_env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env')
if os.path.exists(parent_env_path):
    load_dotenv(parent_env_path)

# Set up logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# Initialize configuration
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

# Validate configuration
if not GROQ_API_KEY:
    logger.warning("GROQ_API_KEY environment variable is not set.")

# Initialize API clients
import sqlite3

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "local_storage.db")

def init_local_db():
    """Initialize local SQLite database for storing Reel transcripts and summaries."""
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS saved_reels (
                id TEXT PRIMARY KEY,
                url TEXT UNIQUE,
                title TEXT,
                raw_transcript TEXT,
                post_caption TEXT,
                extracted_json TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
            )
        """)
        # Idempotent migration: add cluster column if missing
        existing_cols = [r[1] for r in cursor.execute("PRAGMA table_info(saved_reels)").fetchall()]
        if "cluster" not in existing_cols:
            cursor.execute("ALTER TABLE saved_reels ADD COLUMN cluster TEXT")
        conn.commit()
        conn.close()
        logger.info(f"Initialized local SQLite database at: {DB_PATH}")
    except Exception as e:
        logger.error(f"Failed to initialize local SQLite database: {str(e)}")

groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

# Initialize main database
init_local_db()

app = FastAPI(
    title="Instagram Reels Information Extractor API",
    description="Backend service to scrape, transcribe, and extract structured data from Reels",
    version="1.0.0"
)

# CORS middleware configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Adjust for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Pydantic model for structured extraction response
class ReelExtraction(BaseModel):
    core_topic: str = Field(..., description="The main theme, topic, or focus of the Reel.")
    key_takeaway: str = Field(..., description="A single-sentence key summary or final takeaway of the Reel.")
    action_items: List[str] = Field(..., description="Actionable chronological steps, tutorials, workflows, or lessons from the Reel.")
    tools_or_resources: List[str] = Field(..., description="List of software tools, apps, websites, or products mentioned in the Reel.")

    @field_validator("action_items", "tools_or_resources", mode="before")
    @classmethod
    def coerce_list_of_strings(cls, value):
        """The 8B model often returns list items as dicts (e.g. {step, action, description})
        instead of plain strings. Flatten any such items into readable strings so validation
        does not 500 on otherwise-valid extractions."""
        if value is None:
            return []
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, list):
            return [cls._stringify(value)]
        return [s for s in (cls._stringify(item) for item in value) if s]

    @staticmethod
    def _stringify(item) -> str:
        if isinstance(item, str):
            return item.strip()
        if isinstance(item, dict):
            # Prefer the most descriptive fields; fall back to joining all string values.
            for key in ("action", "step", "text", "item", "name", "tool", "resource", "description"):
                v = item.get(key)
                if isinstance(v, str) and v.strip():
                    desc = item.get("description")
                    if key == "action" and isinstance(desc, str) and desc.strip() and desc.strip() != v.strip():
                        return f"{v.strip()}: {desc.strip()}"
                    return v.strip()
            parts = [str(v).strip() for v in item.values() if isinstance(v, (str, int, float)) and str(v).strip()]
            return ": ".join(parts)
        return str(item).strip()

class ExtractionResponse(BaseModel):
    id: Optional[str] = None
    url: Optional[str] = None
    title: str
    raw_transcript: Optional[str] = None
    post_caption: Optional[str] = None
    extracted_json: ReelExtraction
    created_at: Optional[str] = None

class ClusterAssignment(BaseModel):
    id: str
    cluster: str

class ClusterAssignments(BaseModel):
    assignments: List[ClusterAssignment]

# Clustering is chunked to stay under Groq's free-tier token-per-minute cap.
# One all-in-one call over a large library (~350 reels) exceeds the 6000 TPM
# limit, so topics are clustered in small batches paced apart, with each batch
# told the cluster names discovered so far to keep naming consistent.
CLUSTER_CHUNK_SIZE = 50
CLUSTER_CHUNK_DELAY = 30  # seconds between Groq calls, to respect 6000 TPM cap


def _cluster_one_chunk(chunk: List[dict], existing_clusters: List[str]) -> List[dict]:
    """Cluster one batch of {"id", "topic"} items via a single Llama call.

    `existing_clusters` are names already assigned in prior batches; the model is
    asked to reuse a fitting one before inventing a new cluster. Returns
    [{"id", "cluster"}]. Monkeypatched in tests to avoid a real Groq call."""
    if not groq_client:
        raise HTTPException(status_code=500, detail="Groq client is not configured on the backend server.")

    reuse_hint = ""
    if existing_clusters:
        reuse_hint = (
            "Existing cluster names (reuse one verbatim if an item fits it; only "
            "invent a new name when none fit):\n" + json.dumps(existing_clusters) + "\n\n"
        )

    system_prompt = (
        "You are a content librarian. Group the given items into emergent topic "
        "clusters. Invent a short, human-readable name for each cluster (e.g. "
        "'AI Tools', 'Cooking', 'Personal Finance'). Merge near-identical or "
        "overlapping themes into one cluster (e.g. 'Website Security' and 'Website "
        "Security Testing' are the same); prefer fewer, broader groups over many "
        "tiny ones. Every item id must appear exactly once. "
        "Respond ONLY with valid JSON in exactly this shape, no markdown or prose:\n"
        '{"assignments": [{"id": "<id>", "cluster": "<cluster name>"}]}'
    )
    user_prompt = reuse_hint + "Items to cluster (JSON):\n" + json.dumps(chunk)

    try:
        response = groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
        )
        content = response.choices[0].message.content
        data = json.loads(content)
        validated = ClusterAssignments(**data)
        return [a.model_dump() for a in validated.assignments]
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Clustering model returned invalid JSON.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Clustering failed: {str(e)}")


def _merge_cluster_names(names: List[str]) -> dict:
    """Consolidate many chunk-invented cluster names into a small canonical set.

    Chunked clustering names each batch independently, producing near-duplicates
    (e.g. 'AI Tools', 'AI Email Tools', 'Agentic AI'). This one small Groq call
    operates on the *names only* (no token-budget risk) and returns a mapping
    {original_name: canonical_name}. Monkeypatched in tests."""
    if not groq_client:
        raise HTTPException(status_code=500, detail="Groq client is not configured on the backend server.")

    system_prompt = (
        "You are a taxonomy editor. Given a list of cluster names, merge "
        "near-duplicate or overlapping names into a smaller canonical set (aim for "
        "about 8 to 15 total). Map every input name to exactly one canonical name "
        "(a canonical name may be one of the inputs). Keep names short and "
        "human-readable. Respond ONLY with valid JSON in exactly this shape, no "
        "markdown or prose:\n"
        '{"map": {"<original name>": "<canonical name>"}}'
    )
    user_prompt = "Cluster names (JSON):\n" + json.dumps(names)

    try:
        response = groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
        )
        data = json.loads(response.choices[0].message.content)
        mapping = data.get("map", {})
        if not isinstance(mapping, dict):
            return {}
        return {str(k): str(v) for k, v in mapping.items() if v}
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Cluster merge model returned invalid JSON.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Cluster merge failed: {str(e)}")


def cluster_topics_with_llm(items: List[dict]) -> List[dict]:
    """Group reel topics into emergent clusters, batching to stay under TPM limits.

    items: list of {"id": str, "topic": str}. Returns list of {"id", "cluster"}.
    Pipeline: shrink ids to indices -> cluster in paced chunks -> dedup (keep
    first assignment per id) -> a merge pass consolidates fragmented names."""
    # Map real ids -> short indices to shrink the request payload
    idx_to_id = {}
    indexed = []
    for i, it in enumerate(items):
        idx = str(i)
        idx_to_id[idx] = it["id"]
        indexed.append({"id": idx, "topic": it.get("topic", "")})

    raw = []
    known_clusters: List[str] = []
    for start in range(0, len(indexed), CLUSTER_CHUNK_SIZE):
        chunk = indexed[start:start + CLUSTER_CHUNK_SIZE]
        part = _cluster_one_chunk(chunk, known_clusters)
        for a in part:
            raw.append(a)
            name = a.get("cluster")
            if name and name not in known_clusters:
                known_clusters.append(name)
        if start + CLUSTER_CHUNK_SIZE < len(indexed) and CLUSTER_CHUNK_DELAY:
            time.sleep(CLUSTER_CHUNK_DELAY)

    # Dedup: keep the first valid assignment per id (guards duplicate ids)
    seen = {}
    for a in raw:
        aid = a.get("id")
        cluster = a.get("cluster")
        if aid in idx_to_id and cluster and aid not in seen:
            seen[aid] = cluster

    # Merge pass: consolidate the fragmented names produced across chunks
    distinct = list(dict.fromkeys(seen.values()))
    merge_map = _merge_cluster_names(distinct) if len(distinct) > 1 else {}

    return [
        {"id": idx_to_id[aid], "cluster": merge_map.get(cluster, cluster)}
        for aid, cluster in seen.items()
    ]

# Helper functions
def get_cookie_file() -> Optional[str]:
    """Check for cookies.txt in common paths to bypass Instagram scraping blocks."""
    paths = [
        "cookies.txt",
        "backend/cookies.txt",
        "/app/cookies.txt",
        "/home/user/app/cookies.txt"
    ]
    for p in paths:
        if os.path.exists(p):
            logger.info(f"Using cookies file: {p}")
            return p
    return None

def download_and_extract_audio(url: str) -> tuple[str, str, str]:
    """Download Instagram Reel and extract audio payload as MP3 using yt-dlp."""
    temp_dir = tempfile.gettempdir()
    cookie_file = get_cookie_file()

    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': os.path.join(temp_dir, 'video_%(id)s.%(ext)s'),
        'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '192',
        }],
        'quiet': True,
        'no_warnings': True,
    }

    if cookie_file:
        ydl_opts['cookiefile'] = cookie_file

    logger.info(f"Running yt-dlp download for URL: {url}")
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = ydl.prepare_filename(info)
            # The output of FFmpegExtractAudio is an mp3, replacing the original video extension
            mp3_path = os.path.splitext(filename)[0] + '.mp3'
            
            # Double check file exists
            if not os.path.exists(mp3_path):
                raise FileNotFoundError(f"Audio extraction file not found at expected path: {mp3_path}")
                
            post_caption = info.get('description') or info.get('title') or ""
            title = info.get('title') or f"Instagram Reel ({info.get('id')})"
            
            logger.info(f"Successfully downloaded audio to: {mp3_path}")
            return mp3_path, post_caption, title
    except Exception as e:
        logger.error(f"Error downloading or extracting audio: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to download or parse Instagram Reel. Meta may be blocking the request. Error: {str(e)}"
        )

def transcribe_audio(file_path: str) -> str:
    """Transcribe audio using Groq Whisper large v3 turbo."""
    if not groq_client:
        raise HTTPException(status_code=500, detail="Groq client is not configured on the backend server.")

    logger.info(f"Sending audio file to Groq Whisper: {file_path}")
    try:
        with open(file_path, "rb") as audio_file:
            transcription = groq_client.audio.transcriptions.create(
                file=(os.path.basename(file_path), audio_file.read()),
                model="whisper-large-v3-turbo",
            )
        transcript = transcription.text.strip()
        logger.info(f"Successfully transcribed. Length: {len(transcript)} characters.")
        return transcript
    except Exception as e:
        logger.error(f"Whisper transcription failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Audio transcription failed: {str(e)}")

SILENT_HOOK_MIN_WORDS = 15

def guard_silent_hook(raw_transcript: str, caption: Optional[str]) -> None:
    """Short-circuit silent/music-only clips before spending an LLM call.

    Whisper often returns empty text or hallucinated song lyrics for clips with no
    speech. If the transcript is under SILENT_HOOK_MIN_WORDS and there is no caption
    to fall back on, raise 400 instead of summarizing noise."""
    words_count = len((raw_transcript or "").split())
    if words_count < SILENT_HOOK_MIN_WORDS:
        logger.info("Spoken audio transcript is short or silent. Relying on caption if available.")
        if not caption or len(caption.strip()) == 0:
            raise HTTPException(
                status_code=400,
                detail="No spoken audio or caption text was detected. Clip could not be summarized."
            )

def extract_structured_json(transcript: str, caption: str) -> ReelExtraction:
    """Analyze text metadata with Llama 3.1 8B on Groq to output schema-validated insights."""
    if not groq_client:
        raise HTTPException(status_code=500, detail="Groq client is not configured on the backend server.")

    system_prompt = (
        "You are an expert educational and content summarization assistant.\n"
        "Your task is to analyze the audio transcription and post caption of an Instagram Reel "
        "and extract structured insights in JSON format.\n"
        "Instructions:\n"
        "1. Identify the 'core_topic' of the video.\n"
        "2. Condense the overall message into a single-sentence 'key_takeaway'.\n"
        "3. Provide chronological 'action_items' representing steps, tutorials, workflows, or lessons described.\n"
        "4. Extract all 'tools_or_resources' (e.g., software, websites, books, plugins, models) mentioned.\n"
        "'action_items' and 'tools_or_resources' MUST be arrays of plain strings — never objects. "
        "Encode each step as a single string (e.g. \"Use Superhuman to triage emails\"), not a nested object.\n"
        "Respond ONLY with a valid JSON object in exactly this shape:\n"
        "{\"core_topic\": \"string\", \"key_takeaway\": \"string\", "
        "\"action_items\": [\"string\", \"string\"], \"tools_or_resources\": [\"string\", \"string\"]}\n"
        "Do not add markdown backticks, conversational preamble, or explanations."
    )

    user_prompt = ""
    if transcript:
        user_prompt += f"Audio Transcript:\n{transcript}\n\n"
    if caption:
        user_prompt += f"Post Caption/Description:\n{caption}\n"

    logger.info("Sending prompt to Llama 3.1 8B")
    try:
        response = groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            response_format={"type": "json_object"}
        )
        
        content = response.choices[0].message.content
        logger.info(f"Llama response: {content}")
        
        # Parse and validate structure
        data = json.loads(content)
        validated_data = ReelExtraction(**data)
        return validated_data
    except json.JSONDecodeError as je:
        logger.error(f"JSON parsing error: {str(je)}")
        raise HTTPException(status_code=500, detail="LLM returned invalid JSON structure.")
    except Exception as e:
        logger.error(f"Structured extraction failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Structured extraction failed: {str(e)}")

def save_to_database(
    url: Optional[str], 
    title: str, 
    raw_transcript: Optional[str], 
    post_caption: Optional[str], 
    extracted: ReelExtraction
) -> dict:
    """Save record to local SQLite database, returning the saved record."""
    import uuid
    from datetime import datetime
    row_id = str(uuid.uuid4())
    created_at = datetime.utcnow().isoformat()
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        if url:
            cursor.execute("SELECT id, url, title, raw_transcript, post_caption, extracted_json, created_at FROM saved_reels WHERE url = ?", (url,))
            row = cursor.fetchone()
            if row:
                logger.info(f"Reel already exists in local SQLite. ID: {row[0]}")
                return {
                    "id": row[0],
                    "url": row[1],
                    "title": row[2],
                    "raw_transcript": row[3],
                    "post_caption": row[4],
                    "extracted_json": json.loads(row[5]),
                    "created_at": row[6]
                }
        
        extracted_str = json.dumps(extracted.model_dump())
        cursor.execute(
            "INSERT INTO saved_reels (id, url, title, raw_transcript, post_caption, extracted_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (row_id, url, title, raw_transcript, post_caption, extracted_str, created_at)
        )
        conn.commit()
        conn.close()
        return {
            "id": row_id,
            "url": url,
            "title": title,
            "raw_transcript": raw_transcript,
            "post_caption": post_caption,
            "extracted_json": extracted.model_dump(),
            "created_at": created_at
        }
    except Exception as e:
        logger.error(f"Local SQLite save failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Local database save failed: {str(e)}")

# API Endpoints
@app.get("/health")
def health_check():
    """Simple health check endpoint used to check API health."""
    return {"status": "ok", "message": "Extractor service is awake and running."}

@app.get("/reels")
def list_reels(
    limit: int = Query(20, description="Max number of items to return"),
    search: Optional[str] = Query(None, description="Query string for searching raw transcripts or extracted JSON")
):
    """Retrieve saved reels from local SQLite database."""
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        if search:
            like_query = f"%{search}%"
            cursor.execute(
                "SELECT id, url, title, raw_transcript, post_caption, extracted_json, created_at, cluster FROM saved_reels "
                "WHERE title LIKE ? OR raw_transcript LIKE ? OR post_caption LIKE ? OR extracted_json LIKE ? "
                "ORDER BY created_at DESC LIMIT ?",
                (like_query, like_query, like_query, like_query, limit)
            )
        else:
            cursor.execute(
                "SELECT id, url, title, raw_transcript, post_caption, extracted_json, created_at, cluster FROM saved_reels "
                "ORDER BY created_at DESC LIMIT ?",
                (limit,)
            )

        rows = cursor.fetchall()
        conn.close()

        results = []
        for r in rows:
            results.append({
                "id": r[0],
                "url": r[1],
                "title": r[2],
                "raw_transcript": r[3],
                "post_caption": r[4],
                "extracted_json": json.loads(r[5]),
                "created_at": r[6],
                "cluster": r[7] if r[7] else "Unclustered"
            })
        return results
    except Exception as e:
        logger.error(f"Error fetching reels from local SQLite: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch reels: {str(e)}")

@app.post("/clusters/recompute")
def recompute_clusters():
    """Regroup all saved reels into emergent topic clusters via one LLM call."""
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        rows = cursor.execute("SELECT id, extracted_json FROM saved_reels").fetchall()
        if not rows:
            conn.close()
            return {"clusters": [], "assigned": 0}

        items = []
        for rid, ej in rows:
            try:
                topic = (json.loads(ej) or {}).get("core_topic", "")
            except Exception:
                topic = ""
            items.append({"id": rid, "topic": topic})

        assignments = cluster_topics_with_llm(items)

        valid_ids = {r[0] for r in rows}
        applied = 0
        for a in assignments:
            if a.get("id") in valid_ids and a.get("cluster"):
                cursor.execute("UPDATE saved_reels SET cluster = ? WHERE id = ?", (a["cluster"], a["id"]))
                applied += 1
        conn.commit()

        clusters = [
            {"name": name, "count": count}
            for name, count in cursor.execute(
                "SELECT COALESCE(cluster, 'Unclustered') AS c, COUNT(*) FROM saved_reels GROUP BY c ORDER BY COUNT(*) DESC"
            ).fetchall()
        ]
        conn.close()
        logger.info(f"Recomputed clusters: assigned {applied} of {len(rows)} reels.")
        return {"clusters": clusters, "assigned": applied}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Cluster recompute failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Cluster recompute failed: {str(e)}")

@app.get("/clusters")
def list_clusters():
    """Return emergent clusters with reel counts. NULL cluster -> 'Unclustered'."""
    try:
        conn = sqlite3.connect(DB_PATH)
        rows = conn.execute(
            "SELECT COALESCE(cluster, 'Unclustered') AS c, COUNT(*) FROM saved_reels GROUP BY c ORDER BY COUNT(*) DESC"
        ).fetchall()
        conn.close()
        return [{"name": name, "count": count} for name, count in rows]
    except Exception as e:
        logger.error(f"Failed to list clusters: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to list clusters: {str(e)}")

@app.post("/extract/url", response_model=ExtractionResponse)
async def extract_url(payload: dict):
    """
    Accepts Instagram Reel URL. Downloads video, extracts audio, transcribes audio,
    combines description with transcript, extracts JSON highlights, and saves to database.
    """
    url = payload.get("url")
    if not url:
        raise HTTPException(status_code=400, detail="Missing required 'url' parameter.")

    # Check if we already processed this URL to save API tokens
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT id, url, title, raw_transcript, post_caption, extracted_json, created_at FROM saved_reels WHERE url = ?", (url,))
        row = cursor.fetchone()
        conn.close()
        if row:
            logger.info(f"Returning cached SQLite database record for URL: {url}")
            return {
                "id": row[0],
                "url": row[1],
                "title": row[2],
                "raw_transcript": row[3],
                "post_caption": row[4],
                "extracted_json": json.loads(row[5]),
                "created_at": row[6]
            }
    except Exception as e:
        logger.warning(f"Failed to check existing SQLite URL cache: {str(e)}")

    mp3_path = None
    try:
        # 1. Download video and extract audio MP3 & caption description
        mp3_path, post_caption, title = download_and_extract_audio(url)

        # 2. Transcribe Audio
        raw_transcript = ""
        try:
            raw_transcript = transcribe_audio(mp3_path)
        except Exception as e:
            logger.warning(f"Transcription failed: {str(e)}. Proceeding using metadata/caption only.")

        # 3. Check for empty transcription/silent hook
        guard_silent_hook(raw_transcript, post_caption)

        # 4. Extract structured insights
        extracted_data = extract_structured_json(raw_transcript, post_caption)

        # 5. Commit record to database
        db_record = save_to_database(
            url=url,
            title=title,
            raw_transcript=raw_transcript,
            post_caption=post_caption,
            extracted=extracted_data
        )

        return db_record
    finally:
        # Cleanup temporary audio files
        if mp3_path and os.path.exists(mp3_path):
            try:
                os.remove(mp3_path)
                logger.info(f"Cleaned up temporary audio file: {mp3_path}")
            except Exception as ce:
                logger.warning(f"Could not delete temp file {mp3_path}: {str(ce)}")

@app.post("/extract/file", response_model=ExtractionResponse)
async def extract_file(
    file: UploadFile = File(...),
    title: str = Form("Uploaded Audio File"),
    caption: Optional[str] = Form(None)
):
    """
    Accepts uploaded audio files. Transcribes audio, integrates caption metadata,
    extracts JSON highlights, and saves to database.
    """
    temp_dir = tempfile.gettempdir()
    # Write uploaded file to a temporary location
    _, ext = os.path.splitext(file.filename)
    if not ext:
        ext = ".mp3"
        
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=ext, dir=temp_dir)
    temp_file_path = temp_file.name
    
    try:
        content = await file.read()
        temp_file.write(content)
        temp_file.close()

        # 1. Transcribe
        raw_transcript = transcribe_audio(temp_file_path)

        # 2. Guard silent/music-only uploads before spending an LLM call
        guard_silent_hook(raw_transcript, caption)

        # 3. Extract structured insights
        extracted_data = extract_structured_json(raw_transcript, caption or "")

        # 3. Commit to Database
        db_record = save_to_database(
            url=None, # No URL for manual upload
            title=title,
            raw_transcript=raw_transcript,
            post_caption=caption,
            extracted=extracted_data
        )

        return db_record
    finally:
        if os.path.exists(temp_file_path):
            os.remove(temp_file_path)

@app.post("/extract/text", response_model=ExtractionResponse)
async def extract_text(payload: dict):
    """
    Accepts raw transcript text and/or captions directly to skip scraping/transcribing
    and extract JSON highlights. Saves to database.
    """
    title = payload.get("title", "Manual Text Input")
    transcript = payload.get("transcript", "")
    caption = payload.get("caption", "")

    if not transcript and not caption:
        raise HTTPException(status_code=400, detail="Must provide either 'transcript' or 'caption'.")

    # Extract structured insights
    extracted_data = extract_structured_json(transcript, caption)

    # Save to database
    db_record = save_to_database(
        url=None,
        title=title,
        raw_transcript=transcript,
        post_caption=caption,
        extracted=extracted_data
    )

    return db_record
