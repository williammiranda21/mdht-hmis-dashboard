-- Run once (2026-09-09): ACCESS LOG — county-compliance gap #2 (audit trails
-- for READS). Records who viewed or exported person-level data, when, and
-- what. Writes were already attributable (notes/marks pin authorship); this
-- closes the read side so "who viewed this client's record in July?" has an
-- answer.
--
-- Append-only by construction:
--   • inserts happen SERVER-SIDE ONLY via the service role (no insert policy
--     is granted to authenticated, so a browser session cannot forge rows);
--   • there is deliberately NO update and NO delete policy — with RLS on,
--     that denies both to everyone below the service role;
--   • only admins may read it.
--
-- Actions logged (v1): bnl_view (roster page render), bnl_drawer (client
-- drawer opened — carries the pid), bnl_export (roster CSV, carries the
-- filters), fixlist_view / fixlist_export (DQ fix-list per project+period).

create table if not exists access_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  user_id    uuid,
  user_email text,
  action     text not null,
  detail     jsonb,
  constraint access_log_action_chk check (char_length(action) between 1 and 40)
);

create index if not exists access_log_at_idx   on access_log (at desc);
create index if not exists access_log_user_idx on access_log (user_id, at desc);
create index if not exists access_log_action_idx on access_log (action, at desc);

alter table access_log enable row level security;

drop policy if exists "admins read access log" on access_log;
create policy "admins read access log" on access_log
  for select to authenticated using ((select public.is_admin()));

revoke all on access_log from anon;
