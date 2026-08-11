-- ─────────────────────────────────────────────────────────────────────────────
-- Household view on the BNL (user decision 2026-08-11)
--
--   hh_n        — members in the client's current enrollment's household
--   hh_members  — [{pid, name, age, hoh}] HoH first then oldest-first; feeds
--                 the drawer's household card. PII, same boundary as the rest
--                 of bnl_clients (can_see_bnl RLS).
--   fam_rep     — TRUE for the ONE row that represents the household on the
--                 Family tab: the HoH when recorded, else the oldest member.
--                 The fallback keeps the ~800 no-HoH households (Eva checks)
--                 visible; a bare hoh filter would silently drop them.
--
-- Run in the Supabase SQL editor. Idempotent — safe to re-run.
-- Then reload: generate_bnl.py + upsert --only bnl_clients,meta + prune.
-- ─────────────────────────────────────────────────────────────────────────────
alter table bnl_clients add column if not exists hh_n int;
alter table bnl_clients add column if not exists hh_members jsonb;
alter table bnl_clients add column if not exists fam_rep boolean default true;
