-- Run once (2026-08-20): admin-tunable call prioritization.
--
-- helpline_priority: ONE row (id=1) of policy knobs. Empty jsonb fields fall
-- back to the code defaults, which reproduce the original hard-coded scoring
-- exactly — running this file changes nothing until an admin edits a value.
--   weights   {factors:{'Fleeing DV':3,…}, household:{'With children':2},
--              sleeping:{'Street / outside':2,'Car':2}, repeat_call:0}
--   bands     {high:5, med:2}
--   aging     {pts:1, hours:24, cap:4}  — +1 pt per waiting DAY, max +4
--              (user directive 2026-08-20: per day, not per hours)
--   sla_hours int, null = off — queue rows over this age get the breach flag
--   emergency {active,label,pts} — event mode (heat advisory): +pts to
--              callers sleeping outside or in a car, banner shown while on
--
-- helpline_priority_log: who changed what, when — priorities drive real
-- dispatch decisions, the history answers "why was this MED last Tuesday".
--
-- helpline_cases.pinned: admin pin-to-top (reason goes to the case log;
-- assignment auto-unpins).

create table if not exists public.helpline_priority (
  id         int primary key default 1 check (id = 1),
  weights    jsonb not null default '{}'::jsonb,
  bands      jsonb not null default '{}'::jsonb,
  aging      jsonb not null default '{}'::jsonb,
  sla_hours  int default 24,
  emergency  jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.helpline_priority (id) values (1) on conflict (id) do nothing;

create table if not exists public.helpline_priority_log (
  id         bigint generated always as identity primary key,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  change     text not null
);

alter table public.helpline_cases add column if not exists pinned boolean not null default false;

-- HMIS-informed boost (user pick 2026-08-20): open cases whose confirmed
-- HMIS match is CHRONIC on the By-Name List get extra points. SECURITY
-- DEFINER so helpline staff WITHOUT BNL access still get the boost — the
-- function leaks nothing but {case_id, chronic}; the helpline gate applies.
create or replace function public.helpline_hmis_flags()
returns table (case_id bigint, chronic boolean)
language sql security definer set search_path = public as $$
  select hc.id, coalesce(b.chronic, false)
  from helpline_cases hc
  join bnl_clients b on b.pid = hc.matched_pid
  where hc.matched_pid is not null
    and hc.status in ('new','assigned','attempted','contacted','confirmed')
    and (select public.can_see_helpline());
$$;
revoke all on function public.helpline_hmis_flags() from public;
grant execute on function public.helpline_hmis_flags() to authenticated;

alter table public.helpline_priority enable row level security;
drop policy if exists "priority rules read" on public.helpline_priority;
drop policy if exists "priority rules write admin" on public.helpline_priority;
create policy "priority rules read" on public.helpline_priority
  for select to authenticated using ((select public.can_see_helpline()));
create policy "priority rules write admin" on public.helpline_priority
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

alter table public.helpline_priority_log enable row level security;
drop policy if exists "priority log read admin" on public.helpline_priority_log;
drop policy if exists "priority log insert admin" on public.helpline_priority_log;
create policy "priority log read admin" on public.helpline_priority_log
  for select to authenticated using ((select public.is_admin()));
create policy "priority log insert admin" on public.helpline_priority_log
  for insert to authenticated with check ((select public.is_admin()));
-- no update/delete: the change history is immutable
