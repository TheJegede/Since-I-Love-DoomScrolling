"""One-time copy of existing local_storage.db rows into Supabase.

Run once after the Supabase schema exists and .env has SUPABASE creds:
    backend/.venv/Scripts/python.exe backend/migrate_sqlite_to_supabase.py

Idempotent: skips URLs already present in Supabase. Rows are imported as
status='done', source='migrated'.
"""
import json
import os
import sqlite3
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from dotenv import load_dotenv

load_dotenv()
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

import db  # noqa: E402

SQLITE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "local_storage.db")


def main():
    if not os.path.exists(SQLITE_PATH):
        print(f"No SQLite DB at {SQLITE_PATH}; nothing to migrate.")
        return 0
    conn = sqlite3.connect(SQLITE_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, url, title, raw_transcript, post_caption, extracted_json, created_at, cluster "
        "FROM saved_reels"
    ).fetchall()
    conn.close()
    print(f"Found {len(rows)} local rows.")

    client = db.get_client()
    migrated = skipped = failed = 0
    for r in rows:
        url = r["url"]
        if url and db.get_reel_by_url(url):
            skipped += 1
            continue
        try:
            ej = r["extracted_json"]
            ej = json.loads(ej) if isinstance(ej, str) else ej
            client.table(db.TABLE).insert({
                "id": r["id"],
                "url": url,
                "title": r["title"],
                "raw_transcript": r["raw_transcript"],
                "post_caption": r["post_caption"],
                "extracted_json": ej,
                "created_at": r["created_at"],
                "cluster": r["cluster"],
                "status": "done",
                "source": "migrated",
            }).execute()
            migrated += 1
        except Exception as e:
            print(f"  failed {r['id']}: {e}")
            failed += 1
    print(f"Done. migrated={migrated} skipped={skipped} failed={failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
