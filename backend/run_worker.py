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

import db
from main import worker_tick

if __name__ == "__main__":
    logger.info("Standalone reels queue worker started locally.")
    if not os.getenv("SUPABASE_URL") or not os.getenv("SUPABASE_SERVICE_KEY"):
        logger.error("SUPABASE_URL / SUPABASE_SERVICE_KEY env vars not set. Exiting.")
        exit(1)
        
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
            
        time.sleep(5.0 if did_work else 20.0)

