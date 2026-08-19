-- ============================================================================
--  Helpline Triage (2026-08-19) — homeless helpline → triage → outreach
--  assignment → enrollment verification.
--
--  Model: a CASE is one person-episode (caller identity, area, factors,
--  priority, assignment, outcome); CALLS are immutable events attached to a
--  case (initial + every call-back). Repeat calls join the open case instead
--  of duplicating it; the operator always confirms.
--
--  Access = admins + profiles.helpline_access. v1: every access-holder sees
--  all cases (operators + Trust). Per-team provider scoping is a planned v2
--  policy — add it WITHOUT widening v1 (teams.project_id → user_projects).
--
--  Run in Supabase → SQL Editor. Idempotent.
-- ============================================================================

alter table profiles add column if not exists helpline_access boolean not null default false;

create or replace function public.can_see_helpline()
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_admin()
      or coalesce((select p.helpline_access and p.status = 'approved'
                     from profiles p where p.id = auth.uid()), false);
$$;
revoke all on function public.can_see_helpline() from public;
grant execute on function public.can_see_helpline() to authenticated;

-- ── Outreach teams ────────────────────────────────────────────────────────────
-- Seeded from the active HMIS Street Outreach projects so an assignment can
-- bind to a real ProjectID (closes the loop when the SO enrollment appears).
-- zones = areas covered (lib/helpline-options.ts AREAS values, plus
-- COUNTY_ZONES 'County District 1'..'13' — the countywide fallback matched
-- against helpline_cases.county_district when no team covers the exact area);
-- factors = routing tags that outrank geography ('veteran','youth','family').
create table if not exists outreach_teams (
  id         bigint generated always as identity primary key,
  name       text not null,
  project_id bigint,                       -- HMIS SO project; null = non-HMIS team
  zones      text[] not null default '{}',
  factors    text[] not null default '{}',
  active     boolean not null default true
);
alter table outreach_teams enable row level security;
drop policy if exists "helpline teams" on outreach_teams;
create policy "helpline teams" on outreach_teams
  for all to authenticated
  using ((select public.can_see_helpline())) with check ((select public.can_see_helpline()));

insert into outreach_teams (name, project_id)
select v.name, v.pid from (values
  (66, 'City of Miami Beach HUD:ESG Street Outreach - FL0177L4D002417'),
  (68, 'MHAP CE Consolidation HUD:ESG Street Outreach - FL0211L4D002518'),
  (288, 'City of Miami Agency Discharge Release Outreach Program-MOA'),
  (595, 'Camillus House MB Lazarus'),
  (682, 'Camillus Health Concern Street Outreach 2020'),
  (754, 'New Hope Pathways SO Primary Care HUD-SNOFO'),
  (760, 'Hermanos de la Calle - Love Attack SO DCF ESG CV 2'),
  (796, 'New Hope Pathways SO City of Miami Beach'),
  (825, 'City of Hialeah SO'),
  (839, 'Mission United - SSVF SO UWBC Program'),
  (880, 'MRP ARC Project HUD:SNOFO Street Outreach'),
  (1018, 'New Hope Pathways PATH'),
  (1033, 'Camillus House Lazarus SO Program')
) as v(pid, name)
where not exists (select 1 from outreach_teams t where t.project_id = v.pid);

-- ── City of Miami district sub-teams (2026-08-19, from the City's district-
-- based outreach assignment document). One provider, six numbered teams, each
-- owning a Commission District ("District 5 & Government Center" overlaps
-- Team 8 on purpose — the suggestion engine load-balances multiple hits).
-- Outside-city areas the City serves (Miami Shores, North Miami, North Miami
-- Beach, Aventura) route by MUNICIPALITY, never by district (per the doc);
-- their teams are TBD in the doc, so they are not seeded.
-- project_id is NULL until the user confirms which HMIS project these teams
-- enroll under (MHAP CE Consolidation vs City of Miami MOA).
alter table outreach_teams add column if not exists members  text;
alter table outreach_teams add column if not exists dispatch text;

insert into outreach_teams (name, zones, members)
select v.name, v.zones, v.members from (values
  ('City of Miami — Team 4 (District 1)', array['Miami District 1'], 'Laura Martinez & Willie Rachel'),
  ('City of Miami — Team 5 (District 2)', array['Miami District 2'], 'Christian Candelier & Latrayveia Offord'),
  ('City of Miami — Team 6 (District 3)', array['Miami District 3'], 'Lizeth Santana & Calvin Leno'),
  ('City of Miami — Team 7 (District 4)', array['Miami District 4'], 'Giancarlo Venturini & Damara Logan'),
  ('City of Miami — Team 8 (District 5)', array['Miami District 5'], 'Ricky Leath & Christopher Hall'),
  ('City of Miami — Team 9 (District 5 & Government Center)',
     array['Miami District 5','Government Center'], 'Pedro Rodriguez & Irisi Williamson')
) as v(name, zones, members)
where not exists (select 1 from outreach_teams t where t.name = v.name);

-- ── Cases (PII — caller names, phones, locations) ─────────────────────────────
create table if not exists helpline_cases (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users on delete set null,
  status         text not null default 'new' check (status in
                 ('new','assigned','attempted','contacted','confirmed',
                  'declined','no_locate','closed')),
  -- caller identity (everything optional — anonymous callers are real)
  first_name     text,
  last_name      text,
  dob            date,
  ssn4           text,
  phone_line     text,     -- the number they called FROM (caller id / typed)
  phone_callback text,     -- the number they SAY to use (often different)
  -- situation (categoricals from lib/helpline-options.ts — closed lists)
  area           text,
  landmark       text,
  -- precise location for dispatch (user directive 2026-08-19): free-text
  -- address plus geocoded coordinates (server-side Nominatim via
  -- /api/helpline/geocode — county PCs never call external services).
  address        text,
  lat            double precision,
  lng            double precision,
  sleeping       text,
  household      text,
  factors        text[] not null default '{}',
  notes          text,
  priority       int not null default 0,   -- computed in lib; stored for sorting
  -- assignment
  team_id        bigint references outreach_teams on delete set null,
  assigned_at    timestamptz,
  attempts       int not null default 0,   -- FAILED contact attempts
  last_attempt   date,
  contacts       int not null default 0,   -- SUCCESSFUL contacts (separate fact —
  last_contact   date,                     -- never overwritten by a failed try)
  -- HMIS linkage (suggest-only matching; a person confirms)
  matched_pid    text,
  matched_by     uuid references auth.users on delete set null,
  matched_at     timestamptz,
  -- outcome + verification (set by pipeline/verify_helpline.py, never by hand)
  confirmed_at   date,     -- outreach verified homeless on this date
  verified_entry date,     -- HMIS enrollment EntryDate >= confirmed_at
  verified_proj  text,     -- project name of the verifying enrollment
  verified_at    timestamptz
);
-- Backfill for tables created before 2026-08-19 evening (attempts vs contacts
-- split — a failed try and a successful contact are separate facts).
alter table helpline_cases add column if not exists contacts int not null default 0;
alter table helpline_cases add column if not exists last_contact date;

-- Auto-detected Miami-Dade County Commission District (point-in-polygon from
-- the case pin) — the "homeless persons by MDC commission district" reporting
-- cut. City district lives in `area` ('Miami District N') per the routing doc.
alter table helpline_cases add column if not exists county_district text;

-- Outreach events join the call log (user catch: counters can't say WHICH try
-- succeeded — the trail can). kinds: initial/followup = phone calls in;
-- attempt/contact = outreach going out.
alter table helpline_calls drop constraint if exists helpline_calls_kind_check;
alter table helpline_calls add constraint helpline_calls_kind_check
  check (kind in ('initial','followup','attempt','contact'));

create index if not exists idx_hl_cases_status on helpline_cases (status, priority desc, created_at);
create index if not exists idx_hl_cases_phone  on helpline_cases (phone_line);
create index if not exists idx_hl_cases_pid    on helpline_cases (matched_pid);

alter table helpline_cases enable row level security;
drop policy if exists "helpline cases" on helpline_cases;
create policy "helpline cases" on helpline_cases
  for all to authenticated
  using ((select public.can_see_helpline())) with check ((select public.can_see_helpline()));

-- ── Calls — immutable events on a case ────────────────────────────────────────
create table if not exists helpline_calls (
  id          bigint generated always as identity primary key,
  case_id     bigint not null references helpline_cases on delete cascade,
  received_at timestamptz not null default now(),
  operator    uuid references auth.users on delete set null,
  kind        text not null default 'initial'
              check (kind in ('initial','followup','attempt','contact')),
  notes       text
);
create index if not exists idx_hl_calls_case on helpline_calls (case_id, received_at desc);

alter table helpline_calls enable row level security;
drop policy if exists "helpline calls read" on helpline_calls;
create policy "helpline calls read" on helpline_calls
  for select to authenticated using ((select public.can_see_helpline()));
drop policy if exists "helpline calls insert" on helpline_calls;
create policy "helpline calls insert" on helpline_calls
  for insert to authenticated with check ((select public.can_see_helpline()));
-- No update/delete policies: calls are immutable events, like bnl_notes.
