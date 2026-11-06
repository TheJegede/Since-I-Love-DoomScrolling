"""Clean share-link text (?igsh=..., ?xtok=...) off saved reel URLs, and find reels saved twice.

Run from the repo root (back up first: python backend/export_reels.py):
  python backend/normalize_urls.py                               # dry run: print the plan, change nothing
  python backend/normalize_urls.py --apply                       # clean the links; duplicates are only listed
  python backend/normalize_urls.py --apply --delete-duplicates   # also delete the extra copies
Safe to re-run: a clean library produces an empty plan.
"""
import sys

import db
import main  # noqa: F401  importing main loads .env and configures logging
from saved_parser import normalize_instagram_url


def plan(rows: list) -> dict:
    """{"updates": [(id, clean_url)], "duplicates": [(drop_id, keep_id, clean_url)]}.

    Per reel, the copy kept is a finished one if any, else the oldest; extra copies are duplicates."""
    groups = {}
    for row in rows:
        if row.get("url"):
            groups.setdefault(normalize_instagram_url(row["url"]), []).append(row)
    updates, duplicates = [], []
    for clean_url, copies in groups.items():
        keep = min(copies, key=lambda r: (r.get("status") != "done", r.get("created_at") or ""))
        duplicates += [(r["id"], keep["id"], clean_url) for r in copies if r is not keep]
        if keep["url"] != clean_url:
            updates.append((keep["id"], clean_url))
    return {"updates": updates, "duplicates": duplicates}


if __name__ == "__main__":
    apply, delete = "--apply" in sys.argv, "--delete-duplicates" in sys.argv
    todo = plan(db._select_newest_first("id, url, status, created_at"))
    print(f"{len(todo['updates'])} link(s) to clean, {len(todo['duplicates'])} extra copy(ies) of saved reels.")
    for drop, keep, url in todo["duplicates"]:
        print(f"  duplicate {drop} of {keep}  {url}")
    if not apply:
        print("Dry run: nothing changed. Re-run with --apply.")
        sys.exit(0)
    # saved_reels.url is UNIQUE: drop duplicates first (one may already hold the clean link),
    # and without --delete-duplicates leave alone any reel that still has a copy.
    if delete:
        deleted = sum(db.delete_reel(drop) for drop, _, _ in todo["duplicates"])
        print(f"Deleted {deleted} duplicate(s).")
    still_copied = set() if delete else {keep for _, keep, _ in todo["duplicates"]}
    updates = [(reel_id, url) for reel_id, url in todo["updates"] if reel_id not in still_copied]
    for reel_id, clean_url in updates:
        db.set_url(reel_id, clean_url)
    print(f"Cleaned {len(updates)} link(s); skipped {len(todo['updates']) - len(updates)} that still have a duplicate.")
