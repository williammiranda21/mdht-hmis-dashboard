-- Run once (2026-09-09): BNL NOTE EDITING — a per-account grant (user
-- directive: default is NO edit capability unless assigned; a case manager
-- fixing her own typos was the driving need).
--
-- The compliance property notes were built on — a permanent, auditable
-- record — is preserved three ways:
--   • only the note's AUTHOR may edit it, and only with the grant;
--   • every edit stores the previous text in bnl_note_edits (append-only,
--     admin-readable), written by a SECURITY DEFINER trigger the client
--     cannot skip;
--   • only the body may change — pid, author, and created_at are frozen by
--     the same trigger. Deletion remains impossible for everyone.

alter table profiles  add column if not exists bnl_note_edit boolean not null default false;
alter table bnl_notes add column if not exists edited_at timestamptz;

-- May this caller edit their own BNL notes? Admins always; otherwise the
-- explicit grant on top of BNL access.
create or replace function public.can_edit_bnl_notes()
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_admin() or (public.is_approved() and coalesce(
    (select p.bnl_access and p.bnl_note_edit from profiles p where p.id = auth.uid()),
    false));
$$;
revoke all on function public.can_edit_bnl_notes() from public;
grant execute on function public.can_edit_bnl_notes() to authenticated;

-- Edit history: one row per change, holding the text it replaced.
create table if not exists bnl_note_edits (
  id        bigint generated always as identity primary key,
  note_id   bigint not null references bnl_notes (id) on delete cascade,
  old_body  text not null,
  edited_by uuid,
  edited_at timestamptz not null default now()
);
create index if not exists bnl_note_edits_note_idx on bnl_note_edits (note_id, edited_at desc);
alter table bnl_note_edits enable row level security;
-- Admins may read the history; nobody below the service role can write it
-- directly (no insert policy — the trigger below is the only writer) and
-- nothing can update or delete it (no such policies).
drop policy if exists "admins read note edit history" on bnl_note_edits;
create policy "admins read note edit history" on bnl_note_edits
  for select to authenticated using ((select public.is_admin()));
revoke all on table bnl_note_edits from anon;

-- Guard trigger: freeze everything but the body, and archive the old text.
create or replace function public.bnl_note_edit_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.pid          is distinct from old.pid
     or new.author_id    is distinct from old.author_id
     or new.author_name  is distinct from old.author_name
     or new.author_email is distinct from old.author_email
     or new.created_at   is distinct from old.created_at then
    raise exception 'only the note body may be edited';
  end if;
  if new.body is distinct from old.body then
    insert into bnl_note_edits (note_id, old_body, edited_by)
    values (old.id, old.body, auth.uid());
    new.edited_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists bnl_note_edit_guard on bnl_notes;
create trigger bnl_note_edit_guard
  before update on bnl_notes
  for each row execute function public.bnl_note_edit_guard();

-- The one UPDATE path: the author, holding the grant. RLS InitPlan rule:
-- the no-arg helper is wrapped in (select …).
drop policy if exists "granted authors edit own notes" on bnl_notes;
create policy "granted authors edit own notes" on bnl_notes
  for update to authenticated
  using (author_id = (select auth.uid()) and (select public.can_edit_bnl_notes()))
  with check (author_id = (select auth.uid()) and (select public.can_edit_bnl_notes()));
