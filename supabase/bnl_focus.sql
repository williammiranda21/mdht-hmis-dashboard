-- ─────────────────────────────────────────────────────────────────────────────
-- BNL focus list (user request 2026-08-11): highlight clients to concentrate
-- on in current / future case-conferencing meetings.
--
-- Like bnl_notes, this table deliberately has NO foreign key to bnl_clients:
-- the roster is a rebuilt snapshot (prune deletes departed clients) and a
-- focus mark must survive a rebuild; if the client returns, the mark rejoins
-- by pid. Gated by exactly the BNL rule (can_see_bnl), InitPlan-wrapped per
-- the house RLS rule. Toggle = insert/delete; no updates.
--
-- Run in the Supabase SQL editor. Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists bnl_focus (
  pid     text primary key,
  set_by  text,                                -- email snapshot at set time
  set_at  timestamptz not null default now()
);

alter table bnl_focus enable row level security;

drop policy if exists "bnl readers read focus" on bnl_focus;
create policy "bnl readers read focus" on bnl_focus
  for select to authenticated using ((select public.can_see_bnl()));

drop policy if exists "bnl readers set focus" on bnl_focus;
create policy "bnl readers set focus" on bnl_focus
  for insert to authenticated with check ((select public.can_see_bnl()));

drop policy if exists "bnl readers clear focus" on bnl_focus;
create policy "bnl readers clear focus" on bnl_focus
  for delete to authenticated using ((select public.can_see_bnl()));

revoke all on bnl_focus from anon;
grant select, insert, delete on bnl_focus to authenticated;
