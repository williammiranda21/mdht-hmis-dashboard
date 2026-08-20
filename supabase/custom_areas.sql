-- Run once (2026-08-20): admin-drawn custom areas for helpline routing.
--
-- The PIT-app pattern the user asked for: draw a polygon on the call map,
-- name it, and it becomes a routable area. The intake pin checks these
-- FIRST (a deliberately drawn zone beats district/municipality), the Teams
-- editor offers the names as coverage chips, and the call map renders them
-- as a layer. Drawing a polygon named exactly like an existing zone label
-- (e.g. 'Government Center') gives that label a live boundary.
--
-- polygon = GeoJSON geometry {type:'Polygon', coordinates:[[[lng,lat],…]]},
-- WGS84, first ring only (holes aren't drawn or evaluated).
create table if not exists public.custom_areas (
  id         bigint generated always as identity primary key,
  name       text not null unique,
  polygon    jsonb not null,
  active     boolean not null default true,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now()
);

alter table public.custom_areas enable row level security;
drop policy if exists "custom areas read" on public.custom_areas;
drop policy if exists "custom areas insert admin" on public.custom_areas;
drop policy if exists "custom areas update admin" on public.custom_areas;
drop policy if exists "custom areas delete admin" on public.custom_areas;

create policy "custom areas read" on public.custom_areas
  for select to authenticated
  using ((select public.can_see_helpline()));

create policy "custom areas insert admin" on public.custom_areas
  for insert to authenticated
  with check ((select public.is_admin()));

create policy "custom areas update admin" on public.custom_areas
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "custom areas delete admin" on public.custom_areas
  for delete to authenticated
  using ((select public.is_admin()));
