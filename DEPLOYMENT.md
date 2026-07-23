# Deploying to GitHub + Vercel

Status: **not yet deployed.** This is the step-by-step. Read §0 first — it's the one step that
can't be undone.

---

## 0. 🚨 Before `git init` — the PII problem

The `HMIS Dashboard` folder (the parent of `hmis-web/`) contains data that must **never** reach
GitHub, even in a private repo:

| Path | Why it can't be pushed |
|---|---|
| `hud_data/*.csv` | Raw HMIS export — `Client.csv` has **names, SSN, DOB** |
| `outputs/bnl_data.json` | ~30 MB, **23,421 real client names** |
| `outputs/netlify/*.json` | Computed data incl. drill files + `user_config.json` (PIN hashes) |
| `miami_live_hudcsvfy2026_*.zip` | 63 MB raw export |
| `outputs/apr_dashboard.html` | 210 MB generated file |
| `hmis-web/.env.local` | Supabase **service-role key** |

**Never run `git add -A` at the `HMIS Dashboard` root.** Git history is permanent — a bad first
commit means deleting the repo and rotating the Supabase keys.

### Recommended: publish only `hmis-web/`

The web app has no data files in it and already has a good `.gitignore`. Nothing else needs to be
on GitHub for Vercel to build.

```bash
cd "C:/Users/WILLM04/Desktop/HMIS Dashboard/hmis-web"
git init
git add -A
git status          # <-- READ THIS. Confirm: no .env.local, no .csv, no .json data, no .next
git commit -m "HMIS FL-600 System Dashboard — Next.js + Supabase"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

The Python ETL (`apr_monthly_report.py`, `generate_bnl.py`) stays local — it runs against raw HMIS
data and only ever writes to Supabase. It does not belong in a deployed repo.

> If you *do* want the ETL versioned, use a **second private repo** containing only the `.py`
> files, with a `.gitignore` that excludes `hud_data/`, `outputs/`, `*.zip`, `*.csv`.

**Sanity check before pushing:**
```bash
git count-objects -vH        # "size-pack" should be a few hundred KB, not hundreds of MB
```
If that number is large, something data-shaped got staged — stop and fix `.gitignore`.

---

## 1. Vercel setup

1. **vercel.com → Add New → Project → Import** your GitHub repo.
2. **Framework preset:** Next.js (auto-detected).
3. **Root Directory:**
   - If you pushed `hmis-web/` as the repo root → leave as `./`
   - If you pushed the whole folder → set it to **`hmis-web`**
4. Build command / output: leave defaults (`next build`).
5. **Environment Variables** — add all three, for Production *and* Preview:

   | Name | Value | Notes |
   |---|---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` | public |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the anon key | public |
   | `SUPABASE_SERVICE_ROLE_KEY` | the service-role key | **server-only — never prefix `NEXT_PUBLIC_`** |

   Copy them from `hmis-web/.env.local`. **Do not** add `BNL_PIN_SHA256` — the PIN gate is gone.

6. **Deploy.**

## 2. Point Supabase at the deployed URL

Supabase → **Authentication → URL Configuration**:
- **Site URL:** your Vercel production URL (`https://<project>.vercel.app` or your custom domain)
- **Redirect URLs:** add the same, plus `https://<project>.vercel.app/**`

Also confirm **Authentication → Providers → Email** is enabled and **"Confirm email" is OFF**
(admin approval is the real gate, and there's no SMTP configured).

## 3. Post-deploy checks

- [ ] `/` redirects to `/login` when signed out
- [ ] Sign in works, lands on Project Performance with live data
- [ ] **Sign out works** (it's a server-side form POST — verify it clears the session)
- [ ] `/dashboard/bnl` loads the roster for an admin
- [ ] Sign up a throwaway account → lands in **Pending** with no data access
- [ ] Approve it, assign 1–2 projects → confirm it sees **only** those projects
- [ ] Then disable it and delete the test user in Supabase

## 4. Lock down RLS (do this right after deploy works)

The aggregate tables still have `public read using (true)` — an anon key can read them today.
Write and run `supabase/auth_rls.sql` per **CLAUDE.md §7**. Do it *after* confirming login works
in production, because it blanks the dashboard for anyone without a session.

Verify afterwards with the anon key: aggregate reads should return **0 rows** when signed out.

## 5. Refreshing data (no redeploy needed)

Data lives in Supabase, so a refresh is a local Python run. **Two halves: ETL, then load.**

**Half 1 — ETL.** Drop the new HUD export zip anywhere in the project root, then:

```bash
cd "C:/Users/WILLM04/Desktop/HMIS Dashboard"
python refresh.py                            # or: python refresh.py myfile.zip
```

`refresh.py` is the entry point — it finds the newest `*.zip`, extracts every CSV into
`hud_data/`, then runs **all four** generators in order:

| | writes |
|---|---|
| `apr_monthly_report.py` | `outputs/netlify/{data,data_qf,data_dq,drill_all}.json` |
| `generate_analytics.py` | `outputs/netlify/analytics.html` |
| `generate_pathways.py` | `outputs/netlify/pathways.html` |
| `generate_bnl.py` | `outputs/bnl_data.json` (PII — never in `netlify/`) |

> ⚠️ Don't hand-run just `apr_monthly_report.py` + `generate_bnl.py` — that skips analytics and
> pathways. Use `refresh.py`.

**Half 2 — load into Supabase.** `refresh.py` does *not* touch Supabase:

```bash
cd "C:/Users/WILLM04/Desktop/HMIS Dashboard/hmis-web"
python pipeline/upsert_to_supabase.py --verify
python pipeline/recompute_util.py            # REQUIRED — utilization w/ DV beds excluded
python pipeline/prune_stale_bnl.py           # REQUIRED — drops clients that left the roster
```

`recompute_util.py` is separate on purpose: `util_metrics` is excluded from the default upsert
order so a normal run can't reintroduce DV beds from the stale `data.json`. See CLAUDE.md §6.

`prune_stale_bnl.py` exists because **upsert only inserts/updates — it never deletes.** When the
roster shrinks, departed clients linger in Postgres as phantoms. It prunes by *pid-set difference*
against the roster just generated. It deliberately does **not** prune by `as_of`: that silently
misses every orphan whenever two regens land on the same calendar day (observed 2026-07-23 — a
date-based prune missed all 145). Use `--dry-run` to preview.

### Referral side-car
`generate_bnl.py` also merges any `hud_data/*referral*.csv` (e.g. the PSH referral report) into the
BNL's referral fields. It joins on `Personal ID`, which is the same hashed PersonalID as the export.
It **supplements** the `Event.csv` referrals rather than replacing them — most recent wins — because
Event.csv still carries the ES bed / RRH / TH referrals a PSH-only report lacks. Nothing to run; just
drop the file in `hud_data/` before the refresh.

## 6. Later

- **Scheduled refresh** — Vercel Cron can't run this (it needs the raw HMIS CSVs, which are local).
  Options: a scheduled task on the County machine, or GitHub Actions with the export uploaded to
  Supabase Storage (was the original plan).
- **Custom domain** in Vercel → Settings → Domains.
