-- ─────────────────────────────────────────────────────────────────────────────
-- Multi-referral support (user 2026-09-18): a client can hold several live
-- housing referrals at once (e.g. RRH move-in-cost assistance + a PSH
-- subsidy provider). The roster row gains:
--   refs       jsonb — ALL live referrals [{type,status,date,prov}], newest
--                      first, one per (type,provider), capped at 3
--   ref_types  text  — pipe-joined type summary ('PSH|RRH') so the roster's
--                      Referral filter matches ANY live referral via ilike
-- The old single-headline ref_* columns stay (sorting + compatibility).
-- RLS unchanged — these are columns on bnl_clients, covered by its policies.
--
-- Run once in the Supabase SQL editor BEFORE the next BNL load. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────
alter table bnl_clients add column if not exists refs jsonb;
alter table bnl_clients add column if not exists ref_types text;
