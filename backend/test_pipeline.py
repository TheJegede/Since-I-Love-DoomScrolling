"""Pipeline tests. Groq, yt-dlp and Supabase are mocked: no keys or server needed.

Run from the repo root:  python -m pytest backend
"""
import io
import json
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
REAL_NEAREST_CLUSTER = db.nearest_cluster  # every test stubs it; one test checks the real one
REAL_CLAIM_NEXT_CLUSTER_JOB = getattr(db, "claim_next_cluster_job", None)  # same, for the cluster-job claim

REEL_URL = "https://www.instagram.com/reel/Z/"
LONG_TRANSCRIPT = " ".join(["word"] * 30)  # clears the 15-word silent-hook guard
FAKE_VECTOR = [0.25] * 384  # same size as the saved_reels.embedding vector(384) column
EXTRACTION = ReelExtraction(
    core_topic="Topic", key_takeaway="Takeaway", action_items=["a"], tools_or_resources=["b"])


def fake_insert_reel(url, title, raw_transcript, post_caption, extracted_json, embedding=None, cluster=None):
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


class RecordingTable:
    """Stand-in for a Supabase table query that records payloads and filters."""
    def __init__(self, rows=None):
        self.rows = rows or []
        self.payloads = []
        self.filters = []
        self.window = (0, 999)

    def select(self, *args, **kwargs):
        return self

    def insert(self, payload):
        self.payloads.append(payload)
        return self

    def update(self, payload):
        self.payloads.append(payload)
        return self

    def eq(self, *args):
        self.filters.append(("eq", args))
        return self

    def is_(self, *args):
        self.filters.append(("is", args))
        return self

    def order(self, *args, **kwargs):
        return self

    def range(self, start, end):
        self.window = (start, end)
        return self

    def execute(self):
        start, end = self.window
        return type("Result", (), {"data": self.rows[start:end + 1]})()


class FakeEmbeddingModel:
    """Stand-in for fastembed's TextEmbedding: records texts, returns fixed vectors."""
    def __init__(self):
        self.texts = []

    def embed(self, texts):
        self.texts.extend(texts)
        return (FAKE_VECTOR for _ in texts)


@pytest.fixture(autouse=True)
def no_embedding_model(monkeypatch):
    """Never load the real embedding model in tests; embed_reel then returns None."""
    monkeypatch.setattr(main, "_get_embedding_model", raiser(RuntimeError("no embedding model in tests")))
    monkeypatch.setattr(db, "nearest_cluster", lambda embedding, min_similarity: None)  # never hit the real DB


@pytest.fixture(autouse=True)
def no_real_worker_db(monkeypatch):
    """The worker's heartbeat and cluster-job queue never reach the real DB in tests."""
    monkeypatch.setattr(db, "heartbeat", lambda: None, raising=False)
    monkeypatch.setattr(db, "claim_next_cluster_job", lambda: None, raising=False)
    monkeypatch.setattr(db, "recover_stale_cluster_jobs", lambda stale_before: 0, raising=False)


@pytest.fixture
def embedding_model(monkeypatch, no_embedding_model):
    model = FakeEmbeddingModel()
    monkeypatch.setattr(main, "_get_embedding_model", lambda: model)
    return model


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


def test_recompute_clusters(monkeypatch, embedding_model):
    rows = [
        {"id": "a", "extracted_json": {"core_topic": "AI email tools"}, "embedding": [0.1] * 384},
        {"id": "b", "extracted_json": {"core_topic": "Marathon training"}, "embedding": None},  # never embedded
        {"id": "c", "extracted_json": {}, "embedding": None},  # queued/failed reel: nothing to cluster
    ]
    applied, stored, clustered = [], [], []
    monkeypatch.setattr(main.db, "reels_for_clustering", lambda: rows)
    monkeypatch.setattr(main.db, "set_embedding", lambda reel_id, embedding: stored.append(reel_id))
    monkeypatch.setattr(main.db, "set_cluster",
                        lambda reel_ids, cluster: applied.extend((rid, cluster) for rid in reel_ids))

    def fake_cluster(items):
        clustered.extend(items)
        return [{"id": "a", "cluster": "Productivity"}, {"id": "b", "cluster": "Fitness"}]
    monkeypatch.setattr(main, "cluster_topics_semantically", fake_cluster)

    r = client.post("/clusters/recompute")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "started"

    job = client.get("/clusters/recompute/status").json()
    assert job["status"] == "done", job
    assert job["assigned"] == 2, job
    assert ("a", "Productivity") in applied
    assert ("c", None) in applied, "unextracted reel should be reset to Unclustered"
    assert [item["embedding"] for item in clustered] == [[0.1] * 384, FAKE_VECTOR], "stored vectors are reused"
    assert stored == ["b"], "a reel missing its embedding is repaired, not skipped"


def test_new_reel_starts_in_its_nearest_neighbours_cluster(monkeypatch, embedding_model):
    asked = []
    monkeypatch.setattr(db, "nearest_cluster",
                        lambda embedding, min_similarity: asked.append(min_similarity) or "Fitness")
    assert main.search_fields({"core_topic": "Marathon training"}) == {"embedding": FAKE_VECTOR, "cluster": "Fitness"}
    assert asked == [0.4]

    monkeypatch.setattr(db, "nearest_cluster", raiser(RuntimeError("rpc down")))
    assert main.search_fields({"core_topic": "x"}) == {"embedding": FAKE_VECTOR, "cluster": None}
    assert main.search_fields({}) == {"embedding": None, "cluster": None}


def test_nearest_cluster_skips_unclustered_neighbours(monkeypatch):
    class RpcClient:
        def rpc(self, name, params):
            assert name == "match_reels"
            return type("Q", (), {"execute": lambda self: type("R", (), {"data": [{"id": "new"}, {"id": "old"}]})()})()

        def table(self, name):
            return FakeTable([{"id": "new", "cluster": None}, {"id": "old", "cluster": "Fitness"}])
    monkeypatch.setattr(db, "get_client", lambda: RpcClient())
    assert REAL_NEAREST_CLUSTER([0.1] * 384, 0.4) == "Fitness"


def test_reels_for_clustering_parses_pgvector_text(monkeypatch):
    table = RecordingTable([{"id": "a", "extracted_json": '{"core_topic": "x"}', "embedding": "[0.5,0.25]"},
                            {"id": "b", "extracted_json": {}, "embedding": None}])
    monkeypatch.setattr(db, "get_client", fake_client(table))
    assert db.reels_for_clustering() == [
        {"id": "a", "extracted_json": {"core_topic": "x"}, "embedding": [0.5, 0.25]},
        {"id": "b", "extracted_json": {}, "embedding": None},
    ]


def test_recompute_reclusters_reels_saved_while_it_ran(monkeypatch):
    pytest.importorskip("sklearn")
    first = [{"id": "a", "extracted_json": {"core_topic": "Running"}, "embedding": [1.0, 0.0]},
             {"id": "b", "extracted_json": {"core_topic": "Cooking"}, "embedding": [0.0, 1.0]}]
    late = [{"id": "near-a", "extracted_json": {"core_topic": "Jogging"}, "embedding": [0.9, 0.1]},
            {"id": "far", "extracted_json": {"core_topic": "Taxes"}, "embedding": [-1.0, -1.0]}]
    reads = iter([first, first + late])  # the second read sees reels the worker saved meanwhile
    applied = {}
    monkeypatch.setattr(main.db, "reels_for_clustering", lambda: next(reads))
    monkeypatch.setattr(main.db, "set_cluster", lambda reel_ids, cluster: applied.update(dict.fromkeys(reel_ids, cluster)))
    monkeypatch.setattr(main, "cluster_topics_semantically", lambda items: [
        {"id": "a", "cluster": "Fitness"}, {"id": "b", "cluster": "Food"}])

    main.run_cluster_recompute_task()
    assert main.CLUSTER_JOB["status"] == "done", main.CLUSTER_JOB
    assert applied == {"a": "Fitness", "b": "Food", "near-a": "Fitness", "far": None}


def test_recompute_is_claimed_before_the_job_starts(monkeypatch):
    monkeypatch.setattr(main, "run_cluster_recompute_task", lambda: None)  # job never gets to run
    monkeypatch.setitem(main.CLUSTER_JOB, "status", "idle")
    assert client.post("/clusters/recompute").status_code == 200
    assert client.post("/clusters/recompute").status_code == 409


def test_hf_space_queues_urls_for_the_local_worker(monkeypatch):
    saved = []
    monkeypatch.setattr(main, "IS_HF_SPACE", True)
    monkeypatch.setattr(main.db, "get_reel_by_url", lambda url: None)
    monkeypatch.setattr(main.db, "insert_reel", lambda **row: saved.append(row) or {
        "id": "q1", "url": row["url"], "extracted_json": {}, "status": row["status"]})
    monkeypatch.setattr(main, "_run_pipeline", raiser(AssertionError("HF must not download reels")))

    r = client.post("/extract/url", json={"url": "https://www.instagram.com/reel/HF1/?igsh=1"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "pending"
    assert saved[0]["url"] == "https://www.instagram.com/reel/HF1/"
    assert saved[0]["source"] == "dashboard"


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


# ---------------------------------------------------------------- search embeddings

def test_embed_reel_uses_topic_takeaway_and_tools(embedding_model):
    vector = main.embed_reel({
        "core_topic": "AI email tools", "key_takeaway": "Automate replies",
        "tools_or_resources": ["Zapier", "ChatGPT"], "action_items": ["not embedded"]})
    assert vector == FAKE_VECTOR
    assert embedding_model.texts == ["AI email tools Automate replies Zapier, ChatGPT"]


def test_embed_reel_skips_reels_with_nothing_extracted(embedding_model):
    assert main.embed_reel({}) is None  # queued/failed reel
    assert main.embed_reel(None) is None
    assert embedding_model.texts == []


def test_embed_reel_returns_none_when_model_unavailable():
    assert main.embed_reel({"core_topic": "AI"}) is None


def test_embed_reel_never_raises_on_malformed_extraction(embedding_model):
    assert main.embed_reel("a double-encoded string") is None
    assert main.embed_reel(["a", "list"]) is None
    assert main.embed_reel({"core_topic": "AI", "tools_or_resources": 5}) is None


def test_embed_reel_drops_a_vector_the_database_cannot_store(monkeypatch):
    class WrongSizeModel:
        def embed(self, texts):
            return ([0.1, 0.2, 0.3] for _ in texts)

    monkeypatch.setattr(main, "_get_embedding_model", lambda: WrongSizeModel())
    assert main.embed_reel({"core_topic": "AI"}) is None


def test_every_save_path_stores_an_embedding(monkeypatch, pipeline, embedding_model):
    saved = []

    def record_insert(url, title, raw_transcript, post_caption, extracted_json, embedding=None, cluster=None):
        saved.append(embedding)
        return fake_insert_reel(url, title, raw_transcript, post_caption, extracted_json)

    monkeypatch.setattr(main.db, "get_reel_by_url", lambda url: None)
    monkeypatch.setattr(main.db, "insert_reel", record_insert)
    monkeypatch.setattr(main.db, "claim_next_pending", lambda: {"id": "row1", "url": REEL_URL})
    monkeypatch.setattr(main.db, "update_reel_result", lambda **kwargs: saved.append(kwargs["embedding"]))
    monkeypatch.setattr(main.db, "mark_failed", raiser(AssertionError("should not be marked failed")))

    assert client.post("/extract/url", json={"url": REEL_URL}).status_code == 200
    assert client.post("/extract/text", json={"transcript": "hello there"}).status_code == 200
    files = {"file": ("clip.mp3", io.BytesIO(b"audio"), "audio/mpeg")}
    assert client.post("/extract/file", files=files).status_code == 200
    assert main.worker_tick() is True
    assert saved == [FAKE_VECTOR] * 4


def test_reel_still_saves_when_embedding_fails(monkeypatch):
    saved = {}

    def record_insert(url, title, raw_transcript, post_caption, extracted_json, embedding=None, cluster=None):
        saved["embedding"] = embedding
        return fake_insert_reel(url, title, raw_transcript, post_caption, extracted_json)

    monkeypatch.setattr(main, "extract_structured_json", lambda transcript, caption: EXTRACTION)
    monkeypatch.setattr(main.db, "insert_reel", record_insert)
    r = client.post("/extract/text", json={"transcript": "hello there"})
    assert r.status_code == 200, r.text
    assert saved == {"embedding": None}


def test_backfill_embeds_only_rows_with_content(monkeypatch, embedding_model):
    import backfill_embeddings
    monkeypatch.setattr(db, "reels_missing_embedding", lambda: [
        {"id": "a", "extracted_json": {"core_topic": "AI tools"}},
        {"id": "b", "extracted_json": {}},  # queued/failed reel: nothing to embed
        {"id": "c", "extracted_json": '{"key_takeaway": "stored as a JSON string"}'},
    ])
    saved = {}
    monkeypatch.setattr(db, "set_embedding", lambda reel_id, embedding: saved.update({reel_id: embedding}))
    assert backfill_embeddings.backfill() == (2, 1)
    assert saved == {"a": FAKE_VECTOR, "c": FAKE_VECTOR}


def test_backfill_fails_loudly_without_a_model(monkeypatch):
    import backfill_embeddings
    monkeypatch.setattr(db, "reels_missing_embedding", raiser(AssertionError("must not read rows without a model")))
    with pytest.raises(RuntimeError, match="no embedding model"):
        backfill_embeddings.backfill()


# ---------------------------------------------------------------- worker

def test_worker_tick_success(monkeypatch, pipeline):
    saved = {}
    monkeypatch.setattr(main.db, "claim_next_pending", lambda: {"id": "row1", "url": REEL_URL})
    monkeypatch.setattr(main.db, "update_reel_result",
                        lambda reel_id, title, raw_transcript, post_caption, extracted_json, embedding=None, cluster=None:
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
        {"label_values": [  # same reel saved to a second collection
            {"label": "URL", "value": "https://www.instagram.com/reel/AAA/?igsh=xyz"}]},
    ]
    out = parse_saved_posts(sample)
    assert len(out) == 1, out  # the /p/ photo post and the repeat are dropped
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


def test_reimport_reports_real_statuses(monkeypatch, batch_job):
    table = FakeTable([{"url": "https://www.instagram.com/reel/AAA/", "status": "failed", "error": "boom"}])
    monkeypatch.setattr(main.db, "get_client", fake_client(table))
    upload = b'[{"label_values": [{"label": "URL", "value": "https://www.instagram.com/reel/AAA/"}]}]'
    files = {"file": ("saved_posts.json", io.BytesIO(upload), "application/json")}

    r = client.post("/extract/batch", files=files)
    assert r.json()["enqueued"] == 0
    assert (batch_job["status"], batch_job["ok"], batch_job["failed"]) == ("done", 0, 1)


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


def test_insert_reel_stores_embedding_only_when_given(monkeypatch):
    table = RecordingTable()
    monkeypatch.setattr(db, "get_client", fake_client(table))
    record = db.insert_reel("u", "t", "tr", "cap", {"core_topic": "x"}, embedding=[0.1, 0.2])
    db.insert_reel("u2", "t", "tr", "cap", {"core_topic": "x"})
    assert table.payloads[0]["embedding"] == [0.1, 0.2]
    assert "embedding" not in table.payloads[1]
    assert "embedding" not in record  # never leaks into the API record


def test_update_reel_result_stores_embedding_only_when_given(monkeypatch):
    table = RecordingTable()
    monkeypatch.setattr(db, "get_client", fake_client(table))
    db.update_reel_result("r1", "t", "tr", "cap", {"core_topic": "x"}, embedding=[0.3])
    db.update_reel_result("r2", "t", "tr", "cap", {"core_topic": "x"})
    assert table.payloads[0]["embedding"] == [0.3]
    assert "embedding" not in table.payloads[1]


def test_embedding_queue_helpers(monkeypatch):
    table = RecordingTable([{"id": "a", "extracted_json": {}}, {"id": "b", "extracted_json": {}}])
    monkeypatch.setattr(db, "get_client", fake_client(table))
    assert [row["id"] for row in db.reels_missing_embedding()] == ["a", "b"]
    assert ("is", ("embedding", "null")) in table.filters

    db.set_embedding("a", [0.5])
    assert table.payloads == [{"embedding": [0.5]}]
    assert ("eq", ("id", "a")) in table.filters


# ---------------------------------------------------------------- worker: text and audio rows

@pytest.fixture
def worker_events(monkeypatch):
    """Record what the worker writes; any unexpected write shows up in the list."""
    events = []
    monkeypatch.setattr(main.db, "update_reel_result", lambda **kwargs: events.append(("done", kwargs)))
    monkeypatch.setattr(main.db, "mark_failed", lambda *args, **kwargs: events.append(("failed", args)))
    monkeypatch.setattr(main.db, "schedule_retry", lambda reel_id, error, when: events.append(("retry", reel_id)))
    monkeypatch.setattr(main.db, "delete_audio", lambda path: events.append(("deleted", path)), raising=False)
    return events


def queue_row(monkeypatch, **row):
    monkeypatch.setattr(main.db, "claim_next_pending",
                        lambda: {"url": None, "audio_path": None, "raw_transcript": "", "post_caption": None,
                                 "title": None, "attempt_count": 1, **row})


def test_worker_processes_text_row(monkeypatch, pipeline, worker_events):
    seen = []
    monkeypatch.setattr(main, "extract_structured_json", lambda t, c: seen.append((t, c)) or EXTRACTION)
    monkeypatch.setattr(main, "download_and_extract_audio", raiser(AssertionError("text rows are not downloaded")))
    queue_row(monkeypatch, id="t1", title="Notes", raw_transcript=LONG_TRANSCRIPT, post_caption="cap")

    assert main.worker_tick() is True
    assert seen == [(LONG_TRANSCRIPT, "cap")]
    [(kind, saved)] = worker_events
    assert kind == "done"
    assert (saved["reel_id"], saved["title"], saved["raw_transcript"]) == ("t1", "Notes", LONG_TRANSCRIPT)


def test_worker_processes_audio_row_and_deletes_file(monkeypatch, pipeline, worker_events):
    transcribed = {}

    def fake_transcribe(path):
        transcribed["path"] = path
        with open(path, "rb") as f:
            transcribed["bytes"] = f.read()
        return LONG_TRANSCRIPT
    monkeypatch.setattr(main.db, "download_audio", lambda path: b"audio", raising=False)
    monkeypatch.setattr(main, "transcribe_audio", fake_transcribe)
    queue_row(monkeypatch, id="a1", title="Voice memo", audio_path="a1.m4a", post_caption="cap")

    assert main.worker_tick() is True
    assert transcribed["path"].endswith(".m4a") and transcribed["bytes"] == b"audio"
    assert not os.path.exists(transcribed["path"])
    assert [kind for kind, _ in worker_events] == ["done", "deleted"]
    assert worker_events[0][1]["raw_transcript"] == LONG_TRANSCRIPT
    assert worker_events[0][1]["title"] == "Voice memo"
    assert worker_events[1][1] == "a1.m4a"


def test_audio_row_keeps_file_when_transcription_fails(monkeypatch, pipeline, worker_events):
    monkeypatch.setattr(main.db, "download_audio", lambda path: b"audio", raising=False)
    monkeypatch.setattr(main, "transcribe_audio", raiser(HTTPException(status_code=500, detail="x")))
    queue_row(monkeypatch, id="a1", audio_path="a1.m4a")

    assert main.worker_tick() is True
    assert worker_events == [("retry", "a1")]


def test_audio_row_without_speech_or_caption_fails(monkeypatch, pipeline, worker_events):
    monkeypatch.setattr(main.db, "download_audio", lambda path: b"audio", raising=False)
    monkeypatch.setattr(main, "transcribe_audio", lambda path: "")
    queue_row(monkeypatch, id="a1", audio_path="a1.m4a", post_caption=None)

    assert main.worker_tick() is True
    [(kind, args)] = worker_events
    assert kind == "failed" and args[0] == "a1" and "No spoken audio" in args[1]


def test_url_row_never_deletes_stored_audio(monkeypatch, pipeline, worker_events):
    """An audio_path on a URL row (e.g. inserted with the public key) must not delete an owner's upload."""
    queue_row(monkeypatch, id="u1", url=REEL_URL, audio_path="owners-upload.m4a")
    assert main.worker_tick() is True
    assert [kind for kind, _ in worker_events] == ["done"]


def test_row_with_nothing_to_process_fails(monkeypatch, worker_events):
    queue_row(monkeypatch, id="n1")
    assert main.worker_tick() is True
    assert worker_events == [("failed", ("n1", "Nothing to process: no URL, audio or text."))]


def test_done_reel_survives_audio_cleanup_failure(monkeypatch, pipeline, worker_events):
    monkeypatch.setattr(main.db, "download_audio", lambda path: b"audio", raising=False)
    monkeypatch.setattr(main.db, "delete_audio", raiser(RuntimeError("storage down")), raising=False)
    queue_row(monkeypatch, id="a1", audio_path="a1.mp3")

    assert main.worker_tick() is True
    assert [kind for kind, _ in worker_events] == ["done"]


# ---------------------------------------------------------------- worker: cluster jobs and heartbeat

def test_worker_runs_cluster_job_when_no_reels_queued(monkeypatch):
    finished = []
    monkeypatch.setattr(main.db, "claim_next_pending", lambda: None)
    monkeypatch.setattr(main.db, "claim_next_cluster_job", lambda: {"id": "j1"})
    monkeypatch.setattr(main, "recompute_clusters", lambda: 7, raising=False)
    monkeypatch.setattr(main.db, "finish_cluster_job",
                        lambda job_id, status, assigned=0, error=None: finished.append((job_id, status, assigned, error)),
                        raising=False)
    assert main.worker_tick() is True
    assert finished == [("j1", "done", 7, None)]


def test_reels_go_before_cluster_jobs(monkeypatch, pipeline):
    monkeypatch.setattr(main.db, "claim_next_pending", lambda: {"id": "row1", "url": REEL_URL})
    monkeypatch.setattr(main.db, "update_reel_result", lambda **kwargs: None)
    monkeypatch.setattr(main.db, "claim_next_cluster_job", raiser(AssertionError("reels come first")))
    assert main.worker_tick() is True


def test_cluster_job_failure_is_recorded(monkeypatch):
    finished = []
    monkeypatch.setattr(main, "recompute_clusters", raiser(RuntimeError("boom")), raising=False)
    monkeypatch.setattr(main.db, "finish_cluster_job",
                        lambda job_id, status, assigned=0, error=None: finished.append((job_id, status, error)),
                        raising=False)
    main.run_cluster_job({"id": "j1"})
    assert finished == [("j1", "error", "boom")]


def test_heartbeat_failure_does_not_stop_the_worker(monkeypatch, pipeline):
    saved = []
    monkeypatch.setattr(main.db, "heartbeat", raiser(RuntimeError("db offline")))
    monkeypatch.setattr(main.db, "claim_next_pending", lambda: {"id": "row1", "url": REEL_URL})
    monkeypatch.setattr(main.db, "update_reel_result", lambda **kwargs: saved.append(kwargs["reel_id"]))
    assert main.worker_tick() is True
    assert saved == ["row1"]


def test_worker_tick_writes_a_heartbeat(monkeypatch):
    beats = []
    monkeypatch.setattr(main.db, "heartbeat", lambda: beats.append(1))
    monkeypatch.setattr(main.db, "claim_next_pending", lambda: None)
    assert main.worker_tick() is False
    assert beats == [1]


def test_run_worker_recovers_stale_cluster_jobs(monkeypatch):
    recovered = []
    monkeypatch.setattr(main.db, "recover_stale_processing", lambda stale_before: 0)
    monkeypatch.setattr(main.db, "recover_stale_cluster_jobs", lambda stale_before: recovered.append(stale_before) or 0)
    monkeypatch.setattr(main, "worker_tick", lambda: False)
    main.run_worker(drain=True)
    assert len(recovered) == 1


def test_claim_next_cluster_job_returns_none_when_race_lost(monkeypatch):
    class LostRace:
        """Select finds a pending job; the guarded update matches nothing (another worker won)."""
        def __init__(self):
            self.updating = False
        def select(self, *a, **k): return self
        def eq(self, *a): return self
        def order(self, *a, **k): return self
        def limit(self, *a): return self
        def update(self, payload):
            self.updating = True
            return self
        def execute(self):
            return type("R", (), {"data": [] if self.updating else [{"id": "j1", "status": "pending"}]})()
    monkeypatch.setattr(db, "get_client", fake_client(LostRace()))
    assert REAL_CLAIM_NEXT_CLUSTER_JOB is not None, "db.claim_next_cluster_job is missing"
    assert REAL_CLAIM_NEXT_CLUSTER_JOB() is None


# ---------------------------------------------------------------- backup export

def test_export_writes_every_row(monkeypatch, tmp_path):
    import export_reels
    rows = [{"id": str(i), "url": f"u{i}", "extracted_json": {"core_topic": "t"}} for i in range(3)]
    monkeypatch.setattr(db, "_select_newest_first", lambda columns: rows)
    assert export_reels.export(tmp_path / "r.json") == 3
    assert json.loads((tmp_path / "r.json").read_text(encoding="utf-8")) == rows
