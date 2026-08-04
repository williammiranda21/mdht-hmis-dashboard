#!/usr/bin/env python3
"""Left-open enrollment suspects → DQ-tab fix-list records (dq:openstay).

Moves the Deep Dive "Enrollment may have been left open" worklist into the
Data Quality tab (user decision 2026-08-03: its remedy is a RECORD fix —
enter the missed exit — so it belongs with the guided fix-lists, not the
client-action worklists). Source: outputs/bnl_data.json — bnl_core.py's
open_suspect heuristics; each suspect enrollment's own project_id rides in
open_suspect_projects (the 8c07a4c misattribution fix), so a suspect ES
enrollment shows under the ES project that owns it.

Emits drill_clients rows in the dq:* shape:
  period = latest COMPLETE month | project_id | metric = 'dq:openstay'
  personal_ids = unique hashed clients (detail=None — the offending stay's
  dates live in the roster's dq strings, not parsed here).

SNAPSHOT metric: rows exist only under the latest complete month; projects
that no longer have suspects are pruned on reload, and rows under older
periods are removed outright. The digest deliberately EXCLUDES dq:openstay
(a snapshot has no month-over-month "new/cleared" meaning).

Run AFTER generate_bnl.py, alongside recompute_eva.py in the refresh runbook.

Usage:  py pipeline/recompute_openstay.py --dry-run   # counts only
        py pipeline/recompute_openstay.py             # write
"""
from pathlib import Path
import argparse
import json
import os
import sys
from datetime import date, timedelta

import truststore

truststore.inject_into_ssl()
from supabase import create_client  # noqa: E402

HERE = Path(__file__).resolve().parent
WEB = HERE.parent
BNL_JSON = WEB.parent / "outputs" / "bnl_data.json"


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
    ap.add_argument("--dry-run", action="store_true", help="Print counts; write nothing.")
    args = ap.parse_args()

    d = json.load(open(BNL_JSON, encoding="utf-8"))

    # Period = the last complete month AS LOADED (meta.dq_periods) — NOT derived
    # from the local JSON's as_of. The two can skew when the ETL half of a
    # refresh has run but the load half hasn't (observed 2026-08-04: local
    # as_of implied 2026-07 while Supabase DQ data ended 2026-06 — the rows
    # landed on a month the fix-list can't see). Fall back to as_of-derived
    # only if meta is unreachable.
    url, key = load_env()
    sb = create_client(url, key)
    try:
        monthly = (sb.table("meta").select("value").eq("key", "dq_periods")
                   .single().execute().data["value"].get("monthly") or [])
        period = monthly[-1]
    except Exception:
        as_of = date.fromisoformat(d["as_of"])
        period = (as_of.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")

    per_proj: dict[int, list[str]] = {}
    for r in d["roster"]:
        if not r.get("open_suspect"):
            continue
        for pj in (r.get("open_suspect_projects") or []):
            per_proj.setdefault(int(pj), []).append(str(r["pid"]))

    payload = [{"period": period, "project_id": pj, "metric": "dq:openstay",
                "personal_ids": list(dict.fromkeys(pids)), "detail": None}
               for pj, pids in sorted(per_proj.items())]
    n_clients = len({p for row in payload for p in row["personal_ids"]})
    print(f"dq:openstay — {n_clients} clients across {len(payload)} projects "
          f"(period {period})")

    if args.dry_run:
        print("Dry run — nothing written.")
        return

    for i in range(0, len(payload), 150):
        sb.table("drill_clients").upsert(
            payload[i:i + 150], on_conflict="period,project_id,metric").execute()
        print(f"  upserted {min(i + 150, len(payload))}/{len(payload)}", flush=True)

    # Snapshot semantics — prune projects that cleared, and any older periods.
    keys = {p["project_id"] for p in payload}
    existing = (sb.table("drill_clients").select("project_id, period")
                .eq("metric", "dq:openstay").execute().data or [])
    stale = [r for r in existing
             if r["period"] != period or r["project_id"] not in keys]
    for r in stale:
        sb.table("drill_clients").delete().eq("period", r["period"]) \
          .eq("project_id", r["project_id"]).eq("metric", "dq:openstay").execute()
    if stale:
        print(f"  pruned {len(stale)} stale rows")
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
