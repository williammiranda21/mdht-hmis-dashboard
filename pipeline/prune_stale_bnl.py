#!/usr/bin/env python3
"""
Delete bnl_clients rows that are no longer in the current roster.

WHY THIS EXISTS
---------------
`upsert_to_supabase.py` only ever INSERTs and UPDATEs — PostgREST upsert has no
concept of "rows that vanished from the source". So when the roster shrinks
(clients age out of the 24-month BNL window, or a PersonalID changes), their rows
stay in Postgres forever and the page shows phantom clients.

Do NOT prune by `as_of` date. That looks correct but silently fails whenever two
regens land on the same calendar day: the orphans carry the current `as_of` too.
(Observed 2026-07-23 — a date-based prune missed all 145 orphans.) The only
reliable rule is a pid-set difference against the roster we just loaded.

Run this AFTER `upsert_to_supabase.py`, as the last step of a refresh:

  python pipeline/upsert_to_supabase.py --verify
  python pipeline/recompute_util.py
  python pipeline/prune_stale_bnl.py            # <- this

Usage:
  python prune_stale_bnl.py              # prune
  python prune_stale_bnl.py --dry-run    # report what would be deleted, change nothing

Env (read from hmis-web/.env.local, same as the upsert):
  NEXT_PUBLIC_SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent      # hmis-web/pipeline
WEB = HERE.parent                           # hmis-web
REPO = WEB.parent                           # repo root
ROSTER = REPO / "outputs" / "bnl_data.json"

PAGE = 1000        # Supabase caps responses at 1000 rows
DELETE_BATCH = 100 # keep the ?pid=in.(...) URL well under any length limit


def load_env() -> tuple[str, str]:
    env_path = WEB / ".env.local"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        sys.exit("Missing Supabase credentials in hmis-web/.env.local")
    return url, key


def make_client(url: str, key: str):
    # County firewall TLS-inspects HTTPS; route verification through the OS store.
    try:
        import truststore

        truststore.inject_into_ssl()
    except ImportError:
        print("  (truststore not installed — see pipeline/requirements.txt)", flush=True)
    from supabase import create_client

    return create_client(url, key)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="report orphans without deleting")
    args = ap.parse_args()

    if not ROSTER.exists():
        sys.exit(f"Roster not found: {ROSTER}\nRun generate_bnl.py first.")

    with ROSTER.open(encoding="utf-8") as f:
        roster = json.load(f)["roster"]
    src = {r["pid"] for r in roster}
    print(f"roster (source): {len(src):,} clients", flush=True)

    client = make_client(*load_env())

    db: set[str] = set()
    frm = 0
    while True:
        batch = client.table("bnl_clients").select("pid").range(frm, frm + PAGE - 1).execute().data
        if not batch:
            break
        db |= {r["pid"] for r in batch}
        frm += len(batch)          # advance by rows RECEIVED, not rows requested
    print(f"bnl_clients (db): {len(db):,} rows", flush=True)

    orphans = sorted(db - src)
    if not orphans:
        print("No stale rows — db matches the roster.")
        return 0

    print(f"stale rows to delete: {len(orphans):,}", flush=True)
    if args.dry_run:
        for pid in orphans[:10]:
            print(f"  would delete {pid}")
        if len(orphans) > 10:
            print(f"  … and {len(orphans) - 10:,} more")
        print("\n--dry-run: nothing was deleted.")
        return 0

    for i in range(0, len(orphans), DELETE_BATCH):
        client.table("bnl_clients").delete().in_("pid", orphans[i:i + DELETE_BATCH]).execute()
        print(f"  deleted {min(i + DELETE_BATCH, len(orphans)):,}/{len(orphans):,}", flush=True)

    total = client.table("bnl_clients").select("*", count="exact").limit(1).execute().count
    print(f"\nDone. bnl_clients now {total:,} rows "
          f"({'matches' if total == len(src) else 'DOES NOT MATCH'} roster {len(src):,}).")
    return 0 if total == len(src) else 1


if __name__ == "__main__":
    sys.exit(main())
