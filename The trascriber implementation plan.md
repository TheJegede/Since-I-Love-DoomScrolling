Here is the complete implementation plan, now prefaced with a comprehensive system context. You can feed this entire document directly to any AI collaborator (like an IDE copilot or a coding agent) as a Product Requirements Document (PRD). It establishes the exact "why" and "how" before diving into the code, ensuring the AI understands the strict constraints of the project.

## **System Context & Backstory (For AI Comprehension)**

**Project Goal:** To build a fully autonomous, serverless data extraction pipeline that converts information-dense Instagram Reels into structured JSON insights.  
**The Problem:** The user routinely encounters educational or tool-focused Instagram videos containing vital information (e.g., software tools, workflows, action items). The current manual process—saving the video, ripping the audio, running manual transcription, and parsing the text—is highly inefficient and creates a severe bottleneck.  
**The Solution:** An agentic workflow where the user inputs an Instagram URL, and the system autonomously fetches the media, extracts the audio, generates a high-speed transcript, and uses schema-validated LLM inference to parse the raw text into actionable data (core concepts, listed tools, chronological steps).  
**Architecture Constraints & Environment (2026):**

* **Cost Strictness:** The budget is exactly $0. No pay-per-use cloud providers (e.g., AWS, GCP) can be used. The entire stack relies on generous 2026 free tiers.  
* **Scraping Evasion:** Instagram actively blocks unauthenticated scraping. The ingestion layer must utilize yt-dlp injected with exported session cookies to bypass these blocks.  
* **Execution Timeouts:** Standard serverless functions (like Vercel API routes) have strict timeouts that will fail during media downloads. Orchestration must happen in a containerized environment capable of longer execution times.  
* **Inference Speed:** Open-source models will be routed through Groq's API (LPU silicon) to guarantee sub-second LLM responses and near-instant Whisper transcription without local hardware constraints.

## **The $0 Architecture Implementation Plan**

**1.Database Provisioning:**PostgreSQL via Supabase.  
Spin up a new project on Supabase's free tier to handle the persistent state.

* Execute a SQL migration to create a saved\_reels table with the following schema: id (UUID, primary key), url (Text, unique constraint), raw\_transcript (Text), extracted\_json (JSONB), and created\_at (Timestamp).  
*   
* Secure the SUPABASE\_URL and SUPABASE\_KEY to be used as backend environment variables.  
* 

**2.Backend Orchestration:**Python & FastAPI on Hugging Face Spaces.  
Deploy a Dockerized FastAPI application on a free Hugging Face Hub CPU Space. This acts as the central API and avoids the 10-second timeouts typical of standard serverless platforms.

* **Ingestion:** Use the yt-dlp Python library to fetch the video. The container must include a securely mounted cookies.txt file from a burner Instagram account, passing \--cookies cookies.txt to authenticate the session and bypass rate limits.  
*   
* **Audio Extraction:** Run ffmpeg to extract only the audio payload (\-x \--audio-format mp3) to the container's ephemeral /tmp directory, keeping the file lightweight for the transcription API.  
* 

**3.Agentic Extraction:**Groq Whisper v3 Turbo & Llama-3.1 8B.  
Process the audio and force the LLM to return strict, programmatic insights using Groq's free tier (which allows 30,000 tokens per minute).

* **Transcription:** POST the temporary .mp3 file to Groq's whisper-large-v3-turbo endpoint to generate the raw text almost instantly.  
*   
* **Validation:** Define a strict Pydantic model to guarantee the shape of the downstream data:  
* 

Python  
from pydantic import BaseModel

class ReelExtraction(BaseModel):  
    core\_topic: str  
    action\_items: list\[str\]  
    tools\_or\_resources: list\[str\]  
    key\_takeaway: str

* **Summarization:** Pass the raw transcript and the Pydantic schema to llama-3.1-8b-instant via Groq. The strict schema forces the model to drop conversational filler and output clean JSON.  
*   
* **Commit:** Use the Supabase Python client to insert the original URL, the raw text, and the validated JSON payload into the database.  
* 

**4.Frontend Interface:**React & Tailwind CSS via Vercel.  
Build a minimalist interface for input and review.

* Initialize a React application utilizing Tailwind CSS.  
*   
* **The Input Route:** A clean UI with a single input bar accepting the URL. Upon submission, it fires a POST request to the FastAPI endpoint on Hugging Face and triggers a loading state.  
*   
* **The Dashboard:** A grid layout that fetches historical data from Supabase. It maps through the database rows, rendering clean cards that display the core\_topic, list the action\_items chronologically, and highlight the tools\_or\_resources.  
*   
* Deploy the repository to Vercel's free tier for zero-maintenance hosting.  
* 

## **Testing & Validation Scenarios**

When generating the backend logic, validate the pipeline against these three edge cases:

1. **The "Resource Drop" Reel (Entity Extraction Test)**  
   * **Input:** A creator speaking rapidly about "3 AI tools to automate your email."  
   * **Success Criteria:** The pipeline must accurately catch the tool names (accommodating slight Whisper mispronunciations) and categorize them into the tools\_or\_resources array, filtering out the intro hook entirely.  
2. **The "Step-by-Step" Reel (Sequential Logic Test)**  
   * **Input:** A technical workflow tutorial where the sequence of operations is highly dependent.  
   * **Success Criteria:** The LLM prompt and Pydantic validation must maintain the exact chronological order of the steps within the action\_items array while stripping out non-essential commentary.  
3. **The "Silent Hook" Reel (Short-Circuit Test)**  
   * **Input:** A video relying entirely on on-screen text with just a trending music track playing (no spoken words).  
   * **Success Criteria:** Because Whisper will often return empty text or hallucinate the lyrics of the background song, the FastAPI backend must detect if the transcript length is less than \~15 words. If so, it must halt the pipeline and return a 400 Bad Request ("No spoken content detected") before attempting LLM inference.

