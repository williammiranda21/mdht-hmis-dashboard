-- Run once (2026-10-01): BNL FAMILY STATUS — the family housing-search stage
-- set from a dropdown on the By-Name List's Family tab, and filterable there.
--
-- Model: ONE current status per client (the family's roster row — the
-- fam_rep pid), last write wins, in a side table keyed by pid so ETL
-- refreshes never wipe it. Every change (set / change / clear) is copied by
-- trigger into bnl_family_status_log, which nobody can edit or delete — the
-- team can always see who moved a family to which stage, and when.
--
-- The status keys MUST match FAMILY_STATUSES in lib/family-status.ts.
--
-- Permissions mirror BNL notes and cell marks exactly: read = can_see_bnl();
-- write = the population-scoped note-writing grant can_write_bnl_note(pid)
-- (bnl_write_pops.sql), so Family-scope writers (and 'all') can set it.
-- Author is pinned to the caller. No-arg helpers are wrapped in (select …)
-- per the InitPlan rule (rls_initplan.sql).

create table if not exists public.bnl_family_status (
  pid         text primary key,
  status      text not null check (status in (
    'pending_employment', 'needs_income', 'pending_income_verif',
    'rrh_pending_submittal', 'rrh_submitted_incomplete', 'rrh_complete',
    'seeking_unit', 'unit_identified', 'll_docs_received',
    'inspection_pending', 'inspection_complete', 'cash_request_submitted',
    'non_compliant', 'search_on_hold_funds', 'pending_move_out')),
  author_id   uuid not null,
  author_name text,
  updated_at  timestamptz not null default now()
);
create index if not exists bnl_family_status_status_idx on public.bnl_family_status (status);

create table if not exists public.bnl_family_status_log (
  id          bigint generated always as identity primary key,
  pid         text not null,
  old_status  text,
  new_status  text,               -- null = cleared
  author_id   uuid,
  author_name text,
  at          timestamptz not null default now()
);
create index if not exists bnl_family_status_log_pid_idx on public.bnl_family_status_log (pid, at desc);

-- History trigger: SECURITY DEFINER so it can write the log even though the
-- log grants no INSERT to users (they must not be able to forge history).
create or replace function public.bnl_family_status_audit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    insert into bnl_family_status_log (pid, old_status, new_status, author_id, author_name)
    values (old.pid, old.status, null, auth.uid(),
            (select coalesce(p.display_name, p.email) from profiles p where p.id = auth.uid()));
    return old;
  end if;
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;
  insert into bnl_family_status_log (pid, old_status, new_status, author_id, author_name)
  values (new.pid, case when tg_op = 'UPDATE' then old.status end, new.status,
          new.author_id, new.author_name);
  return new;
end $$;

drop trigger if exists bnl_family_status_audit_trg on public.bnl_family_status;
create trigger bnl_family_status_audit_trg
  after insert or update or delete on public.bnl_family_status
  for each row execute function public.bnl_family_status_audit();

alter table public.bnl_family_status enable row level security;
alter table public.bnl_family_status_log enable row level security;

drop policy if exists "bnl readers read family status" on public.bnl_family_status;
create policy "bnl readers read family status" on public.bnl_family_status
  for select to authenticated
  using ((select public.can_see_bnl()));

drop policy if exists "bnl writers set family status" on public.bnl_family_status;
create policy "bnl writers set family status" on public.bnl_family_status
  for insert to authenticated
  with check (public.can_write_bnl_note(pid) and author_id = auth.uid());

-- Upsert = INSERT ... ON CONFLICT DO UPDATE, so UPDATE needs its own policy.
drop policy if exists "bnl writers change family status" on public.bnl_family_status;
create policy "bnl writers change family status" on public.bnl_family_status
  for update to authenticated
  using (public.can_write_bnl_note(pid))
  with check (public.can_write_bnl_note(pid) and author_id = auth.uid());

drop policy if exists "bnl writers clear family status" on public.bnl_family_status;
create policy "bnl writers clear family status" on public.bnl_family_status
  for delete to authenticated
  using (public.can_write_bnl_note(pid));

-- History: readable by BNL readers; no insert/update/delete policies at all
-- (only the definer trigger writes it).
drop policy if exists "bnl readers read family status log" on public.bnl_family_status_log;
create policy "bnl readers read family status log" on public.bnl_family_status_log
  for select to authenticated
  using ((select public.can_see_bnl()));
