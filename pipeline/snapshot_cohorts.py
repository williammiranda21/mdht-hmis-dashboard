#!/usr/bin/env python3
"""Capture each cohort's status mix into cohort_snapshots (trend points).

Run at the END of every refresh, after prune_stale_bnl.py — the roster is
final by then. One row per cohort per day: {n, active, housed, inactive,
housed_pct, returned}. The cohort dashboard's "Housed % over time" chart
reads these; live metrics come straight from bnl_clients at view time.

Usage:  py pipeline/snapshot_cohorts.py --dry-run
        py pipeline/snapshot_cohorts.py
"""
from pathlib import Path
import argparse
import os
import sys
from datetime import date

import truststore

truststore.inject_into_ssl()
from supabase import create_client  # noqa: E402

WEB = Path(__file__).resolve().parent.parent


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
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    url, key = load_env()
    sb = create_client(url, key)
    today = date.today().isoformat()

    cohorts = (sb.table("cohorts").select("id, name").execute().data or [])
    if not cohorts:
        print("No cohorts — nothing to snapshot.")
        return

    members = (sb.table("cohort_members").select("cohort_id, pid").execute().data or [])
    by_cohort: dict[int, list[str]] = {}
    for m in members:
        by_cohort.setdefault(int(m["cohort_id"]), []).append(str(m["pid"]))

    rows = []
    for c in cohorts:
        pids = by_cohort.get(int(c["id"]), [])
        counts = {"n": len(pids), "active": 0, "housed": 0, "inactive": 0, "returned": 0}
        for i in range(0, len(pids), 200):
            data = (sb.table("bnl_clients").select("status, returned")
                    .in_("pid", pids[i:i + 200]).execute().data or [])
            for r in data:
                if r["status"] in counts:
                    counts[r["status"]] += 1
                if r.get("returned"):
                    counts["returned"] += 1
        counts["housed_pct"] = round(100 * counts["housed"] / counts["n"], 1) if counts["n"] else None
        rows.append({"cohort_id": int(c["id"]), "captured_on": today, "counts": counts})
        print(f"  {c['name']}: {counts}")

    if args.dry_run:
        print("Dry run — nothing written.")
        return
    if rows:
        sb.table("cohort_snapshots").upsert(
            rows, on_conflict="cohort_id,captured_on").execute()
    print(f"Done — {len(rows)} snapshot(s) @ {today}.", flush=True)


if __name__ == "__main__":
    main()
