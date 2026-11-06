# saved_reels access before the Supabase-only migration

Recorded 2026-11-05 from the live project (read-only query over `pg_policies`, `pg_constraint`,
`information_schema.role_table_grants`). Rollbacks re-create exactly these.

## Policies (`public.saved_reels`, RLS on)

| Name | Command | Role | Using | With check |
|---|---|---|---|---|
| `anon insert pending reels` | INSERT | anon | — | `((status = 'pending'::text) AND (url ~~ '%instagram.com/%'::text))` |
| `anon read reels` | SELECT | anon | `true` | — |

No policies on `storage` objects.

Re-create `anon read reels` (Task 9 rollback):

```sql
create policy "anon read reels" on public.saved_reels for select to anon using (true);
```

## Constraints (`public.saved_reels`)

- `saved_reels_pkey`: `PRIMARY KEY (id)`
- `saved_reels_url_key`: `UNIQUE (url)` — two rows can't hold the same URL string; cleaning a link to a
  URL another row already holds fails.

No CHECK constraint on `source` or `status`.

## Table grants (`public.saved_reels`)

- `anon`: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE (row-level security is what limits it)
- `authenticated`: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
