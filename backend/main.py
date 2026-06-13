import os
import json
import time
import uuid
import threading
import tempfile
import logging
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from typing import List, Optional
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query, BackgroundTasks, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
import yt_dlp
from groq import Groq
from dotenv import load_dotenv
import re
import glob

# Load local environment variables if present (for local dev)
load_dotenv()
# Also fallback to parent project root directory .env
parent_env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env')
if os.path.exists(parent_env_path):
    load_dotenv(parent_env_path)

# Set up logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# Auto-inject ffmpeg from WinGet packages if not found in PATH (Windows local dev helper)
import shutil
if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
    localappdata = os.environ.get("LOCALAPPDATA")
    if localappdata:
        winget_packages_dir = os.path.join(localappdata, "Microsoft", "WinGet", "Packages")
        if os.path.exists(winget_packages_dir):
            import glob
            ffmpeg_paths = glob.glob(os.path.join(winget_packages_dir, "**", "ffmpeg.exe"), recursive=True)
            if ffmpeg_paths:
                ffmpeg_bin_dir = os.path.dirname(ffmpeg_paths[0])
                os.environ["PATH"] = ffmpeg_bin_dir + os.pathsep + os.environ["PATH"]
                logger.info(f"Automatically added ffmpeg to PATH: {ffmpeg_bin_dir}")

# Initialize configuration
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

# Validate configuration
if not GROQ_API_KEY:
    logger.warning("GROQ_API_KEY environment variable is not set.")

API_AUTH_TOKEN = os.getenv("API_AUTH_TOKEN")

def verify_api_key(x_api_key: Optional[str] = Header(None)):
    """Access gate: enforce token check if API_AUTH_TOKEN environment variable is set."""
    if API_AUTH_TOKEN:
        if not x_api_key or x_api_key.strip() != API_AUTH_TOKEN.strip():
            raise HTTPException(status_code=401, detail="Unauthorized API access. Valid X-API-Key header required.")

# Initialize data layer
import db
from saved_parser import parse_saved_posts


def init_local_db():
    """Schema is managed in Supabase (see docs). This only verifies config presence."""
    if not os.getenv("SUPABASE_URL") or not os.getenv("SUPABASE_SERVICE_KEY"):
        logger.warning("SUPABASE_URL / SUPABASE_SERVICE_KEY not set — DB calls will fail.")
    else:
        logger.info("Supabase configuration detected.")

groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

# Initialize main database
init_local_db()

@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.getenv("ENABLE_WORKER", "1") == "0":
        logger.info("ENABLE_WORKER=0 — queue worker disabled.")
    else:
        threading.Thread(target=_worker_loop, daemon=True).start()
    yield


app = FastAPI(
    title="Instagram Reels Information Extractor API",
    description="Backend service to scrape, transcribe, and extract structured data from Reels",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS middleware configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Adjust for production
    allow_credentials=False,
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


def _chunked(seq: list, size: int):
    """Yield successive `size`-length slices of `seq`."""
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


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
def is_valid_instagram_reel(url: str) -> bool:
    if not url:
        return False
    # Strict regex pattern matching Instagram Reel paths
    pattern = r"^https?://(www\.)?instagram\.com/reel/[A-Za-z0-9_\-]+/?.*$"
    return bool(re.match(pattern, url.strip()))

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

    # Extract Reel ID from the URL (fallback to UUID if match fails)
    match = re.search(r"/reel/([A-Za-z0-9_\-]+)", url)
    reel_id = match.group(1) if match else str(uuid.uuid4())

    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': os.path.join(temp_dir, f'video_{reel_id}.%(ext)s'),
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
        # Clean up any leftover temp files on download error
        for f in glob.glob(os.path.join(temp_dir, f"video_{reel_id}.*")):
            try:
                os.remove(f)
                logger.info(f"Cleaned up failed download file: {f}")
            except Exception as ce:
                logger.warning(f"Could not delete temp file {f}: {str(ce)}")
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
    extracted: ReelExtraction,
) -> dict:
    """Persist a record via the Supabase data layer, returning the saved record.
    If the URL already exists, returns the existing row (cache/idempotency)."""
    if url:
        existing = db.get_reel_by_url(url)
        if existing:
            logger.info(f"Reel already exists. ID: {existing['id']}")
            return existing
    return db.insert_reel(
        url=url,
        title=title,
        raw_transcript=raw_transcript,
        post_caption=post_caption,
        extracted_json=extracted.model_dump(),
        source=None,
    )

# API Endpoints
@app.get("/health")
def health_check():
    """Simple health check endpoint used to check API health."""
    return {"status": "ok", "message": "Extractor service is awake and running."}

@app.get("/reels")
def list_reels(
    limit: int = Query(20, description="Max number of items to return"),
    search: Optional[str] = Query(None, description="Search across title/transcript/caption"),
):
    """Retrieve saved reels from Supabase."""
    try:
        return db.list_reels(limit=limit, search=search)
    except Exception as e:
        logger.error(f"Error fetching reels: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch reels: {str(e)}")

@app.delete("/reels/{reel_id}", dependencies=[Depends(verify_api_key)])
def delete_reel(reel_id: str):
    """Delete a single saved reel by id. 404 if it does not exist."""
    try:
        if not db.delete_reel(reel_id):
            raise HTTPException(status_code=404, detail="Reel not found.")
        return {"deleted": reel_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Delete failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Delete failed: {str(e)}")


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

CLUSTER_JOB = {
    "status": "idle",  # idle | running | done | error
    "started_at": None,
    "finished_at": None,
    "assigned": 0,
    "error": None,
}


def run_cluster_recompute_task():
    global CLUSTER_JOB
    CLUSTER_JOB.update({
        "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None,
        "assigned": 0,
        "error": None,
    })
    try:
        rows = db.reels_for_clustering()
        if not rows:
            CLUSTER_JOB.update({
                "status": "done",
                "finished_at": datetime.now(timezone.utc).isoformat(),
            })
            return

        items = []
        for r in rows:
            ej = r.get("extracted_json")
            if isinstance(ej, str):
                try:
                    ej = json.loads(ej)
                except Exception:
                    ej = {}
            items.append({"id": r["id"], "topic": (ej or {}).get("core_topic", "")})

        assignments = cluster_topics_with_llm(items)
        valid_ids = {r["id"] for r in rows}
        applied = 0
        for a in assignments:
            if a.get("id") in valid_ids and a.get("cluster"):
                db.set_cluster(a["id"], a["cluster"])
                applied += 1

        logger.info(f"Recomputed clusters: assigned {applied} of {len(rows)} reels.")
        CLUSTER_JOB.update({
            "status": "done",
            "assigned": applied,
            "finished_at": datetime.now(timezone.utc).isoformat(),
        })
    except Exception as e:
        logger.error(f"Cluster recompute task failed: {str(e)}")
        CLUSTER_JOB.update({
            "status": "error",
            "error": str(e),
            "finished_at": datetime.now(timezone.utc).isoformat(),
        })


@app.post("/clusters/recompute", dependencies=[Depends(verify_api_key)])
def recompute_clusters(background_tasks: BackgroundTasks):
    """Trigger cluster recomputation in the background."""
    if CLUSTER_JOB["status"] == "running":
        raise HTTPException(status_code=409, detail="Cluster recomputation is already in progress.")
        
    background_tasks.add_task(run_cluster_recompute_task)
    return {"status": "started", "message": "Cluster recomputation started in the background."}


@app.get("/clusters/recompute/status")
def get_recompute_status():
    """Poll endpoint to check recomputation status."""
    return CLUSTER_JOB

@app.get("/clusters")
def list_clusters():
    """Return emergent clusters with reel counts."""
    try:
        return db.cluster_counts()
    except Exception as e:
        logger.error(f"Failed to list clusters: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to list clusters: {str(e)}")

def _run_pipeline(url: str) -> tuple[str, str, str, ReelExtraction]:
    """Download → transcribe → silent-hook guard → LLM extract for one reel.

    Owns the temp audio file (always cleaned up). Returns
    (title, raw_transcript, post_caption, extracted). Raises HTTPException(400)
    on silent-hook reels and HTTPException(500) on download/transcription/LLM
    failures. Callers handle persistence."""
    mp3_path = None
    try:
        mp3_path, post_caption, title = download_and_extract_audio(url)
        raw_transcript = ""
        try:
            raw_transcript = transcribe_audio(mp3_path)
        except Exception as e:
            logger.warning(f"Transcription failed: {str(e)}. Proceeding using metadata/caption only.")
        guard_silent_hook(raw_transcript, post_caption)
        extracted = extract_structured_json(raw_transcript, post_caption)
        return title, raw_transcript, post_caption, extracted
    finally:
        if mp3_path and os.path.exists(mp3_path):
            try:
                os.remove(mp3_path)
                logger.info(f"Cleaned up temporary audio file: {mp3_path}")
            except Exception as ce:
                logger.warning(f"Could not delete temp file {mp3_path}: {str(ce)}")


def process_reel_url(url: str) -> dict:
    """Full single-reel pipeline. Returns the saved DB record.

    Returns the cached row if this URL was already processed. Raises
    HTTPException(400) on silent-hook reels (no spoken content). Used by
    /extract/url and (indirectly) the queue worker."""
    cached = db.get_reel_by_url(url)
    if cached:
        logger.info(f"Returning cached record for URL: {url}")
        return cached

    title, raw_transcript, post_caption, extracted = _run_pipeline(url)
    return save_to_database(
        url=url,
        title=title,
        raw_transcript=raw_transcript,
        post_caption=post_caption,
        extracted=extracted,
    )


@app.post("/extract/url", response_model=ExtractionResponse, dependencies=[Depends(verify_api_key)])
async def extract_url(payload: dict):
    """Accepts an Instagram Reel URL and runs the full extraction pipeline."""
    url = payload.get("url")
    if not url:
        raise HTTPException(status_code=400, detail="Missing required 'url' parameter.")
    if not is_valid_instagram_reel(url):
        raise HTTPException(status_code=400, detail="Invalid Instagram Reel URL format.")
    return process_reel_url(url)


def process_pending_reel(row: dict) -> None:
    """Run the pipeline for one claimed queue row and UPDATE it in place.

    Unlike process_reel_url, this never inserts — the row already exists as
    'processing'. Download failures (e.g. IG 403) mark the row 'failed' so it
    can be retried later by resetting its status to 'pending'."""
    reel_id = row["id"]
    url = row["url"]
    if not is_valid_instagram_reel(url):
        logger.warning(f"Worker rejected reel {reel_id}: Invalid URL format ({url})")
        db.mark_failed(reel_id, f"Invalid Instagram Reel URL format: {url}")
        return
    try:
        title, raw_transcript, post_caption, extracted = _run_pipeline(url)
        db.update_reel_result(
            reel_id=reel_id,
            title=title,
            raw_transcript=raw_transcript,
            post_caption=post_caption,
            extracted_json=extracted.model_dump(),
        )
        logger.info(f"Worker processed reel {reel_id} ({url})")
    except HTTPException as e:
        logger.warning(f"Worker failed reel {reel_id}: {e.detail}")
        db.mark_failed(reel_id, e.detail)
    except Exception as e:
        logger.error(f"Worker error on reel {reel_id}: {str(e)}")
        db.mark_failed(reel_id, str(e))


def worker_tick() -> bool:
    """Process at most one pending reel. Returns True if one was claimed."""
    row = db.claim_next_pending()
    if not row:
        return False
    process_pending_reel(row)
    return True


def _worker_loop(poll_interval: float = 5.0, idle_interval: float = 20.0) -> None:
    """Background loop: drain the queue, backing off when it's empty."""
    logger.info("Queue worker started.")
    while True:
        try:
            did_work = worker_tick()
        except Exception as e:
            logger.error(f"Worker tick crashed: {str(e)}")
            did_work = False
        time.sleep(poll_interval if did_work else idle_interval)


@app.post("/extract/file", response_model=ExtractionResponse, dependencies=[Depends(verify_api_key)])
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

        # 4. Commit to Database
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

@app.post("/extract/text", response_model=ExtractionResponse, dependencies=[Depends(verify_api_key)])
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


BATCH_JOB = {
    "status": "idle",   # idle | running | done | error
    "total": 0,
    "done": 0,
    "ok": 0,
    "failed": 0,
    "current": "",
    "errors": [],
    "urls": [],
    "started_at": None,
    "finished_at": None,
}


async def update_batch_job_status():
    """Query Supabase to aggregate current progress for the tracked URLs."""
    if not BATCH_JOB["urls"]:
        BATCH_JOB["status"] = "idle"
        return
        
    client = db.get_client()
    urls = BATCH_JOB["urls"]
    
    # Fetch all statuses in chunks of 100 to avoid query limit bounds
    db_rows = []
    for chunk in _chunked(urls, 100):
        try:
            res = client.table(db.TABLE).select("url", "status", "error").in_("url", chunk).execute()
            db_rows.extend(res.data or [])
        except Exception as e:
            logger.error(f"Error fetching batch status chunk: {e}")
            
    status_map = {row["url"]: row for row in db_rows}
    
    ok = 0
    failed = 0
    processing = 0
    current_url = ""
    errors = []
    
    for url in urls:
        row = status_map.get(url)
        if not row:
            # Not yet inserted or missing? Treat as pending
            processing += 1
        else:
            status = row.get("status") or "done"
            if status == "done":
                ok += 1
            elif status == "failed":
                failed += 1
                errors.append({"url": url, "detail": row.get("error") or "Unknown error"})
            else:
                processing += 1
                if status == "processing":
                    current_url = url
                
    done = ok + failed
    BATCH_JOB.update({
        "done": done,
        "ok": ok,
        "failed": failed,
        "current": current_url,
        "errors": errors[-50:],  # cap error log
    })
    
    if processing == 0:
        BATCH_JOB["status"] = "done"
        BATCH_JOB["finished_at"] = datetime.now(timezone.utc).isoformat()


@app.post("/extract/batch", dependencies=[Depends(verify_api_key)])
async def extract_batch(file: UploadFile = File(...)):
    """Accept an uploaded saved_posts.json and enqueue reels in Supabase."""
    if BATCH_JOB["status"] == "running":
        await update_batch_job_status()
        if BATCH_JOB["status"] == "running":
            raise HTTPException(status_code=409, detail="A batch import is already running.")

    try:
        raw = await file.read()
        data = json.loads(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="Could not parse uploaded JSON.")
        
    reels = parse_saved_posts(data)
    if not reels:
        raise HTTPException(status_code=400, detail="No reel URLs found in the uploaded file.")
        
    # Query Supabase to find which URLs already exist
    client = db.get_client()
    urls = [r["url"] for r in reels]
    
    # Check existing in chunks of 100
    existing_urls = set()
    for chunk in _chunked(urls, 100):
        res = client.table(db.TABLE).select("url").in_("url", chunk).execute()
        for row in (res.data or []):
            existing_urls.add(row["url"])
            
    new_reels = [r for r in reels if r["url"] not in existing_urls]
    
    enqueued_count = 0
    if new_reels:
        rows_to_insert = [
            {
                "id": str(uuid.uuid4()),
                "url": r["url"],
                "title": r["title"] or f"Reel ({r['url'].split('/reel/')[-1].replace('/', '')})",
                "raw_transcript": "",
                "post_caption": r["caption"],
                "extracted_json": {},
                "created_at": datetime.now(timezone.utc).isoformat(),
                "status": "pending",
                "source": "batch",
            }
            for r in new_reels
        ]
        
        # Insert in chunks of 50
        for chunk in _chunked(rows_to_insert, 50):
            client.table(db.TABLE).insert(chunk).execute()
        enqueued_count = len(rows_to_insert)

    # Initialize batch tracking state
    BATCH_JOB.update({
        "status": "running" if enqueued_count > 0 else "done",
        "total": len(urls),
        "urls": urls,
        "done": len(existing_urls),
        "ok": len(existing_urls),
        "failed": 0,
        "current": "",
        "errors": [],
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": datetime.now(timezone.utc).isoformat() if enqueued_count == 0 else None,
    })
    
    return {
        "started": enqueued_count > 0,
        "total": len(urls),
        "enqueued": enqueued_count,
        "existing": len(existing_urls),
    }


@app.get("/extract/batch/status")
async def extract_batch_status():
    """Poll endpoint to check progress."""
    if BATCH_JOB["status"] == "running":
        await update_batch_job_status()
    return BATCH_JOB


@app.post("/reels/status")
async def get_reels_status(payload: dict):
    """Stateless status check for a list of URLs."""
    urls = payload.get("urls", [])
    if not urls:
        return []
        
    client = db.get_client()
    db_rows = []
    for chunk in _chunked(urls, 100):
        res = client.table(db.TABLE).select("url", "status", "error").in_("url", chunk).execute()
        db_rows.extend(res.data or [])
        
    return db_rows

