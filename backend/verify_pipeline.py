import os
import sys

# Ensure backend directory is in path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

# Set mock env variables for testing if they are not defined
if not os.environ.get("GROQ_API_KEY"):
    os.environ["GROQ_API_KEY"] = "mock_groq_key_for_testing"

try:
    from fastapi.testclient import TestClient
except ImportError:
    print("Installing 'httpx' for TestClient support...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "httpx"])
    from fastapi.testclient import TestClient

from main import app, ReelExtraction

client = TestClient(app)

def test_health():
    print("Testing GET /health...")
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    print("[OK] Health check passed!")

def test_cluster_assignments_model():
    print("Testing ClusterAssignments validation...")
    from main import ClusterAssignments
    m = ClusterAssignments(assignments=[{"id": "a", "cluster": "AI Tools"},
                                         {"id": "b", "cluster": "Fitness"}])
    assert m.assignments[0].cluster == "AI Tools"
    assert m.assignments[1].id == "b"
    print("[OK] ClusterAssignments model passed!")

def test_extract_text_mock():
    print("Testing POST /extract/text with mock data...")
    # Monkeypatch the extract_structured_json function in main to prevent external calls
    import main
    
    mock_extracted = ReelExtraction(
        core_topic="AI Video Automation",
        key_takeaway="You can automate your video transcription easily.",
        action_items=["Get a URL", "Extract audio", "Run Whisper"],
        tools_or_resources=["FastAPI", "Groq", "Supabase"]
    )
    
    original_extract = main.extract_structured_json
    main.extract_structured_json = lambda t, c: mock_extracted
    
    # Mock saving to database to prevent real database call
    original_save = main.save_to_database
    main.save_to_database = lambda url, title, raw_transcript, post_caption, extracted: {
        "id": "123e4567-e89b-12d3-a456-426614174000",
        "url": url,
        "title": title,
        "raw_transcript": raw_transcript,
        "post_caption": post_caption,
        "extracted_json": extracted.model_dump(),
        "created_at": "2026-06-05T00:00:00Z"
    }
    
    try:
        response = client.post("/extract/text", json={
            "title": "Test AI Video",
            "transcript": "Let's build a transcription app with Python and React.",
            "caption": "#coding #ai #python"
        })
        assert response.status_code == 200
        data = response.json()
        assert data["title"] == "Test AI Video"
        assert data["extracted_json"]["core_topic"] == "AI Video Automation"
        assert len(data["extracted_json"]["action_items"]) == 3
        print("[OK] Text extraction pipeline endpoint passed (mocked)!")
    finally:
        # Restore functions
        main.extract_structured_json = original_extract
        main.save_to_database = original_save

def test_recompute_clusters_mock():
    print("Testing POST /clusters/recompute (db + llm mocked)...")
    import main
    fake_rows = [
        {"id": "a", "extracted_json": {"core_topic": "AI email tools"}},
        {"id": "b", "extracted_json": {"core_topic": "Marathon training"}},
    ]
    applied = []
    orig_for = main.db.reels_for_clustering
    orig_set = main.db.set_cluster
    orig_counts = main.db.cluster_counts
    orig_llm = main.cluster_topics_with_llm
    main.db.reels_for_clustering = lambda: fake_rows
    main.db.set_cluster = lambda rid, cluster: applied.append((rid, cluster))
    main.db.cluster_counts = lambda: [{"name": "Productivity", "count": 1},
                                      {"name": "Fitness", "count": 1}]
    main.cluster_topics_with_llm = lambda items: [
        {"id": "a", "cluster": "Productivity"}, {"id": "b", "cluster": "Fitness"}]
    try:
        r = client.post("/clusters/recompute")
        assert r.status_code == 200, r.text
        assert r.json()["assigned"] == 2, r.text
        assert ("a", "Productivity") in applied
        print("[OK] recompute clusters passed!")
    finally:
        main.db.reels_for_clustering = orig_for
        main.db.set_cluster = orig_set
        main.db.cluster_counts = orig_counts
        main.cluster_topics_with_llm = orig_llm

def test_cluster_chunking():
    print("Testing cluster_topics_with_llm chunks large inputs...")
    import main
    items = [{"id": f"id{i}", "topic": f"topic {i % 3}"} for i in range(130)]
    calls = []
    orig_chunk = main._cluster_one_chunk
    orig_merge = main._merge_cluster_names
    orig_delay = main.CLUSTER_CHUNK_DELAY

    def fake_chunk(chunk, existing):
        calls.append((len(chunk), list(existing)))
        return [{"id": c["id"], "cluster": "C" + c["topic"][-1]} for c in chunk]

    main._cluster_one_chunk = fake_chunk
    main._merge_cluster_names = lambda names: {}  # identity (no consolidation)
    main.CLUSTER_CHUNK_DELAY = 0
    try:
        import math
        out = main.cluster_topics_with_llm(items)
        # every reel assigned, real ids preserved (index mapping round-trips)
        assert len(out) == 130, len(out)
        assert {o["id"] for o in out} == {f"id{i}" for i in range(130)}
        # chunk count derives from the configured size (not hardcoded)
        size = main.CLUSTER_CHUNK_SIZE
        expected_chunks = math.ceil(130 / size)
        assert len(calls) == expected_chunks, calls
        assert calls[0][0] == min(size, 130), calls
        assert calls[-1][0] == 130 - size * (expected_chunks - 1), calls
        # later chunks receive accumulated cluster names
        assert calls[1][1], "existing cluster names not propagated to later chunks"
        print("[OK] cluster chunking passed!")
    finally:
        main._cluster_one_chunk = orig_chunk
        main._merge_cluster_names = orig_merge
        main.CLUSTER_CHUNK_DELAY = orig_delay


def test_cluster_merge_pass():
    print("Testing cluster_topics_with_llm consolidates fragmented names + dedups...")
    import main
    items = [{"id": f"id{i}", "topic": "t"} for i in range(4)]
    orig_chunk = main._cluster_one_chunk
    orig_merge = main._merge_cluster_names
    orig_delay = main.CLUSTER_CHUNK_DELAY
    main.CLUSTER_CHUNK_DELAY = 0

    # Chunk returns fragmented AI-ish names + a duplicate id (id0 assigned twice)
    def fake_chunk(chunk, existing):
        out = [{"id": c["id"],
                "cluster": "AI Tools" if int(c["id"]) % 2 == 0 else "AI Email Tools"}
               for c in chunk]
        out.append({"id": chunk[0]["id"], "cluster": "Dup"})  # duplicate id
        return out

    captured = {}

    def fake_merge(names):
        captured["names"] = sorted(names)
        return {n: ("AI" if n.startswith("AI") else n) for n in names}

    main._cluster_one_chunk = fake_chunk
    main._merge_cluster_names = fake_merge
    try:
        out = main.cluster_topics_with_llm(items)
        ids = [o["id"] for o in out]
        # each id appears exactly once (duplicate collapsed, keep-first)
        assert len(ids) == len(set(ids)) == 4, out
        # fragmented AI names consolidated by the merge map
        clusters = {o["id"]: o["cluster"] for o in out}
        assert clusters["id0"] == "AI" and clusters["id2"] == "AI", out
        # merge pass received the distinct fragmented names
        assert "AI Tools" in captured["names"] and "AI Email Tools" in captured["names"]
        print("[OK] cluster merge pass passed!")
    finally:
        main._cluster_one_chunk = orig_chunk
        main._merge_cluster_names = orig_merge
        main.CLUSTER_CHUNK_DELAY = orig_delay


def test_db_module_surface():
    print("Testing db.py exposes the expected data-layer functions...")
    import db
    for fn in ("get_reel_by_url", "insert_reel", "list_reels",
               "reels_for_clustering", "set_cluster", "cluster_counts",
               "row_to_record"):
        assert hasattr(db, fn), f"db.{fn} missing"
    print("[OK] db module surface passed!")


def test_db_queue_surface():
    print("Testing db.py exposes queue functions...")
    import db
    for fn in ("claim_next_pending", "update_reel_result", "mark_failed"):
        assert hasattr(db, fn), f"db.{fn} missing"
    print("[OK] db queue surface passed!")


def test_extract_url_regression():
    print("Testing POST /extract/url via process_reel_url (mocked)...")
    import main
    long_transcript = " ".join(["word"] * 30)  # clears the 15-word silent-hook guard
    mocked = ReelExtraction(
        core_topic="Topic", key_takeaway="Takeaway",
        action_items=["a"], tools_or_resources=["b"])
    orig_dl = main.download_and_extract_audio
    orig_tr = main.transcribe_audio
    orig_ex = main.extract_structured_json
    orig_save = main.save_to_database
    orig_cache = main.db.get_reel_by_url
    main.db.get_reel_by_url = lambda url: None
    main.download_and_extract_audio = lambda url: ("/tmp/does_not_exist.mp3", "cap", "Title")
    main.transcribe_audio = lambda p: long_transcript
    main.extract_structured_json = lambda t, c: mocked
    main.save_to_database = lambda url, title, raw_transcript, post_caption, extracted: {
        "id": "id-1", "url": url, "title": title,
        "raw_transcript": raw_transcript, "post_caption": post_caption,
        "extracted_json": extracted.model_dump(), "created_at": "2026-06-06T00:00:00Z"}
    try:
        r = client.post("/extract/url", json={"url": "https://www.instagram.com/reel/REGRESSION1/"})
        assert r.status_code == 200, r.text
        assert r.json()["extracted_json"]["core_topic"] == "Topic"
        print("[OK] extract_url regression passed!")
    finally:
        main.download_and_extract_audio = orig_dl
        main.transcribe_audio = orig_tr
        main.extract_structured_json = orig_ex
        main.save_to_database = orig_save
        main.db.get_reel_by_url = orig_cache


def test_delete_reel():
    print("Testing DELETE /reels/{id} (db mocked)...")
    import main
    calls = []
    orig = main.db.delete_reel
    # First call: row exists (returns True); second: missing (False -> 404)
    main.db.delete_reel = lambda rid: (calls.append(rid), len(calls) == 1)[1]
    try:
        r = client.delete("/reels/abc")
        assert r.status_code == 200, r.text
        assert r.json()["deleted"] == "abc"
        assert client.delete("/reels/abc").status_code == 404
        print("[OK] delete reel passed!")
    finally:
        main.db.delete_reel = orig


def test_list_clusters():
    print("Testing GET /clusters (db mocked)...")
    import main
    orig = main.db.cluster_counts
    main.db.cluster_counts = lambda: [{"name": "AI Tools", "count": 3}]
    try:
        r = client.get("/clusters")
        assert r.status_code == 200, r.text
        assert r.json()[0]["name"] == "AI Tools"
        print("[OK] list clusters passed!")
    finally:
        main.db.cluster_counts = orig


def test_reels_include_cluster():
    print("Testing GET /reels includes cluster (db mocked)...")
    import main
    orig = main.db.list_reels
    main.db.list_reels = lambda limit=20, search=None: [{
        "id": "x", "url": None, "title": "t", "raw_transcript": None,
        "post_caption": None, "extracted_json": {"core_topic": "c"},
        "created_at": "2026-06-06T00:00:00Z", "cluster": "Unclustered"}]
    try:
        r = client.get("/reels")
        assert r.status_code == 200, r.text
        assert "cluster" in r.json()[0]
        print("[OK] reels include cluster passed!")
    finally:
        main.db.list_reels = orig

if __name__ == "__main__":
    print("--- Starting Transcriber Pipeline Test ---")
    test_health()
    test_cluster_assignments_model()
    test_extract_text_mock()
    test_recompute_clusters_mock()
    test_cluster_chunking()
    test_cluster_merge_pass()
    test_db_module_surface()
    test_db_queue_surface()
    test_extract_url_regression()
    test_delete_reel()
    test_list_clusters()
    test_reels_include_cluster()
    print("--- All tests completed successfully! ---")
    sys.exit(0)
