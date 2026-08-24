import re
from typing import Optional


def normalize_instagram_url(url: str) -> str:
    """Strip query strings and normalize Instagram Reel/Post URLs to canonical form."""
    if not url:
        return ""
    match = re.search(r"instagram\.com/(reel|reels|p)/([A-Za-z0-9_\-]+)", url.strip())
    if match:
        kind = "reel" if match.group(1) in ("reel", "reels") else "p"
        return f"https://www.instagram.com/{kind}/{match.group(2)}/"
    return url.strip().split("?")[0]


def parse_saved_posts(data: list) -> list:
    """Return [{url, caption, title}] for every /reel/ URL in the export.

    Drops photo (/p/) posts because they lack audio.
    """
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
        if url and ("/reel/" in url or "/reels/" in url):
            clean_url = normalize_instagram_url(url)
            items.append({"url": clean_url, "caption": caption, "title": title})
    return items
