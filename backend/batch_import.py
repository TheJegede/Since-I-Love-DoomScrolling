"""
Batch import saved Instagram reels into the Transcriber pipeline.

Reads an Instagram "Download Your Information" export (saved_posts.json),
filters to /reel/ URLs, and POSTs each to the running backend's /extract/url.

Resumable: progress is tracked in batch_progress.json so re-running skips
already-done URLs. The backend also caches by URL, so re-processing is cheap
either way.

Usage (backend must be running, default http://localhost:8000):
    python batch_import.py path/to/saved_posts.json
    python batch_import.py saved_posts.json --delay 3 --caption-fallback
    python batch_import.py saved_posts.json --limit 10          # smoke test
    python batch_import.py saved_posts.json --retry-failed      # only retry prior failures
"""
import argparse
import json
import os
import sys
import time

import requests

PROGRESS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "batch_progress.json")


def parse_saved(json_path):
    """Return list of {url, caption, title} for every /reel/ URL in the export."""
    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)
    items = []
    for entry in data:
        url = caption = title = ""
        for lv in entry.get("label_values", []):
            label = lv.get("label")
            if label == "URL":
                url = lv.get("value", "")
            elif label == "Caption":
                caption = lv.get("value", "")
            elif label == "Title":
                title = lv.get("value", "")
        if "/reel/" in url:
            items.append({"url": url, "caption": caption, "title": title})
    return items


def load_progress():
    if os.path.exists(PROGRESS_PATH):
        with open(PROGRESS_PATH, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_progress(progress):
    with open(PROGRESS_PATH, "w", encoding="utf-8") as f:
        json.dump(progress, f, indent=2)


def post_with_retry(url, payload, retries=3, backoff=5):
    """POST with retry on 429/5xx. Returns (ok, status_code, detail)."""
    for attempt in range(retries):
        try:
            r = requests.post(url, json=payload, timeout=300)
            if r.status_code == 200:
                return True, 200, ""
            # silent-hook / no audio = 400, permanent for this reel — don't retry
            if r.status_code == 400:
                return False, 400, r.json().get("detail", r.text[:200])
            if r.status_code == 429 or r.status_code >= 500:
                wait = backoff * (attempt + 1)
                print(f"    {r.status_code}, retry in {wait}s ({attempt + 1}/{retries})")
                time.sleep(wait)
                continue
            return False, r.status_code, r.text[:200]
        except requests.RequestException as e:
            wait = backoff * (attempt + 1)
            print(f"    network error {e}, retry in {wait}s ({attempt + 1}/{retries})")
            time.sleep(wait)
    return False, 0, "exhausted retries"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("json_path", help="Path to saved_posts.json from the IG export")
    ap.add_argument("--api", default="http://localhost:8000", help="Backend base URL")
    ap.add_argument("--delay", type=float, default=2.0, help="Seconds between reels")
    ap.add_argument("--limit", type=int, default=0, help="Process at most N new reels (0 = all)")
    ap.add_argument("--caption-fallback", action="store_true",
                    help="On download failure, extract from export caption (DB row loses its URL)")
    ap.add_argument("--retry-failed", action="store_true",
                    help="Only re-attempt URLs marked failed in progress file")
    args = ap.parse_args()

    items = parse_saved(args.json_path)
    progress = load_progress()
    print(f"Found {len(items)} reels in export. Progress file has {len(progress)} records.\n")

    queue = []
    for it in items:
        status = progress.get(it["url"], {}).get("status")
        if args.retry_failed:
            if status == "failed":
                queue.append(it)
        elif status not in ("ok", "caption"):
            queue.append(it)

    if args.limit:
        queue = queue[: args.limit]
    print(f"Queue: {len(queue)} reels to process.\n")

    done = ok = capt = fail = 0
    for it in queue:
        done += 1
        url = it["url"]
        print(f"[{done}/{len(queue)}] {url}")
        success, code, detail = post_with_retry(f"{args.api}/extract/url", {"url": url})

        if success:
            progress[url] = {"status": "ok"}
            ok += 1
            print("    ok")
        elif code == 400:
            # silent hook / no spoken content — permanent
            progress[url] = {"status": "failed", "code": 400, "detail": detail}
            fail += 1
            print(f"    skip (400): {detail}")
        elif args.caption_fallback and it["caption"]:
            s2, c2, d2 = post_with_retry(
                f"{args.api}/extract/text",
                {"transcript": "", "caption": it["caption"],
                 "title": it["title"] or url},
            )
            if s2:
                progress[url] = {"status": "caption", "note": "url not stored in DB"}
                capt += 1
                print("    ok (caption fallback)")
            else:
                progress[url] = {"status": "failed", "code": code, "detail": detail}
                fail += 1
                print(f"    failed: {detail}")
        else:
            progress[url] = {"status": "failed", "code": code, "detail": detail}
            fail += 1
            print(f"    failed ({code}): {detail}")

        save_progress(progress)
        time.sleep(args.delay)

    print(f"\nDone. ok={ok} caption={capt} failed={fail}")
    if fail:
        print("Re-run with --retry-failed to retry failures (download throttling is often transient).")


if __name__ == "__main__":
    sys.exit(main())
