-- ─────────────────────────────────────────────────────────────────────────────
-- BNL client notes + a per-user BNL access grant
--
-- Run this in the Supabase SQL editor. Safe to re-run (idempotent).
--
-- Two things happen here:
--   1. `profiles.bnl_access` — a per-user switch so an approved NON-admin can be
--      granted By-Name List access without making them an admin.
--   2. `bnl_notes` — append-only notes on a client, stamped with author + time.
--
-- Notes are gated by exactly the same rule as the BNL itself (`can_see_bnl()`),
-- so a note can never be read by someone who cannot open the client record it
-- describes. Notes contain client-identifying context — treat them as PII.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1 ── per-user BNL grant ────────────────────────────────────────────────────
alter table profiles add column if not exists bnl_access boolean not null default false;

-- Who may see the By-Name List: any approved admin, or an approved user who has
-- been granted bnl_access. Admin implies approved (see is_admin), and disabling
-- an account revokes both paths.
create or replace function public.can_see_bnl()
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_admin()
      or (public.is_approved() and coalesce(
            (select p.bnl_access from profiles p where p.id = auth.uid()), false));
$$;

revoke all on function public.can_see_bnl() from public;
grant execute on function public.can_see_bnl() to authenticated;

-- Widen the roster policy from admins-only to the same gate.
drop policy if exists "admins read bnl" on bnl_clients;
drop policy if exists "bnl readers read roster" on bnl_clients;
create policy "bnl readers read roster" on bnl_clients
  for select to authenticated using (public.can_see_bnl());

-- 2 ── notes ────────────────────────────────────────────────────────────────
-- NOTE: `pid` deliberately has NO foreign key to bnl_clients. The roster is a
-- rebuilt snapshot — prune_stale_bnl.py DELETEs clients who age out of the
-- 24-month window, and an ON DELETE CASCADE would silently destroy their case
-- notes. Notes must outlive the roster; if a client returns, notes rejoin by pid.
-- author_name / author_email are SNAPSHOTS taken when the note is written, not
-- joins to profiles. Two reasons: the note is a permanent record of who wrote it
-- at the time, and — decisively — the "read profiles" policy only lets a user
-- read their OWN profile unless they are an admin, so a non-admin with
-- bnl_access could not resolve the name of anyone else's note.
create table if not exists bnl_notes (
  id           bigint generated always as identity primary key,
  pid          text        not null,
  body         text        not null,
  author_id    uuid        not null references auth.users on delete set null,
  author_name  text,                                   -- display name at write time
  author_email text,                                   -- fallback if no display name
  created_at   timestamptz not null default now(),
  constraint bnl_notes_body_not_blank check (length(btrim(body)) > 0)
);

-- for databases created before author_name existed
alter table bnl_notes add column if not exists author_name text;

create index if not exists bnl_notes_pid_idx on bnl_notes (pid, created_at desc);

alter table bnl_notes enable row level security;

drop policy if exists "bnl readers read notes" on bnl_notes;
create policy "bnl readers read notes" on bnl_notes
  for select to authenticated using (public.can_see_bnl());

-- Author is pinned to the caller so a note can never be attributed to someone
-- else, even if the client sends a different author_id.
drop policy if exists "bnl readers add notes" on bnl_notes;
create policy "bnl readers add notes" on bnl_notes
  for insert to authenticated
  with check (public.can_see_bnl() and author_id = auth.uid());

-- APPEND-ONLY BY OMISSION: there is deliberately no UPDATE and no DELETE policy.
-- With RLS enabled and no such policy, every update/delete is denied — including
-- by the author. Corrections are made by adding a new note. Do not add an UPDATE
-- or DELETE policy without deciding you want case notes to become mutable.

-- ── verify ──────────────────────────────────────────────────────────────────
-- select public.can_see_bnl();
-- select id, pid, author_email, created_at, left(body, 40) from bnl_notes order by created_at desc limit 5;
