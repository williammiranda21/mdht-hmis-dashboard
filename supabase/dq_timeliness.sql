-- ── DQ timeliness — provider responsiveness to the fix-lists ─────────────────
-- Run ONCE in the Supabase SQL editor. Written by pipeline/snapshot_dq.py
-- (dq_items, dq_timeliness) and /api/dq-due (dq_due_dates, admin sessions).
--
-- WHY (user directive 2026-08-14): measure how fast providers CLEAN errors,
-- not just how many they have. dq_items is the per-record worklist ledger —
-- first_seen when a unit first hits a fix-list capture, fixed when it vanishes
-- from a later capture of the SAME period. fixed_on comes from the underlying
-- HMIS record's DateUpdated (the true clean date), NOT the refresh date the
-- fix was detected — the upload only bounds detection (user insight 8/14).

-- One row per offending unit per period. status:
--   open   — currently on the fix-list
--   fixed  — vanished from a later capture of the same period (a real fix)
--   rolled — the period rolled over while still open; successor row in the
--            new period inherits first_seen. Excluded from timeliness stats
--            (can't distinguish "fixed" from "left the new period's universe").
create table if not exists dq_items (
  period      text not null,
  project_id  bigint not null,
  metric      text not null,                -- 'dq:<el>' | 'eva:<id>'
  pid         text not null,                -- hashed PersonalID
  first_seen  date not null,                -- first capture that listed it
  last_seen   date not null,                -- latest capture that listed it
  status      text not null default 'open', -- open | fixed | rolled
  fixed_on    date,                         -- record's DateUpdated (true clean date)
  detected_on date,                         -- capture that noticed the fix
  days_to_fix int,                          -- fixed_on - first_seen (fixed only)
  primary key (period, project_id, metric, pid),
  constraint dq_items_status_chk check (status in ('open', 'fixed', 'rolled'))
);
create index if not exists dq_items_proj_open
  on dq_items (project_id, status);

-- Per-project rollup recomputed by snapshot_dq.py after each capture — small
-- (one row per project) so the DQ tab can read it without aggregate queries.
create table if not exists dq_timeliness (
  project_id      bigint primary key,
  median_fix_days numeric,                  -- median days_to_fix, fixed items
  n_fixed         int not null default 0,   -- fixed items in the window
  n_open          int not null default 0,   -- currently open units
  n_open_30d      int not null default 0,   -- open 30+ days (aging tail)
  computed_on     date not null
);

-- Homeless Trust due dates per project + fix-list element (campaign level —
-- deliberately NOT per record). Written by /api/dq-due under the ADMIN's own
-- session (RLS below), so writes are attributable; read by everyone approved.
create table if not exists dq_due_dates (
  project_id bigint not null,
  metric     text not null,                 -- 'dq:<el>' | 'eva:<id>'
  due_date   date not null,
  set_by     uuid not null references auth.users (id),
  set_at     timestamptz not null default now(),
  primary key (project_id, metric)
);

alter table dq_items      enable row level security;
alter table dq_timeliness enable row level security;
alter table dq_due_dates  enable row level security;

-- Same visibility as drill_clients: admins everything, agencies their projects.
-- InitPlan rule (2026-08-05): no-arg helpers ALWAYS wrapped in (select ...).
drop policy if exists "scoped read dq items" on dq_items;
create policy "scoped read dq items" on dq_items
  for select to authenticated
  using ((select public.is_admin()) or public.can_see_project(project_id));
-- No write policies: only the service-role pipeline writes dq_items.

-- Timeliness is an aggregate (no client-level data) — approved-read like
-- dq_metrics, so the DQ tab can rank every provider for any approved viewer.
drop policy if exists "approved read timeliness" on dq_timeliness;
create policy "approved read timeliness" on dq_timeliness
  for select to authenticated
  using ((select public.is_approved()));

drop policy if exists "approved read due dates" on dq_due_dates;
create policy "approved read due dates" on dq_due_dates
  for select to authenticated
  using ((select public.is_approved()));
drop policy if exists "admin write due dates" on dq_due_dates;
create policy "admin write due dates" on dq_due_dates
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()) and set_by = (select auth.uid()));

revoke all on dq_items      from anon;
revoke all on dq_timeliness from anon;
revoke all on dq_due_dates  from anon;
