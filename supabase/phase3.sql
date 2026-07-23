-- ─────────────────────────────────────────────────────────────────────────────
-- Deep Dive Phase 3 — project pathways + system forecast
--
-- Run in the Supabase SQL editor, THEN reload:
--     python refresh.py                          (or just: python generate_pathways.py
--                                                  && python generate_analytics.py)
--     cd hmis-web && python pipeline/upsert_to_supabase.py \
--         --only project_pathways,system_forecast
--
-- Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── project_pathways ────────────────────────────────────────────────────────
-- One row per project: the Sankey + per-state bottleneck for the clients that
-- project served in the trailing 24 months, traced across their WHOLE system
-- pathway (generate_pathways.py §5). Aggregate counts and state-path strings
-- only — no names, no PersonalIDs.
create table if not exists project_pathways (
  project_id   int   primary key,
  project_name text,
  project_type int,
  n_clients    int   not null,      -- cohort size (clients served in the window)
  window_start date,
  window_end   date,
  -- { nodes, links, top_paths, source_rates, bottleneck } — the whole payload
  -- for this project. jsonb because the shape is nested and read whole, never
  -- row-filtered.
  data         jsonb not null default '{}'::jsonb
);

-- ── system_forecast ─────────────────────────────────────────────────────────
-- System-level inflow projection and capacity-utilisation forecast. Two rows,
-- keyed 'inflow' / 'capacity'. Leadership-facing, not agency-scoped — same
-- computation the static analytics page already shows.
create table if not exists system_forecast (
  key       text primary key,       -- 'inflow' | 'capacity'
  value     jsonb not null,
  generated text                    -- e.g. 'June 2026' — the cohort end month
);

-- ── RLS — aggregate rule (is_approved), not agency scoping ───────────────────
-- Both tables are non-personal aggregates, so they take the SAME rule as every
-- other aggregate on this dashboard: any APPROVED user, no agency filter (this
-- is a CoC-wide benchmarking dashboard — peer comparison is the point). Approval,
-- not signup, is the boundary, so a pending account still sees nothing. Policy
-- name matches the loop in auth_rls.sql §1 so a future re-run of that script
-- replaces these instead of OR-ing a second policy on top.
do $$
declare t text;
begin
  foreach t in array array['project_pathways', 'system_forecast'] loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists "public read" on %I;', t);
    execute format('drop policy if exists "authenticated read" on %I;', t);
    execute format(
      'create policy "authenticated read" on %I for select to authenticated '
      'using (public.is_approved());', t);
  end loop;
end $$;

-- ── verify (after the upsert) ───────────────────────────────────────────────
-- select count(*) as projects, min(window_start), max(window_end),
--        min(n_clients), max(n_clients)
-- from project_pathways;
-- select key, generated, jsonb_typeof(value) from system_forecast order by key;
