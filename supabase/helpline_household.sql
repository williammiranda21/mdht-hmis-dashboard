-- Run once in the Supabase SQL editor.
-- Household-size follow-up on call intake (2026-09-22): when the operator
-- picks household "With children", the form asks how many people are in the
-- household. Everything degrades gracefully until this runs — the form
-- detects the missing column and folds the size into the case notes instead.
alter table public.helpline_cases add column if not exists household_size int;
