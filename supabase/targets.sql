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

-- project_targets shipped with RLS never enabled — the admin gate lived only in
-- /api/targets, so any REST caller with the anon key could write targets
-- directly. Close both tables: approved users read, admins write. Policy names
-- and predicates match the house style (auth_rls.sql §1, auth_setup.sql).
alter table project_targets enable row level security;
alter table type_targets    enable row level security;

do $$
declare t text;
begin
  foreach t in array array['project_targets', 'type_targets'] loop
    execute format('drop policy if exists "public read" on %I;', t);
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
