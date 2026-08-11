-- ─────────────────────────────────────────────────────────────────────────────
-- Milestone worklists (user request 2026-08-11): make the CE journey bar's
-- waiting numbers clickable — a roster list of who is stuck on each leg,
-- longest-waiting first.
--
--   ms_stage — the client's live CE leg: their furthest milestone reached,
--              set ONLY for ACTIVE clients not yet moved in (identical
--              semantics to the ce_milestones aggregate's `waiting`, computed
--              from the same per-row fields in bnl_core so the bar's count
--              and the clicked list always match).
--   ms_wait  — days since that milestone, as of the roster's as_of.
--
-- Run in the Supabase SQL editor. Idempotent — safe to re-run.
-- Then reload: generate_bnl.py + upsert --only bnl_clients,bnl_flow,meta
-- + prune_stale_bnl.py.
-- ─────────────────────────────────────────────────────────────────────────────
alter table bnl_clients add column if not exists ms_stage text;
alter table bnl_clients add column if not exists ms_wait int;
