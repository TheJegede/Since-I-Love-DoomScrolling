"""Back up every saved_reels row to a local JSON file. Safe to re-run.

Run from the repo root:  python backend/export_reels.py
Writes backups/reels-<YYYY-MM-DD>.json (git-ignored).
"""
import json
import pathlib
from datetime import date

import db
import main  # noqa: F401  importing main loads .env and configures logging


def export(path: pathlib.Path) -> int:
    """Write all rows (every column) as a JSON array. Returns the row count."""
    rows = db._select_newest_first("*")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, ensure_ascii=False, default=str), encoding="utf-8")
    return len(rows)


if __name__ == "__main__":
    target = pathlib.Path(__file__).resolve().parent.parent / "backups" / f"reels-{date.today().isoformat()}.json"
    print(f"Exported {export(target)} reel(s) to {target}")
