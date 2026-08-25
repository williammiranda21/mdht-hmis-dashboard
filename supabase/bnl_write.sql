-- Run once (2026-08-25): account-level control over WRITING BNL notes
-- (user directive: every BNL population, one switch per account).
--
-- Until now anyone who could SEE the By-Name List could write notes. With
-- quick notes making writing one click, read and write become separate
-- grants: profiles.bnl_write, admin-toggled in Users. Admins always write.
-- EXISTING BNL users are grandfathered (write = true) so nothing breaks at
-- deploy — revoke individually for read-only accounts.

alter table public.profiles add column if not exists bnl_write boolean not null default false;

update public.profiles set bnl_write = true
where bnl_write = false and (bnl_access = true or is_admin = true);

create or replace function public.can_write_bnl_notes()
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_admin()
      or (public.is_approved() and coalesce(
            (select p.bnl_access and p.bnl_write
               from profiles p where p.id = auth.uid()), false));
$$;
revoke all on function public.can_write_bnl_notes() from public;
grant execute on function public.can_write_bnl_notes() to authenticated;

-- The INSERT policy is the real boundary (the UI hiding composers is
-- courtesy). Author stays pinned to the caller. InitPlan-wrapped per house
-- rule. Read policy unchanged: seeing notes still rides can_see_bnl().
drop policy if exists "bnl readers add notes" on public.bnl_notes;
drop policy if exists "bnl writers add notes" on public.bnl_notes;
create policy "bnl writers add notes" on public.bnl_notes
  for insert to authenticated
  with check ((select public.can_write_bnl_notes()) and author_id = auth.uid());
