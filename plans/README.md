# Transcriber worker improvement plans

These plans are deliberately sized for a single-user, $0/month deployment. They reuse the existing Python worker and Supabase database. They do not introduce Redis, Celery, a paid scheduler, a second hosted service, or broad parallel processing.

Planned against commit `4a5e5e3` on 2026-07-12.

## Execution order

| Order | Plan | Status | Effort | Depends on |
|---|---|---|---|---|
| 1 | [001 — Fix worker throughput and terminal statuses](001-fix-worker-throughput-and-statuses.md) | DONE | S | none |
| 2 | [002 — Add lightweight recovery and retries](002-add-worker-recovery-and-retries.md) | DONE | M | 001 |
| 3 | [003 — Consolidate worker lifecycle and timing](003-consolidate-worker-lifecycle.md) | OPTIONAL | M | 001, preferably 002 |

```mermaid
flowchart LR
    A["001: correctness + free speed"] --> B["002: crash recovery + retries"]
    B --> C["003: lifecycle cleanup + timings"]
```

## Recommended stopping point

Plans 001 and 002 are the best value. Stop there unless the duplicated worker loops or debugging friction continues to bother you. Plan 003 improves maintainability and visibility but is not required for a reliable personal worker.

## Explicitly deferred

- **Redis, Celery, RabbitMQ, or another queue service:** recurring cost and operational complexity are not justified; Supabase is already the queue.
- **Postgres `FOR UPDATE SKIP LOCKED` RPC:** useful for multiple concurrent workers, but this project normally has one residential worker. Revisit only if multiple workers are intentionally introduced.
- **Heartbeats and worker registries:** unnecessary for one worker; a claim timestamp plus startup recovery is sufficient.
- **Automatic high concurrency:** Instagram and Groq free-tier limits make this more likely to reduce reliability than improve throughput. Measure first.
- **Persisting `BATCH_JOB`:** a restart losing the display-only batch summary is acceptable for a personal tool because row statuses remain in Supabase.

## Verification baseline

Run from the repository root:

```powershell
.\backend\.venv\Scripts\python.exe backend\verify_pipeline.py
cd frontend
npm test
npm run lint
npm run build
```

At planning time, all backend checks passed, all 17 frontend tests passed, lint passed, and the production build passed.
