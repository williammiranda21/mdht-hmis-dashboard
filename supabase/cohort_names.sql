-- Cohort-only access (2026-09-15, user directive: "access to just a cohort
-- and nothing else"). Run once in the Supabase SQL editor.
--
-- Lets a cohort GRANTEE read the By-Name List rows for THEIR cohorts'
-- members — names stop requiring the full BNL grant, which would have opened
-- the whole roster. Real client names stay behind two-factor: the policy
-- demands an MFA-verified session (aal2), the same bar the BNL holds, so a
-- cohort-only user enrolls TOTP in My account before member names render.
--
-- Permissive policy — ORs with the existing can_see_bnl() policy, so admins
-- and BNL-granted users are untouched. Quals follow the house InitPlan rule
-- (supabase/rls_initplan.sql): every no-arg helper wrapped in (select …);
-- the EXISTS is a correlated index probe, not a per-row function call.

-- The per-row probe filters cohort_members by pid first — give it an index.
create index if not exists cohort_members_pid on cohort_members (pid);

drop policy if exists "cohort members readable" on bnl_clients;
create policy "cohort members readable" on bnl_clients
  for select to authenticated
  using (
    (select public.is_approved())
    and (select coalesce(auth.jwt() ->> 'aal', 'aal1')) = 'aal2'
    and exists (
      select 1
      from cohort_members m
      join cohort_access a on a.cohort_id = m.cohort_id
      where m.pid = bnl_clients.pid
        and a.user_id = (select auth.uid())
    )
  );
