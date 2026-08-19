#!/usr/bin/env python3
"""Load client_index — minimal identifiers for Youth Connect HMIS matching.

One row per HMIS client (hashed PersonalID + normalized name, DOB, SSN-4, sex)
from hud_data/Client.csv, upserted into `client_index`. The table has RLS on
and NO select policy — only the service role (the /api/yc/match route) reads
it; nothing browser-facing can.

Run in the refresh load half, after upsert_to_supabase.py (any order among the
recomputes). Table DDL: supabase/youth_connect.sql (run once in the SQL editor).

Usage:  py pipeline/load_client_index.py [--dry-run]
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


def norm(s) -> str | None:
    s = "" if pd.isna(s) else str(s).strip().lower()
    return s or None


def main():
    dry = "--dry-run" in sys.argv
    cl = pd.read_csv(DATA_DIR / "Client.csv", low_memory=False, dtype={"SSN": str},
                     usecols=["PersonalID", "FirstName", "LastName", "DOB", "SSN", "Sex"])
    cl["DOB"] = pd.to_datetime(cl["DOB"], errors="coerce")
    rows = []
    for r in cl.itertuples(index=False):
        ssn = ("" if pd.isna(r.SSN) else str(r.SSN).strip())
        rows.append({
            "pid": r.PersonalID,
            "first_n": norm(r.FirstName),
            "last_n": norm(r.LastName),
            "dob": r.DOB.date().isoformat() if pd.notna(r.DOB) else None,
            "ssn4": ssn[-4:] if len(ssn) == 9 and ssn.isdigit() else None,
            "sex": int(r.Sex) if pd.notna(r.Sex) else None,
        })
    print(f"client_index: {len(rows):,} clients from Client.csv", flush=True)
    if dry:
        print("(dry run — nothing written)")
        return

    url, key = load_env()
    sb = create_client(url, key)
    for i in range(0, len(rows), 1000):
        sb.table("client_index").upsert(rows[i:i + 1000], on_conflict="pid").execute()
        if (i // 1000) % 10 == 0 or i + 1000 >= len(rows):
            print(f"  upserted {min(i + 1000, len(rows)):,}/{len(rows):,}", flush=True)
    # Prune clients that left the export (full-export re-baseline can drop pids).
    have = set()
    off = 0
    while True:
        page = sb.table("client_index").select("pid").range(off, off + 9999).execute().data
        if not page:
            break
        have.update(p["pid"] for p in page)
        off += 10000
    stale = sorted(have - {r["pid"] for r in rows})
    for i in range(0, len(stale), 500):
        sb.table("client_index").delete().in_("pid", stale[i:i + 500]).execute()
    print(f"  pruned {len(stale):,} stale rows · table now {len(rows):,}", flush=True)
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
