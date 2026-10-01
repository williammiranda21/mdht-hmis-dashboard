-- Run once (2026-10-01): FIELD OUTCOME DISPOSITIONS.
--
-- The field app now requires outreach to say what happened on every outcome
-- ("No bed available", "Declined services", "Not at the location", …; the
-- list lives in lib/helpline-options.ts FIELD_DISPOSITIONS). The label always
-- leads the event's note, so it shows on the board, case window and dispatch
-- sheet with or without this file. This column stores it on its own so it
-- can be counted and reported ("how many contacts ended in no bed available").
--
-- Until this runs the field app saves the note without the column (it
-- retries automatically), so nothing breaks in the deploy-to-SQL gap.

alter table public.helpline_calls add column if not exists disposition text;
create index if not exists idx_hl_calls_disposition on public.helpline_calls (disposition)
  where disposition is not null;
