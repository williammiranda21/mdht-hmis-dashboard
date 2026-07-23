#!/usr/bin/env python3
"""
Recompute Unit Utilization with DV (Domestic Violence) beds excluded, and upsert it.

Why: Victim Service Provider / DV projects (Project.csv TargetPopulation == 1) report
bed inventory to the CoC for the Housing Inventory Count but do NOT enter client-level
data into HMIS (they use a comparable database). Their beds therefore inflate capacity
with ~zero occupancy, artificially deflating utilization. They are informational only
and must not affect bed counts or utilization.

This faithfully replicates `_util_per` from apr_monthly_report.py (verified to reproduce
the existing numbers exactly when the DV filter is off) and recomputes only the
utilization payload — no need to re-run the full report pipeline. It then upserts
`util_metrics` and refreshes `meta.util_periods`.

Usage (run from hmis-web/):
  python pipeline/recompute_util.py --verify     # print before/after for a few periods, no write
  python pipeline/recompute_util.py              # recompute (DV excluded) and upsert
  python pipeline/recompute_util.py --keep-dv    # recompute WITHOUT excluding DV (for validation)
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

import pandas as pd
import numpy as np

HERE = Path(__file__).resolve().parent
WEB = HERE.parent
REPO = WEB.parent
DATA_DIR = REPO / "hud_data"

_PT = {0: "ES", 1: "ES", 2: "TH", 3: "PSH", 8: "SH", 13: "RRH", 9: "PH", 10: "PH"}
_FIXED = {"ES", "TH", "SH", "PSH"}
_UNITB = {"RRH", "PH"}


# ── Load + prep (mirrors apr_monthly_report.py's enroll/_inv construction) ────
def load_frames(exclude_dv: bool):
    proj = pd.read_csv(DATA_DIR / "Project.csv", low_memory=False)
    inv = pd.read_csv(DATA_DIR / "Inventory.csv", low_memory=False)
    enr = pd.read_csv(DATA_DIR / "Enrollment.csv", low_memory=False)
    ex = pd.read_csv(DATA_DIR / "Exit.csv", low_memory=False)
    cli = pd.read_csv(DATA_DIR / "Client.csv", low_memory=False)

    for c in ("InventoryStartDate", "InventoryEndDate"):
        inv[c] = pd.to_datetime(inv[c], errors="coerce")
    enr["EntryDate"] = pd.to_datetime(enr["EntryDate"], errors="coerce")
    ex["ExitDate"] = pd.to_datetime(ex["ExitDate"], errors="coerce")
    cli["DOB"] = pd.to_datetime(cli["DOB"], errors="coerce")

    dv_ids = set(proj.loc[proj["TargetPopulation"] == 1, "ProjectID"])

    e = (
        enr.merge(ex[["EnrollmentID", "ExitDate"]], on="EnrollmentID", how="left")
        .merge(cli[["PersonalID", "DOB"]], on="PersonalID", how="left")
        .merge(proj[["ProjectID", "ProjectType", "ProjectName"]], on="ProjectID", how="left")
    )
    age_days = (e["EntryDate"] - e["DOB"]).dt.days
    e["AgeAtEntry"] = (
        (age_days / 365.25).round(0)
        .where(e["DOB"].notna() & e["EntryDate"].notna(), other=-1)
        .fillna(-1).astype(int)
    )
    hh_has_minor = (
        e.groupby("HouseholdID")["AgeAtEntry"]
        .apply(lambda a: ((a >= 0) & (a < 18)).any())
        .reset_index().rename(columns={"AgeAtEntry": "HasMinorChild"})
    )
    e = e.merge(hh_has_minor, on="HouseholdID", how="left")
    e["HasMinorChild"] = e["HasMinorChild"].fillna(False)

    inv = inv.merge(proj[["ProjectID", "ProjectType", "ProjectName"]], on="ProjectID", how="left")
    inv["T"] = inv["ProjectType"].map(_PT)
    inv["fi"] = inv["HouseholdType"].isin([3, 4])

    eu = e[e["ProjectType"].map(_PT).notna()].copy()
    eu["T"] = eu["ProjectType"].map(_PT)
    eu["fam"] = eu["HasMinorChild"].fillna(False)

    if exclude_dv:
        inv = inv[~inv["ProjectID"].isin(dv_ids)].copy()
        eu = eu[~eu["ProjectID"].isin(dv_ids)].copy()

    return inv, eu, len(dv_ids)


def make_util_per(_inv, _eu):
    """Returns a _util_per(ps, pe) closure identical in logic to apr_monthly_report.py."""
    def _util_per(ps, pe):
        nextm = pe + pd.Timedelta(days=1)
        days = max((nextm - ps).days, 1)
        ai = _inv[(_inv["InventoryStartDate"] <= pe) & (_inv["InventoryEndDate"].isna() | (_inv["InventoryEndDate"] >= ps)) & _inv["T"].notna()]
        if ai.empty:
            return None
        e = _eu[(_eu["EntryDate"] <= pe) & (_eu["ExitDate"].isna() | (_eu["ExitDate"] >= ps))].copy()
        e["nights"] = ((e["ExitDate"].fillna(nextm).clip(upper=nextm)) - (e["EntryDate"].clip(lower=ps))).dt.days.clip(lower=0)
        e["pit"] = ((e["EntryDate"] <= pe) & (e["ExitDate"].isna() | (e["ExitDate"] > pe))).astype(int)
        projs = []
        for pid, grp in ai.groupby("ProjectID"):
            t = grp["T"].iloc[0]
            nm = str(grp["ProjectName"].iloc[0] or f"Project {pid}")[:46]
            if t in _FIXED:
                cap = int(grp["BedInventory"].sum()); ce = e[e["ProjectID"] == pid]
                occ = ce["nights"].sum() / days; pit = int(ce["pit"].sum()); kind = "beds"
            else:
                cap = int(grp["UnitInventory"].sum()); ch = e[(e["ProjectID"] == pid) & (e["RelationshipToHoH"] == 1)]
                occ = ch["nights"].sum() / days; pit = int(ch["pit"].sum()); kind = "units"
            if cap <= 0:
                continue
            projs.append({"n": nm, "t": t, "k": kind, "cap": cap, "occ": round(float(occ), 1),
                          "util": round(float(occ) / cap * 100, 1), "pit": pit, "putil": round(pit / cap * 100, 1)})

        def _hh(capmask, occmask, types, useBeds=True):
            col = "BedInventory" if useBeds else "UnitInventory"
            cap = int(ai[ai["T"].isin(types) & capmask][col].sum())
            sel = e[e["T"].isin(types) & occmask]; occ = sel["nights"].sum() / days; pit = int(sel["pit"].sum())
            return {"c": cap, "o": round(float(occ)), "u": round(float(occ) / cap * 100, 1) if cap else None,
                    "p": pit, "pu": round(pit / cap * 100, 1) if cap else None}

        _T = ai["T"].notna(); _Te = e["T"].notna()
        byType = []
        for t in ["ES", "TH", "SH", "PSH"]:
            cap = int(ai[ai["T"] == t]["BedInventory"].sum())
            if cap <= 0:
                continue
            o = e[e["T"] == t]["nights"].sum() / days; p = e[e["T"] == t]["pit"].sum()
            byType.append([t, cap, round(float(o) / cap * 100, 1), round(float(p) / cap * 100, 1)])
        allhh = _hh(_T, _Te, _FIXED); allhh["bt"] = byType
        ind = _hh(~ai["fi"], ~e["fam"], _FIXED)
        fam = _hh(ai["fi"], e["fam"], _FIXED)
        unitT = []
        for t in ["RRH", "PH"]:
            cap = int(ai[ai["T"] == t]["UnitInventory"].sum())
            if cap <= 0:
                continue
            ch = e[(e["T"] == t) & (e["RelationshipToHoH"] == 1)]
            unitT.append([t, cap, round(float(ch["nights"].sum()) / days / cap * 100, 1), round(float(ch["pit"].sum()) / cap * 100, 1)])
        ucap = int(ai[ai["T"].isin(_UNITB)]["UnitInventory"].sum())
        usel = e[e["T"].isin(_UNITB) & (e["RelationshipToHoH"] == 1)]
        uocc = usel["nights"].sum() / days; upit = int(usel["pit"].sum())
        unit = {"c": ucap, "o": round(float(uocc)), "u": round(float(uocc) / ucap * 100, 1) if ucap else None,
                "p": upit, "pu": round(upit / ucap * 100, 1) if ucap else None, "bt": unitT}
        empty = max(0, round(allhh["c"] - allhh["o"]))
        over = len([p for p in projs if p["util"] > 110]); under = len([p for p in projs if p["util"] < 65])
        return {"hh": {"All": allhh, "Individuals": ind, "Families": fam}, "unit": unit,
                "empty": empty, "over": over, "under": under, "projects": projs}

    return _util_per


# Report boundary = last day of the most recent COMPLETE month (mirrors
# apr_monthly_report.py REPORT_END). In-progress quarter/FY periods are capped here so
# their inventory window matches what the original computed (don't reach into future months).
from datetime import datetime as _dt
REPORT_END = pd.Timestamp(_dt.now().replace(day=1)) - pd.Timedelta(days=1)


def period_range(key: str):
    """(start, end) Timestamps for a util period key. FY = Oct 1 – Sep 30; end capped at REPORT_END."""
    m = re.match(r"^(\d{4})-(\d{2})$", key)
    if m:
        ps = pd.Timestamp(int(m[1]), int(m[2]), 1)
        return ps, min(ps + pd.offsets.MonthEnd(0), REPORT_END)
    q = re.match(r"^FY(\d{4})-Q([1-4])$", key)
    if q:
        y, qq = int(q[1]), int(q[2])
        ps, pe = {
            1: (pd.Timestamp(y - 1, 10, 1), pd.Timestamp(y - 1, 12, 31)),
            2: (pd.Timestamp(y, 1, 1), pd.Timestamp(y, 3, 31)),
            3: (pd.Timestamp(y, 4, 1), pd.Timestamp(y, 6, 30)),
            4: (pd.Timestamp(y, 7, 1), pd.Timestamp(y, 9, 30)),
        }[qq]
        return ps, min(pe, REPORT_END)
    f = re.match(r"^FY(\d{4})$", key)
    if f:
        y = int(f[1])
        return pd.Timestamp(y - 1, 10, 1), min(pd.Timestamp(y, 9, 30), REPORT_END)
    raise ValueError(f"Unrecognized util period key: {key!r}")


# ── Supabase ─────────────────────────────────────────────────────────────────
def make_client():
    try:
        import truststore
        truststore.inject_into_ssl()
    except ImportError:
        pass
    env_path = WEB / ".env.local"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        sys.exit("Missing Supabase credentials in hmis-web/.env.local")
    from supabase import create_client
    return create_client(url, key)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify", action="store_true", help="Print before/after for a few periods, no write.")
    ap.add_argument("--keep-dv", action="store_true", help="Do NOT exclude DV (validation only).")
    args = ap.parse_args()

    exclude_dv = not args.keep_dv
    print(f"Loading HMIS CSVs … (DV exclusion: {'ON' if exclude_dv else 'OFF'})", flush=True)
    _inv, _eu, n_dv = load_frames(exclude_dv)
    print(f"  {n_dv} DV (TargetPopulation==1) projects {'excluded' if exclude_dv else 'kept'}", flush=True)
    util_per = make_util_per(_inv, _eu)

    client = make_client()
    meta = client.table("meta").select("value").eq("key", "util_periods").maybe_single().execute()
    period_lists = meta.data["value"] if meta.data else {}
    keys = [k for lst in period_lists.values() for k in lst]
    print(f"  recomputing {len(keys)} periods", flush=True)

    if args.verify:
        for k in ["2026-05", "FY2026-Q3", "FY2026"]:
            if k not in keys:
                continue
            ps, pe = period_range(k)
            r = util_per(ps, pe)
            cur = client.table("util_metrics").select("data").eq("period", k).maybe_single().execute()
            old = cur.data["data"]["hh"]["All"] if cur.data else {}
            print(f"\n[{k}] bed util  current: {old.get('c')} beds / {old.get('u')}%   "
                  f"recomputed: {r['hh']['All']['c']} beds / {r['hh']['All']['u']}%")
        print("\n(verify only — nothing written)")
        return

    payload = []
    for k in keys:
        ps, pe = period_range(k)
        r = util_per(ps, pe)
        if r:
            payload.append({"period": k, "data": r})
    for i in range(0, len(payload), 200):
        client.table("util_metrics").upsert(payload[i:i + 200], on_conflict="period").execute()
    print(f"  upserted {len(payload)} util_metrics rows", flush=True)
    # refresh the period list (unchanged keys, but keep it authoritative)
    client.table("meta").upsert({"key": "util_periods", "value": {
        "monthly": sorted(k for k in keys if re.match(r"^\d{4}-\d{2}$", k)),
        "quarterly": sorted(k for k in keys if re.match(r"^FY\d{4}-Q", k)),
        "fiscal": sorted(k for k in keys if re.match(r"^FY\d{4}$", k)),
    }}, on_conflict="key").execute()
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
