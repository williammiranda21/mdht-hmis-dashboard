-- Run once (2026-08-20): outreach team management.
--
-- (1) member_accounts — dashboard ACCOUNTS assigned to a team, stored as a
--     jsonb snapshot [{id, name}] (same pattern as cohort_tasks.assignees:
--     profiles are self-read-only for non-admins, so a join can't render
--     names on the team board — the snapshot can). Free-text `members` stays
--     for field workers without accounts (the MHAP district staff doc).
-- (2) RLS tightened: any helpline user could WRITE teams under the v1
--     for-all policy; team create/edit/coverage is an admin console, so
--     writes become admin-only. Reads stay helpline-wide (the board, the
--     suggestion engine, the intake form all need them).
-- Teams are never deleted — deactivate instead (cases keep team_id history);
-- hence no delete policy at all.

alter table public.outreach_teams
  add column if not exists member_accounts jsonb not null default '[]';

drop policy if exists "helpline teams" on public.outreach_teams;
drop policy if exists "helpline teams read" on public.outreach_teams;
drop policy if exists "helpline teams insert admin" on public.outreach_teams;
drop policy if exists "helpline teams update admin" on public.outreach_teams;

create policy "helpline teams read" on public.outreach_teams
  for select to authenticated
  using ((select public.can_see_helpline()));

create policy "helpline teams insert admin" on public.outreach_teams
  for insert to authenticated
  with check ((select public.is_admin()));

create policy "helpline teams update admin" on public.outreach_teams
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
