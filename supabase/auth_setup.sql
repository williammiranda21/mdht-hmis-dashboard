-- ============================================================================
--  Auth model: self-service signup + admin approval.
--
--  Anyone may create an account. A new account lands in `pending` and can see
--  NOTHING — every data policy requires status = 'approved'. The admin then
--  approves the user, assigns which ProjectIDs they may see, and may grant
--  admin. Approval (not signup) is the security boundary.
--
--  Safe to run now: this only ADDS tables/functions/policies. It does NOT touch
--  the existing "public read" policies on the aggregate tables, so the current
--  dashboard keeps working until auth_rls.sql (step 2) is run.
--
--  Run in Supabase → SQL Editor. Idempotent.
-- ============================================================================

-- ── Who each account is, and whether it's been let in ────────────────────────
create table if not exists profiles (
  id           uuid primary key references auth.users on delete cascade,
  email        text,
  display_name text,
  agency       text,                                   -- what they typed at signup
  is_admin     boolean not null default false,
  status       text    not null default 'pending',     -- pending | approved | disabled
  created_at   timestamptz not null default now(),
  approved_at  timestamptz,
  approved_by  uuid references auth.users on delete set null,
  constraint profiles_status_chk check (status in ('pending','approved','disabled'))
);

-- Backfill columns if an earlier version of this file was already run.
alter table profiles add column if not exists agency      text;
alter table profiles add column if not exists status      text not null default 'pending';
alter table profiles add column if not exists approved_at timestamptz;
alter table profiles add column if not exists approved_by uuid references auth.users on delete set null;

-- ── Which ProjectIDs a non-admin approved user may see ───────────────────────
create table if not exists user_projects (
  user_id    uuid   not null references auth.users on delete cascade,
  project_id bigint not null,
  primary key (user_id, project_id)
);
create index if not exists idx_user_projects_user on user_projects (user_id);

-- ── Every new signup automatically gets a PENDING profile ────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, agency, status)
  values (
    new.id,
    new.email,
    coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), split_part(new.email, '@', 1)),
    nullif(new.raw_user_meta_data->>'agency', ''),
    'pending'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Helper functions used by every data policy ───────────────────────────────
-- SECURITY DEFINER so they can read profiles/user_projects without tripping
-- those tables' own RLS (which would recurse). search_path pinned to public.

create or replace function public.is_approved()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select p.status = 'approved' from profiles p where p.id = auth.uid()), false);
$$;

-- Admin implies approved: disabling an account revokes admin power too.
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select p.is_admin and p.status = 'approved' from profiles p where p.id = auth.uid()),
    false);
$$;

create or replace function public.can_see_project(pid bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_admin()
      or (public.is_approved() and exists (
            select 1 from user_projects up
            where up.user_id = auth.uid() and up.project_id = pid));
$$;

revoke all on function public.is_approved()            from public;
revoke all on function public.is_admin()               from public;
revoke all on function public.can_see_project(bigint)  from public;
grant execute on function public.is_approved()           to authenticated;
grant execute on function public.is_admin()              to authenticated;
grant execute on function public.can_see_project(bigint) to authenticated;

-- ── Profile / grant visibility and administration ────────────────────────────
alter table profiles      enable row level security;
alter table user_projects enable row level security;

-- Everyone reads their own profile (needed to render the "pending" screen);
-- admins read everyone (the approval queue).
drop policy if exists "read own profile" on profiles;
drop policy if exists "read profiles" on profiles;
create policy "read profiles" on profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

-- Only admins may change a profile (approve / disable / grant admin).
-- No insert policy: rows are created solely by the signup trigger.
drop policy if exists "admins update profiles" on profiles;
create policy "admins update profiles" on profiles
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Users see their own grants; admins see and manage all of them.
drop policy if exists "read own projects" on user_projects;
drop policy if exists "read project grants" on user_projects;
create policy "read project grants" on user_projects
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "admins manage grants" on user_projects;
create policy "admins manage grants" on user_projects
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ── Client-level (PII) tables: grant read to the right signed-in users ───────
-- Additive: these tables have never had a select policy (service-role only),
-- so this cannot break anything that works today.

-- By-Name List: real names → approved admins only.
drop policy if exists "admins read bnl" on bnl_clients;
create policy "admins read bnl" on bnl_clients
  for select to authenticated using (public.is_admin());

-- Drill-downs: hashed PersonalIDs per project. Agencies get their own projects;
-- project_id 0 marks system-level rows, which stay admin-only.
drop policy if exists "scoped read drill" on drill_clients;
create policy "scoped read drill" on drill_clients
  for select to authenticated
  using (public.is_admin() or (project_id <> 0 and public.can_see_project(project_id)));

-- ============================================================================
--  BOOTSTRAP — run this ONCE, after you sign up, to make yourself the admin.
--  (Nobody can approve anyone until one admin exists.)
--
--    update profiles
--       set is_admin = true, status = 'approved', approved_at = now()
--     where email = 'you@example.com';
-- ============================================================================
