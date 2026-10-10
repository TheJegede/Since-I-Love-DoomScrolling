"""Fingerprint reels that have no search embedding yet. Safe to re-run.

Run from the repo root:  python backend/backfill_embeddings.py
"""
import db
import main  # importing main loads .env and configures logging


def backfill() -> tuple:
    """Embed every row missing an embedding. Returns (updated, skipped)."""
    main._get_embedding_model()  # fail loudly here rather than skip every row
    updated = skipped = 0
    for row in db.reels_missing_embedding():
        embedding = main.embed_reel(db.row_to_record(row)["extracted_json"])
        if embedding is None:
            skipped += 1  # queued/failed reel: nothing extracted to embed
            continue
        db.set_embedding(row["id"], embedding)
        updated += 1
    return updated, skipped


if __name__ == "__main__":
    updated, skipped = backfill()
    print(f"Embedded {updated} reel(s); skipped {skipped} with nothing to embed.")
