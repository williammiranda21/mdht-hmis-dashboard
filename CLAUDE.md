# HMIS Dashboard — Project brief for Claude Code

**Miami-Dade County Homeless Trust · FL-600 System Dashboard.**

The migration from the old Python→static-HTML dashboard to **Next.js (App Router, TypeScript) +
Supabase (Postgres/Auth/RLS)** is **built and working locally**. All tabs render live Supabase
data, auth is in place, and every metric has been verified against the source pipeline.

> ⚠️ This file was rewritten 2026-07-22 to describe the **current state**. The original version
> described the plan before it was built — ignore any older copy.
> **Updated 2026-08-04:** status table refreshed (RLS/drills/deploy all DONE long since), the
> load-half runbook is now TEN steps (§12), and the auto-memory `project_pending.md` carries the
> live handoff — read its top block for what's actually open.

---

## 1. Current status

| Area | State |
|---|---|
| Data pipeline → Supabase | ✅ Done, verified; **load half = 10 steps, see §12 runbook** |
| Dashboard tabs (Projects/Returns/System/Forecast/DQ/Util/BNL/Rankings/Deep Dive) | ✅ Built + verified |
| Admin suite (Users / Targets / Cohorts) | ✅ Built (Targets = type defaults + overrides; Cohorts = tracked client groups) |
| Supabase Auth + RLS flip + forgot-password flow | ✅ Done (`auth_rls.sql` run; forgot-password awaits Supabase URL config) |
| Drill-downs, DQ fix-lists + Eva checks, error-rates-by-user, CE milestones | ✅ Built |
| **GitHub + Vercel deploy** | ✅ **LIVE**: github.com/williammiranda21/mdht-hmis-dashboard → hmisdashboard.vercel.app |
| County-network access (vercel.app proxied — client fetches die on county PCs) | ⬜ Blocked on `hmis.miamidade.gov` + ITD allowlist |

Run locally: `cd hmis-web && npm run dev -- -p 3011` (the user demos on **3011**).

## 2. Architecture

```
                    ┌── refresh.py (ETL entry point: unzips → runs all 4) ──┐
export.zip ──►      │   apr_monthly_report.py ──► outputs/netlify/*.json    │
hud_data/*.csv      │   generate_analytics.py ──► analytics.html            │
(raw HMIS export)   │   generate_pathways.py  ──► pathways.html             │
+ *referral*.csv    │   generate_bnl.py       ──► outputs/bnl_data.json     │
                    └───────────────────────────────┬───────────────────────┘
                                                    ▼
                              hmis-web/pipeline/upsert_to_supabase.py
                                                  + recompute_util.py   (util, DV-excluded)
                                                  + prune_stale_bnl.py  (drop departed clients)
                                                    ▼
                                          Supabase Postgres (RLS)
                                                    ▼
                             Next.js App Router (Server Components)
```

**`refresh.py` runs the ETL half; the pipeline scripts run the load half.** Never hand-run only
`apr_monthly_report.py` + `generate_bnl.py` — that silently skips analytics and pathways.

**Python stays the ETL.** It computes every HUD metric; the web app only *displays* what's in
Postgres. Data refreshes are a Python upsert — no redeploy needed.

## 3. Where things live

| Path | What |
|---|---|
| `../refresh.py` | **ETL entry point.** Unzips the newest export → `hud_data/`, runs all four generators. Start here for a data refresh. |
| `../apr_monthly_report.py` | **Source of truth for all metric logic.** SPM (M1–M7), Returns (M2), DQ, Unit Utilization. Never re-derive — port. |
| `../generate_analytics.py` | Analytics page (static HTML) **plus `outputs/netlify/analytics.json`** — §3b computes per-project time-to-housing (Kaplan-Meier) for the web app. See §11 |
| `../generate_pathways.py` | Pathways/Predictor page (still static HTML, not yet in the web app) |
| `../generate_bnl.py` | Builds the By-Name List roster (`outputs/bnl_data.json`). Also merges `hud_data/*referral*.csv` into the referral fields (see §6) |
| `../bnl_core.py` | Shared BNL logic — status cascade, referral merge, flags |
| `pipeline/upsert_to_supabase.py` | Loads all tables. `--dry-run`, `--only`, `--verify` |
| `pipeline/recompute_util.py` | **Authoritative** utilization loader (DV-excluded, see §6) |
| `pipeline/prune_stale_bnl.py` | Deletes BNL clients that left the roster (upsert never deletes — see §6) |
| `supabase/schema.sql` | Data tables |
| `supabase/survival.sql` | `survival_metrics` (time to housing) — run once in the SQL editor |
| `supabase/auth_setup.sql` | Auth model — profiles, grants, RLS helpers |
| `lib/queries.ts` | All data access. **Every call uses `supabaseServer()`** |
| `lib/supabase-server.ts` | Request-scoped session client + `getViewer()` |
| `middleware.ts` | Gates every route except `/login`, `/signup` |
| `app/dashboard/*` | The 7 tabs |
| `app/dashboard/admin/` | User administration console |

## 4. Auth model (built, working)

**Self-service signup + admin approval.** No pre-seeded accounts.

1. Anyone signs up at `/signup`
2. A trigger on `auth.users` auto-creates a **`pending`** profile — zero data access
3. An admin approves them and assigns ProjectIDs (or grants admin)
4. They see only their assigned projects

**Approval — not signup — is the security boundary.** `profiles.status` is
`pending | approved | disabled`; every policy requires `approved`. `is_admin()` also requires
approved, so disabling an account revokes admin power.

- Sole admin today: **william.miranda@miamidade.gov**
- Bootstrap (first admin only, already done): the `UPDATE` at the bottom of `auth_setup.sql`
- Admin console `/dashboard/admin`: approve/disable, grant/revoke admin, **edit projects**
  (searchable picker — only renders for non-admins, since admins bypass grants), and
  **reset password** (temp password shown once, never emailed — no SMTP configured)
- Users self-change password at `/dashboard/account`

### Non-obvious things that will bite you
- **Sign-out must stay server-side** (`app/auth/signout/route.ts`, plain form POST). A client-side
  `signOut()` silently failed: the browser client can't clear middleware-set/chunked `sb-*`
  cookies, and the client redirect raced middleware which bounced `/login` → `/dashboard`.
- **Login uses a hard navigation** (`window.location.assign`), not `router.replace`. A soft
  transition lazily fetches the dashboard chunk, whose hash changes on every dev recompile →
  `ChunkLoadError` flash.
- **`lib/queries.ts` must use `supabaseServer()`**, never the module-level anon client — the anon
  client has no session, so RLS returns nothing.
- Middleware returns **JSON 401 for `/api/*`** instead of redirecting to an HTML login page.
- Supabase has **"Confirm email" OFF** (accounts auto-confirm). Admin approval is the real gate.

## 5. Metric correctness — the top priority

The user's standing instruction: **follow HUD to the teeth, especially System Performance.**
Leadership reports against these numbers.

- **Never re-derive SPM math in the web app.** `apr_monthly_report.py` is HUD-compliant and
  precomputes into `sys_data` → `system_metrics.data` jsonb. The app maps fields, nothing more.
- **Do not conflate the three PH-exit fields:** `PHExits` (project-level),
  `M_AllPHExits` (system, unduplicated — the "Total PH exits" card), `M7b1_PHExits` (SPM 7b.1).
- SPM cards are a faithful port of `renderSpmTab()` (~line 6122). Field bindings are documented
  in `app/dashboard/system/SpmView.tsx` — check against the Python before changing any.
- Fiscal year = **Oct 1 – Sep 30**. PH destinations `{410,411,421,422,423,426,435}`;
  unsubsidized `{410,411}`. Project type 6 (Services Only) excluded everywhere.
- Every tab was verified digit-for-digit against `data.json` when built.

## 6. Data gotchas (hard-won — don't rediscover these)

- **Period lists differ per dataset.** `project_metrics` includes the partial current month;
  `system_metrics`, `dq_metrics`, `returns_metrics`, `util_metrics` stop at the last *complete*
  period. Each tab reads its own list from `meta` (`periods`, `dq_periods`, `ret_periods`,
  `util_periods`) or from its own table. Never use the project period list for SPM/DQ/Returns.
- **PostgREST caps responses at 1000 rows.** Never derive a distinct/aggregate list with
  `select()` over a big table — that's why period lists live in `meta`.
- **Next.js caches `fetch()` GETs** (incl. supabase-js) in a Data Cache that persists to disk and
  survives restarts. `lib/supabase.ts` forces `cache: 'no-store'` — keep it, or pipeline upserts
  won't show up.
- **DV beds are excluded from utilization.** Victim Service Provider projects
  (`Project.csv TargetPopulation == 1`, 8 projects) report HIC bed inventory but enter no client
  data into HMIS, so their beds were phantom capacity. Excluded in both
  `apr_monthly_report.py::_util_per` and `pipeline/recompute_util.py`.
  **`util_metrics` is deliberately NOT in the default upsert order** — load it via
  `recompute_util.py`, or you'll reintroduce DV beds from the stale `data.json`.
- **RRH capacity is DYNAMIC (2026-07-30, per HUD + user directive).** RRH is tenant-based —
  the HIC inventory equals the households actually in units, and the county cannot maintain
  Inventory.csv per move-in/out. So in both `_util_per` copies: RRH capacity = HoH enrollments
  with an ACTIVE MOVE-IN (point-in-time), `Inventory.csv UnitInventory` is ignored for RRH,
  and utilization is PEGGED at 100% under both methods (inventory ≡ occupancy by definition;
  an un-pegged avg-daily figure wobbles with month-boundary churn and trips the over/under
  flags). The real RRH signal is the `aw` field — enrolled households awaiting move-in —
  shown on the project row and the unit hero card. PH (types 9/10) keeps static UnitInventory.
  An RRH project with zero moved-in households drops out of the table (cap<=0 skip), same as
  a zero-HIC project did before.
  **Hotel/motel programs get the same treatment (2026-07-30):** rooms are leased per household
  as needed, so their HIC is aspirational (City of Miami showed 650 beds / 30% util; reality
  194 clients). Detected by NAME (`hotel|motel`, residential types 0/1/2/8, DV excluded);
  capacity = PIT clients, pegged 100%, `dyn:true` on the row. Implemented by REPLACING the
  hotel rows' BedInventory in `ai` with PIT (fam/ind split preserved) so every aggregate
  (type, household, empty-beds) inherits it with no special-casing.
- **Returns (M2) need a full 24-month lookback**, so only ~21 monthly periods exist.
- **In-progress quarter/FY periods cap at `REPORT_END`** (last day of the most recent complete
  month) — otherwise inventory over-counts. See `recompute_util.py::period_range`.
- **A local `supabase/` folder shadows the pip package** when running `python -c` from
  `hmis-web/`. Run probe scripts from another directory.
- The County firewall TLS-inspects HTTPS, so Python needs `truststore.inject_into_ssl()` (already
  wired into the pipeline scripts). Port 5432 direct is unreachable; the pooler and REST work.

- **RLS policy quals MUST wrap no-arg helper calls in a scalar subquery:**
  `using ((select public.can_see_bnl()))`, never `using (public.can_see_bnl())`. The bare form
  is evaluated PER ROW (the helpers are SECURITY DEFINER → not inlinable, ~0.34 ms each), and a
  full-scan query pays it for every row — the BNL page died in prod on exactly this
  (2026-08-05: 23,958 rows × 2 passes ≈ 8 s → statement timeout 57014 → Next digest screen).
  The wrapped form is an InitPlan, evaluated once per statement, identical semantics.
  `supabase/rls_initplan.sql` converges every policy; any NEW policy must follow the pattern.
  **Corollary: never verify query health with the service-role key alone** — it bypasses RLS and
  hides this entire failure class. Probe with a real session JWT (create a throwaway auto-confirmed
  user via the auth admin API, approve via service role, password-grant sign-in, delete after).

- **Upsert now PRUNES its own tables (task #13, 2026-08-05)** — but only them. PostgREST upsert
  has no concept of rows that vanished from the source; ~22k orphans accumulated this way
  (returns_metrics 2× its source; the stale-is_partial June/July bug). `upsert_to_supabase.py`
  stamps every row with a per-run `loaded_at` watermark (column added by run-once
  `supabase/loaded_at.sql`) and, after each table's load completes, deletes the rows that run
  didn't stamp. A table is pruned only when its build produced rows, so a missing side-car file
  can never empty a table; `--no-prune` opts out. EXEMPT: `meta` (snapshot writers own keys),
  recompute-owned tables (util/dest_profile/leaseup), and drill_clients rows with metric
  `eva:*`/`dq:openstay` (loaded later in the runbook).
  **bnl_clients stays on `pipeline/prune_stale_bnl.py`** — pid-set difference, deliberately *not*
  date-based: an `as_of`-DATE prune silently misses every orphan when two regens land on the same
  calendar day (observed 2026-07-23: it missed all 145). Run it as step 9 of the refresh as before.
- **Referrals come from two sources, merged in `bnl_core.py`.** `Event.csv` (HUD 4.20 CE events) is
  sparse for PSH — it had only 47 PSH referrals. Any `hud_data/*referral*.csv` side-car (the PSH
  referral report) is merged on `Personal ID`, which is the same hashed PersonalID as the export, so
  it joins to roster `pid` directly. It **supplements** Event.csv (most recent referral wins), since
  Event.csv still supplies the ES bed / RRH / TH referrals a PSH-only report lacks. Outcome values
  are carried through verbatim — `canceled` / `accepted on wait list` have no Event.csv equivalent.

### "Why is the current month showing as a partial period?"
That's correct behavior, not a bug — the in-progress month is genuinely incomplete. The `is_partial`
flag is **baked into the data at generation time**, so it only advances when the ETL is re-run
against a newer export.

⚠️ If the period looks *stale* (e.g. last month still flagged partial), check **which half of the
refresh was skipped** before re-running anything. On 2026-07-23 the ETL outputs were already
current — only the Supabase *upsert* had been missed, so re-running the ETL would have been wasted
work. Compare `outputs/netlify/data.json`'s `partial_period` against `meta.partial_period` in
Supabase: if they differ, you only need the load half (§ DEPLOYMENT.md 5).

## 7. What's left to build

Everything in the old version of this section (RLS flip, drill-downs, deploy) is **DONE**.
The live queue and open user actions are maintained in the auto-memory
`project_pending.md` — its top ⭐ block is the source of truth. Highlights as of 2026-08-04:

- ~~Stale-row prune (task #13)~~ **BUILT 2026-08-05** — `loaded_at` watermark stamped by the
  upsert + post-load filtered DELETE per owned table (see §6). Run-once `supabase/loaded_at.sql`
  adds the column; first full upsert after it sweeps the ~22k accumulated orphans.
- **County domain** `hmis.miamidade.gov` — the standing blocker for county-PC access.
- Metric glossary page · off-target flags on Rankings · milestone worklists · Eva parity pass.

## 8. Deploy — READ BEFORE `git init`

🚨 **This directory contains PII and must never be pushed whole.**
`hud_data/Client.csv` has names/SSN/DOB. `outputs/bnl_data.json` has 23k real client names.
There is also a 63 MB source zip and a 210 MB generated HTML.

**Never run `git add -A` at the `HMIS Dashboard` root.** The safe options are:
- **(Recommended)** make `hmis-web/` its own repo — it already has a good `.gitignore` and contains
  no data files, or
- init at the root only with a `.gitignore` that excludes `hud_data/`, `outputs/`, `model_data/`,
  `hmis_import/`, `.venv/`, `*.zip`, `*.csv`, `__pycache__/`, `.env.local` — verified with
  `git status` **before** the first commit.

Vercel needs: root directory = `hmis-web`, and env vars `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server-only — never
`NEXT_PUBLIC_`). `BNL_PIN_SHA256` is obsolete; don't carry it over.

## 9. Design system

Current theme is **"Darkone"** (a StackBros admin adaptation), applied 2026-07-22 — it replaced an
earlier "Government slate" theme. Violet primary `#7E67FE`, flat cards, 8px radius, **dark left
sidebar in both modes**, dark mode default.

- Layout: `.shell` → fixed `.sidenav` (brand, vertical nav) + `.mainc` (56px sticky header,
  1340px content). Collapses to horizontal tabs under 1024px.
- Text ramps are **WCAG AA tuned** (14.2 / 9.5 / 6 / 4.7 : 1 in both modes). The earlier
  `--faint` was 2.1–2.2:1 and unreadable. If you change a text token, re-check contrast.
- All colors are CSS variables in `app/globals.css` — theming is a token swap, never per-component
  hex.
- `--serif` is currently aliased to Inter (EB Garamond was removed), so serif heading rules are
  inert.
- Mockups in `../outputs/dashboard_*.html` reflect the **older** Blue+Amber design — useful for
  component anatomy (card/gauge/table treatments), not current colors.

## 10. Conventions

- Server Components fetch data; Client Components only for interactivity.
- Keep `SUPABASE_SERVICE_ROLE_KEY` server-only. It's used in exactly one place now
  (`app/api/admin/reset-password/route.ts`), and that route verifies the **caller** is an admin
  before using it. Everything else goes through RLS.
- Prefer extending `lib/queries.ts` over scattering Supabase calls.
- Don't change metric math without checking `apr_monthly_report.py`.
- Hashed PersonalIDs are not names, but `bnl_clients` **is** real PII — treat it accordingly.

## 11. Time to housing (Kaplan-Meier) — Deep Dive Phase 2

Where it lives: `../generate_analytics.py` §3b → `outputs/netlify/analytics.json` →
`pipeline/upsert_to_supabase.py::build_survival_metrics` → `survival_metrics` →
`/api/project` + `/api/grid` → `components/TimeToHousing.tsx` and
`app/dashboard/deep-dive/PerformanceGrid.tsx`.

**The event depends on the project type, and that is the point.**

| Types | Event | Why |
|---|---|---|
| 3, 9, 10, 13 (PSH / PH-only / PH w-services / RRH) | recorded `MoveInDate` | These clients are enrolled in a housing programme; the question is when they are actually in a unit. HUD's move-in concept. |
| 0, 2, 4, 8 (ES–Entry Exit / TH / SO / Safe Haven) | exit to a PH destination | There is no move-in in a shelter, so leaving for permanent housing is the housing event. |
| 1 (ES – Night-by-Night) | **excluded** | Measured first: 3,197 enrolments, 2 recorded PH exits (0.06%), both projects `(INACTIVE)`. NbN records bed-nights, not destinations — the figure would report recordkeeping as an outcome. Same call as dropping the Last-contact column. |

§3's older `survival.curve_ph` uses the exit-to-PH definition for *every* type, which
reads as "time to leave" for a PSH project. It is left untouched because the static
analytics page ships it — but it is **not** what `survival_metrics` reports. Don't
cross-reference the two.

### Things that will bite you

- **Cohort is a rolling 24 months of ENTRIES**, ending at `REPORT_END`. The type
  baseline is computed in the same block over the same window, so a project median and
  the peer median it is shown against can never describe different cohorts. Every row
  carries `window_start`/`window_end` — surface them, don't assume.
- **`median_days = null` and `median_days = 0` are both real answers.** `null` = the
  curve never crossed 50% within two years ("more than half were still waiting").
  `0` = genuinely same-day, which PH projects that create the enrolment on move-in day
  produce legitimately (10 of 97 projects). `median || 'n/a'` collapses the two and is
  wrong; use `fmtDays()` in `components/TimeToHousing.tsx`.
- **Statistics are read off the EXACT step function, the chart line off a grid.**
  `tth_stats` samples the curve at `CHART_DAYS` for drawing, but medians, quartiles and
  the 90/180/365-day rates come from `km_steps` unrounded. An earlier version read
  `rate_180` off the nearest 7-day point (day 175) and was wrong by up to 9pp. 90, 180,
  365 and 545 are forced into `CHART_DAYS` so the line passes through the days the panel
  labels.
- **Minimum cohort is 20 enrolments** (`TTH_MIN_N`); below that no row is emitted and the
  UI says so rather than drawing a curve out of noise. 97 of 232 projects qualify.
- Verified 2026-07-23: all 104 rows (7 types + 97 projects) match an independent
  re-derivation from `hud_data/*.csv` — n, n_housed, median, q1, q3, all three rates,
  and sampled curve points.

### Small-multiples grid (`/api/grid`)
Shares **one y-scale across every card** — per-card auto-scaling would make a project
wobbling 4%–6% look identical to one swinging 10%–60%. Sorted worst-first, direction per
metric; Clients served has no good direction and is sorted by size with the header saying
so. Values are the stored `project_metrics` columns — nothing is recalculated client-side.

## 12. Deep Dive Phase 3 — project pathways · forecast · BNL affordance

Three tracks, all shipped 2026-07-23. Data verified against raw CSVs / source payloads.

### Project pathways (`project_pathways`) — agency-facing, on Deep Dive
`generate_pathways.py` §5 → `outputs/netlify/pathways.json` →
`build_project_pathways` → `project_pathways` → `/api/pathways` →
`app/dashboard/deep-dive/ProjectPathways.tsx`.

- **Cohort = clients a project served in the trailing 24 months, traced across their
  WHOLE system pathway** (user decision 2026-07-23). The cohort is "served here recently";
  the Sankey is built from those clients' *entire* enrollment history (reuses
  `build_sankey_data` unchanged), so an ES sees where its people went *after* it, not just
  its own exit door.
- **One project at a time** — the picker chooses from the Deep Dive selection. Pooling
  projects would double-count anyone two of them served; the payload is keyed per project.
- **`PP_MIN_CLIENTS = 30`** → 83 of 232 projects qualify. Others return `{pathways:null}` and
  the UI shows an explanatory empty state — not an error.
- The diagram is a **bipartite one-step transition Sankey** ("came from" | "went to"): each
  state appears once as a source (left) and once as a target (right). A conventional
  single-node-per-state Sankey tangles because clients cycle (SO↔ES constantly); bipartite
  keeps every flow legible. Node height and ribbon width share one scale.
- Per-project `bottleneck` is **deliberately leaner** than the system block in
  `generate_pathways.py` §2 — no 8-quarter trend, no opportunity projections (noise at project
  scale). The system block is untouched; this is a separate `project_bottleneck()`.
- Verified: all 83 projects' cohort sizes + per-state n / n_ph match a raw-CSV re-derivation.

### System forecast (`system_forecast`) — leadership-facing, its own Forecast tab
`generate_analytics.py` (`inflow`, `capacity`) → `build_system_forecast` (from
`analytics.json`, the SAME file survival reads) → two keyed rows → `getSystemForecast` →
`app/dashboard/forecast/`. New TabNav entry (`trend` icon), between System and Data Quality.
- **Both inflow forecasts are shown** (weighted-average + linear-trend) on purpose — they
  disagree, and the gap IS the uncertainty. Don't "clean this up" to one line.
- Capacity table reads occupancy 30/60/90 days out; RRH etc. can exceed 100% (lease-up
  target, not fixed beds) — same convention as Unit Utilization.

### BNL magnifying glass
`.bnl-drillname::after` puts a 🔍 next to each client name in the By-Name List roster (rows
open the detail drawer). Mirrors the `.drill` affordance but does NOT recolor the name (the
unsheltered-red inline style must survive). **Deliberately NOT added to the Deep Dive
worklists** — those rows don't open anything, so a 🔍 there would be a false affordance.

### Still excluded
The **Housing Predictor** (`predictor_ml`) remains unbuilt — needs explicit sign-off on framing
(see the Phase 3 memory). Do not surface a per-client success score without it.

### Refresh runbook — CURRENT FULL ORDER (2026-08-04; ten load steps)
ETL half: `py refresh.py` (unzips newest export, runs all four generators).
Load half, in order (`py hmis-web/pipeline/<script>` — use SYSTEM `py`, the root
`.venv` lacks the supabase/truststore packages):
1. `upsert_to_supabase.py --verify` (now also prunes its own tables' stale rows — §6; `--no-prune` opts out)
2. `recompute_util.py` (authoritative utilization, DV-excluded)
3. `recompute_dest.py` (destination profiles)
4. `recompute_leaseup.py` (lease-up funnel)
5. `recompute_eva.py` (Eva checks, latest complete month snapshot)
6. `recompute_openstay.py` (left-open enrollments → dq:openstay; period from meta.dq_periods)
7. `recompute_user_dq.py` (error rates by user — AFTER eva/openstay so it attributes them)
8. `snapshot_dq.py` (fixed-since-refresh ledger capture)
9. `prune_stale_bnl.py` (BNL orphan prune)
10. `snapshot_cohorts.py` (cohort trend points — last, roster is final)
11. `load_client_index.py` (Youth Connect match index — all Client.csv identifiers;
    service-role-only table, feeds /api/yc/match; any order among the recomputes)

Skipping the load half leaves Supabase stale while local JSONs advance — the classic
"which half ran" trap (§6). New SQL run-once files since 2026-07-31: `targets.sql`,
`dq_snapshots.sql`, `user_dq.sql`, `cohorts.sql` (all already run in prod),
`youth_connect.sql` (2026-08-19 — Youth Connect: youth_intakes/intake_invites/
client_index + profiles.yc_access + can_see_yc()).

### Youth Connect (2026-08-19)
Youth intake + self-entry portal. Access = admins + `profiles.yc_access`
(granted to Educate Tomorrow). Surfaces: PUBLIC `/yc/[token]` (invite-tokened
self-entry, no account; the app's only unauthenticated write, via
`/api/yc/submit` service-role insert after token validation) ·
`/dashboard/youth-intake` (review queue + intake list + invite links) ·
`/dashboard/youth-intake/new` (staff intake with SSN-4 + internal case notes) ·
BNL drawer "Youth Connect" section (components/YcSection.tsx — matched intake's
contact/situation, for case conferencing). Matching is SUGGEST-ONLY
(/api/yc/match: DOB/SSN-4/name-similarity against client_index; a person
confirms). HMIS/WellSky stays the system of record — unmatched youth are
flagged for HMIS entry, never written around.
