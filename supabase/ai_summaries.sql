-- ── AI case summaries cache (Layer-2 pilot, 2026-08-12) ─────────────────────
-- Run ONCE in the Supabase SQL editor.
--
-- One row per client (hashed pid): the latest AI-generated case summary +
-- extracted next-step proposals, plus an input_hash of the notes/tasks/journey
-- state that produced it. The API route (/api/ai/summary) regenerates ONLY
-- when that hash changes — an unchanged thread is never re-billed.
--
-- De-identification happens in the route BEFORE the Claude API call
-- (lib/ai/deidentify.ts strips names / SSN / phone / email / DOB) — this table
-- stores the RESULT, which refers to "the client" only. It is still RLS-gated
-- exactly like bnl_notes, because the narrative derives from note content.
-- Like bnl_notes, pid has NO foreign key to bnl_clients (the roster is a
-- rebuilt snapshot; a cached summary simply goes stale-invisible if the
-- client leaves the roster and rejoins by pid later).

create table if not exists ai_summaries (
  pid         text primary key,           -- hashed PersonalID (bnl_clients.pid)
  summary     text not null,
  proposals   jsonb not null default '[]'::jsonb,  -- [{body, rationale, source_date}]
  input_hash  text not null,              -- sha256 over note ids + task states + journey
  model       text not null,
  created_by  text,                       -- email snapshot of who clicked Generate
  created_at  timestamptz not null default now()
);

alter table ai_summaries enable row level security;

-- Same gate as the notes the summary derives from. All quals InitPlan-wrapped
-- per the house RLS rule (supabase/rls_initplan.sql) — never a bare helper call.
drop policy if exists "bnl readers read ai" on ai_summaries;
create policy "bnl readers read ai" on ai_summaries
  for select to authenticated using ((select public.can_see_bnl()));

drop policy if exists "bnl readers insert ai" on ai_summaries;
create policy "bnl readers insert ai" on ai_summaries
  for insert to authenticated with check ((select public.can_see_bnl()));

drop policy if exists "bnl readers update ai" on ai_summaries;
create policy "bnl readers update ai" on ai_summaries
  for update to authenticated
  using ((select public.can_see_bnl()))
  with check ((select public.can_see_bnl()));

revoke all on ai_summaries from anon;

-- ── verify ──────────────────────────────────────────────────────────────────
-- select pid, model, created_at, left(summary, 60) from ai_summaries order by created_at desc limit 5;
