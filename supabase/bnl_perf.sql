-- ─────────────────────────────────────────────────────────────────────────────
-- By-Name List performance: server-side filtering, sorting and pagination
--
-- Run in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- WHY: the BNL page used to select all ~23,800 rows × 46 columns (24 MB over 25
-- paged round-trips) purely so the browser could filter, sort and count them.
-- That took ~2 minutes. The page now asks for ONE page of rows at a time, and
-- reads its KPI cards / inflow-outflow chart from precomputed aggregates in
-- meta.bnl_agg. These indexes are what make that page query fast.
-- ─────────────────────────────────────────────────────────────────────────────

-- Number of DQ flags, so "has DQ" is an indexed integer test rather than
-- jsonb_array_length(dq) evaluated per row. Populated by the pipeline.
alter table bnl_clients add column if not exists dq_n int not null default 0;

-- ── Filter predicates ───────────────────────────────────────────────────────
-- Population selectors map to these columns:
--   youth  age >= 18 and age < 25      vet     veteran
--   family family                      single  age >= 25 and not family
--   senior age >= 62
create index if not exists bnl_status_idx   on bnl_clients (status);
create index if not exists bnl_age_idx      on bnl_clients (age);
create index if not exists bnl_veteran_idx  on bnl_clients (veteran) where veteran;
create index if not exists bnl_family_idx   on bnl_clients (family)  where family;
create index if not exists bnl_dq_idx       on bnl_clients (dq_n)    where dq_n > 0;
create index if not exists bnl_assessed_idx on bnl_clients (assessed);

-- Flag filters are highly selective, so partial indexes stay small.
create index if not exists bnl_chronic_idx  on bnl_clients (chronic)  where chronic;
create index if not exists bnl_isnew_idx    on bnl_clients (is_new)   where is_new;
create index if not exists bnl_returned_idx on bnl_clients (returned) where returned;

-- ── Sort keys ───────────────────────────────────────────────────────────────
-- The table's default sort is days_homeless desc; the rest are user-selectable.
create index if not exists bnl_days_idx      on bnl_clients (days_homeless desc);
create index if not exists bnl_sysdays_idx   on bnl_clients (sys_days3 desc);
create index if not exists bnl_lastcont_idx  on bnl_clients (last_contact desc);
create index if not exists bnl_name_idx      on bnl_clients (name);

-- Default view: actively homeless, longest-waiting first.
create index if not exists bnl_status_days_idx on bnl_clients (status, days_homeless desc);

-- ── Search ──────────────────────────────────────────────────────────────────
-- Name/project search uses ILIKE '%term%'. A leading wildcard cannot use a
-- btree index, so use trigram indexes. pg_trgm ships with Supabase.
create extension if not exists pg_trgm;
create index if not exists bnl_name_trgm_idx    on bnl_clients using gin (name gin_trgm_ops);
create index if not exists bnl_project_trgm_idx on bnl_clients using gin (project gin_trgm_ops);

analyze bnl_clients;

-- ── verify ──────────────────────────────────────────────────────────────────
-- select count(*) from bnl_clients where dq_n > 0;
-- explain analyze select pid, name from bnl_clients
--   where status = 'active' order by days_homeless desc limit 100;
