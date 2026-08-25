-- Run once (2026-08-25): BNL note-writing scoped PER POPULATION
-- (user directive: an account can write notes in the Youth BNL but not
-- Families, and vice versa).
--
-- profiles.bnl_write_pops holds the population scopes an account may WRITE
-- notes for: any of {all, youth, vet, family, single, senior}. Empty = read
-- only. 'all' = every population (what the old boolean meant). Because
-- populations OVERLAP and notes belong to CLIENTS, the rule is: you may
-- write on a client who belongs to at least one of your scopes — a client
-- in two populations is writable by either scope.
--
-- The predicates below MUST stay in sync with POPS in bnl_core.py and
-- canWriteClient() in lib/bnl-query.ts. One deliberate difference: the
-- Families TAB shows one representative row per household (fam_rep), but
-- family WRITE scope covers every member of a child-including household —
-- a family case manager notes on members, not just the rep.
--
-- Migration: accounts holding the old boolean grant become 'all', then the
-- boolean is retired (set false) so re-runs stay idempotent.

alter table public.profiles
  add column if not exists bnl_write_pops text[] not null default '{}'::text[];

update public.profiles set bnl_write_pops = '{all}'::text[]
where bnl_write = true and bnl_write_pops = '{}'::text[];
update public.profiles set bnl_write = false where bnl_write = true;

create or replace function public.can_write_bnl_note(p_pid text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_admin() or (
    public.is_approved()
    and exists (
      select 1
      from profiles p
      left join bnl_clients b on b.pid = p_pid
      where p.id = auth.uid()
        and p.bnl_access
        and (
          'all' = any(p.bnl_write_pops)
          or (b.pid is not null and (
               ('youth'  = any(p.bnl_write_pops) and b.age >= 18 and b.age < 25)
            or ('vet'    = any(p.bnl_write_pops) and b.veteran)
            or ('family' = any(p.bnl_write_pops) and b.family)
            or ('single' = any(p.bnl_write_pops) and b.age >= 25 and not b.family)
            or ('senior' = any(p.bnl_write_pops) and b.age >= 62)
          ))
        )
    )
  );
$$;
revoke all on function public.can_write_bnl_note(text) from public;
grant execute on function public.can_write_bnl_note(text) to authenticated;

-- Per-row check (inserts are single-row); author stays pinned to the caller.
drop policy if exists "bnl writers add notes" on public.bnl_notes;
create policy "bnl writers add notes" on public.bnl_notes
  for insert to authenticated
  with check (public.can_write_bnl_note(pid) and author_id = auth.uid());
