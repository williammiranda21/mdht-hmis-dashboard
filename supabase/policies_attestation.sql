-- Run once (2026-09-09): ANNUAL HMIS POLICIES ATTESTATION — implements the
-- Manual's own End User Agreement requirement (P&P section C: every user must
-- have a signed agreement on file and abide by the Manual) as an in-app
-- checkbox gate at sign-in, renewed every 365 days. County-compliance gap #6.
--
-- The stamp is written ONLY through attest_policies(), which stamps the
-- CALLER's row — a user can never attest for someone else, and the client
-- never updates profiles directly.

alter table profiles add column if not exists policies_attested_at timestamptz;

create or replace function public.attest_policies()
returns timestamptz
language sql security definer set search_path = public
as $$
  update profiles
     set policies_attested_at = now()
   where id = auth.uid()
  returning policies_attested_at;
$$;
revoke all on function public.attest_policies() from public;
grant execute on function public.attest_policies() to authenticated;
