"""Pure parser for the Instagram 'Download Your Information' saved_posts.json.

No heavy dependencies — safe to import from both the FastAPI app and the CLI.
"""

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
        if url and "/reel/" in url:
            items.append({"url": url, "caption": caption, "title": title})
    return items
