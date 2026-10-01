-- Run once (2026-10-01): HELPLINE DUPLICATE MERGE.
--
-- Repeat calls had created several OPEN cases for one person (e.g. #28, #29,
-- #34 — same name + DOB, three teams). A helpline admin can now merge them
-- from the call form: the most-advanced case survives; the others are set to
-- status 'closed' with merged_into = the survivor. Nothing is deleted and no
-- call log row moves (helpline_calls stays immutable) — the survivor's case
-- window reads its own log plus the merged cases' logs.
--
-- Merged cases drop out of the board, queues and case counts (page filters
-- merged_into); their phone calls still count toward call volume.
-- Until this runs the dashboard treats every case as unmerged and the merge
-- button explains that this file needs to run.

alter table public.helpline_cases
  add column if not exists merged_into bigint references public.helpline_cases on delete set null;
create index if not exists idx_hl_cases_merged_into on public.helpline_cases (merged_into)
  where merged_into is not null;
