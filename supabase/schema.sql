-- ============================================================================
--  HMIS Dashboard — Supabase schema
--  Run this in Supabase → SQL Editor. Safe to re-run (idempotent-ish: drops first).
--  Grain mirrors the Python pipeline's records so upserts are simple.
-- ============================================================================

-- ── Projects ────────────────────────────────────────────────────────────────
create table if not exists projects (
  project_id    bigint primary key,
  name          text,
  project_type  int,
  type_name     text,
  operating_start date,
  operating_end   date
);

-- ── Per-project operational metrics (today's "rows"/"qtr_rows"/"fy_rows") ─────
create table if not exists project_metrics (
  period          text not null,                 -- '2026-05' | 'FY2026-Q3' | 'FY2026'
  granularity     text not null,                 -- 'monthly' | 'quarterly' | 'fiscal'
  project_id      bigint not null,
  household_type  text not null default 'All',   -- 'All' | 'Adult Only' | 'Adult with Children'
  subpopulation   text not null default 'All',   -- 'All' | 'Chronic' | ...
  project_name    text,
  type_name       text,
  clients_served  int,
  leavers         int,
  exits_ph        int,
  ph_exit_rate    numeric,
  exits_unsub     int,
  unsub_rate      numeric,
  avg_los         numeric,
  is_partial      boolean default false,
  -- Full 34-column source record ({colName: value}) so the dense Project
  -- Performance table + column picker can show every metric without 30 more
  -- typed columns. The typed columns above stay for fast SQL filter/sort.
  data            jsonb,
  primary key (period, granularity, project_id, household_type, subpopulation)
);
create index if not exists idx_pm_lookup   on project_metrics (granularity, period, household_type, subpopulation);
create index if not exists idx_pm_project  on project_metrics (granularity, project_id, household_type, subpopulation);

-- ── Data Quality (APR Q6) per project/period (today's "dq_rows") ─────────────
create table if not exists dq_metrics (
  period       text not null,
  granularity  text not null,                    -- 'monthly' | 'quarterly' | 'fiscal'
  project_id   bigint not null,
  data         jsonb not null,                    -- the full DQ record (30 dq_cols)
  primary key (period, granularity, project_id)
);
create index if not exists idx_dq_lookup on dq_metrics (granularity, period);

-- ── Returns by prior-exit destination (today's "ret_dest") ───────────────────
create table if not exists returns_by_dest (
  period          text not null,
  project_id      bigint not null,
  household_type  text not null default 'All',
  subpopulation   text not null default 'All',
  data            jsonb not null,                  -- { destination -> {exits, returns, ...} }
  primary key (period, project_id, household_type, subpopulation)
);

-- ── System Performance metrics (today's "sys_data") ──────────────────────────
create table if not exists system_metrics (
  period          text not null,
  granularity     text not null,
  household_type  text not null default 'All',
  subpopulation   text not null default 'All',
  data            jsonb not null,                -- the full SPM record (M1a/M3/M5/M7/...)
  primary key (period, granularity, household_type, subpopulation)
);

-- ── Returns (SPM Measure 2) per project/period ───────────────────────────────
create table if not exists returns_metrics (
  period          text not null,
  granularity     text not null,
  project_id      bigint not null,
  household_type  text not null default 'All',
  subpopulation   text not null default 'All',
  total_ph_exits  int,
  returns_lt6mo   int,
  returns_6to12mo int,
  returns_13to24mo int,
  returns_2yr     int,
  primary key (period, granularity, project_id, household_type, subpopulation)
);

-- ── Unit utilization per period (the new tab) ────────────────────────────────
create table if not exists util_metrics (
  period      text primary key,                  -- '2026-05' | 'FY2026-Q3' | 'FY2026'
  data        jsonb not null                     -- { hh, unit, empty, over, under, projects }
);

-- ── Drill-down client lists (admin only) — hashed PersonalIDs ─────────────────
create table if not exists drill_clients (
  period        text not null,
  project_id    bigint not null,
  metric        text not null,                   -- 'c' | 'l' | 'p' | 'u' | 'los0' ...
  personal_ids  text[] not null,
  primary key (period, project_id, metric)
);

-- ── Meta (generated_at, period range, etc.) ──────────────────────────────────
create table if not exists meta (
  key   text primary key,
  value jsonb
);

-- ============================================================================
--  Row-Level Security
--  Aggregate metrics: readable by anyone (anon) — they contain no PII.
--  drill_clients: locked down (server/service-role only for now; add an
--  admin policy once Supabase Auth is wired).
-- ============================================================================
alter table projects        enable row level security;
alter table project_metrics enable row level security;
alter table dq_metrics      enable row level security;
alter table system_metrics  enable row level security;
alter table returns_metrics enable row level security;
alter table returns_by_dest enable row level security;
alter table util_metrics    enable row level security;
alter table meta            enable row level security;
alter table drill_clients   enable row level security;

-- public read on aggregates
do $$
declare t text;
begin
  foreach t in array array['projects','project_metrics','dq_metrics','system_metrics','returns_metrics','returns_by_dest','util_metrics','meta']
  loop
    execute format('drop policy if exists "public read" on %I;', t);
    execute format('create policy "public read" on %I for select using (true);', t);
  end loop;
end $$;

-- drill_clients: NO select policy for anon/authenticated yet → effectively private.
-- The pipeline upserts with the service_role key, which bypasses RLS.
-- When you add Supabase Auth, replace with an admin/agency-scoped policy, e.g.:
--   create policy "admins read drill" on drill_clients for select
--     using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));

-- ── By-Name List, all populations (PII — names!) ─────────────────────────────
-- Loaded from outputs/bnl_data.json by pipeline/upsert_to_supabase.py.
-- RLS: NO select policy → private (service-role only), same posture as
-- drill_clients. The /dashboard/bnl page reads it server-side behind a PIN
-- gate (replace with Supabase Auth admin policy later).
create table if not exists bnl_clients (
  pid            text primary key,               -- hashed PersonalID
  as_of          date not null,
  name           text,
  age            int,                            -- null when DOB missing
  status         text not null,                  -- 'active' | 'housed' | 'inactive'
  detail         text,
  enrolled       boolean default false,          -- false → project/entry are a FORMER (exited) stay
  project        text,
  ptype          text,
  entry          date,
  last_contact   date,
  days_since_contact int,
  days_homeless  int,                            -- self-reported (3.917), capped
  ep_start       date,                            -- episode start behind days_homeless
  sys_days3      int,                             -- HMIS-observed homeless days, last 3y
  episodes3      int,                             -- occasions, 7+ night breaks (HUD CH Final Rule)
  times3_sr      text,                            -- 3.917.4 self-report: '1'|'2'|'3'|'4+'
  months3_sr     int,                             -- 3.917.5 self-report: 1-12, 13 = more than 12
  dob            date,
  sex            text,                            -- 'F' | 'M'
  race           text,                            -- compact multi-race string
  income         int,                             -- latest TotalMonthlyIncome (4.02)
  income_date    date,
  dv_fleeing     boolean,                         -- currently fleeing DV (4.11)
  dv_survivor    boolean,
  foster         boolean,                         -- former ward child welfare (RHY)
  jj             boolean,                         -- former ward juvenile justice (RHY)
  ref_type       text,                            -- latest CE housing referral (4.20)
  ref_status     text,                            -- accepted | client rejected | provider rejected | pending
  ref_date       date,
  ref_prov       text,                            -- referred-to provider when recorded
  risk_pts       int,                             -- youth prioritization score (partial)
  risk_max       int,
  chronic        boolean default false,           -- HUD CH logic (approx.): disabling + 12mo/4x-12mo
  is_new         boolean default false,          -- newly identified (30d)
  returned       boolean default false,
  veteran        boolean default false,
  family         boolean default false,          -- household includes a child
  hoh            boolean default false,
  parenting      boolean default false,
  unaccompanied  boolean default false,
  assessed       date,                           -- last CE assessment
  in_school      boolean default false,
  dq             jsonb,                          -- text[] of DQ flags
  timeline       jsonb,                          -- last 8 enrollments
  hist3          jsonb,                          -- 3-year history card (see bnl_core.py hist3)
  fm             text,                           -- first-contact month  '2026-05'
  hm             text,                           -- housed-event month
  im             text                            -- became-inactive month
);

create table if not exists bnl_flow (
  month    text primary key,                     -- '2026-05'
  new_n    int default 0,
  housed_n int default 0,
  inactive_n int default 0
);

alter table bnl_clients enable row level security;
alter table bnl_flow  enable row level security;
-- bnl_flow has no PII — public read is fine
drop policy if exists "public read" on bnl_flow;
create policy "public read" on bnl_flow for select using (true);
-- bnl_clients: intentionally NO select policy (private).
