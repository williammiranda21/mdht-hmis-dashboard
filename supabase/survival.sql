-- ─────────────────────────────────────────────────────────────────────────────
-- Deep Dive Phase 2 — time-to-housing (Kaplan-Meier)
--
-- Run in the Supabase SQL editor, THEN reload:
--     python generate_analytics.py                       (writes outputs/netlify/analytics.json)
--     cd hmis-web && python pipeline/upsert_to_supabase.py --only survival_metrics
--
-- Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per project and one per project TYPE, computed together in
-- generate_analytics.py §3b over the SAME 24-month entry cohort. Keeping both in
-- one table is the point: a project median only means something next to the peer
-- median it is judged against, and two separately-loaded numbers would eventually
-- disagree about which cohort they describe.
create table if not exists survival_metrics (
  -- 'project' | 'type'. ref_id is the ProjectID or the HUD ProjectType.
  scope        text    not null,
  ref_id       int     not null,

  -- 'movein'  = PH project types (PSH/PH-only/PH w-services/RRH); the event is a
  --             recorded MoveInDate — HUD's move-in concept.
  -- 'ph_exit' = ES/TH/SO/Safe Haven; there is no move-in in a shelter, so the
  --             housing event is an exit to a permanent destination.
  event        text    not null,

  project_type int,
  label        text,                  -- project name, or the type label

  n            int     not null,      -- enrollments in the cohort
  n_housed     int     not null,      -- of those, reached the event

  -- Kaplan-Meier quartiles, in days from entry. NULL means "not reached inside
  -- the window" — i.e. fewer than that share were housed. That is a real answer,
  -- not missing data, and must never be rendered as 0 or as the window length.
  median_days  int,
  q1_days      int,
  q3_days      int,

  -- Cumulative share housed by day N (percent). Legible where a median is NULL.
  rate_90      numeric,
  rate_180     numeric,
  rate_365     numeric,

  -- The matched same-type baseline, denormalised onto the project row so a panel
  -- renders from one fetch. NULL on scope='type' rows.
  type_median  int,
  type_rate_180 numeric,
  type_n       int,

  -- [{x: day, y: survival prob 0-1, n: at risk}] every 7 days to 730.
  curve        jsonb   not null default '[]'::jsonb,

  -- Cohort bounds, carried on every row so a stale load is visible in the UI
  -- rather than silently mixing windows.
  window_start date,
  window_end   date,

  primary key (scope, ref_id)
);

create index if not exists survival_scope_idx on survival_metrics (scope);

alter table survival_metrics enable row level security;

-- Aggregate, non-personal, project-dimensioned — so it takes the SAME rule as
-- every other aggregate table: `is_approved()`, not bare `authenticated`.
-- Approval, not signup, is the security boundary on this dashboard (a pending
-- account is authenticated and must still see nothing), and peer comparison
-- across the whole CoC is the feature, so there is no agency scoping here.
-- Policy name matches the loop in auth_rls.sql §1 so a future re-run of that
-- script replaces this one instead of leaving two policies OR'd together.
-- Do NOT add can_see_project() — that was considered and explicitly rejected.
drop policy if exists "public read" on survival_metrics;
drop policy if exists "authenticated read" on survival_metrics;
create policy "authenticated read" on survival_metrics
  for select to authenticated using (public.is_approved());

-- ── verify (after the upsert) ───────────────────────────────────────────────
-- select scope, event, count(*), min(window_start), max(window_end)
-- from survival_metrics group by 1, 2 order by 1, 2;
--
-- Projects whose median was never reached inside the window (expect these to be
-- the ones with low rate_365 — if a project shows median NULL and rate_365 > 50
-- something is wrong with the curve):
-- select label, n, n_housed, median_days, rate_365 from survival_metrics
-- where scope = 'project' and median_days is null order by rate_365 desc;
