-- ============================================================================
--  Youth Connect — youth intake + self-entry portal (2026-08-19)
--
--  Two doors into one pipeline: Educate Tomorrow staff enter youth inside the
--  dashboard, and youth enter themselves via tokened invite links (no account).
--  Every record lands "pending", staff confirm an HMIS identity (suggest-only
--  matching against client_index), and matched intakes surface in the BNL
--  drawer for case conferencing. HMIS/WellSky remains the system of record.
--
--  Access = admins + profiles.yc_access (same pattern as bnl_access).
--  Run in Supabase → SQL Editor. Idempotent.
-- ============================================================================

-- ── Capability flag ──────────────────────────────────────────────────────────
alter table profiles add column if not exists yc_access boolean not null default false;

create or replace function public.can_see_yc()
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_admin()
      or coalesce((select p.yc_access and p.status = 'approved'
                     from profiles p where p.id = auth.uid()), false);
$$;
revoke all on function public.can_see_yc() from public;
grant execute on function public.can_see_yc() to authenticated;

-- ── Intake records (PII — names, DOB, contact, staff case notes) ─────────────
create table if not exists youth_intakes (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  source       text not null check (source in ('self','staff')),
  status       text not null default 'pending'
               check (status in ('pending','matched','no_match','rejected')),
  -- answers (nullable on purpose: youth may skip anything)
  first_name   text,
  last_name    text,
  dob          date,
  ssn4         text,                -- staff intake only; sharpens matching
  contact      text,                -- phone / email / social — youth's own words
  sleeping     text,                -- where they slept / are staying tonight
  school_work  text,
  unsafe       text,                -- yes / no / rather not say
  notes        text,                -- staff case notes; internal-only, never shown to youth
  -- linkage to HMIS (hashed PersonalID — joins bnl_clients.pid / drill pids)
  matched_pid  text,
  matched_by   uuid references auth.users on delete set null,
  matched_at   timestamptz,
  created_by   uuid references auth.users on delete set null,  -- staff intakes
  invite_token text                                            -- self entries
);
create index if not exists idx_yc_intakes_status on youth_intakes (status, created_at desc);
create index if not exists idx_yc_intakes_pid    on youth_intakes (matched_pid);

alter table youth_intakes enable row level security;
-- InitPlan form (see rls_initplan.sql): helper wrapped in a scalar subquery so
-- it evaluates once per statement, not per row.
drop policy if exists "yc read intakes" on youth_intakes;
create policy "yc read intakes" on youth_intakes
  for select to authenticated using ((select public.can_see_yc()));
drop policy if exists "yc insert intakes" on youth_intakes;
create policy "yc insert intakes" on youth_intakes
  for insert to authenticated with check ((select public.can_see_yc()));
drop policy if exists "yc update intakes" on youth_intakes;
create policy "yc update intakes" on youth_intakes
  for update to authenticated
  using ((select public.can_see_yc())) with check ((select public.can_see_yc()));
-- No delete policy: wrong entries become status='rejected', keeping an audit trail.
-- Self-entries INSERT via the service role (/api/yc/submit) after token checks.

-- ── Invite links for the public portal ───────────────────────────────────────
create table if not exists intake_invites (
  token      text primary key,           -- URL-safe random, generated in the app
  label      text,                       -- e.g. "Outreach cards Aug 2026"
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,                -- null = no expiry
  max_uses   int not null default 500,
  uses       int not null default 0,
  disabled   boolean not null default false
);
alter table intake_invites enable row level security;
drop policy if exists "yc manage invites" on intake_invites;
create policy "yc manage invites" on intake_invites
  for all to authenticated
  using ((select public.can_see_yc())) with check ((select public.can_see_yc()));
-- The public portal validates tokens via the service role; anon never reads this.

-- ── Match index: minimal identifiers for ALL HMIS clients (~53k) ─────────────
-- Loaded by pipeline/load_client_index.py after each refresh. Matching runs in
-- a gated server route with the service role — hence NO select policy at all:
-- with RLS enabled and zero policies, authenticated/anon read nothing.
create table if not exists client_index (
  pid     text primary key,              -- hashed PersonalID
  first_n text,                          -- lower(trim(FirstName))
  last_n  text,
  dob     date,
  ssn4    text,
  sex     int
);
create index if not exists idx_client_index_dob  on client_index (dob);
create index if not exists idx_client_index_last on client_index (last_n);
alter table client_index enable row level security;

-- ── Initial grants (user directive 2026-08-19: admins + Educate Tomorrow) ────
update profiles set yc_access = true
 where status = 'approved' and email ilike '%@educatetomorrow.org';
