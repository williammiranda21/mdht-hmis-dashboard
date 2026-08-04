#!/usr/bin/env python3
"""Capture the current DQ state into dq_snapshots — the fixed-since-refresh ledger.

Run at the END of every refresh (after upsert + recompute_eva + recompute_openstay).
Freezes, for the latest COMPLETE month:
  • every dq:* fix-list row (EXCLUDING dq:openstay — it prunes older periods,
    so a period roll would read as a mass "fix")
  • every eva:* check row (eva keeps older-period rows, so it diffs cleanly)
  • each project's DQ_Score (metric='score')
Because a complete month's universe can never change, any client present in a
capture but absent from the same month's live rows later = a real data fix —
including retroactive ones that the month-vs-month digest can't see.

Also maintains meta key 'dq_snapshot_dates' (ascending list of capture dates)
so /api/digest can find the comparison base without scanning the table, and
prunes captures older than KEEP_DAYS.

Usage:  py pipeline/snapshot_dq.py --dry-run
        py pipeline/snapshot_dq.py
"""
from pathlib import Path
import argparse
import os
import sys
from datetime import date, timedelta

import truststore

truststore.inject_into_ssl()
from supabase import create_client  # noqa: E402

WEB = Path(__file__).resolve().parent.parent
KEEP_DAYS = 180


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


def fetch_all(q, page=1000):
    out, start = [], 0
    while True:
        r = q.range(start, start + page - 1).execute()
        out.extend(r.data or [])
        if len(r.data or []) < page:
            return out
        start += page


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    url, key = load_env()
    sb = create_client(url, key)
    today = date.today().isoformat()

    monthly = (sb.table("meta").select("value").eq("key", "dq_periods")
               .single().execute().data["value"].get("monthly") or [])
    if not monthly:
        sys.exit("meta.dq_periods missing — run the upsert first.")
    period = monthly[-1]

    drill = fetch_all(
        sb.table("drill_clients").select("project_id, metric, personal_ids")
          .eq("period", period)
          .or_("metric.like.dq:*,metric.like.eva:*")
          .neq("metric", "dq:openstay")
          .order("project_id").order("metric"))
    scores = fetch_all(
        sb.table("dq_metrics").select("project_id, data")
          .eq("granularity", "monthly").eq("period", period)
          .order("project_id"))

    rows = [{"captured_on": today, "period": period,
             "project_id": int(r["project_id"]), "metric": r["metric"],
             "personal_ids": r.get("personal_ids") or [], "score": None}
            for r in drill]
    rows += [{"captured_on": today, "period": period,
              "project_id": int(r["project_id"]), "metric": "score",
              "personal_ids": None,
              "score": (r.get("data") or {}).get("DQ_Score")}
             for r in scores]
    print(f"snapshot {today} · period {period}: {len(drill)} fix-list rows, "
          f"{len(scores)} scores")

    if args.dry_run:
        print("Dry run — nothing written.")
        return

    for i in range(0, len(rows), 200):
        sb.table("dq_snapshots").upsert(
            rows[i:i + 200],
            on_conflict="captured_on,period,project_id,metric").execute()
        print(f"  upserted {min(i + 200, len(rows))}/{len(rows)}", flush=True)

    # Capture-date index for the digest (ascending, deduped).
    meta = sb.table("meta").select("value").eq("key", "dq_snapshot_dates") \
             .maybe_single().execute()
    dates = list((meta.data or {}).get("value") or []) if meta and meta.data else []
    if today not in dates:
        dates = sorted(set(dates + [today]))
    cutoff = (date.today() - timedelta(days=KEEP_DAYS)).isoformat()
    dropped = [d for d in dates if d < cutoff]
    dates = [d for d in dates if d >= cutoff]
    sb.table("meta").upsert({"key": "dq_snapshot_dates", "value": dates},
                            on_conflict="key").execute()
    for d in dropped:
        sb.table("dq_snapshots").delete().eq("captured_on", d).execute()
    if dropped:
        print(f"  pruned {len(dropped)} old capture(s)")
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
