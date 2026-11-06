import os
import json
import time
import uuid
import threading
import tempfile
import logging
import random
from datetime import datetime, timedelta, timezone
from contextlib import asynccontextmanager
from typing import List, Optional
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, BackgroundTasks, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
import yt_dlp
from groq import Groq, APIConnectionError, APIStatusError
import httpx
from dotenv import load_dotenv
import re
import glob
import shutil

import db
from saved_parser import parse_saved_posts, normalize_instagram_url

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
if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
    localappdata = os.environ.get("LOCALAPPDATA")
    if localappdata:
        winget_packages_dir = os.path.join(localappdata, "Microsoft", "WinGet", "Packages")
        if os.path.exists(winget_packages_dir):
            ffmpeg_paths = glob.glob(os.path.join(winget_packages_dir, "**", "ffmpeg.exe"), recursive=True)
            if ffmpeg_paths:
                ffmpeg_bin_dir = os.path.dirname(ffmpeg_paths[0])
                os.environ["PATH"] = ffmpeg_bin_dir + os.pathsep + os.environ["PATH"]
                logger.info(f"Automatically added ffmpeg to PATH: {ffmpeg_bin_dir}")

# Initialize configuration
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_LLM_MODEL = os.getenv("GROQ_LLM_MODEL", "openai/gpt-oss-120b")
GROQ_LLM_FALLBACK_MODELS = [
    m.strip() for m in os.getenv("GROQ_LLM_FALLBACK_MODELS", "openai/gpt-oss-20b,qwen/qwen3.6-27b").split(",") if m.strip()
]

# Validate configuration
if not GROQ_API_KEY:
    logger.warning("GROQ_API_KEY environment variable is not set.")

API_AUTH_TOKEN = os.getenv("API_AUTH_TOKEN")


def _positive_int_env(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
        if value <= 0:
            raise ValueError
        return value
    except ValueError:
        logger.warning("%s must be a positive integer; using %s.", name, default)
        return default


WORKER_STALE_MINUTES = _positive_int_env("WORKER_STALE_MINUTES", 30)
MAX_WORKER_ATTEMPTS = 3

def verify_api_key(x_api_key: Optional[str] = Header(None)):
    """Access gate: enforce token check if API_AUTH_TOKEN environment variable is set."""
    if API_AUTH_TOKEN:
        if not x_api_key or x_api_key.strip() != API_AUTH_TOKEN.strip():
            raise HTTPException(status_code=401, detail="Unauthorized API access. Valid X-API-Key header required.")


groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None
# Instagram blocks HF's datacenter IPs: on the Space, reels are queued for the local worker instead of downloaded.
IS_HF_SPACE = "SPACE_ID" in os.environ

@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.getenv("ENABLE_WORKER", "1") == "0" or IS_HF_SPACE:
        if IS_HF_SPACE:
            logger.info("Running on Hugging Face Space — auto-disabling queue worker to prevent datacenter IP blocks.")
        else:
            logger.info("ENABLE_WORKER=0 — queue worker disabled.")
    else:
        threading.Thread(target=run_worker, daemon=True).start()
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
        """LLMs often return list items as dicts (e.g. {step, action, description})
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
    """A saved reel row. /extract/url can return one that is still queued or
    failed (the URL was already submitted), so only finished rows carry a
    title and a full ReelExtraction in extracted_json."""
    id: Optional[str] = None
    url: Optional[str] = None
    title: Optional[str] = None
    raw_transcript: Optional[str] = None
    post_caption: Optional[str] = None
    extracted_json: dict
    created_at: Optional[str] = None
    status: str = "done"
    error: Optional[str] = None


def _chat_json(task: str, system_prompt: str, user_prompt: str, parse):
    """Ask each configured model in turn for a JSON reply and return
    parse(reply) from the first that succeeds. Raises HTTPException(500)
    once every model has failed."""
    if not groq_client:
        raise HTTPException(status_code=500, detail="Groq client is not configured on the backend server.")

    last_error = None
    for model_name in dict.fromkeys([GROQ_LLM_MODEL, *GROQ_LLM_FALLBACK_MODELS]):
        logger.info(f"Sending prompt to LLM ({model_name})")
        try:
            response = groq_client.chat.completions.create(
                model=model_name,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                response_format={"type": "json_object"},
            )
            content = response.choices[0].message.content
            logger.debug(f"LLM response from {model_name}: {content}")
            return parse(json.loads(content))
        except Exception as e:
            logger.warning(f"{task} attempt on {model_name} failed: {e}")
            last_error = e

    logger.error(f"{task} failed on every model. Last error: {last_error}")
    raise HTTPException(status_code=500, detail=f"{task} failed: {last_error}")


# Semantic clustering uses local embeddings for assignment and one small LLM call only for names.

EMBEDDING_MODEL_NAME = os.getenv(
    "EMBEDDING_MODEL_NAME",
    "sentence-transformers/all-MiniLM-L6-v2",
)
EMBEDDING_DIMENSIONS = 384  # size of the saved_reels.embedding vector(384) column
CLUSTER_SAMPLE_SIZE = 4
MIN_SEMANTIC_CLUSTERS = 8
MAX_SEMANTIC_CLUSTERS = 12
_embedding_model = None


class ClusterNameItem(BaseModel):
    id: str
    name: str


class ClusterNames(BaseModel):
    clusters: List[ClusterNameItem]

def _get_embedding_model():
    """Load the local embedding model once per worker process."""
    global _embedding_model
    if _embedding_model is None:
        try:
            from fastembed import TextEmbedding
        except ImportError as e:
            raise HTTPException(
                status_code=500,
                detail="Semantic clustering dependencies are not installed. "
                       "Install backend/requirements.txt.",
            ) from e
        try:
            logger.info("Loading local embedding model: %s", EMBEDDING_MODEL_NAME)
            _embedding_model = TextEmbedding(model_name=EMBEDDING_MODEL_NAME)
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Could not load embedding model '{EMBEDDING_MODEL_NAME}': {e}",
            ) from e
    return _embedding_model


def _reel_embedding_text(extracted_json: Optional[dict]) -> str:
    """The text a reel is fingerprinted from for semantic search."""
    ej = extracted_json or {}
    tools = ", ".join(str(tool) for tool in ej.get("tools_or_resources") or [])
    parts = (ej.get("core_topic"), ej.get("key_takeaway"), tools)
    return " ".join(str(part).strip() for part in parts if part and str(part).strip())


def embed_reel(extracted_json: Optional[dict]) -> Optional[List[float]]:
    """Fingerprint a reel for semantic search.

    Never raises: a reel must still save when embedding is unavailable
    (backfill_embeddings.py repairs it later). Returns None when there is
    nothing to embed."""
    try:
        text = _reel_embedding_text(extracted_json)
        if not text:
            return None
        vector = [float(x) for x in next(iter(_get_embedding_model().embed([text])))]
    except Exception as e:
        logger.warning(f"Could not embed reel for search: {getattr(e, 'detail', e)}")
        return None
    if len(vector) != EMBEDDING_DIMENSIONS:
        # pgvector would reject the whole row, losing the reel along with the vector.
        logger.warning("Embedding has %s dimensions, expected %s; not storing it. Check EMBEDDING_MODEL_NAME.",
                       len(vector), EMBEDDING_DIMENSIONS)
        return None
    return vector


# Same bar as the dashboard's smart search: unrelated topics peaked at 0.39 similarity.
NEAREST_CLUSTER_MIN_SIMILARITY = 0.4


def search_fields(extracted_json: Optional[dict]) -> dict:
    """The embedding and a starting cluster for a reel being saved.

    The cluster is copied from the closest already-clustered reel so new reels
    don't sit in Unclustered until the next recompute. Never raises: a reel
    without a close neighbour (or with the lookup down) just stays Unclustered."""
    embedding = embed_reel(extracted_json)
    cluster = None
    if embedding is not None:
        try:
            cluster = db.nearest_cluster(embedding, NEAREST_CLUSTER_MIN_SIMILARITY)
        except Exception as e:
            logger.warning(f"Could not find a starting cluster for reel: {e}")
    return {"embedding": embedding, "cluster": cluster}


def _target_cluster_count(item_count: int) -> int:
    """Choose a small, stable number of broad clusters for the library size."""
    if item_count <= 0:
        return 0
    if item_count < MIN_SEMANTIC_CLUSTERS:
        return item_count
    return min(MAX_SEMANTIC_CLUSTERS, max(MIN_SEMANTIC_CLUSTERS, round(item_count ** 0.5)))


def _semantic_cluster_labels(embeddings: List) -> List[int]:
    """Group embeddings with k-means on unit-length vectors (i.e. by cosine similarity).

    Average-linkage agglomerative clustering was used before; on a 740-reel
    library it put 96% of the reels into two clusters and left singletons."""
    if len(embeddings) <= 1:
        return [0] * len(embeddings)

    try:
        from sklearn.cluster import KMeans
        from sklearn.preprocessing import normalize
    except ImportError as e:
        raise HTTPException(
            status_code=500,
            detail="Semantic clustering dependencies are not installed. "
                   "Install backend/requirements.txt.",
        ) from e

    # Fixed seed: recomputing an unchanged library yields the same grouping.
    clusterer = KMeans(n_clusters=_target_cluster_count(len(embeddings)), n_init=10, random_state=0)
    return [int(label) for label in clusterer.fit_predict(normalize(embeddings))]


def _name_semantic_clusters(items: List[dict], labels: List[int]) -> dict:
    """Name mathematical clusters with one compact, schema-constrained LLM call."""
    examples_by_cluster = {}
    for item, label in zip(items, labels):
        topic = str(item.get("topic") or "").strip()
        takeaway = str(item.get("takeaway") or "").strip()
        example = " — ".join(part for part in (topic, takeaway) if part)
        examples_by_cluster.setdefault(str(label), []).append(example or 'Uncategorized content')

    cluster_examples = [
        {
            "id": cluster_id,
            "examples": examples[:CLUSTER_SAMPLE_SIZE],
        }
        for cluster_id, examples in sorted(examples_by_cluster.items(), key=lambda pair: int(pair[0]))
    ]
    system_prompt = (
        "You are a taxonomy editor. Name each semantic content cluster from the "
        "provided examples. Return one concise, human-readable label of 2 to 4 "
        "words per cluster. Labels must be distinct, broad, and descriptive; do "
        "not include counts, cluster numbers, or punctuation-heavy prose. "
        "Respond ONLY with valid JSON in exactly this shape, with every input id "
        "appearing exactly once:\n"
        '{"clusters": [{"id": "0", "name": "AI Tools"}]}'
    )
    user_prompt = "Semantic clusters and representative examples (JSON):\n" + json.dumps(
        cluster_examples,
        ensure_ascii=False,
    )

    validated = _chat_json("Cluster naming", system_prompt, user_prompt, lambda data: ClusterNames(**data))

    names = {}
    used_names = set()
    for cluster in validated.clusters:
        cluster_id = str(cluster.id)
        name = cluster.name.strip()
        if cluster_id not in examples_by_cluster or not name:
            continue
        if name in used_names:
            name = f"{name} {cluster_id}"
        names[cluster_id] = name
        used_names.add(name)

    # Preserve a complete assignment if the model omitted an id.
    for cluster_id in examples_by_cluster:
        names.setdefault(cluster_id, f"Topic Group {int(cluster_id) + 1}")
    return names


def cluster_topics_semantically(items: List[dict]) -> List[dict]:
    """Cluster reels by their stored search embeddings, then name the clusters once.

    items: list of {"id": str, "topic": str, "takeaway": str, "embedding": list}.
    Returns list of {"id": str, "cluster": str}.
    """
    if not items:
        return []

    labels = _semantic_cluster_labels([item["embedding"] for item in items])
    names = _name_semantic_clusters(items, labels)
    return [
        {"id": item["id"], "cluster": names[str(label)]}
        for item, label in zip(items, labels)
    ]


# Helper functions
def is_valid_instagram_reel(url: str) -> bool:
    if not url:
        return False
    clean_url = normalize_instagram_url(url)
    pattern = r"^https?://(www\.)?instagram\.com/(?:reel|reels|p)/[A-Za-z0-9_\-]+/?$"
    return bool(re.match(pattern, clean_url))

def get_cookie_file() -> Optional[str]:
    """Check for cookies.txt in absolute and relative paths to bypass Instagram scraping blocks."""
    current_dir = os.path.dirname(os.path.abspath(__file__))
    parent_dir = os.path.dirname(current_dir)
    
    paths = [
        os.path.join(current_dir, "cookies.txt"),
        os.path.join(parent_dir, "cookies.txt"),
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
    clean_url = normalize_instagram_url(url)

    # Extract Reel ID from the URL (fallback to UUID if match fails)
    match = re.search(r"/(?:reel|reels|p)/([A-Za-z0-9_\-]+)", clean_url)
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
        err_msg = str(e)
        logger.error(f"Error downloading or extracting audio: {err_msg}")
        # Clean up any leftover temp files on download error
        for f in glob.glob(os.path.join(temp_dir, f"video_{reel_id}.*")):
            try:
                os.remove(f)
                logger.info(f"Cleaned up failed download file: {f}")
            except Exception as ce:
                logger.warning(f"Could not delete temp file {f}: {str(ce)}")
        
        err_msg_lower = err_msg.lower()
        if any(x in err_msg_lower for x in ["empty media response", "cookies", "login", "authenticate"]):
            status_code = 403
            detail = f"Instagram session cookies are expired or missing. Please export your browser cookies to backend/cookies.txt. Error: {err_msg}"
        elif any(x in err_msg_lower for x in ["no video formats found", "extractorerror", "unsupported url"]):
            status_code = 415
            detail = f"This post is a photo carousel. The Transcriber only supports videos and reels. Error: {err_msg}"
        else:
            status_code = 500
            detail = f"Failed to download or parse Instagram Reel. Meta may be blocking the request. Error: {err_msg}"

        raise HTTPException(status_code=status_code, detail=detail)

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

def _parse_extraction(data) -> ReelExtraction:
    if isinstance(data, list):
        if not data:
            raise ValueError("LLM returned an empty JSON array.")
        data = data[0]
    if not isinstance(data, dict):
        raise ValueError(f"Expected JSON object, got {type(data).__name__}")
    return ReelExtraction(**data)


def extract_structured_json(transcript: str, caption: str) -> ReelExtraction:
    """Analyze the transcript and caption with the configured Groq LLM to output schema-validated insights."""
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

    return _chat_json("Structured extraction", system_prompt, user_prompt, _parse_extraction)

# API Endpoints
@app.get("/health")
def health_check():
    """Simple health check endpoint used to check API health."""
    return {"status": "ok", "message": "Extractor service is awake and running."}

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


@app.post("/reels/{reel_id}/retry", dependencies=[Depends(verify_api_key)])
def retry_reel(reel_id: str):
    """Requeue a terminal reel failure for another worker attempt."""
    try:
        if not db.retry_reel(reel_id):
            raise HTTPException(status_code=404, detail="Reel not found or not in a retryable failure state.")
        return {"id": reel_id, "status": "pending"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Retry enqueue failed: {e}")
        raise HTTPException(status_code=500, detail=f"Retry enqueue failed: {e}")

CLUSTER_JOB = {
    "status": "idle",  # idle | running | done | error
    "started_at": None,
    "finished_at": None,
    "assigned": 0,
    "error": None,
}


def _recluster_late_reels(items: List[dict], clusters: List[str]) -> None:
    """Reels saved while the recompute ran copied a pre-recompute cluster name.
    Give each the new cluster of its closest reel from this run (same 0.4 bar as
    search_fields), computed locally so their own stale names can't match."""
    if not items:
        return
    from sklearn.preprocessing import normalize
    clustered = normalize([item["embedding"] for item in items])
    seen = {item["id"] for item in items}
    late = [r for r in db.reels_for_clustering() if r["id"] not in seen and r["embedding"] is not None]
    ids_by_cluster = {}
    for reel in late:
        similarities = clustered @ normalize([reel["embedding"]])[0]
        best = int(similarities.argmax())
        cluster = clusters[best] if similarities[best] >= NEAREST_CLUSTER_MIN_SIMILARITY else None
        ids_by_cluster.setdefault(cluster, []).append(reel["id"])
    for cluster, reel_ids in ids_by_cluster.items():
        db.set_cluster(reel_ids, cluster)


def recompute_clusters() -> int:
    """Regroup every extracted reel into named clusters. Returns how many reels were assigned."""
    rows = db.reels_for_clustering()
    if not rows:
        return 0

    items = []
    unextracted_ids = []  # queued or failed reels: nothing to cluster on
    for r in rows:
        ej = r["extracted_json"]
        embedding = r["embedding"]
        if embedding is None:
            # Not embedded yet (e.g. saved while the model was unavailable): repair it now.
            embedding = embed_reel(ej)
            if embedding is not None:
                db.set_embedding(r["id"], embedding)
        if embedding is None:
            unextracted_ids.append(r["id"])
        else:
            items.append({"id": r["id"], "topic": ej.get("core_topic", ""),
                          "takeaway": ej.get("key_takeaway", ""), "embedding": embedding})

    db.set_cluster(unextracted_ids, None)
    assignments = cluster_topics_semantically(items)
    ids_by_cluster = {}
    for assignment in assignments:
        ids_by_cluster.setdefault(assignment["cluster"], []).append(assignment["id"])
    for cluster, reel_ids in ids_by_cluster.items():
        db.set_cluster(reel_ids, cluster)
    applied = sum(len(reel_ids) for reel_ids in ids_by_cluster.values())
    _recluster_late_reels(items, [a["cluster"] for a in assignments])
    logger.info(f"Recomputed clusters: assigned {applied} of {len(rows)} reels.")
    return applied


def run_cluster_job(job: dict) -> None:
    """Run one recompute requested from the dashboard and record the outcome on its row."""
    try:
        db.finish_cluster_job(job["id"], "done", recompute_clusters())
    except Exception as e:
        logger.error(f"Cluster job {job['id']} failed: {e}")
        db.finish_cluster_job(job["id"], "error", error=str(e))


def run_cluster_recompute_task():
    CLUSTER_JOB.update({
        "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None,
        "assigned": 0,
        "error": None,
    })
    try:
        CLUSTER_JOB.update({
            "status": "done",
            "assigned": recompute_clusters(),
            "finished_at": datetime.now(timezone.utc).isoformat(),
        })
    except Exception as e:
        logger.error(f"Cluster recompute task failed: {str(e)}")
        CLUSTER_JOB.update({
            "status": "error",
            "error": str(e),
            "finished_at": datetime.now(timezone.utc).isoformat(),
        })


_CLUSTER_JOB_LOCK = threading.Lock()


@app.post("/clusters/recompute", dependencies=[Depends(verify_api_key)])
def start_cluster_recompute(background_tasks: BackgroundTasks):
    """Trigger cluster recomputation in the background."""
    # Endpoints run in a threadpool: claim the job here, or two quick requests both start one.
    with _CLUSTER_JOB_LOCK:
        if CLUSTER_JOB["status"] == "running":
            raise HTTPException(status_code=409, detail="Cluster recomputation is already in progress.")
        CLUSTER_JOB["status"] = "running"
    background_tasks.add_task(run_cluster_recompute_task)
    return {"status": "started", "message": "Cluster recomputation started in the background."}


@app.get("/clusters/recompute/status")
def get_recompute_status():
    """Poll endpoint to check recomputation status."""
    return CLUSTER_JOB

def _run_pipeline(url: str, allow_caption_fallback: bool = True) -> tuple[str, str, str, ReelExtraction]:
    """Download → transcribe → silent-hook guard → LLM extract for one reel.

    Owns the temp audio file (always cleaned up). Returns
    (title, raw_transcript, post_caption, extracted). Raises HTTPException(400)
    on silent-hook reels and HTTPException(500) on download/LLM failures. A
    failed transcription falls back to the caption alone unless
    allow_caption_fallback is False, in which case it raises too. Callers
    handle persistence."""
    mp3_path = None
    try:
        mp3_path, post_caption, title = download_and_extract_audio(url)
        raw_transcript, extracted = _transcribe_and_extract(mp3_path, post_caption, allow_caption_fallback)
        return title, raw_transcript, post_caption, extracted
    finally:
        _remove_temp_file(mp3_path)


def _remove_temp_file(path: Optional[str]) -> None:
    if path and os.path.exists(path):
        try:
            os.remove(path)
            logger.info(f"Cleaned up temporary audio file: {path}")
        except Exception as ce:
            logger.warning(f"Could not delete temp file {path}: {str(ce)}")


def _transcribe_and_extract(audio_file: str, caption: Optional[str],
                            allow_caption_fallback: bool) -> tuple[str, ReelExtraction]:
    """Transcribe → silent-hook guard → LLM extract. Returns (raw_transcript, extracted).

    A failed transcription falls back to the caption alone unless
    allow_caption_fallback is False, in which case it raises."""
    raw_transcript = ""
    try:
        raw_transcript = transcribe_audio(audio_file)
    except Exception as e:
        if not allow_caption_fallback:
            raise
        logger.warning(f"Transcription failed: {str(e)}. Proceeding using metadata/caption only.")
    guard_silent_hook(raw_transcript, caption)
    return raw_transcript, extract_structured_json(raw_transcript, caption or "")


def _extract_from_audio_row(row: dict, allow_caption_fallback: bool) -> tuple[str, ReelExtraction]:
    """Fetch a dashboard upload from Storage into a temp file, then transcribe and extract it."""
    suffix = os.path.splitext(row["audio_path"])[1] or ".mp3"
    temp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        temp.write(db.download_audio(row["audio_path"]))
        temp.close()
        return _transcribe_and_extract(temp.name, row.get("post_caption"), allow_caption_fallback)
    finally:
        temp.close()
        _remove_temp_file(temp.name)


def process_reel_url(url: str) -> dict:
    """Full single-reel pipeline. Returns the saved DB record.

    Returns the cached row if this URL was already processed. Raises
    HTTPException(400) on silent-hook reels (no spoken content). Used by
    /extract/url."""
    clean_url = normalize_instagram_url(url)
    cached = db.get_reel_by_url(clean_url)
    if cached:
        logger.info(f"Returning cached record for URL: {clean_url}")
        return cached
    if IS_HF_SPACE:
        logger.info(f"Queued {clean_url} for the local worker.")
        return db.insert_reel(url=clean_url, title=None, raw_transcript="", post_caption="",
                              extracted_json={}, status="pending", source="dashboard")

    title, raw_transcript, post_caption, extracted = _run_pipeline(clean_url)
    # The Shortcut or worker may have saved this URL while the pipeline ran.
    existing = db.get_reel_by_url(clean_url)
    if existing:
        logger.info(f"Reel already exists. ID: {existing['id']}")
        return existing
    extracted_json = extracted.model_dump()
    return db.insert_reel(
        url=clean_url,
        title=title,
        raw_transcript=raw_transcript,
        post_caption=post_caption,
        extracted_json=extracted_json,
        **search_fields(extracted_json),
    )


@app.post("/extract/url", response_model=ExtractionResponse, dependencies=[Depends(verify_api_key)])
def extract_url(payload: dict):
    """Accepts an Instagram Reel URL and runs the full extraction pipeline."""
    url = payload.get("url")
    if not url:
        raise HTTPException(status_code=400, detail="Missing required 'url' parameter.")
    clean_url = normalize_instagram_url(url)
    if not is_valid_instagram_reel(clean_url):
        raise HTTPException(status_code=400, detail="Invalid Instagram Reel URL format.")
    return process_reel_url(clean_url)


def process_pending_reel(row: dict) -> None:
    """Run the pipeline for one claimed queue row and UPDATE it in place.

    The row says what to do: a URL is downloaded (Shortcut, pasted URL, bulk
    import), an audio_path is fetched from Storage (dashboard upload), and
    otherwise its pasted transcript/caption is extracted directly. Failures
    are retried with backoff or marked with a failure status the dashboard
    can retry."""
    reel_id = row["id"]
    url = row.get("url")
    audio_path = row.get("audio_path")
    uploaded_audio = None  # set only when this row's audio was what got processed
    try:
        # A failed transcription is retried like any transient error; only the
        # last attempt settles for a caption-only extraction.
        is_final_attempt = int(row.get("attempt_count") or 0) >= MAX_WORKER_ATTEMPTS
        if url:
            clean_url = normalize_instagram_url(url)
            if not is_valid_instagram_reel(clean_url):
                logger.warning(f"Worker rejected reel {reel_id}: Invalid URL format ({url})")
                db.mark_failed(reel_id, f"Invalid Instagram Reel URL format: {url}")
                return
            title, raw_transcript, post_caption, extracted = _run_pipeline(
                clean_url, allow_caption_fallback=is_final_attempt)
        elif audio_path:
            title, post_caption = row.get("title"), row.get("post_caption")
            raw_transcript, extracted = _extract_from_audio_row(row, is_final_attempt)
            uploaded_audio = audio_path
        elif (row.get("raw_transcript") or "").strip() or (row.get("post_caption") or "").strip():
            title = row.get("title")
            raw_transcript, post_caption = row.get("raw_transcript") or "", row.get("post_caption") or ""
            extracted = extract_structured_json(raw_transcript, post_caption)
        else:
            db.mark_failed(reel_id, "Nothing to process: no URL, audio or text.")
            return
        extracted_json = extracted.model_dump()
        db.update_reel_result(
            reel_id=reel_id,
            title=title,
            raw_transcript=raw_transcript,
            post_caption=post_caption,
            extracted_json=extracted_json,
            **search_fields(extracted_json),
        )
        logger.info(f"Worker processed reel {reel_id} ({url or audio_path or 'pasted text'})")
        if uploaded_audio:
            try:
                db.delete_audio(uploaded_audio)
            except Exception as e:  # the reel is saved; a leftover file only costs Storage space
                logger.warning(f"Could not delete uploaded audio {uploaded_audio}: {e}")
    except HTTPException as e:
        logger.warning(f"Worker failed reel {reel_id}: {e.detail}")
        if is_retryable_worker_error(e) and _schedule_worker_retry(row, e.detail):
            return
        status = "failed"
        if e.status_code == 403:
            status = "cookies_expired"
        elif e.status_code == 415:
            status = "unsupported_format"
        db.mark_failed(reel_id, e.detail, status)
    except Exception as e:
        logger.error(f"Worker error on reel {reel_id}: {str(e)}")
        if is_retryable_worker_error(e) and _schedule_worker_retry(row, str(e)):
            return
        db.mark_failed(reel_id, str(e))


def is_retryable_worker_error(error: Exception) -> bool:
    """Classify only known transient API and network failures as retryable."""
    if isinstance(error, HTTPException):
        return error.status_code == 429 or 500 <= error.status_code <= 599
    if isinstance(error, APIStatusError):
        return error.status_code == 429 or 500 <= error.status_code <= 599
    return isinstance(error, (APIConnectionError, httpx.TimeoutException, httpx.NetworkError))


def retry_delay_seconds(attempt_count: int, jitter: float | None = None) -> float:
    """Return bounded exponential retry delay: about 30s, then about 2m."""
    base = 30 * (4 ** max(0, attempt_count - 1))
    factor = random.uniform(0.9, 1.1) if jitter is None else jitter
    return base * factor


def _schedule_worker_retry(row: dict, error: str) -> bool:
    attempt_count = int(row.get("attempt_count") or 0)
    if attempt_count >= MAX_WORKER_ATTEMPTS:
        return False
    next_attempt = datetime.now(timezone.utc) + timedelta(seconds=retry_delay_seconds(attempt_count))
    db.schedule_retry(row["id"], error, next_attempt)
    logger.warning("Scheduled retry %s/%s for reel %s at %s.",
                   attempt_count + 1, MAX_WORKER_ATTEMPTS, row["id"], next_attempt.isoformat())
    return True


def worker_tick() -> bool:
    """Process one pending reel, or if none is waiting, one recompute request.
    Returns True if anything was claimed."""
    try:
        db.heartbeat()
    except Exception as e:  # losing the "last seen" signal must never stop real work
        logger.warning(f"Worker heartbeat failed: {e}")
    row = db.claim_next_pending()
    if row:
        process_pending_reel(row)
        return True
    job = db.claim_next_cluster_job()
    if job:
        run_cluster_job(job)
        return True
    return False


def run_worker(drain: bool = False, idle_interval: float = 20.0) -> None:
    """Recover abandoned claims, then process the queue.

    Idles between polls when the queue is empty; with drain=True it exits
    instead (also after a crashed tick). Shared by the in-process thread and
    run_worker.py."""
    stale_before = datetime.now(timezone.utc) - timedelta(minutes=WORKER_STALE_MINUTES)
    for recover in (db.recover_stale_processing, db.recover_stale_cluster_jobs):
        try:
            logger.info("Recovered %s stale item(s) via %s.", recover(stale_before), recover.__name__)
        except Exception as e:
            logger.error(f"Stale-claim recovery failed ({recover.__name__}): {e}")

    logger.info("Queue worker started.")
    while True:
        try:
            did_work = worker_tick()
        except Exception as e:
            logger.error(f"Worker tick crashed: {str(e)}")
            did_work = False
        if did_work:
            continue
        if drain:
            logger.info("No more pending reels to process. Exiting drain worker.")
            return
        time.sleep(idle_interval)


@app.post("/extract/file", response_model=ExtractionResponse, dependencies=[Depends(verify_api_key)])
def extract_file(
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
        temp_file.write(file.file.read())
        temp_file.close()

        # 1. Transcribe
        raw_transcript = transcribe_audio(temp_file_path)

        # 2. Guard silent/music-only uploads before spending an LLM call
        guard_silent_hook(raw_transcript, caption)

        # 3. Extract structured insights
        extracted_data = extract_structured_json(raw_transcript, caption or "")

        # 4. Commit to Database
        extracted_json = extracted_data.model_dump()
        return db.insert_reel(
            url=None,  # No URL for manual upload
            title=title,
            raw_transcript=raw_transcript,
            post_caption=caption,
            extracted_json=extracted_json,
            **search_fields(extracted_json),
        )
    finally:
        if os.path.exists(temp_file_path):
            os.remove(temp_file_path)

@app.post("/extract/text", response_model=ExtractionResponse, dependencies=[Depends(verify_api_key)])
def extract_text(payload: dict):
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
    extracted_json = extracted_data.model_dump()
    return db.insert_reel(
        url=None,
        title=title,
        raw_transcript=transcript,
        post_caption=caption,
        extracted_json=extracted_json,
        **search_fields(extracted_json),
    )


ACTIVE_REEL_STATUSES = frozenset({"pending", "processing"})
SUCCESS_REEL_STATUSES = frozenset({"done"})

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


def update_batch_job_status():
    """Query Supabase to aggregate current progress for the tracked URLs."""
    urls = BATCH_JOB["urls"]
    if not urls:
        BATCH_JOB["status"] = "idle"
        return

    try:
        status_map = {row["url"]: row for row in db.statuses_for_urls(urls)}
    except Exception as e:
        logger.error(f"Error fetching batch status: {e}")
        return

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
            if status in SUCCESS_REEL_STATUSES:
                ok += 1
            elif status in db.FAILURE_STATUSES:
                failed += 1
                errors.append({"url": url, "detail": row.get("error") or "Unknown error"})
            elif status in ACTIVE_REEL_STATUSES:
                processing += 1
                if status == "processing":
                    current_url = url
            else:
                failed += 1
                errors.append({"url": url, "detail": f"Unknown queue status: {status}"})
                
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
def extract_batch(file: UploadFile = File(...)):
    """Accept an uploaded saved_posts.json and enqueue reels in Supabase."""
    if BATCH_JOB["status"] == "running":
        update_batch_job_status()
        if BATCH_JOB["status"] == "running":
            raise HTTPException(status_code=409, detail="A batch import is already running.")

    try:
        data = json.loads(file.file.read())
    except Exception:
        raise HTTPException(status_code=400, detail="Could not parse uploaded JSON.")

    reels = parse_saved_posts(data)
    if not reels:
        raise HTTPException(status_code=400, detail="No reel URLs found in the uploaded file.")

    urls = [r["url"] for r in reels]
    existing_urls = {row["url"] for row in db.statuses_for_urls(urls)}
    new_reels = [r for r in reels if r["url"] not in existing_urls]
    db.insert_pending_reels(new_reels, source="batch")
    enqueued_count = len(new_reels)

    # Initialize batch tracking state; counts come from the rows' real statuses.
    BATCH_JOB.update({
        "status": "running",
        "total": len(urls),
        "urls": urls,
        "done": 0,
        "ok": 0,
        "failed": 0,
        "current": "",
        "errors": [],
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None,
    })
    update_batch_job_status()

    return {
        "started": enqueued_count > 0,
        "total": len(urls),
        "enqueued": enqueued_count,
        "existing": len(existing_urls),
    }


@app.get("/extract/batch/status")
def extract_batch_status():
    """Poll endpoint to check progress."""
    if BATCH_JOB["status"] == "running":
        update_batch_job_status()
    return BATCH_JOB

