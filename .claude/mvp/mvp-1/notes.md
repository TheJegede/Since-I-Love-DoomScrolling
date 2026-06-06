# MVP 1 notes

Single-file backend (`backend/main.py`). All three ingestion endpoints converge on `save_to_database`. `ReelExtraction` Pydantic model is the data contract — change it in 4 places together (system prompt, model, DB JSON, frontend render).
