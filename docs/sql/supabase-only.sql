-- Supabase-only migration (plan: docs/superpowers/plans/2026-11-05-supabase-only.md)
-- Run each block in the Supabase SQL Editor, one at a time, only after the owner says yes.
-- Never commit the owner's UUID: <OWNER_UUID> is replaced inside the editor only.

-- ============================================================ Task 1: schema additions
alter table public.saved_reels add column if not exists audio_path text;

create table if not exists public.cluster_jobs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'error')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  assigned integer not null default 0,
  error text
);
-- at most one queued-or-running recompute, enforced by the database
create unique index if not exists cluster_jobs_one_active
  on public.cluster_jobs ((true)) where status in ('pending', 'running');
alter table public.cluster_jobs enable row level security;

create table if not exists public.worker_status (
  id integer primary key default 1 check (id = 1),
  last_seen timestamptz not null
);
alter table public.worker_status enable row level security;
-- Supabase usually grants these by default; explicit so the dashboard's Data API calls can't hit "permission denied".
grant select, insert on public.cluster_jobs to authenticated;
grant select on public.worker_status to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('audio-uploads', 'audio-uploads', false, 26214400, array['audio/*'])
on conflict (id) do nothing;

-- Task 1 rollback (the new objects are empty until Task 8):
-- delete from storage.buckets where id = 'audio-uploads';  -- if refused: Storage → audio-uploads → Delete bucket
-- drop table if exists public.worker_status;
-- drop table if exists public.cluster_jobs;
-- alter table public.saved_reels drop column if exists audio_path;

-- ============================================================ Task 2: owner policies
create or replace function public.is_owner() returns boolean
language sql stable set search_path = ''
as $$ select auth.uid() = '<OWNER_UUID>'::uuid $$;

create policy "owner all reels" on public.saved_reels for all to authenticated
  using (public.is_owner()) with check (public.is_owner());
create policy "owner all cluster jobs" on public.cluster_jobs for all to authenticated
  using (public.is_owner()) with check (public.is_owner());
create policy "owner reads worker status" on public.worker_status for select to authenticated
  using (public.is_owner());
create policy "owner audio uploads" on storage.objects for all to authenticated
  using (bucket_id = 'audio-uploads' and public.is_owner())
  with check (bucket_id = 'audio-uploads' and public.is_owner());

-- Task 2 rollback:
-- drop policy if exists "owner audio uploads" on storage.objects;
-- drop policy if exists "owner reads worker status" on public.worker_status;
-- drop policy if exists "owner all cluster jobs" on public.cluster_jobs;
-- drop policy if exists "owner all reels" on public.saved_reels;
-- drop function if exists public.is_owner();

-- ============================================================ Task 9: remove anonymous read (after the soak)
-- drop policy "anon read reels" on public.saved_reels;
-- Rollback: re-create it exactly as recorded in docs/sql/policies-before-supabase-only.md.
