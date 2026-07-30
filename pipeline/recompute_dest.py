#!/usr/bin/env python3
"""Destination profile loader — "where do my clients go" (Pillar 3).

Per project + month: counts of ALL exits by HUD destination code (returns_by_dest
only covers PH exits, for returns tracking — this is the full exit door).

Follows the recompute_util.py precedent: a standalone loader reading hud_data/
CSVs and upserting `dest_profile` directly — no apr_monthly_report.py regen
needed. Run it as part of the refresh load half, alongside recompute_util.py.

Tier sets mirror generate_pathways.py (DEST_* at ~line 305) and bnl_core PH_DEST —
keep them in lockstep; the UI groups codes into tiers with these same sets.

Table (run once in the Supabase SQL editor):
  create table if not exists dest_profile (
    period      text not null,
    project_id  bigint not null,
    data        jsonb not null,   -- {destCode: count}, plus "_n" total exits
    primary key (period, project_id)
  );
  alter table dest_profile enable row level security;
  create policy "public read dest" on dest_profile for select using (true);
"""
from pathlib import Path
import os, sys

import pandas as pd
import truststore

truststore.inject_into_ssl()
from supabase import create_client  # noqa: E402

HERE = Path(__file__).resolve().parent
WEB = HERE.parent
DATA_DIR = WEB.parent / "hud_data"
MONTHS_KEPT = 36   # trailing complete months

PH_DEST = {410, 411, 421, 422, 423, 426, 435}


def load_env():
    env = WEB / ".env.local"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        sys.exit("Missing Supabase credentials (hmis-web/.env.local).")
    return url, key


def main():
    print("Loading HMIS CSVs …", flush=True)
    enr = pd.read_csv(DATA_DIR / "Enrollment.csv", low_memory=False,
                      usecols=["EnrollmentID", "ProjectID"])
    ex = pd.read_csv(DATA_DIR / "Exit.csv", low_memory=False,
                     usecols=["EnrollmentID", "ExitDate", "Destination"])
    ex["ExitDate"] = pd.to_datetime(ex["ExitDate"], errors="coerce")
    e = ex.dropna(subset=["ExitDate"]).merge(enr, on="EnrollmentID", how="left")
    e = e.dropna(subset=["ProjectID"])

    # Trailing complete months (mirror REPORT_END: last day of last complete month)
    from datetime import datetime as _dt
    report_end = pd.Timestamp(_dt.now().replace(day=1)) - pd.Timedelta(days=1)
    start = (report_end.replace(day=1) - pd.DateOffset(months=MONTHS_KEPT - 1))
    e = e[(e["ExitDate"] >= start) & (e["ExitDate"] <= report_end)].copy()

    e["period"] = e["ExitDate"].dt.strftime("%Y-%m")
    # Blank destination is a real (and reportable) answer: not collected
    e["Destination"] = pd.to_numeric(e["Destination"], errors="coerce").fillna(-1).astype(int)

    rows = []
    for (period, pid), grp in e.groupby(["period", "ProjectID"]):
        counts = grp["Destination"].value_counts().to_dict()
        data = {str(k): int(v) for k, v in counts.items()}
        data["_n"] = int(len(grp))
        rows.append({"period": period, "project_id": int(pid), "data": data})
    print(f"  {len(rows):,} project-month rows ({e['period'].min()} – {e['period'].max()})", flush=True)

    url, key = load_env()
    sb = create_client(url, key)
    for i in range(0, len(rows), 500):
        sb.table("dest_profile").upsert(rows[i:i + 500], on_conflict="period,project_id").execute()
        print(f"  upserted {min(i + 500, len(rows)):,}/{len(rows):,}", flush=True)
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
