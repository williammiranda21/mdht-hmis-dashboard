-- ── Cohort staffing tasks ("Next steps") + per-cohort access grants ─────────
-- Run ONCE in the Supabase SQL editor.
--
-- Replaces the "Next steps/Follow-up" + "Responsible Staff" columns of the
-- cohort-meeting spreadsheets: per cohort member, a checklist of action items,
-- each assigned to a DASHBOARD ACCOUNT (user decision 2026-08-12 — no free-text
-- assignees), checked off with an audit stamp. Cohort-scoped by design: this
-- lives only on the Cohorts page, never on the BNL (user decision 2026-08-12).
--
-- cohort_access lets an admin share a SPECIFIC cohort with a non-admin account
-- (the staff who work that cohort). A grant opens: that cohort's page, its
-- member list, snapshots, and its tasks (read + add + check off). Cohort
-- CREATION/deletion, membership edits, and grants themselves stay admin-only.
-- NOTE: member names/details still come from bnl_clients + bnl_notes, which are
-- gated by can_see_bnl() — a grantee without BNL access sees an empty member
-- list. Grant BNL access alongside (the Access panel shows who lacks it).
--
-- Like bnl_notes, pid has NO foreign key to bnl_clients — the roster is a
-- rebuilt snapshot and tasks must outlive it. cohort_id DOES cascade: deleting
-- a cohort deletes its meeting artifacts (same as cohort_members).
-- assignee_name / created_by / done_by are snapshots, not joins — a permanent
-- record of who was assigned/acting at the time (same rationale as bnl_notes).

create table if not exists cohort_tasks (
  id            bigint generated always as identity primary key,
  cohort_id     bigint not null references cohorts(id) on delete cascade,
  pid           text not null,                     -- hashed PersonalID (bnl_clients.pid)
  body          text not null,
  -- [{id, name}, ...] — account id + display-name snapshots at assignment time
  -- (multiple assignees per task, user request 2026-08-12; snapshot rationale
  -- as bnl_notes authors)
  assignees     jsonb not null default '[]'::jsonb,
  status        text not null default 'open' check (status in ('open', 'done')),
  created_by    text,                              -- email snapshot
  created_at    timestamptz not null default now(),
  done_at       timestamptz,
  done_by       text,                              -- email snapshot
  constraint cohort_tasks_body_not_blank check (length(btrim(body)) > 0)
);

-- Migration for tables created by the earlier single-assignee version of this
-- file: fold assignee_id/assignee_name into the assignees array, then drop
-- the old columns. Safe to re-run.
alter table cohort_tasks add column if not exists assignees jsonb not null default '[]'::jsonb;
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'cohort_tasks'
               and column_name = 'assignee_id') then
    update cohort_tasks
       set assignees = jsonb_build_array(jsonb_build_object('id', assignee_id, 'name', assignee_name))
     where assignee_id is not null and assignees = '[]'::jsonb;
    alter table cohort_tasks drop column assignee_id;
    alter table cohort_tasks drop column assignee_name;
  end if;
end $$;

create index if not exists cohort_tasks_lookup on cohort_tasks (cohort_id, pid, status);

create table if not exists cohort_access (
  cohort_id  bigint not null references cohorts(id) on delete cascade,
  user_id    uuid   not null references auth.users on delete cascade,
  granted_by text,                                 -- email snapshot
  granted_at timestamptz default now(),
  primary key (cohort_id, user_id)
);

alter table cohort_tasks  enable row level security;
alter table cohort_access enable row level security;

-- All quals InitPlan-wrapped per the house RLS rule (supabase/rls_initplan.sql)
-- — never a bare no-arg helper call. The EXISTS probes hit the cohort_access
-- primary key, so per-row cost is an index lookup, not a function call.

-- Admins: everything, on both new tables.
drop policy if exists "admins all" on cohort_tasks;
create policy "admins all" on cohort_tasks for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "admins all" on cohort_access;
create policy "admins all" on cohort_access for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- A user can see which cohorts they were granted (drives the nav link).
drop policy if exists "own grants" on cohort_access;
create policy "own grants" on cohort_access for select to authenticated
  using (user_id = (select auth.uid()));

-- Grantees: read the cohort + its members/snapshots, read + add + update tasks.
-- Policies are permissive (OR'd with "admins all"), and each requires an
-- APPROVED account — a disabled account's leftover grants go dead with it.
drop policy if exists "granted read" on cohorts;
create policy "granted read" on cohorts for select to authenticated
  using ((select public.is_approved()) and exists (
    select 1 from cohort_access a
    where a.cohort_id = cohorts.id and a.user_id = (select auth.uid())));

drop policy if exists "granted read" on cohort_members;
create policy "granted read" on cohort_members for select to authenticated
  using ((select public.is_approved()) and exists (
    select 1 from cohort_access a
    where a.cohort_id = cohort_members.cohort_id and a.user_id = (select auth.uid())));

drop policy if exists "granted read" on cohort_snapshots;
create policy "granted read" on cohort_snapshots for select to authenticated
  using ((select public.is_approved()) and exists (
    select 1 from cohort_access a
    where a.cohort_id = cohort_snapshots.cohort_id and a.user_id = (select auth.uid())));

drop policy if exists "granted read" on cohort_tasks;
create policy "granted read" on cohort_tasks for select to authenticated
  using ((select public.is_approved()) and exists (
    select 1 from cohort_access a
    where a.cohort_id = cohort_tasks.cohort_id and a.user_id = (select auth.uid())));

drop policy if exists "granted insert" on cohort_tasks;
create policy "granted insert" on cohort_tasks for insert to authenticated
  with check ((select public.is_approved()) and exists (
    select 1 from cohort_access a
    where a.cohort_id = cohort_tasks.cohort_id and a.user_id = (select auth.uid())));

drop policy if exists "granted update" on cohort_tasks;
create policy "granted update" on cohort_tasks for update to authenticated
  using ((select public.is_approved()) and exists (
    select 1 from cohort_access a
    where a.cohort_id = cohort_tasks.cohort_id and a.user_id = (select auth.uid())))
  with check ((select public.is_approved()) and exists (
    select 1 from cohort_access a
    where a.cohort_id = cohort_tasks.cohort_id and a.user_id = (select auth.uid())));

revoke all on cohort_tasks, cohort_access from anon;
