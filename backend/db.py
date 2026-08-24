"""Supabase-backed data layer for Transcriber.

All persistence goes through this module so main.py never touches the DB driver
directly. The backend authenticates with the Supabase SERVICE ROLE key (bypasses
RLS) and must only ever run on a trusted machine.
"""
import json
import os
import uuid
from collections import Counter
from datetime import datetime, timezone
from typing import Optional

from supabase import create_client, Client

TABLE = "saved_reels"
_client: Optional[Client] = None


def get_client() -> Client:
    """Lazily create the Supabase client so importing db.py never needs creds."""
    global _client
    if _client is None:
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_SERVICE_KEY")
        if not url or not key:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.")
        _client = create_client(url, key)
    return _client


def row_to_record(r: dict) -> dict:
    """Map a raw DB row to the API record shape the frontend expects."""
    ej = r.get("extracted_json")
    if isinstance(ej, str):
        try:
            ej = json.loads(ej)
        except (json.JSONDecodeError, TypeError):
            ej = {}
    return {
        "id": r["id"],
        "url": r.get("url"),
        "title": r.get("title"),
        "raw_transcript": r.get("raw_transcript"),
        "post_caption": r.get("post_caption"),
        "extracted_json": ej,
        "created_at": r.get("created_at"),
        "cluster": r.get("cluster") or "Unclustered",
        "status": r.get("status") or "done",
        "error": r.get("error"),
    }


def get_reel_by_url(url: str) -> Optional[dict]:
    res = get_client().table(TABLE).select("*").eq("url", url).limit(1).execute()
    rows = res.data or []
    return row_to_record(rows[0]) if rows else None


def insert_reel(url, title, raw_transcript, post_caption, extracted_json,
                status="done", source=None) -> dict:
    row = {
        "id": str(uuid.uuid4()),
        "url": url,
        "title": title,
        "raw_transcript": raw_transcript,
        "post_caption": post_caption,
        "extracted_json": extracted_json,  # dict -> jsonb
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "source": source,
    }
    get_client().table(TABLE).insert(row).execute()
    return row_to_record(row)


def list_reels(limit: int = 20, search: Optional[str] = None) -> list:
    q = get_client().table(TABLE).select("id, url, title, extracted_json, created_at, cluster, status, error").order("created_at", desc=True).limit(limit)
    if search:
        # UI filters in-memory; this server search is a coarse fallback over text cols.
        like = f"%{search}%"
        q = q.or_(f"title.ilike.{like},raw_transcript.ilike.{like},post_caption.ilike.{like}")
    res = q.execute()
    return [row_to_record(r) for r in (res.data or [])]


def get_reel_details(reel_id: str) -> Optional[dict]:
    """Retrieve only raw_transcript and post_caption fields for a reel."""
    res = get_client().table(TABLE).select("raw_transcript, post_caption").eq("id", reel_id).limit(1).execute()
    rows = res.data or []
    return rows[0] if rows else None


def reels_for_clustering() -> list:
    res = get_client().table(TABLE).select("id, extracted_json").execute()
    return res.data or []


def set_cluster(reel_id: str, cluster: str) -> None:
    get_client().table(TABLE).update({"cluster": cluster}).eq("id", reel_id).execute()


def delete_reel(reel_id: str) -> bool:
    """Delete a reel by id. Returns True if a row was removed, False if none matched."""
    res = get_client().table(TABLE).delete().eq("id", reel_id).execute()
    return bool(res.data)


def claim_next_pending() -> Optional[dict]:
    """Atomically claim the oldest pending reel: flip it to 'processing' and
    return the raw row. Returns None if the queue is empty or another worker
    won the claim."""
    c = get_client()
    now = datetime.now(timezone.utc).isoformat()
    res = (c.table(TABLE).select("*")
           .eq("status", "pending")
           .or_(f"next_attempt_at.is.null,next_attempt_at.lte.{now}")
           .order("created_at").limit(1).execute())
    rows = res.data or []
    if not rows:
        return None
    row = rows[0]
    attempt_count = int(row.get("attempt_count") or 0) + 1
    payload = {
        "status": "processing",
        "processing_started_at": now,
        "next_attempt_at": None,
        "attempt_count": attempt_count,
    }
    upd = (c.table(TABLE).update(payload)
           .eq("id", row["id"]).eq("status", "pending").execute())
    if not upd.data:
        return None  # lost the race
    return {**row, **payload}


def update_reel_result(reel_id: str, title: str, raw_transcript, post_caption,
                       extracted_json, status: str = "done") -> None:
    """Write pipeline results back onto an existing (claimed) row."""
    get_client().table(TABLE).update({
        "title": title,
        "raw_transcript": raw_transcript,
        "post_caption": post_caption,
        "extracted_json": extracted_json,
        "status": status,
        "error": None,
        "processing_started_at": None,
        "next_attempt_at": None,
    }).eq("id", reel_id).execute()


def mark_failed_with_status(reel_id: str, error, status: str = "failed") -> None:
    """Mark a claimed row with a specific failure status, recording a truncated error message."""
    get_client().table(TABLE).update({
        "status": status,
        "error": str(error)[:500],
        "processing_started_at": None,
        "next_attempt_at": None,
    }).eq("id", reel_id).execute()


def mark_failed(reel_id: str, error) -> None:
    """Mark a claimed row failed, recording a truncated error message."""
    mark_failed_with_status(reel_id, error, "failed")


RETRYABLE_FAILURE_STATUSES = frozenset({"failed", "cookies_expired", "unsupported_format"})


def retry_reel(reel_id: str) -> bool:
    """Requeue a terminal failure and reset its retry budget."""
    res = get_client().table(TABLE).update({
        "status": "pending",
        "error": None,
        "processing_started_at": None,
        "next_attempt_at": None,
        "attempt_count": 0,
    }).eq("id", reel_id).in_("status", list(RETRYABLE_FAILURE_STATUSES)).execute()
    return bool(res.data)

def recover_stale_processing(stale_before: datetime) -> int:
    """Return abandoned claims older than stale_before to the queue."""
    res = (get_client().table(TABLE).update({
        "status": "pending",
        "error": "Recovered stale processing claim",
        "processing_started_at": None,
    }).eq("status", "processing")
      .lt("processing_started_at", stale_before.astimezone(timezone.utc).isoformat())
      .execute())
    return len(res.data or [])


def schedule_retry(reel_id: str, error: str, next_attempt_at: datetime) -> None:
    """Release a claim for a future retry while preserving its attempt count."""
    get_client().table(TABLE).update({
        "status": "pending",
        "error": str(error)[:500],
        "processing_started_at": None,
        "next_attempt_at": next_attempt_at.astimezone(timezone.utc).isoformat(),
    }).eq("id", reel_id).execute()

def cluster_counts() -> list:
    res = get_client().table(TABLE).select("cluster").execute()
    counts = Counter((r.get("cluster") or "Unclustered") for r in (res.data or []))
    return [{"name": name, "count": n}
            for name, n in sorted(counts.items(), key=lambda kv: -kv[1])]
