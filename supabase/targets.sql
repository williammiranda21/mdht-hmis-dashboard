-- ── Targets: type-level defaults + RLS for both target tables ────────────────
-- Run ONCE in the Supabase SQL editor (same drill as survival.sql). Until it
-- runs: type-level target saves fail ("relation type_targets does not exist")
-- and the admin Targets page shows a setup notice; project-level targets keep
-- working exactly as before.

-- Type-level default targets — apply to EVERY project of the type unless a
-- project_targets row overrides that metric for a specific project. Metric
-- keys and 0-100 / 0-3650 ranges match lib/target-metrics.ts.
create table if not exists type_targets (
  project_type int  not null,                    -- projects.project_type code
  metric       text not null,                    -- same keys as project_targets
  target       numeric not null,
  updated_by   text,
  updated_at   timestamptz default now(),
  primary key (project_type, metric)
);

-- project_targets already has RLS from the hand-run setup SQL (2026-07-30):
-- "read targets" (select using true — open to anon + unapproved) and
-- "admin write targets" (is_admin). Writes were fine; the read policy is looser
-- than the house standard. This block CONVERGES both tables to the standard:
-- approved users read, admins write — dropping the old policy names so the
-- open read doesn't survive alongside (policies OR together). Idempotent.
alter table project_targets enable row level security;
alter table type_targets    enable row level security;

do $$
declare t text;
begin
  foreach t in array array['project_targets', 'type_targets'] loop
    execute format('drop policy if exists "public read" on %I;', t);
    execute format('drop policy if exists "read targets" on %I;', t);
    execute format('drop policy if exists "admin write targets" on %I;', t);
    execute format('drop policy if exists "authenticated read" on %I;', t);
    execute format(
      'create policy "authenticated read" on %I for select to authenticated '
      'using (public.is_approved());', t);
    execute format('drop policy if exists "admins manage targets" on %I;', t);
    execute format(
      'create policy "admins manage targets" on %I for all to authenticated '
      'using (public.is_admin()) with check (public.is_admin());', t);
  end loop;
end $$;

-- Belt and braces, mirroring auth_rls.sql §3: anon gets nothing even if a loose
-- policy reappears.
revoke all on project_targets, type_targets from anon;
