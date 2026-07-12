import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env'))
import db

c = db.get_client()

# Delete test row
c.table('saved_reels').delete().eq('url', 'https://www.instagram.com/reel/DIAGTEST1/').execute()
print('Test row deleted.')

# Show any non-done rows
res = c.table('saved_reels').select('id,url,status,source,created_at,error,attempt_count,processing_started_at,next_attempt_at').in_('status', ['pending','processing','failed','cookies_expired','unsupported_format']).order('created_at', desc=True).limit(10).execute()
rows = res.data or []
print(f'Non-done rows in queue: {len(rows)}')
for r in rows:
    url = (r['url'] or 'NO URL')[:60]
    err = (r.get('error') or '')[:60]
    src = (r.get('source') or '')[:8]
    attempts = r.get("attempt_count") or 0
    started = r.get("processing_started_at") or "-"
    next_at = r.get("next_attempt_at") or "-"
    print(f"  {r['status']:<18} | tries={attempts} | started={started} | next={next_at} | {src:<8} | {url} | err={err}")

# Also show total row count
total = c.table('saved_reels').select('id', count='exact').execute()
print(f'Total rows: {total.count}')
