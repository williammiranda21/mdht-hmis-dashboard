-- ─────────────────────────────────────────────────────────────────────────────
-- Task #13 — stale-row prune: `loaded_at` watermark on upsert-owned tables
--
-- PROBLEM: PostgREST upsert only inserts/updates — rows that vanish from the
-- source linger forever. ~22k orphaned rows had accumulated across the period
-- tables (returns_metrics carried 2× its source), and 51 stale is_partial
-- flags mislabeled complete months as "partial" (2026-08-04 incident).
--
-- FIX: upsert_to_supabase.py stamps every row it writes with one run
-- timestamp, then — after a table's load fully completes — deletes rows whose
-- loaded_at predates the run (or is NULL: rows never touched since this
-- column was added, i.e. the existing orphans). A table is only pruned in the
-- same invocation that just (re)stamped its entire current source, so a live
-- row can never be deleted.
--
-- EXEMPT (deliberately NO watermark prune):
--   meta            — shared: snapshot_dq.py & friends own some keys
--   bnl_clients     — pruned by pid-set diff in prune_stale_bnl.py (a DATE
--                     prune was explicitly rejected there: two regens on the
--                     same day would miss every orphan)
--   util_metrics, dest_profile, leaseup_funnel, user_dq, dq_snapshots,
--   cohort_*        — recompute-/snapshot-owned; their loaders manage their
--                     own periods/retention
--   drill_clients   — gets the column, but the prune EXCLUDES rows with
--                     metric LIKE 'eva:%' or metric = 'dq:openstay'
--                     (loaded later in the runbook by recompute_eva.py /
--                     recompute_openstay.py)
--
-- `default now()` is belt-and-braces: any future writer that forgets the
-- column produces a fresh stamp, not a NULL that the next prune would eat.
--
-- Run in the Supabase SQL editor. Idempotent — safe to re-run.
-- AFTER running this, run the full load half (upsert_to_supabase.py --verify)
-- so every live row gets stamped and the orphans get swept.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare t text;
begin
  foreach t in array array[
    'projects', 'project_metrics', 'dq_metrics', 'system_metrics',
    'returns_metrics', 'returns_by_dest', 'drill_clients', 'bnl_flow',
    'survival_metrics', 'project_pathways', 'system_forecast'
  ] loop
    execute format(
      'alter table %I add column if not exists loaded_at timestamptz default now();', t);
  end loop;
end $$;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- select table_name from information_schema.columns
--  where column_name = 'loaded_at' and table_schema = 'public'
--  order by table_name;
-- → the 11 tables above.
