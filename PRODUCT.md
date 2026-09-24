# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Priority order (confirmed 2026-09-24): **Homeless Trust operations staff first** —
the CoC team running Coordinated Entry, the By-Name List, helpline dispatch, and
HUD reporting day-to-day (admin console, all tabs). **Provider agency staff
second** — case managers and data-entry users at ~100 partner agencies, scoped by
RLS to their own projects, self-serving scorecards and DQ fix-lists. **Leadership
third** — Trust directors/board consuming System Performance Measures, trends, and
the monthly helpline report; they read, rarely click. Additional operational
roles: helpline call operators (intake form, triage queue), street outreach
workers (the `/field` mobile app), and narrowly-scoped roles (cohort-only,
Youth Connect partner).

Operating reality: many users sit on Miami-Dade County PCs behind a TLS-inspecting
proxy (Fireglass isolation) on Windows; field workers use personal phones,
sometimes in cellular dead spots (the field app has an offline queue).

## Product Purpose

The FL-600 (Miami-Dade County Homeless Trust) HMIS performance dashboard: HUD-exact
metrics (SPM, APR-style DQ, returns, utilization) plus the county's operational
homelessness tools — By-Name List, CE milestones, helpline call
intake/triage/dispatch, field outreach logging, DQ fix-lists, analytics and
return-risk models.

**Success (confirmed): operations actually run on it.** CE case conferencing, BNL
work, helpline dispatch, field logging, and agency DQ fixes happen *in* the
dashboard. WellSky (HMIS) remains the system of record; this is the system of
work. Data flows one way: WellSky CSV export → Python ETL → Postgres → display.

## Positioning

The only place where HUD-compliant numbers and the county's daily homeless-response
operations live together. Neighboring products are either generic HMIS vendors
(WellSky reports: compliant but not operational) or one-off local tools (operational
but not HUD-exact). This dashboard's claim: every metric traceable to the HUD
spec (`apr_monthly_report.py` is the single source of metric truth; the web app
never re-derives), while the BNL/CE/helpline surfaces make it the room where
decisions happen.

## Operating Context

- Data rhythm: recurring WellSky export → `refresh.py` (ETL) → 12-step Supabase
  load. Metrics advance only on refresh; the current month is genuinely partial.
- Fiscal year Oct 1 – Sep 30. Data window 2022-10 → current.
- Case conferencing, dispatch decisions, and leadership reporting cite these
  numbers; the priority scoring on the helpline queue drives real dispatch order.
- The City of Miami call-handling SOP (08.2026) governs helpline behavior:
  specialized refer-outs (youth/veteran/DV/prevention), geographic team routing,
  operators never create HMIS enrollments.
- Print artifacts matter: dispatch sheets, monthly helpline PDF, security/
  governance packets go to people who never log in.

## Capabilities and Constraints

- Auth: self-service signup + admin approval; RLS is the data boundary
  (aggregates login-only, person-level agency-scoped). TOTP MFA; 20-minute idle
  sign-out (PII system — fail closed).
- PII: `bnl_clients` and helpline cases are real PII. Hashed PersonalIDs are the
  cross-system identifier (searchable in WellSky). Minimal-disclosure posture for
  HMIS glances shown to helpline/field staff without the BNL grant.
- HMIS matching is suggest-only everywhere: a person confirms every link.
- WellSky has no deep links (session-bound URLs) — copy-ID workflows instead.
- Helpline module currently pinned to a single user (pre-go-live); grants exist
  (`helpline_access`, `helpline_admin`) for rollout.
- County domain (`hmis.homelesstrust.org`) pending; vercel.app is proxied on
  county PCs — server-side fetching patterns exist for anything external
  (geocoding, tiles).
- Undecided (recorded, not invented): sheltered-caller protocol is unwritten in
  the SOP (working practice: route to provider case manager, no dispatch);
  whether assessment dates should count as BNL "last contact" is an open
  decision with roster-membership consequences.

## Brand Commitments

Confirmed binding: the **violet "HT" mark** and the current dark-first visual
identity (Darkone adaptation, violet primary, dark sidenav both modes) are the
committed look — the owner approved the 2026-09-22 design language and directed
that it not be restyled. Voice: plain operational English, sentence case,
no jargon-as-drama; project types abbreviated (TH, PSH, RRH…) with full names
on hover.

## Evidence on Hand

- Real production data: ~24k-person By-Name List, 171k drill records, 373 months
  of trend history, trained return/housing models (AUC documented in-app).
- Every metric verified digit-for-digit against the Python pipeline at build
  time; survival/pathways figures verified against raw CSV re-derivations.
- Shipped artifacts in the repo root: security posture PDF, data governance
  packet, DQ fix-timeline guide, helpline features PDF.
- Absent (do not fabricate): testimonials, pricing, competitive benchmarks,
  uptime claims.

## Product Principles

1. **HUD to the teeth** — metric logic lives in the ETL, follows the HUD spec
   exactly, and the web app only displays it. Never re-derive; never approximate.
2. **WellSky is the record; this is the work** — read from HMIS, act here, write
   nothing around HMIS (no enrollment creation, suggest-only matching).
3. **Definition changes are announced, never silent** — score/universe changes
   ship with caveats (rule-change ≠ real improvement) because leadership quotes
   these numbers.
4. **Least disclosure that still lets people act** — RLS scoping, minimal HMIS
   glances, grants per capability; approval is the security boundary.
5. **Built for the worst seat in the house** — county proxy, Fireglass, a phone
   under an overpass: every workflow must survive its hostile environment
   (offline queues, server-side fetches, print fallbacks).

## Accessibility & Inclusion

WCAG 2.1 AA is a standing requirement (confirmed 2026-09-24): AA-tuned text
ramps are documented in the design tokens, keyboard operability and reduced-
motion support are maintained deliberately (2026-09-24 pass), and future work
must not regress them. Field-app surfaces additionally follow mobile touch
minimums (44pt targets, 16px base text).
