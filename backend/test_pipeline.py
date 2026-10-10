"""Pipeline tests. Groq, yt-dlp and Supabase are mocked: no keys or server needed.

Run from the repo root:  python -m pytest backend
"""
import io
import os
import tempfile
from datetime import datetime, timezone

os.environ.setdefault("GROQ_API_KEY", "mock_groq_key_for_testing")
os.environ["ENABLE_WORKER"] = "0"  # never spawn the background worker thread

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import db
import main
from main import ReelExtraction
from saved_parser import normalize_instagram_url, parse_saved_posts

client = TestClient(main.app)

REEL_URL = "https://www.instagram.com/reel/Z/"
LONG_TRANSCRIPT = " ".join(["word"] * 30)  # clears the 15-word silent-hook guard
EXTRACTION = ReelExtraction(
    core_topic="Topic", key_takeaway="Takeaway", action_items=["a"], tools_or_resources=["b"])


def fake_insert_reel(url, title, raw_transcript, post_caption, extracted_json):
    return {"id": "id-1", "url": url, "title": title, "raw_transcript": raw_transcript,
            "post_caption": post_caption, "extracted_json": extracted_json,
            "created_at": "2026-06-06T00:00:00Z"}


def raiser(exc):
    def _raise(*args, **kwargs):
        raise exc
    return _raise


def fake_client(table):
    """A db.get_client replacement whose every table() is the given fake."""
    return lambda: type("FakeClient", (), {"table": lambda self, name: table})()


class FakeTable:
    """Stand-in for a Supabase table query: filters with in_() and records inserts."""
    def __init__(self, rows=None):
        self.data = rows or []
        self.inserted = []

    def select(self, *args, **kwargs):
        return self

    def in_(self, col, vals):
        return FakeTable([row for row in self.data if row.get(col) in vals])

    def insert(self, rows):
        self.inserted.extend(rows)
        return self

    def execute(self):
        return type("Result", (), {"data": self.data})()


@pytest.fixture
def pipeline(monkeypatch):
    """Mock download, transcription and extraction so the pipeline runs offline."""
    monkeypatch.setattr(main, "download_and_extract_audio", lambda url: ("/tmp/does_not_exist.mp3", "cap", "Title"))
    monkeypatch.setattr(main, "transcribe_audio", lambda path: LONG_TRANSCRIPT)
    monkeypatch.setattr(main, "extract_structured_json", lambda transcript, caption: EXTRACTION)


@pytest.fixture
def batch_job():
    """Restore the in-memory batch tracker after the test."""
    saved = dict(main.BATCH_JOB)
    yield main.BATCH_JOB
    main.BATCH_JOB.clear()
    main.BATCH_JOB.update(saved)


# ---------------------------------------------------------------- endpoints

def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_cors_no_credentials():
    r = client.options("/health", headers={
        "Origin": "https://reels-transcriber.vercel.app",
        "Access-Control-Request-Method": "GET",
    })
    # With allow_credentials=False, Starlette must not advertise credentials for a wildcard origin.
    assert r.headers.get("access-control-allow-credentials") != "true", dict(r.headers)


def test_extract_text(monkeypatch):
    monkeypatch.setattr(main, "extract_structured_json", lambda transcript, caption: EXTRACTION)
    monkeypatch.setattr(main.db, "insert_reel", fake_insert_reel)
    response = client.post("/extract/text", json={
        "title": "Test AI Video",
        "transcript": "Let's build a transcription app with Python and React.",
        "caption": "#coding #ai #python",
    })
    assert response.status_code == 200
    data = response.json()
    assert data["title"] == "Test AI Video"
    assert data["extracted_json"]["core_topic"] == "Topic"


def test_extract_url(monkeypatch, pipeline):
    monkeypatch.setattr(main.db, "get_reel_by_url", lambda url: None)
    monkeypatch.setattr(main.db, "insert_reel", fake_insert_reel)
    r = client.post("/extract/url", json={"url": "https://www.instagram.com/reel/REGRESSION1/"})
    assert r.status_code == 200, r.text
    assert r.json()["extracted_json"]["core_topic"] == "Topic"
    assert r.json()["status"] == "done"


@pytest.mark.parametrize("status, title, error", [
    ("pending", None, None),  # title is NULL for rows the iPhone Shortcut inserts over REST
    ("failed", "Reel (Q)", "Meta blocking request"),
])
def test_extract_url_returns_unfinished_row(monkeypatch, status, title, error):
    """A URL that is already queued or failed comes back as-is instead of a 500."""
    monkeypatch.setattr(main.db, "get_reel_by_url", lambda url: {
        "id": "row-q", "url": url, "title": title, "raw_transcript": "", "post_caption": None,
        "extracted_json": {}, "created_at": "2026-10-10T00:00:00Z", "cluster": "Unclustered",
        "status": status, "error": error})
    r = client.post("/extract/url", json={"url": "https://www.instagram.com/reel/QUEUED1/"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == status
    assert r.json()["error"] == error


def test_extract_url_rejects_invalid_url():
    response = client.post("/extract/url", json={"url": "https://google.com"})
    assert response.status_code == 400
    assert "Invalid Instagram Reel URL" in response.json()["detail"]


def test_url_validation_helpers():
    assert main.is_valid_instagram_reel("https://www.instagram.com/reel/C7xY9/")
    assert main.is_valid_instagram_reel("http://instagram.com/reel/abc-123_XYZ/?query=1")
    assert main.is_valid_instagram_reel("https://instagram.com/reels/abc-123/")
    assert main.is_valid_instagram_reel("https://instagram.com/p/abc/")
    assert not main.is_valid_instagram_reel("https://google.com")
    assert not main.is_valid_instagram_reel("invalid-url")
    assert not main.is_valid_instagram_reel("")

    assert normalize_instagram_url("https://www.instagram.com/reel/C7xY9/?igsh=123&foo=bar") == "https://www.instagram.com/reel/C7xY9/"
    assert normalize_instagram_url("https://instagram.com/reels/abc-123?igsi=abc==") == "https://www.instagram.com/reel/abc-123/"
    assert normalize_instagram_url("https://www.instagram.com/p/ABC123_/?img_index=2") == "https://www.instagram.com/p/ABC123_/"


def test_api_auth_token(monkeypatch):
    monkeypatch.setattr(main, "API_AUTH_TOKEN", "super_secret_test_key")
    monkeypatch.setattr(main, "extract_structured_json", lambda transcript, caption: EXTRACTION)
    monkeypatch.setattr(main.db, "insert_reel", fake_insert_reel)
    payload = {"title": "Test", "transcript": "a", "caption": "b"}

    res = client.post("/extract/text", json=payload)
    assert res.status_code == 401, res.text
    assert "Unauthorized" in res.json()["detail"]

    res = client.post("/extract/text", json=payload, headers={"X-API-Key": "wrong"})
    assert res.status_code == 401, res.text

    res = client.post("/extract/text", json=payload, headers={"X-API-Key": "super_secret_test_key"})
    assert res.status_code == 200, res.text
    assert res.json()["title"] == "Test"


def test_delete_reel(monkeypatch):
    calls = []
    # First call: row exists (True); second: already gone (False -> 404)
    monkeypatch.setattr(main.db, "delete_reel", lambda rid: (calls.append(rid), len(calls) == 1)[1])
    r = client.delete("/reels/abc")
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] == "abc"
    assert client.delete("/reels/abc").status_code == 404


def test_get_reel_details(monkeypatch):
    monkeypatch.setattr(main.db, "get_reel_details",
                        lambda rid: {"raw_transcript": "t", "post_caption": "c"} if rid == "abc" else None)
    r = client.get("/reels/abc/details")
    assert r.status_code == 200, r.text
    assert r.json() == {"raw_transcript": "t", "post_caption": "c"}
    assert client.get("/reels/missing/details").status_code == 404


def test_reels_include_cluster(monkeypatch):
    monkeypatch.setattr(main.db, "list_reels", lambda limit=20: [{
        "id": "x", "url": None, "title": "t", "raw_transcript": None,
        "post_caption": None, "extracted_json": {"core_topic": "c"},
        "created_at": "2026-06-06T00:00:00Z", "cluster": "Unclustered"}])
    r = client.get("/reels")
    assert r.status_code == 200, r.text
    assert "cluster" in r.json()[0]


def test_recompute_clusters(monkeypatch):
    rows = [
        {"id": "a", "extracted_json": {"core_topic": "AI email tools"}},
        {"id": "b", "extracted_json": {"core_topic": "Marathon training"}},
        {"id": "c", "extracted_json": {}},  # queued/failed reel: nothing to cluster
    ]
    applied = []
    monkeypatch.setattr(main.db, "reels_for_clustering", lambda: rows)
    monkeypatch.setattr(main.db, "set_cluster",
                        lambda reel_ids, cluster: applied.extend((rid, cluster) for rid in reel_ids))
    monkeypatch.setattr(main, "cluster_topics_semantically", lambda items: [
        {"id": "a", "cluster": "Productivity"}, {"id": "b", "cluster": "Fitness"}])

    r = client.post("/clusters/recompute")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "started"

    job = client.get("/clusters/recompute/status").json()
    assert job["status"] == "done", job
    assert job["assigned"] == 2, job
    assert ("a", "Productivity") in applied
    assert ("c", None) in applied, "unextracted reel should be reset to Unclustered"


def test_cluster_labels_are_balanced():
    """Well-separated groups must not collapse into one giant cluster plus singletons."""
    np = pytest.importorskip("numpy")
    pytest.importorskip("sklearn")
    rng = np.random.default_rng(0)
    centers = np.eye(8, 16) * 10  # 8 distinct directions
    points = [center + rng.normal(scale=0.1, size=16) for center in centers for _ in range(8)]  # 64 points -> 8 clusters
    labels = main._semantic_cluster_labels(points)
    sizes = sorted(labels.count(label) for label in set(labels))
    assert sizes == [8] * 8, sizes


# ---------------------------------------------------------------- worker

def test_worker_tick_success(monkeypatch, pipeline):
    saved = {}
    monkeypatch.setattr(main.db, "claim_next_pending", lambda: {"id": "row1", "url": REEL_URL})
    monkeypatch.setattr(main.db, "update_reel_result",
                        lambda reel_id, title, raw_transcript, post_caption, extracted_json:
                        saved.update(id=reel_id, title=title))
    monkeypatch.setattr(main.db, "mark_failed", raiser(AssertionError("should not be marked failed")))
    assert main.worker_tick() is True
    assert saved == {"id": "row1", "title": "Title"}


def test_worker_tick_failure(monkeypatch):
    failed = {}
    monkeypatch.setattr(main.db, "claim_next_pending", lambda: {"id": "row2", "url": "https://www.instagram.com/reel/F/"})
    monkeypatch.setattr(main, "download_and_extract_audio",
                        raiser(HTTPException(status_code=400, detail="Meta blocking request")))
    monkeypatch.setattr(main.db, "mark_failed",
                        lambda reel_id, error, status="failed": failed.update(id=reel_id, error=str(error), status=status))
    assert main.worker_tick() is True
    assert failed["id"] == "row2"
    assert "Meta blocking" in failed["error"]


def test_worker_tick_invalid_url(monkeypatch):
    failed = {}
    monkeypatch.setattr(main.db, "claim_next_pending", lambda: {"id": "row_invalid", "url": "https://malicious-ssrf.com"})
    monkeypatch.setattr(main.db, "mark_failed", lambda reel_id, error: failed.update(id=reel_id, error=str(error)))
    assert main.worker_tick() is True
    assert failed["id"] == "row_invalid"
    assert "Invalid Instagram Reel URL" in failed["error"]


def test_worker_tick_empty(monkeypatch):
    monkeypatch.setattr(main.db, "claim_next_pending", lambda: None)
    assert main.worker_tick() is False


def test_worker_retries_failed_transcription(monkeypatch, pipeline):
    """A transcription error is retried, not silently replaced by a caption-only extraction."""
    events = []
    monkeypatch.setattr(main.db, "claim_next_pending", lambda: {"id": "row1", "url": REEL_URL, "attempt_count": 1})
    monkeypatch.setattr(main, "transcribe_audio",
                        raiser(HTTPException(status_code=500, detail="Audio transcription failed: 429")))
    monkeypatch.setattr(main.db, "schedule_retry", lambda reel_id, error, when: events.append(("retry", reel_id)))
    monkeypatch.setattr(main.db, "update_reel_result", lambda **kwargs: events.append(("done", kwargs["reel_id"])))
    monkeypatch.setattr(main.db, "mark_failed", lambda *args, **kwargs: events.append(("failed", args[0])))
    assert main.worker_tick() is True
    assert events == [("retry", "row1")]


def test_worker_falls_back_to_caption_on_final_attempt(monkeypatch, pipeline):
    saved = {}
    monkeypatch.setattr(main.db, "claim_next_pending",
                        lambda: {"id": "row1", "url": REEL_URL, "attempt_count": main.MAX_WORKER_ATTEMPTS})
    monkeypatch.setattr(main, "transcribe_audio",
                        raiser(HTTPException(status_code=500, detail="Audio transcription failed: 413")))
    monkeypatch.setattr(main.db, "update_reel_result",
                        lambda **kwargs: saved.update(id=kwargs["reel_id"], transcript=kwargs["raw_transcript"]))
    assert main.worker_tick() is True
    assert saved == {"id": "row1", "transcript": ""}


def test_run_worker_drain(monkeypatch):
    """Drain mode stops at the first empty tick and survives a failed stale-claim recovery."""
    ticks = iter([True, True, False])
    monkeypatch.setattr(main.db, "recover_stale_processing", raiser(RuntimeError("db offline")))
    monkeypatch.setattr(main, "worker_tick", lambda: next(ticks))
    main.run_worker(drain=True)
    assert next(ticks, None) is None


def test_worker_retry_policy(monkeypatch):
    assert main.is_retryable_worker_error(HTTPException(status_code=429))
    assert main.is_retryable_worker_error(HTTPException(status_code=503))
    assert main.is_retryable_worker_error(httpx.ConnectError("offline"))
    assert not main.is_retryable_worker_error(HTTPException(status_code=400))
    assert not main.is_retryable_worker_error(HTTPException(status_code=403))
    assert not main.is_retryable_worker_error(HTTPException(status_code=415))
    assert 27 <= main.retry_delay_seconds(1, .9) <= 33
    assert 108 <= main.retry_delay_seconds(2, .9) <= 132

    scheduled = []
    monkeypatch.setattr(main.db, "schedule_retry", lambda reel_id, error, when: scheduled.append(reel_id))
    assert main._schedule_worker_retry({"id": "a", "attempt_count": 1}, "temporary")
    assert main._schedule_worker_retry({"id": "b", "attempt_count": 2}, "temporary")
    assert not main._schedule_worker_retry({"id": "c", "attempt_count": 3}, "temporary")
    assert scheduled == ["a", "b"]


def test_download_cleanup_on_failure(monkeypatch):
    reel_id = "test_cleanup_fail_123"
    leftovers = [os.path.join(tempfile.gettempdir(), f"video_{reel_id}.{ext}") for ext in ("mp4", "part")]
    for path in leftovers:
        with open(path, "w") as f:
            f.write("partial download")

    class FailingYDL:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            pass

        def extract_info(self, *args, **kwargs):
            raise Exception("Mock download error")

    monkeypatch.setattr(main.yt_dlp, "YoutubeDL", FailingYDL)
    try:
        with pytest.raises(HTTPException) as excinfo:
            main.download_and_extract_audio(f"https://www.instagram.com/reel/{reel_id}/")
        assert excinfo.value.status_code == 500
        assert "Mock download error" in excinfo.value.detail
        assert not any(os.path.exists(path) for path in leftovers)
    finally:
        for path in leftovers:
            if os.path.exists(path):
                os.remove(path)


# ---------------------------------------------------------------- bulk import

def test_parse_saved_posts():
    sample = [
        {"label_values": [
            {"label": "URL", "value": "https://www.instagram.com/reel/AAA/"},
            {"label": "Caption", "value": "hello"},
            {"label": "Title", "value": "T1"}]},
        {"label_values": [
            {"label": "URL", "value": "https://www.instagram.com/p/BBB/"},
            {"label": "Caption", "value": "photo"}]},
    ]
    out = parse_saved_posts(sample)
    assert len(out) == 1, out  # the /p/ photo post is dropped
    assert out[0] == {"url": "https://www.instagram.com/reel/AAA/", "caption": "hello", "title": "T1"}


def test_batch_status_shape():
    body = client.get("/extract/batch/status").json()
    for key in ("status", "total", "done", "ok", "failed", "current", "errors"):
        assert key in body, f"missing {key} in {body}"


def test_batch_guard_409(monkeypatch, batch_job):
    batch_job["status"] = "running"
    monkeypatch.setattr(main, "update_batch_job_status", lambda: None)
    files = {"file": ("saved_posts.json", io.BytesIO(b"[]"), "application/json")}
    assert client.post("/extract/batch", files=files).status_code == 409


def test_extract_batch(monkeypatch, batch_job):
    table = FakeTable([{"url": "https://www.instagram.com/reel/BBB/"}])  # BBB already saved
    monkeypatch.setattr(main.db, "get_client", fake_client(table))
    upload = (
        '[{"label_values": [{"label": "URL", "value": "https://www.instagram.com/reel/AAA/"}]},'
        ' {"label_values": [{"label": "URL", "value": "https://www.instagram.com/reel/BBB/"}]}]'
    )
    files = {"file": ("saved_posts.json", io.BytesIO(upload.encode()), "application/json")}

    r = client.post("/extract/batch", files=files)
    assert r.status_code == 200, r.text
    assert r.json() == {"started": True, "total": 2, "enqueued": 1, "existing": 1}
    assert len(table.inserted) == 1
    assert table.inserted[0]["url"] == "https://www.instagram.com/reel/AAA/"
    assert table.inserted[0]["status"] == "pending"
    assert table.inserted[0]["source"] == "batch"

    status = client.get("/extract/batch/status").json()
    assert (status["status"], status["total"], status["done"]) == ("running", 2, 1)

    table.data.append({"url": "https://www.instagram.com/reel/AAA/", "status": "done"})  # worker finishes AAA
    status = client.get("/extract/batch/status").json()
    assert (status["status"], status["done"], status["ok"]) == ("done", 2, 2)


@pytest.mark.parametrize("status", ["cookies_expired", "unsupported_format", "mystery"])
def test_batch_terminal_statuses(monkeypatch, batch_job, status):
    table = FakeTable()
    table.in_ = lambda col, vals: FakeTable([{"url": "u", "status": status, "error": "boom"}])
    monkeypatch.setattr(main.db, "get_client", fake_client(table))
    batch_job.update({"status": "running", "urls": ["u"], "finished_at": None})

    main.update_batch_job_status()
    assert batch_job["status"] == "done"
    assert batch_job["failed"] == 1
    if status == "mystery":
        assert "Unknown queue status: mystery" in batch_job["errors"][0]["detail"]


# ---------------------------------------------------------------- data layer

def test_row_to_record_handles_bad_json():
    assert db.row_to_record({"id": "1", "extracted_json": "{not valid json"})["extracted_json"] == {}
    assert db.row_to_record({"id": "2", "extracted_json": '{"core_topic": "x"}'})["extracted_json"] == {"core_topic": "x"}


def test_chunked_helper():
    assert list(db._chunked([1, 2, 3, 4, 5], 2)) == [[1, 2], [3, 4], [5]]
    assert list(db._chunked([], 3)) == []
    assert list(db._chunked([1, 2], 5)) == [[1, 2]]


def test_db_queue_metadata_contract(monkeypatch):
    class Query:
        def __init__(self):
            self.calls = []
            self.updated = None

        def select(self, *args):
            self.calls.append(("select", args))
            return self

        def update(self, payload):
            self.updated = payload
            return self

        def eq(self, *args):
            self.calls.append(("eq", args))
            return self

        def or_(self, value):
            self.calls.append(("or", value))
            return self

        def order(self, *args, **kwargs):
            return self

        def limit(self, value):
            return self

        def lt(self, *args):
            self.calls.append(("lt", args))
            return self

        def execute(self):
            rows = [{"id": "r1", "attempt_count": 1}] if self.updated is None else [{"id": "r1"}]
            return type("Result", (), {"data": rows})()

    query = Query()
    monkeypatch.setattr(db, "get_client", fake_client(query))

    claimed = db.claim_next_pending()
    assert claimed["attempt_count"] == 2
    assert any(kind == "or" and "next_attempt_at.is.null" in value and "next_attempt_at.lte." in value
               for kind, value in query.calls)
    assert query.updated["status"] == "processing"
    assert query.updated["processing_started_at"]
    assert query.updated["next_attempt_at"] is None

    query.calls.clear()
    assert db.recover_stale_processing(datetime.now(timezone.utc)) == 1
    assert ("eq", ("status", "processing")) in query.calls
    assert any(kind == "lt" and args[0] == "processing_started_at" for kind, args in query.calls)
