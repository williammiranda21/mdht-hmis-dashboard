-- ── Announcements grow details, types, and images (run ONCE, after comments.sql)
-- 2026-08-14: the banner's one-liner can carry optional longer "details"
-- (shown behind "read more" and on /dashboard/announcements), a KIND —
-- 'notice' for general business (deadlines, meetings, data issues) or
-- 'update' for dashboard features/changelog — and attached screenshots.
-- Replacing/clearing the banner EXPIRES rows instead of deleting them, so
-- the table is also the browsable announcement history.

alter table announcements add column if not exists details text;
alter table announcements add column if not exists kind text not null default 'notice';
alter table announcements drop constraint if exists announcements_kind_chk;
alter table announcements add constraint announcements_kind_chk
  check (kind in ('notice', 'update'));
alter table announcements drop constraint if exists announcements_details_chk;
alter table announcements add constraint announcements_details_chk
  check (details is null or char_length(details) <= 5000);

-- ── Screenshot storage for release notes ────────────────────────────────────
-- Private bucket (screenshots could accidentally catch real data — never
-- public); read = any approved user via /api/ann-image, write = admins via
-- /api/announcements/upload. Details reference images as "[img]<path>" lines.
-- Any admin manages ANY announcement — the original FOR ALL policy's
-- `created_by = auth.uid()` WITH CHECK made retiring a COLLEAGUE's banner a
-- check violation (caught by the 8/14 write test). Authorship is enforced on
-- INSERT only; update/delete are any-admin.
drop policy if exists "admin write announcements" on announcements;
drop policy if exists "admin insert announcements" on announcements;
create policy "admin insert announcements" on announcements
  for insert to authenticated
  with check ((select public.is_admin()) and created_by = (select auth.uid()));
drop policy if exists "admin update announcements" on announcements;
create policy "admin update announcements" on announcements
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
drop policy if exists "admin delete announcements" on announcements;
create policy "admin delete announcements" on announcements
  for delete to authenticated
  using ((select public.is_admin()));

insert into storage.buckets (id, name, public)
values ('announcements', 'announcements', false)
on conflict (id) do nothing;

drop policy if exists "approved read ann images" on storage.objects;
create policy "approved read ann images" on storage.objects
  for select to authenticated
  using (bucket_id = 'announcements' and (select public.is_approved()));

drop policy if exists "admin write ann images" on storage.objects;
create policy "admin write ann images" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'announcements' and (select public.is_admin()));

drop policy if exists "admin delete ann images" on storage.objects;
create policy "admin delete ann images" on storage.objects
  for delete to authenticated
  using (bucket_id = 'announcements' and (select public.is_admin()));
