# Plan 006: Create Root-Level .env.example Template

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git status --porcelain`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `9537dd6`, 2026-06-12

## Why this matters

The repository documentation in `README.md` advises developers to run `cp .env.example .env` in the root workspace during onboarding. However, no `.env.example` template is present in either the root directory or the backend subfolder. This causes friction during setup, as new developers must manually discover and compile the list of required environment variables.

Creating a comprehensive root-level `.env.example` template resolves this setup friction.

## Current state

- Relevant files:
  - `.env.example` (New file in root directory)
  - `README.md` (Onboarding guide)
- No `.env.example` template exists in the repository root or the backend folder today.

## Scope

**In scope**:
- `.env.example` (NEW)

**Out of scope**:
- Any modifications to source code or active `.env` configuration files.

## Steps

### Step 1: Create root-level .env.example file

Write the environment configuration template file `.env.example` in the root workspace directory. It must document all backend uvicorn/worker keys and all frontend Vite client keys, separating them with clear headings and comments.

Target content:
```ini
# ==============================================================================
# Transcriber Configuration Template
# ==============================================================================

# --- Backend API & Queue Worker Settings ---
# Free-tier keys from https://console.groq.com
GROQ_API_KEY=your_groq_api_key_here

# Supabase database connection details
SUPABASE_URL=https://your-supabase-project-id.supabase.co
# SERVICE ROLE key (bypasses RLS) - NEVER expose to browser
SUPABASE_SERVICE_KEY=your_supabase_service_role_key

# Background thread worker (set to 0 to disable worker on FastAPI start)
ENABLE_WORKER=1

# --- Frontend Client Settings ---
# Supabase connection (public/anon key is safe for browser use)
VITE_SUPABASE_URL=https://your-supabase-project-id.supabase.co
VITE_SUPABASE_ANON_KEY=your_supabase_public_anon_key

# Base URL pointing to the deployed backend server (defaults to localhost:8000 if omitted)
# VITE_API_URL=https://your-hf-space-subdomain.hf.space
VITE_API_URL=http://localhost:8000
```

**Verify**: Verify the new file exists at `c:\Users\jeged\Downloads\Transcriber\.env.example`.

## Test plan

- Run `git status` -> verifies new file `.env.example` is tracked.

## Done criteria

- [ ] `.env.example` is successfully created in the project root workspace directory.
- [ ] No files other than `.env.example` are created/modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- If `.env.example` already exists (a merge might be needed instead of overwrite).

## Maintenance notes

- Any new environment variable introduced to the backend or frontend must be documented in this template.
