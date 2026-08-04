-- ── DQ "as captured" snapshots — the fixed-since-refresh ledger ──────────────
-- Run ONCE in the Supabase SQL editor. Written by pipeline/snapshot_dq.py at
-- the END of every refresh; read by /api/digest.
--
-- WHY: dashboard months are recomputed from the current export on every
-- refresh, so a retroactive fix quietly rewrites history — it EVAPORATES from
-- the month-vs-month digest instead of showing as repaired work. Freezing each
-- refresh's fix-lists lets the digest diff "the list as captured last refresh"
-- against "the same month as it stands now": every disappearance from that
-- diff IS a data fix (the month is complete, so its universe cannot change).

create table if not exists dq_snapshots (
  captured_on  date not null,               -- refresh date the capture ran
  period       text not null,               -- the complete month it describes
  project_id   bigint not null,
  metric       text not null,               -- 'dq:<el>' | 'eva:<id>' | 'score'
  personal_ids text[],                      -- offending clients (null for score)
  score        numeric,                     -- DQ_Score (metric='score' only)
  primary key (captured_on, period, project_id, metric)
);

alter table dq_snapshots enable row level security;

-- Same visibility as drill_clients: admins everything, agencies their projects.
drop policy if exists "scoped read snapshots" on dq_snapshots;
create policy "scoped read snapshots" on dq_snapshots
  for select to authenticated
  using (public.is_admin() or public.can_see_project(project_id));
-- No insert/update/delete policies: only the service-role loader writes.

revoke all on dq_snapshots from anon;
