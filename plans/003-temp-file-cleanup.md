# Plan 003: Clean up Temporary Files on Download Failure

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9537dd6..HEAD -- backend/main.py`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: correctness
- **Planned at**: commit `9537dd6`, 2026-06-12

## Why this matters

The function `download_and_extract_audio` calls `yt-dlp` to download Reels to the local temp directory. If the download is blocked or interrupted mid-download (common when Instagram blocks datacenter/residential worker connections), `yt-dlp` leaves partial files (e.g. `video_*.mp4`, `video_*.m4a`, `video_*.part`) in the temp directory. Because `_run_pipeline` only deletes `mp3_path` (which is `None` on download failure), these temporary files leak and clutter host storage over time.

Ensuring cleanup of partial files on failure prevents local disk bloat.

## Current state

- Relevant files:
  - `backend/main.py` — contains `download_and_extract_audio` (lines 307–350).
- Excerpt from `backend/main.py`:
  ```python
  def download_and_extract_audio(url: str) -> tuple[str, str, str]:
      """Download Instagram Reel and extract audio payload as MP3 using yt-dlp."""
      temp_dir = tempfile.gettempdir()
      cookie_file = get_cookie_file()
  
      ydl_opts = {
          'format': 'bestaudio/best',
          'outtmpl': os.path.join(temp_dir, 'video_%(id)s.%(ext)s'),
          'postprocessors': [{
              'key': 'FFmpegExtractAudio',
              'preferredcodec': 'mp3',
              'preferredquality': '192',
          }],
          'quiet': True,
          'no_warnings': True,
      }
      ...
  ```

## Commands you will need

| Purpose   | Command                                               | Expected on success |
|-----------|-------------------------------------------------------|---------------------|
| Tests     | `backend/.venv/Scripts/python backend/verify_pipeline.py` | all 20+ tests pass  |

## Scope

**In scope** (the only files you should modify):
- `backend/main.py`

**Out of scope**:
- Direct ffmpeg subprocess calls or custom temporary directory contexts.

## Steps

### Step 1: Add import glob at top of backend/main.py

Ensure `import glob` is declared at the top of `backend/main.py` along with other imports.

### Step 2: Extract Reel ID from URL and use it in outtmpl

Modify `download_and_extract_audio` in `backend/main.py` to parse the Reel ID from the URL using a regex match at the start of the function. Use this explicit Reel ID inside the output template `outtmpl` parameter to ensure files have a predictable prefix.

Target shape:
```python
def download_and_extract_audio(url: str) -> tuple[str, str, str]:
    """Download Instagram Reel and extract audio payload as MP3 using yt-dlp."""
    temp_dir = tempfile.gettempdir()
    cookie_file = get_cookie_file()

    # Extract Reel ID from the URL (fallback to UUID if match fails)
    match = re.search(r"/reel/([A-Za-z0-9_\-]+)", url)
    reel_id = match.group(1) if match else str(uuid.uuid4())

    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': os.path.join(temp_dir, f'video_{reel_id}.%(ext)s'),
        'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '192',
        }],
        'quiet': True,
        'no_warnings': True,
    }
    ...
```

### Step 3: Implement cleanup in download_and_extract_audio exception block

Add code to clean up any files matching `video_{reel_id}.*` inside the `except` block of `download_and_extract_audio` before raising the `HTTPException`.

Target shape:
```python
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = ydl.prepare_filename(info)
            mp3_path = os.path.splitext(filename)[0] + '.mp3'
            
            if not os.path.exists(mp3_path):
                raise FileNotFoundError(f"Audio extraction file not found at expected path: {mp3_path}")
                
            post_caption = info.get('description') or info.get('title') or ""
            title = info.get('title') or f"Instagram Reel ({info.get('id')})"
            
            logger.info(f"Successfully downloaded audio to: {mp3_path}")
            return mp3_path, post_caption, title
    except Exception as e:
        logger.error(f"Error downloading or extracting audio: {str(e)}")
        # Clean up any leftover temp files on download error
        for f in glob.glob(os.path.join(temp_dir, f"video_{reel_id}.*")):
            try:
                os.remove(f)
                logger.info(f"Cleaned up failed download file: {f}")
            except Exception as ce:
                logger.warning(f"Could not delete temp file {f}: {str(ce)}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to download or parse Instagram Reel. Meta may be blocking the request. Error: {str(e)}"
        )
```

**Verify**: Run `backend/.venv/Scripts/python backend/verify_pipeline.py` to verify all pipeline integration tests pass.

## Test plan

- Mock a failing `download_and_extract_audio` call inside `backend/verify_pipeline.py` or assert that its exception triggers file deletion.
- Verify `backend/.venv/Scripts/python backend/verify_pipeline.py` runs and succeeds.

## Done criteria

- [ ] `download_and_extract_audio` contains download failure cleanup logic using `glob` and the `reel_id`.
- [ ] No files outside `backend/main.py` are modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- If `tempfile.gettempdir()` permissions restrict reading/listing files in the temporary directory.

## Maintenance notes

- If multiple workers run concurrently on the same machine processing the same Reel URL, they might collide on the same temporary file. However, standard workflow locks processing via Supabase status, so single-reel collisions are rare.
