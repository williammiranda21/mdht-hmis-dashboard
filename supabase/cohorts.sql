-- ── Client cohorts — admin-curated tracked groups ────────────────────────────
-- Run ONCE in the Supabase SQL editor. Admin-only end to end (user decision
-- 2026-08-04): creation, membership and viewing all require is_admin().
--
-- Membership is STATIC by design — clients stay in a cohort after they are
-- housed or go inactive; the whole point is following a fixed group through
-- time. Metrics are computed LIVE from bnl_clients at view time;
-- cohort_snapshots (written by pipeline/snapshot_cohorts.py each refresh)
-- preserves the trend ("% housed since creation") that the regenerated
-- roster cannot.

create table if not exists cohorts (
  id          bigint generated always as identity primary key,
  name        text not null,
  description text,
  created_by  text,
  created_at  timestamptz default now()
);

create table if not exists cohort_members (
  cohort_id bigint not null references cohorts(id) on delete cascade,
  pid       text not null,                        -- hashed PersonalID (bnl_clients.pid)
  added_by  text,
  added_at  timestamptz default now(),
  primary key (cohort_id, pid)
);

create table if not exists cohort_snapshots (
  cohort_id   bigint not null references cohorts(id) on delete cascade,
  captured_on date not null,
  counts      jsonb not null,                     -- {n, active, housed, inactive, housed_pct, returned}
  primary key (cohort_id, captured_on)
);

alter table cohorts          enable row level security;
alter table cohort_members   enable row level security;
alter table cohort_snapshots enable row level security;

do $$
declare t text;
begin
  foreach t in array array['cohorts', 'cohort_members', 'cohort_snapshots'] loop
    execute format('drop policy if exists "admins all" on %I;', t);
    execute format(
      'create policy "admins all" on %I for all to authenticated '
      'using (public.is_admin()) with check (public.is_admin());', t);
  end loop;
end $$;

revoke all on cohorts, cohort_members, cohort_snapshots from anon;
