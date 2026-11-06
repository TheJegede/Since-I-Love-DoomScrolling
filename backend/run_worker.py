"""Standalone local queue worker: drains pending reels without the FastAPI server.

Pass --drain to exit once the queue is empty instead of idling.
"""
import os
import sys

if sys.stderr is None:  # pythonw.exe (the scheduled task) has no console; give logging and yt-dlp somewhere to write
    sys.stdout = sys.stderr = open(os.devnull, "w")

import yt_dlp

from main import logger, run_worker  # importing main loads .env and configures logging

if __name__ == "__main__":
    logger.info("Standalone reels queue worker started locally.")
    logger.info("yt-dlp version: %s", getattr(yt_dlp.version, "__version__", "unknown"))

    if not os.getenv("SUPABASE_URL") or not os.getenv("SUPABASE_SERVICE_KEY"):
        logger.error("SUPABASE_URL / SUPABASE_SERVICE_KEY env vars not set. Exiting.")
        sys.exit(1)

    drain_mode = "--drain" in sys.argv
    if drain_mode:
        logger.info("Running in DRAIN mode. Will exit once queue is empty.")
    run_worker(drain=drain_mode)
