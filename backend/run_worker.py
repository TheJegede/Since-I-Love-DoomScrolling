import os
import sys
import time
import logging
from dotenv import load_dotenv

# Set up logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()
parent_env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env')
if os.path.exists(parent_env_path):
    load_dotenv(parent_env_path)

from datetime import datetime, timedelta, timezone
import yt_dlp

from main import WORKER_STALE_MINUTES, worker_tick
from db import recover_stale_processing

if __name__ == "__main__":
    logger.info("Standalone reels queue worker started locally.")
    
    logger.info("yt-dlp version: %s", getattr(yt_dlp.version, "__version__", "unknown"))

    if not os.getenv("SUPABASE_URL") or not os.getenv("SUPABASE_SERVICE_KEY"):
        logger.error("SUPABASE_URL / SUPABASE_SERVICE_KEY env vars not set. Exiting.")
        sys.exit(1)
        
    recovered = recover_stale_processing(
        datetime.now(timezone.utc) - timedelta(minutes=WORKER_STALE_MINUTES)
    )
    logger.info("Recovered %s stale queue item(s).", recovered)

    drain_mode = "--drain" in sys.argv
    if drain_mode:
        logger.info("Running in DRAIN mode. Will exit once queue is empty.")
        
    while True:
        try:
            did_work = worker_tick()
        except Exception as e:
            logger.error(f"Worker tick crashed: {str(e)}")
            did_work = False
            if drain_mode:
                break
        
        if drain_mode and not did_work:
            logger.info("No more pending reels in queue. Exiting drain worker.")
            break
            
        if not did_work:
            time.sleep(20.0)
