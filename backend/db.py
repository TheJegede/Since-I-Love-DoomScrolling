"""Supabase-backed data layer for Transcriber.

All persistence goes through this module so main.py never touches the DB driver
directly. The backend authenticates with the Supabase SERVICE ROLE key (bypasses
RLS) and must only ever run on a trusted machine.
"""
import json
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from supabase import create_client, Client

TABLE = "saved_reels"
FAILURE_STATUSES = frozenset({"failed", "cookies_expired", "unsupported_format"})
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


def _chunked(seq: list, size: int):
    """Yield successive size-length slices of a sequence."""
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def _select_newest_first(columns: str, limit: Optional[int] = None) -> list:
    """Select rows newest-first, paging past PostgREST's per-request row cap."""
    rows = []
    while limit is None or len(rows) < limit:
        last = len(rows) + 999 if limit is None else limit - 1
        page = (get_client().table(TABLE).select(columns)
                .order("created_at", desc=True).order("id")
                .range(len(rows), last).execute().data or [])
        if not page:
            break
        rows.extend(page)
    return rows


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


def list_reels(limit: int = 20) -> list:
    columns = "id, url, title, extracted_json, created_at, cluster, status, error"
    return [row_to_record(r) for r in _select_newest_first(columns, limit)]


def statuses_for_urls(urls: list) -> list:
    """Return [{url, status, error}] for whichever of the given URLs exist."""
    rows = []
    for chunk in _chunked(urls, 100):
        res = get_client().table(TABLE).select("url", "status", "error").in_("url", chunk).execute()
        rows.extend(res.data or [])
    return rows


def insert_pending_reels(reels: list, source: str) -> None:
    """Enqueue parsed [{url, title, caption}] reels as pending rows for the worker."""
    rows = [
        {
            "id": str(uuid.uuid4()),
            "url": r["url"],
            "title": r["title"] or f"Reel ({r['url'].split('/reel/')[-1].replace('/', '')})",
            "raw_transcript": "",
            "post_caption": r["caption"],
            "extracted_json": {},
            "created_at": datetime.now(timezone.utc).isoformat(),
            "status": "pending",
            "source": source,
        }
        for r in reels
    ]
    for chunk in _chunked(rows, 50):
        get_client().table(TABLE).insert(chunk).execute()


def get_reel_details(reel_id: str) -> Optional[dict]:
    """Retrieve only raw_transcript and post_caption fields for a reel."""
    res = get_client().table(TABLE).select("raw_transcript, post_caption").eq("id", reel_id).limit(1).execute()
    rows = res.data or []
    return rows[0] if rows else None


def reels_for_clustering() -> list:
    return _select_newest_first("id, extracted_json")


def set_cluster(reel_ids: list, cluster: Optional[str]) -> None:
    for chunk in _chunked(reel_ids, 100):
        get_client().table(TABLE).update({"cluster": cluster}).in_("id", chunk).execute()


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


def mark_failed(reel_id: str, error, status: str = "failed") -> None:
    """Mark a claimed row with a failure status, recording a truncated error message."""
    get_client().table(TABLE).update({
        "status": status,
        "error": str(error)[:500],
        "processing_started_at": None,
        "next_attempt_at": None,
    }).eq("id", reel_id).execute()


def retry_reel(reel_id: str) -> bool:
    """Requeue a terminal failure and reset its retry budget."""
    res = get_client().table(TABLE).update({
        "status": "pending",
        "error": None,
        "processing_started_at": None,
        "next_attempt_at": None,
        "attempt_count": 0,
    }).eq("id", reel_id).in_("status", list(FAILURE_STATUSES)).execute()
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
