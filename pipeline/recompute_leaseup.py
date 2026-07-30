#!/usr/bin/env python3
"""Lease-up funnel loader (Pillar 3-4) — enrollment → move-in per PH-type project.

One row per PH/RRH/PSH project (types 3/9/10/13, DV excluded), snapshot as of the
last complete day of data (Export.csv ExportEndDate): open HoH enrollments split
into moved-in vs awaiting move-in, the awaiting queue aged into buckets, and
90-day move-in velocity. CE referrals are deliberately NOT a stage: Event.csv
cannot tie a referral to a target ProjectID, so a referral stage would be fiction.

Run in the refresh load half alongside recompute_util.py / recompute_dest.py.

Table (run once in the Supabase SQL editor):
  create table if not exists leaseup_funnel (
    project_id  bigint primary key,
    as_of       date not null,
    data        jsonb not null
  );
  alter table leaseup_funnel enable row level security;
  create policy "public read leaseup" on leaseup_funnel for select using (true);

data jsonb: { enrolled_hh, movedin_hh, awaiting, buckets: {lt30, d30_90, d90p},
              median_wait, max_wait, movedin_90d, entered_90d, ptype }
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
PH_TYPES = {3, 9, 10, 13}


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
    proj = pd.read_csv(DATA_DIR / "Project.csv", low_memory=False)
    enr = pd.read_csv(DATA_DIR / "Enrollment.csv", low_memory=False,
                      usecols=["EnrollmentID", "PersonalID", "ProjectID", "EntryDate",
                               "MoveInDate", "RelationshipToHoH", "HouseholdID"])
    ex = pd.read_csv(DATA_DIR / "Exit.csv", low_memory=False, usecols=["EnrollmentID", "ExitDate"])
    exp = pd.read_csv(DATA_DIR / "Export.csv")
    as_of = pd.to_datetime(exp["ExportEndDate"].iloc[0])

    enr["EntryDate"] = pd.to_datetime(enr["EntryDate"], errors="coerce")
    enr["MoveInDate"] = pd.to_datetime(enr["MoveInDate"], errors="coerce")
    enr["ExitDate"] = enr["EnrollmentID"].map(
        ex.assign(ExitDate=pd.to_datetime(ex["ExitDate"], errors="coerce")).set_index("EnrollmentID")["ExitDate"])

    dv = set(proj.loc[proj["TargetPopulation"] == 1, "ProjectID"])
    ptype = proj.set_index("ProjectID")["ProjectType"].to_dict()
    ph_ids = {p for p, t in ptype.items() if t in PH_TYPES} - dv

    hoh = enr[(enr["ProjectID"].isin(ph_ids)) & (enr["RelationshipToHoH"] == 1)
              & (enr["EntryDate"].notna()) & (enr["EntryDate"] <= as_of)]
    open_hoh = hoh[hoh["ExitDate"].isna()].copy()
    open_hoh["moved"] = open_hoh["MoveInDate"].notna() & (open_hoh["MoveInDate"] <= as_of)
    open_hoh["wait"] = (as_of - open_hoh["EntryDate"]).dt.days

    win90 = as_of - pd.Timedelta(days=90)
    rows = []
    for pid, g in open_hoh.groupby("ProjectID"):
        awaiting = g[~g["moved"]]
        w = awaiting["wait"]
        recent_mi = hoh[(hoh["ProjectID"] == pid) & hoh["MoveInDate"].notna()
                        & (hoh["MoveInDate"] > win90) & (hoh["MoveInDate"] <= as_of)]
        recent_en = hoh[(hoh["ProjectID"] == pid) & (hoh["EntryDate"] > win90)]
        rows.append({"project_id": int(pid), "as_of": as_of.date().isoformat(), "data": {
            "ptype": int(ptype.get(pid, -1)),
            "enrolled_hh": int(len(g)),
            "movedin_hh": int(g["moved"].sum()),
            "awaiting": int(len(awaiting)),
            "buckets": {"lt30": int((w < 30).sum()),
                        "d30_90": int(((w >= 30) & (w < 90)).sum()),
                        "d90p": int((w >= 90).sum())},
            "median_wait": int(w.median()) if len(w) else None,
            "max_wait": int(w.max()) if len(w) else None,
            "movedin_90d": int(len(recent_mi)),
            "entered_90d": int(len(recent_en)),
        }})
    print(f"  {len(rows)} PH-type projects (as of {as_of.date()})", flush=True)

    url, key = load_env()
    sb = create_client(url, key)
    for i in range(0, len(rows), 500):
        sb.table("leaseup_funnel").upsert(rows[i:i + 500], on_conflict="project_id").execute()
    # snapshot table: drop projects that no longer qualify
    keep = [r["project_id"] for r in rows]
    if keep:
        sb.table("leaseup_funnel").delete().not_.in_("project_id", keep).execute()
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
