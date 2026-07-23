-- ─────────────────────────────────────────────────────────────────────────────
-- Deep Dive — Phase 1 (per-project worklists)
--
-- Run in the Supabase SQL editor, THEN re-run the pipeline:
--     python generate_bnl.py
--     cd hmis-web && python pipeline/upsert_to_supabase.py --only bnl_clients
--     python pipeline/prune_stale_bnl.py
--
-- Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- Join key. bnl_clients only carried the project NAME, which cannot be matched
-- reliably (several projects share near-identical names across funders), so
-- worklists could not be scoped to a project at all.
alter table bnl_clients add column if not exists project_id bigint;

-- Worklist flags, computed in bnl_core.py over the finished roster:
--   long_stay    — currently homeless and past 1.5x the MEDIAN days for their
--                  project type (median, not mean: length-of-stay is heavily
--                  right-skewed and a few multi-year clients would hide the rest)
--   open_suspect — carries an "enrollment left open by mistake" DQ flag
alter table bnl_clients add column if not exists long_stay    boolean not null default false;
alter table bnl_clients add column if not exists open_suspect boolean not null default false;

create index if not exists bnl_projid_idx    on bnl_clients (project_id);
create index if not exists bnl_longstay_idx  on bnl_clients (project_id) where long_stay;
create index if not exists bnl_opensusp_idx  on bnl_clients (project_id) where open_suspect;

analyze bnl_clients;

-- ── verify (after the pipeline re-run) ─────────────────────────────────────
-- select count(*) filter (where project_id is not null) as with_proj,
--        count(*) filter (where long_stay)              as long_stay,
--        count(*) filter (where open_suspect)           as open_suspect,
--        count(*)                                       as total
-- from bnl_clients;
