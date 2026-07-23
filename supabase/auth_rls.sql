-- ─────────────────────────────────────────────────────────────────────────────
-- Close the aggregate tables to anonymous reads
--
-- 🚨 RUN THIS ONLY AFTER CONFIRMING LOGIN WORKS IN PRODUCTION.
--    Until now every aggregate table carried `public read using (true)`, so the
--    anon key — which ships in the browser bundle of the deployed site — could
--    read them all directly. This replaces those with session-scoped policies.
--    If auth is misconfigured when you run it, the dashboard goes blank for
--    everyone. §"Rolling back" at the bottom restores the old behaviour.
--
-- Run in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- Prerequisite: auth_setup.sql (is_admin / is_approved / can_see_project) and
-- bnl_notes.sql (can_see_bnl) must already have been run.
--
-- ── ACCESS MODEL (user decision, 2026-07-23) ────────────────────────────────
-- Aggregates are NOT agency-scoped. Every approved user sees every project's
-- aggregate numbers — that is intentional: this is a CoC-wide performance
-- dashboard and the whole point is that agencies can compare themselves against
-- the system. The login is the boundary, not the agency.
--
-- The ONE thing that IS agency-scoped is the drill-down to individual clients
-- (`drill_clients`, hashed PersonalIDs) and the By-Name List (`bnl_clients`,
-- real names). Those stay locked to the caller's assigned projects / BNL grant.
--
-- So: aggregate = "are you logged in and approved?"
--     person-level = "is this your agency's client?"
-- Do not add can_see_project() to the aggregate tables — that was considered and
-- explicitly rejected.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. All aggregate tables → any approved user, no anonymous access ────────
-- projects/project_metrics/dq_metrics/returns_* are project-dimensioned but are
-- still aggregate COUNTS, not people, so they are open to every approved user.
-- meta holds the period lists every tab needs to render at all.
-- bnl_flow is 12 monthly totals with no PII.
do $$
declare t text;
begin
  foreach t in array array[
    'projects', 'project_metrics', 'dq_metrics', 'system_metrics',
    'returns_metrics', 'returns_by_dest', 'util_metrics', 'meta', 'bnl_flow'
  ] loop
    execute format('drop policy if exists "public read" on %I;', t);
    execute format('drop policy if exists "scoped read" on %I;', t);
    execute format('drop policy if exists "authenticated read" on %I;', t);
    execute format(
      'create policy "authenticated read" on %I for select to authenticated '
      'using (public.is_approved());', t);
  end loop;
end $$;

-- Because aggregates are open to all approved users, the per-project breakdown
-- nested inside util_metrics' jsonb is no longer a cross-agency leak — RLS could
-- not have filtered inside a jsonb blob anyway. That earlier concern is moot
-- under this access model.

-- ── 2. Person-level tables — asserted, NOT changed ──────────────────────────
-- These are the actual restriction, and they are already correct:
--
--   drill_clients → "scoped read drill"   [auth_setup.sql]
--       is_admin() OR (project_id <> 0 AND can_see_project(project_id))
--       Hashed PersonalIDs, scoped to the caller's assigned projects.
--       1,401 rows carry project_id = 0 (system-level roll-ups) and stay
--       admin-only, which is intended.
--
--   bnl_clients   → "bnl readers read roster"  (can_see_bnl)  [bnl_notes.sql]
--   bnl_notes     → "bnl readers read notes"   (can_see_bnl)  [bnl_notes.sql]
--       Real client names. Admins, plus non-admins granted profiles.bnl_access.
--
--   profiles / user_projects → set in auth_setup.sql
--
-- Nothing below touches them. If you ever loosen drill_clients, you are
-- publishing client-level identifiers system-wide — don't.

-- ── 3. Revoke the anon role outright ───────────────────────────────────────
-- Belt and braces: with no policy granting it access, anon already gets nothing.
-- This makes the intent explicit and survives someone re-adding a loose policy.
-- Only the `anon` role is touched; `authenticated` keeps its grants, so signed-in
-- users are unaffected. Login/signup use the auth schema, not these tables.
revoke select on all tables in schema public from anon;
alter default privileges in schema public revoke select on tables from anon;

-- ── Verify ─────────────────────────────────────────────────────────────────
-- Signed OUT (anon key), every one of these must return 0 rows:
--   select count(*) from project_metrics;
--   select count(*) from system_metrics;
--   select count(*) from meta;
--
-- Signed in as an approved user, all aggregates return their full counts, and
-- drill_clients returns only that user's projects (everything, for an admin).
--
-- List what is now in force:
--   select tablename, policyname, roles, qual
--   from pg_policies where schemaname = 'public' order by tablename, policyname;

-- ── Rolling back ───────────────────────────────────────────────────────────
-- If the dashboard blanks and you need the old behaviour immediately:
--   do $$ declare t text; begin
--     foreach t in array array['projects','project_metrics','dq_metrics',
--       'system_metrics','returns_metrics','returns_by_dest','util_metrics',
--       'meta','bnl_flow'] loop
--       execute format('drop policy if exists "authenticated read" on %I;', t);
--       execute format('create policy "public read" on %I for select using (true);', t);
--     end loop; end $$;
--   grant select on all tables in schema public to anon;
-- That restores public reads — treat it as a temporary measure, not a fix.
