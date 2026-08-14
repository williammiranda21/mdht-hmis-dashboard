-- ── Record-anchored communication (user directive 2026-08-14) ────────────────
-- Run ONCE in the Supabase SQL editor.
--
-- dq_comments: threaded notes on a project's fix-list CATEGORY (project +
-- element metric) — the "we re-entered the source record / confirmed, waiting
-- on Friday's refresh" loop between agencies and the Homeless Trust. Anchored
-- to records, deliberately NOT free-form DMs (Teams owns conversation;
-- anchored notes are auditable and PII-scoped by construction).
--
-- announcements: one-line admin broadcasts shown as a banner on every
-- dashboard page ("data refreshed through 8/12", "DQ cleanup due Friday").

create table if not exists dq_comments (
  id          bigint generated always as identity primary key,
  project_id  bigint not null,
  metric      text not null,                -- 'dq:<el>' | 'eva:<id>'
  author      uuid not null references auth.users (id),
  author_name text not null,                -- denormalized at write time:
                                            -- profiles are self-read-only, so
                                            -- readers can't join for names
  is_admin    boolean not null default false, -- badge the Homeless Trust side
  body        text not null,
  created_at  timestamptz not null default now(),
  constraint dq_comments_body_chk check (char_length(body) between 1 and 2000)
);
create index if not exists dq_comments_proj on dq_comments (project_id, metric, created_at);

alter table dq_comments enable row level security;

-- Same visibility as the fix-lists themselves: admins everything, agencies
-- their projects. InitPlan rule: no-arg helpers wrapped in (select ...).
drop policy if exists "scoped read dq comments" on dq_comments;
create policy "scoped read dq comments" on dq_comments
  for select to authenticated
  using ((select public.is_admin()) or public.can_see_project(project_id));

drop policy if exists "scoped write dq comments" on dq_comments;
create policy "scoped write dq comments" on dq_comments
  for insert to authenticated
  with check (
    (select public.is_approved())
    and author = (select auth.uid())
    and ((select public.is_admin()) or public.can_see_project(project_id))
  );

-- Authors may delete their own comment; admins any (moderation).
drop policy if exists "delete own dq comments" on dq_comments;
create policy "delete own dq comments" on dq_comments
  for delete to authenticated
  using (author = (select auth.uid()) or (select public.is_admin()));

create table if not exists announcements (
  id         bigint generated always as identity primary key,
  body       text not null,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  expires_on date,                          -- null = until replaced/deleted
  constraint announcements_body_chk check (char_length(body) between 1 and 300)
);

alter table announcements enable row level security;

drop policy if exists "approved read announcements" on announcements;
create policy "approved read announcements" on announcements
  for select to authenticated
  using ((select public.is_approved()));

drop policy if exists "admin write announcements" on announcements;
create policy "admin write announcements" on announcements
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()) and created_by = (select auth.uid()));

revoke all on dq_comments   from anon;
revoke all on announcements from anon;
