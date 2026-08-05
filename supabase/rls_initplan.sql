-- ─────────────────────────────────────────────────────────────────────────────
-- RLS performance fix: evaluate helper functions ONCE per statement, not per row
--
-- WHY (2026-08-05): the By-Name List went down in prod with
--   "Application error: a server-side exception has occurred" —
-- Postgres error 57014 (statement timeout, 8 s). The roster policy
--   using (public.can_see_bnl())
-- makes Postgres call can_see_bnl() for EVERY row it scans. The helper is a
-- SECURITY DEFINER sql function (not inlinable), and it calls is_admin() /
-- is_approved() / a profiles lookup — ~0.34 ms per row. A sorted page-1 read
-- of bnl_clients (23,958 rows) plus its count=exact pass is ~48k evaluations
-- ≈ 8+ s → timeout. The same query via service role (RLS bypassed) runs in
-- 0.6 s, which is why earlier "healthy" probes missed it.
--
-- FIX: wrap every no-argument helper call in a scalar subquery —
--   using ((select public.can_see_bnl()))
-- The planner hoists that into an InitPlan evaluated ONCE per statement.
-- Semantics are identical (the functions are STABLE and take no row values);
-- only the evaluation count changes. This is Supabase's documented RLS
-- performance pattern. can_see_project(project_id) takes a row value and
-- cannot be hoisted — but the is_admin() OR-branch in front of it can, which
-- short-circuits the whole qual for admins.
--
-- Run in the Supabase SQL editor. Idempotent — safe to re-run.
-- No redeploy needed: the app's queries are unchanged.
--
-- Prerequisites: auth_setup.sql, bnl_notes.sql, auth_rls.sql, survival.sql,
-- phase3.sql, targets.sql, dq_snapshots.sql, user_dq.sql, cohorts.sql
-- (i.e. the current prod state — this file only re-states their policies).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. bnl_clients — the outage ─────────────────────────────────────────────
drop policy if exists "admins read bnl"          on bnl_clients;  -- legacy name
drop policy if exists "bnl readers read roster"  on bnl_clients;
create policy "bnl readers read roster" on bnl_clients
  for select to authenticated using ((select public.can_see_bnl()));

-- ── 2. bnl_notes — same gate ────────────────────────────────────────────────
drop policy if exists "bnl readers read notes" on bnl_notes;
create policy "bnl readers read notes" on bnl_notes
  for select to authenticated using ((select public.can_see_bnl()));

drop policy if exists "bnl readers add notes" on bnl_notes;
create policy "bnl readers add notes" on bnl_notes
  for insert to authenticated
  with check ((select public.can_see_bnl()) and author_id = (select auth.uid()));

-- ── 3. Aggregate tables — "approved read" (auth_rls / survival / phase3 /
--       targets read half). Same cliff waiting to happen on any full scan. ───
do $$
declare t text;
begin
  foreach t in array array[
    'projects', 'project_metrics', 'dq_metrics', 'system_metrics',
    'returns_metrics', 'returns_by_dest', 'util_metrics', 'meta', 'bnl_flow',
    'survival_metrics', 'project_pathways', 'system_forecast',
    'project_targets', 'type_targets'
  ] loop
    execute format('drop policy if exists "public read" on %I;', t);         -- legacy
    execute format('drop policy if exists "authenticated read" on %I;', t);
    execute format(
      'create policy "authenticated read" on %I for select to authenticated '
      'using ((select public.is_approved()));', t);
  end loop;
end $$;

-- ── 4. Admin-write policies ─────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['project_targets', 'type_targets'] loop
    execute format('drop policy if exists "admins manage targets" on %I;', t);
    execute format(
      'create policy "admins manage targets" on %I for all to authenticated '
      'using ((select public.is_admin())) with check ((select public.is_admin()));', t);
  end loop;
  foreach t in array array['cohorts', 'cohort_members', 'cohort_snapshots'] loop
    execute format('drop policy if exists "admins all" on %I;', t);
    execute format(
      'create policy "admins all" on %I for all to authenticated '
      'using ((select public.is_admin())) with check ((select public.is_admin()));', t);
  end loop;
end $$;

-- ── 5. Project-scoped person-level reads — hoist the admin branch ───────────
-- can_see_project(project_id) stays per-row for non-admins (it takes a row
-- value); admins now short-circuit via one InitPlan instead of one call/row.
drop policy if exists "scoped read drill" on drill_clients;
create policy "scoped read drill" on drill_clients
  for select to authenticated
  using ((select public.is_admin())
         or (project_id <> 0 and public.can_see_project(project_id)));

drop policy if exists "scoped read snapshots" on dq_snapshots;
create policy "scoped read snapshots" on dq_snapshots
  for select to authenticated
  using ((select public.is_admin()) or public.can_see_project(project_id));

drop policy if exists "scoped read user dq" on user_dq;
create policy "scoped read user dq" on user_dq
  for select to authenticated
  using ((select public.is_admin()) or public.can_see_project(project_id));

-- ── 6. profiles / user_projects ─────────────────────────────────────────────
drop policy if exists "read profiles" on profiles;
create policy "read profiles" on profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists "admins update profiles" on profiles;
create policy "admins update profiles" on profiles
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists "read project grants" on user_projects;
create policy "read project grants" on user_projects
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists "admins manage grants" on user_projects;
create policy "admins manage grants" on user_projects
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Every qual should now show the wrapped form "( SELECT ...)":
--   select tablename, policyname, qual, with_check
--   from pg_policies where schemaname = 'public' order by tablename, policyname;
--
-- And the page-1 roster read as a signed-in user should drop from
-- 8 s + timeout to well under 1 s.
