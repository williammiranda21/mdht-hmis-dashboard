-- ── Per-user data-entry quality (error rates by user) ────────────────────────
-- Run ONCE in the Supabase SQL editor. Written by pipeline/recompute_user_dq.py;
-- read by /api/user-dq.
--
-- One row per (period, user, project, metric):
--   metric = 'created'  → n = records this user created that month on this
--                          project (Enrollment/Exit/IncomeBenefits) — the
--                          denominator for error rates
--   metric = 'dq:<el>' / 'eva:<id>' → n = fix-list records attributed to this
--                          user as the CREATOR of the responsible source record
-- Staff name/email are denormalized onto the row so RLS scoping covers them:
-- agency users see exactly the staff visible through their own projects.

create table if not exists user_dq (
  period      text not null,
  user_id     text not null,
  project_id  bigint not null,
  metric      text not null,
  n           int not null,
  user_name   text,
  user_email  text,
  is_import   boolean default false,   -- batch/conversion accounts, filtered in UI
  primary key (period, user_id, project_id, metric)
);
create index if not exists idx_userdq_proj on user_dq (project_id, period);

alter table user_dq enable row level security;

-- Same visibility model as drill_clients: admins see everyone; agency users
-- see users through the lens of projects they are granted.
drop policy if exists "scoped read user dq" on user_dq;
create policy "scoped read user dq" on user_dq
  for select to authenticated
  using (public.is_admin() or public.can_see_project(project_id));
-- No write policies: only the service-role loader writes.

revoke all on user_dq from anon;
