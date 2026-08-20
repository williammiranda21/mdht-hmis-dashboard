-- Run once (2026-08-20): external referral tracking — implements the
-- "Specialized Referral Procedures" + "Areas Assigned to Other Outreach
-- Providers" sections of the SOP (Call Handling, Referral, and Outreach
-- Dispatch Procedures, 08.2026).
--
-- (1) helpline_cases gains referred_to + status 'referred_out': a call
--     resolved by pointing the caller to the right door, kept as a tracked
--     case (KPIs / filters / reporting count them).
-- (2) helpline_resources: the refer-out picker + the operator SCRIPT CARD —
--     exactly what the call taker reads to the caller. Admin-edited; seeded
--     from the SOP below. TBD phones stay TBD until the City fills them in.

alter table public.helpline_cases add column if not exists referred_to text;
alter table public.helpline_cases drop constraint if exists helpline_cases_status_check;
alter table public.helpline_cases add constraint helpline_cases_status_check
  check (status in ('new','assigned','attempted','contacted','confirmed',
                    'declined','no_locate','closed','referred_out'));

create table if not exists public.helpline_resources (
  id           bigint generated always as identity primary key,
  name         text not null unique,
  phone        text,
  instructions text not null,
  active       boolean not null default true,
  sort         int not null default 100
);

alter table public.helpline_resources enable row level security;
drop policy if exists "helpline resources read" on public.helpline_resources;
drop policy if exists "helpline resources write admin" on public.helpline_resources;
create policy "helpline resources read" on public.helpline_resources
  for select to authenticated
  using ((select public.can_see_helpline()));
create policy "helpline resources write admin" on public.helpline_resources
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- Seeds = the SOP scripts, verbatim procedure. Idempotent by name.
insert into public.helpline_resources (name, phone, instructions, sort)
select v.name, v.phone, v.instructions, v.sort from (values
  ('Homeless Prevention (At Risk of Homelessness)', '1-877-994-HELP (4357)',
   'Caller is housed but at risk of losing their housing.' || chr(10) ||
   'Give the Miami-Dade County Homeless Helpline number: 1-877-994-HELP (4357).' || chr(10) ||
   'Language: Press 1 English - 2 Spanish - 3 Creole.' || chr(10) ||
   'Then select OPTION 1 - At Risk of Homelessness.' || chr(10) ||
   'Document that the homelessness-prevention referral information was provided.', 10),
  ('Domestic Violence / Human Trafficking', '1-877-994-HELP (4357)',
   'Caller reports domestic violence or human trafficking.' || chr(10) ||
   'Give the Miami-Dade County Homeless Helpline number: 1-877-994-HELP (4357).' || chr(10) ||
   'Language: Press 1 English - 2 Spanish - 3 Creole.' || chr(10) ||
   'Then select OPTION 2 - Domestic Violence or Human Trafficking.' || chr(10) ||
   'Document that the DV/Human Trafficking referral information was provided.', 20),
  ('Veterans (at risk or experiencing homelessness)', '1-877-994-HELP (4357)',
   'Caller is a veteran at risk of or experiencing homelessness.' || chr(10) ||
   'Give the Miami-Dade County Homeless Helpline number: 1-877-994-HELP (4357).' || chr(10) ||
   'Language: Press 1 English - 2 Spanish - 3 Creole.' || chr(10) ||
   'Then select OPTION 3 - Veterans.' || chr(10) ||
   'Document that the Veteran Services referral information was provided.', 30),
  ('Youth Ages 18-24', '1-877-994-HELP (4357)',
   'Person needing assistance is between 18 and 24.' || chr(10) ||
   'Give the Miami-Dade County Homeless Helpline number: 1-877-994-HELP (4357).' || chr(10) ||
   'Language: Press 1 English - 2 Spanish - 3 Creole.' || chr(10) ||
   'Then select OPTION 4 - Youth Services.' || chr(10) ||
   'Document that the Youth Services referral information was provided.', 40),
  ('Miami Beach Outreach (county helpline Option 5)', '1-877-994-HELP (4357)',
   'Person is experiencing homelessness in the City of Miami Beach.' || chr(10) ||
   'Give the Miami-Dade County Homeless Helpline number: 1-877-994-HELP (4357).' || chr(10) ||
   'Language: Press 1 English - 2 Spanish - 3 Creole.' || chr(10) ||
   'Then select OPTION 5 - Miami Beach.' || chr(10) ||
   'Do NOT dispatch a City of Miami outreach team.', 50),
  ('Hermanos de la Calle (Hialeah / W of I-95 to the City northern boundary)', null,
   'Area assigned to another outreach provider - do NOT dispatch a City team.' || chr(10) ||
   'Give the caller Hermanos de la Calle''s outreach number (phone TBD - update here when the directory is filled in) and instruct them to contact that provider directly.', 60),
  ('New Hope (South of Kendall Drive)', null,
   'Area assigned to another outreach provider - do NOT dispatch a City team.' || chr(10) ||
   'Give the caller New Hope''s outreach number (phone TBD - update here when the directory is filled in) and instruct them to contact that provider directly.', 70)
) as v(name, phone, instructions, sort)
where not exists (select 1 from public.helpline_resources r where r.name = v.name);
