-- ============================================================================
--  Run once in the Supabase SQL editor (after helpline.sql / team_mgmt.sql /
--  helpline_priority.sql / helpline_referrals.sql / custom_areas.sql).
--
--  Helpline ADMIN grant (2026-09-22): lets a named helpline user manage the
--  Helpline Settings tab — teams, priority rules, referral resources, custom
--  routing areas — without full dashboard admin. Dashboard admins always
--  qualify. UI: Users console "Grant Helpline admin" (shown once the account
--  has the Helpline grant).
--
--  All quals stay wrapped in scalar subqueries (RLS InitPlan doctrine —
--  supabase/rls_initplan.sql).  Idempotent.
-- ============================================================================

alter table public.profiles add column if not exists helpline_admin boolean not null default false;

create or replace function public.is_helpline_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_admin()
      or coalesce((select p.helpline_admin and p.status = 'approved'
                     from profiles p where p.id = auth.uid()), false);
$$;
revoke all on function public.is_helpline_admin() from public;
grant execute on function public.is_helpline_admin() to authenticated;

-- ── outreach_teams (write policies from team_mgmt.sql) ──────────────────────
drop policy if exists "helpline teams insert admin" on public.outreach_teams;
drop policy if exists "helpline teams update admin" on public.outreach_teams;
create policy "helpline teams insert admin" on public.outreach_teams
  for insert to authenticated
  with check ((select public.is_helpline_admin()));
create policy "helpline teams update admin" on public.outreach_teams
  for update to authenticated
  using ((select public.is_helpline_admin()))
  with check ((select public.is_helpline_admin()));

-- ── priority rules + immutable change log (helpline_priority.sql) ───────────
drop policy if exists "priority rules write admin" on public.helpline_priority;
create policy "priority rules write admin" on public.helpline_priority
  for all to authenticated
  using ((select public.is_helpline_admin()))
  with check ((select public.is_helpline_admin()));
drop policy if exists "priority log read admin" on public.helpline_priority_log;
drop policy if exists "priority log insert admin" on public.helpline_priority_log;
create policy "priority log read admin" on public.helpline_priority_log
  for select to authenticated using ((select public.is_helpline_admin()));
create policy "priority log insert admin" on public.helpline_priority_log
  for insert to authenticated with check ((select public.is_helpline_admin()));

-- ── referral resources (helpline_referrals.sql) ─────────────────────────────
drop policy if exists "helpline resources write admin" on public.helpline_resources;
create policy "helpline resources write admin" on public.helpline_resources
  for all to authenticated
  using ((select public.is_helpline_admin()))
  with check ((select public.is_helpline_admin()));

-- ── custom routing areas (custom_areas.sql) ─────────────────────────────────
drop policy if exists "custom areas insert admin" on public.custom_areas;
drop policy if exists "custom areas update admin" on public.custom_areas;
drop policy if exists "custom areas delete admin" on public.custom_areas;
create policy "custom areas insert admin" on public.custom_areas
  for insert to authenticated
  with check ((select public.is_helpline_admin()));
create policy "custom areas update admin" on public.custom_areas
  for update to authenticated
  using ((select public.is_helpline_admin()))
  with check ((select public.is_helpline_admin()));
create policy "custom areas delete admin" on public.custom_areas
  for delete to authenticated
  using ((select public.is_helpline_admin()));
