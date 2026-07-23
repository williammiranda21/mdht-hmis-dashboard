# HMIS Dashboard — Web (Next.js + Supabase + Vercel)

A live, query-on-demand rebuild of the HMIS Performance Dashboard. Instead of shipping a
55 MB `data.json`, the Next.js app reads metrics from Postgres (Supabase) so each page view
fetches only the rows on screen. Your existing Python computations stay — they now **upsert**
into Supabase instead of writing HTML/JSON.

```
hmis-web/
  app/                     Next.js App Router pages
    globals.css            Blue + Amber design tokens + component styles
    layout.tsx
    page.tsx               Portal / landing
    dashboard/page.tsx     Project Performance (live data from Supabase)
  components/              Redesigned cards, tables, filters
  lib/
    supabase.ts            Supabase clients (browser + server)
    queries.ts             Typed data access
    types.ts
  supabase/schema.sql      Postgres tables + RLS
  pipeline/
    upsert_to_supabase.py  Loads your computed outputs into Supabase
    requirements.txt
  .env.local.example
```

---

## What you need

| | |
|---|---|
| **Accounts** | [GitHub](https://github.com) · [Supabase](https://supabase.com) · [Vercel](https://vercel.com) — free tiers cover this |
| **Local tools** | [Node.js LTS](https://nodejs.org) (18+), Git, a code editor (VS Code). You already have Python 3. |

## Setup — step by step

### 1. Create the Supabase project
1. supabase.com → **New project**. Save the database password.
2. Project → **SQL Editor** → paste the contents of `supabase/schema.sql` → **Run**. This creates the tables, indexes, and RLS policies.
3. Project → **Settings → API**. Copy three values:
   - `Project URL`
   - `anon` `public` key
   - `service_role` key  *(secret — never commit it or expose it in the browser)*

### 2. Configure env
```bash
cp .env.local.example .env.local
```
Fill in:
```
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...        # safe for the browser (RLS protects data)
SUPABASE_SERVICE_ROLE_KEY=eyJ...            # server/pipeline only
```

### 3. Load your data into Supabase
The upsert reads the outputs your Python pipeline already produces (`outputs/apr_monthly_report.csv`
and `outputs/netlify/data.json`) and writes them to Postgres. From this folder:
```bash
cd pipeline
pip install -r requirements.txt
python upsert_to_supabase.py        # reads ../../outputs, upserts to Supabase
```
(Run this whenever you refresh your HMIS data — it replaces the "ship a new JSON" step.)

### 4. Run the app locally
```bash
npm install
npm run dev          # http://localhost:3000
```
Open `/dashboard` — Project Performance now renders from live Supabase queries.

### 5. Deploy to Vercel
1. Push this folder to a **GitHub** repo.
2. Vercel → **New Project** → import the repo.
3. Add the same three env vars in Vercel → **Settings → Environment Variables**.
4. Deploy. Every `git push` redeploys.

---

## How this maps to the old dashboard

| Old (Python → static) | New (Next.js → Supabase) |
|---|---|
| 55 MB `data.json` downloaded per visit | Indexed Postgres query per page (KB) |
| PIN hashes in `user_config.json` | Supabase Auth + Row-Level Security |
| `refresh.bat` regenerates HTML | `upsert_to_supabase.py` updates rows (no redeploy) |
| One giant HTML file | Component-based Next.js pages |

## Next steps (after this starter runs)
- Port the remaining tabs (SPM cards, Returns, Youth, DQ, **Unit Utilization**) as pages.
- Wire **Supabase Auth** for agency logins (replaces PINs); RLS scopes `drill_clients`.
- Move the `drill_clients` table behind an admin-only RLS policy.
