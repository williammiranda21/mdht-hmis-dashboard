#!/usr/bin/env python3
"""Helpline enrollment verification — the one promise, checked from the data.

For every helpline case outreach marked CONFIRMED homeless:
  matched + unverified → look for an Enrollment.csv entry on the linked client
  dated on/after the confirmation date. Found → stamp verified_entry /
  verified_proj / verified_at. Read from the export, never self-reported.

Also re-matches confirmed-but-unmatched cases against client_index identifiers
(exact DOB + exact normalized name) so a caller who was new to HMIS links up
once their record appears — suggest-only elsewhere, but here an EXACT
DOB+first+last collision is strong enough to auto-link for verification
purposes (the case keeps showing who linked it: this script).

Run in the refresh load half, after upsert (step 12).
Usage:  py pipeline/verify_helpline.py [--dry-run]
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


def main():
    dry = "--dry-run" in sys.argv
    url, key = load_env()
    sb = create_client(url, key)

    cases = (sb.table("helpline_cases")
             .select("id, status, confirmed_at, matched_pid, first_name, last_name, dob, verified_entry")
             .eq("status", "confirmed").execute().data or [])
    todo = [c for c in cases if not c.get("verified_entry")]
    if not todo:
        print("verify_helpline: no confirmed-unverified cases.")
        return
    print(f"verify_helpline: {len(todo)} confirmed cases to check", flush=True)

    # ── Re-match unmatched confirmed cases (exact DOB + exact name only) ─────
    unmatched = [c for c in todo if not c.get("matched_pid")
                 and c.get("dob") and c.get("first_name") and c.get("last_name")]
    if unmatched:
        cl = pd.read_csv(DATA_DIR / "Client.csv", low_memory=False,
                         usecols=["PersonalID", "FirstName", "LastName", "DOB"])
        cl["DOB"] = pd.to_datetime(cl["DOB"], errors="coerce").dt.date.astype(str)
        cl["k"] = (cl["FirstName"].str.strip().str.lower().fillna("") + "|"
                   + cl["LastName"].str.strip().str.lower().fillna("") + "|" + cl["DOB"])
        idx = cl.groupby("k")["PersonalID"].agg(list).to_dict()
        for c in unmatched:
            k = f'{c["first_name"].strip().lower()}|{c["last_name"].strip().lower()}|{c["dob"]}'
            pids = idx.get(k, [])
            if len(pids) == 1:      # unique exact hit only — anything else stays manual
                c["matched_pid"] = pids[0]
                print(f'  case {c["id"]}: auto-linked to {pids[0][:10]}… (exact name+DOB)')
                if not dry:
                    sb.table("helpline_cases").update({"matched_pid": pids[0]}).eq("id", c["id"]).execute()

    # ── Enrollment check for every matched confirmed case ────────────────────
    matched = [c for c in todo if c.get("matched_pid") and c.get("confirmed_at")]
    if not matched:
        print("  nothing matched to verify yet.")
        return
    en = pd.read_csv(DATA_DIR / "Enrollment.csv", low_memory=False,
                     usecols=["PersonalID", "ProjectID", "EntryDate"])
    pr = pd.read_csv(DATA_DIR / "Project.csv", low_memory=False,
                     usecols=["ProjectID", "ProjectName"]).set_index("ProjectID")["ProjectName"]
    en["EntryDate"] = pd.to_datetime(en["EntryDate"], errors="coerce")
    by_pid = dict(tuple(en.dropna(subset=["EntryDate"]).groupby("PersonalID")))

    verified = 0
    for c in matched:
        g = by_pid.get(c["matched_pid"])
        if g is None:
            continue
        hits = g[g["EntryDate"] >= pd.Timestamp(c["confirmed_at"])]
        if hits.empty:
            continue
        first = hits.sort_values("EntryDate").iloc[0]
        patch = {
            "verified_entry": first["EntryDate"].date().isoformat(),
            "verified_proj": str(pr.get(first["ProjectID"], f'Project {first["ProjectID"]}')),
            "verified_at": pd.Timestamp.now(tz="UTC").isoformat(),
        }
        verified += 1
        print(f'  case {c["id"]}: ✓ enrolled {patch["verified_entry"]} — {patch["verified_proj"][:50]}')
        if not dry:
            sb.table("helpline_cases").update(patch).eq("id", c["id"]).execute()

    gap = len(matched) - verified
    print(f"Done. {verified} verified · {gap} still confirmed-without-enrollment"
          + (" (dry run — nothing written)" if dry else ""), flush=True)


if __name__ == "__main__":
    main()
