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

def test_cluster_column_migration():
    print("Testing cluster column migration (idempotent)...")
    import main, sqlite3
    # Run init twice — must not error and column must exist exactly once
    main.init_local_db()
    main.init_local_db()
    conn = sqlite3.connect(main.DB_PATH)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(saved_reels)").fetchall()]
    conn.close()
    assert cols.count("cluster") == 1, f"cluster column missing/duplicated: {cols}"
    print("[OK] cluster column migration passed!")

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

if __name__ == "__main__":
    print("--- Starting Transcriber Pipeline Test ---")
    test_health()
    test_cluster_column_migration()
    test_extract_text_mock()
    print("--- All tests completed successfully! ---")
    sys.exit(0)
