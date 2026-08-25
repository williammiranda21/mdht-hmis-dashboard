-- Run once (2026-08-25): BNL CELL MARKS — right-click color highlights on
-- roster cells, for case conferencing ("mark the referral cell red").
--
-- Model: ONE mark per (client, column), last write wins. Colors are the
-- unlabeled values 1..4 (red / yellow / green / blue — user call 2026-08-25:
-- no semantic labels yet; meanings can be layered on later without touching
-- this table). Marks are SHARED team state — every BNL reader sees them —
-- and live in a side table keyed by pid, so ETL refreshes never wipe them.
-- prune_stale_bnl.py sweeps marks for clients that left the roster.
--
-- Permissions mirror BNL notes exactly: read = can_see_bnl(); write = the
-- population-scoped note-writing grant can_write_bnl_note(pid)
-- (bnl_write_pops.sql). Author is pinned to the caller, same as notes.
--
-- RLS note: the no-arg helper is wrapped in (select …) per the InitPlan rule
-- (rls_initplan.sql). can_write_bnl_note(pid) is per-row by nature, but every
-- write statement targets a single (pid, col) row, so it runs once per call —
-- the same shape the bnl_notes INSERT policy already has.

create table if not exists public.bnl_cell_marks (
  pid         text not null,
  col         text not null,
  color       smallint not null check (color between 1 and 4),
  author_id   uuid not null,
  author_name text,
  updated_at  timestamptz not null default now(),
  primary key (pid, col)
);

alter table public.bnl_cell_marks enable row level security;

drop policy if exists "bnl readers read marks" on public.bnl_cell_marks;
create policy "bnl readers read marks" on public.bnl_cell_marks
  for select to authenticated
  using ((select public.can_see_bnl()));

drop policy if exists "bnl writers add marks" on public.bnl_cell_marks;
create policy "bnl writers add marks" on public.bnl_cell_marks
  for insert to authenticated
  with check (public.can_write_bnl_note(pid) and author_id = auth.uid());

-- Upsert = INSERT ... ON CONFLICT DO UPDATE, so UPDATE needs its own policy.
-- The new author takes ownership of the mark (it's team state, not a thread).
drop policy if exists "bnl writers recolor marks" on public.bnl_cell_marks;
create policy "bnl writers recolor marks" on public.bnl_cell_marks
  for update to authenticated
  using (public.can_write_bnl_note(pid))
  with check (public.can_write_bnl_note(pid) and author_id = auth.uid());

drop policy if exists "bnl writers clear marks" on public.bnl_cell_marks;
create policy "bnl writers clear marks" on public.bnl_cell_marks
  for delete to authenticated
  using (public.can_write_bnl_note(pid));
