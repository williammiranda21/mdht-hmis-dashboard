#!/usr/bin/env python3
"""Eva-based data-quality check registry — v1 (Pillar: Eva DQ rebuild).

Computes HUD Eva's client/enrollment-level checks (github.com/abtassociates/eva,
EvaChecks.csv ids kept) against the local hud_data export and emits findings in
the SAME shape as the dq:* fix-lists: drill_clients rows keyed
  period = latest COMPLETE month | project_id | metric = 'eva:<id>'
with personal_ids (unique clients) and detail = [{pid, entry}] per offending
enrollment — so the fix-list UI, digest new/cleared diffs, and agency RLS
scoping all inherit Eva checks with no new plumbing.

v1 scope (user-approved 2026-07-30; specs in outputs/eva_check_inventory.md):
  Household integrity  2 no-HoH · 3 multiple-HoH · 4 missing-relationship · 86 children-only
  Impossible dates     14 future-exit · 99 exit-before-entry · 75 entry-after-created ·
                       84 entered-before-born · 143 age>100 · 40 move-in-outside-stay ·
                       69 homeless-start-after-entry
  Duplicates           1 same client+project+entry-date (High Priority)

Universe: enrollments active within the trailing 12 months of the export end
(older closed stays aren't actionable). APR Q6 dq:* records are untouched.
Severity + guided copy live web-side in lib/evaChecks.ts (single auditable map).

Usage:  py pipeline/recompute_eva.py --dry-run   # counts only, no writes
        py pipeline/recompute_eva.py             # upsert into drill_clients
Parity note: results are provisional until reconciled against the Eva app itself.
"""
from pathlib import Path
import argparse, os, sys
import pandas as pd
import truststore

truststore.inject_into_ssl()
from supabase import create_client  # noqa: E402

HERE = Path(__file__).resolve().parent
WEB = HERE.parent
DATA_DIR = WEB.parent / "hud_data"
LOOKBACK_DAYS = 365
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
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="Print counts; write nothing.")
    args = ap.parse_args()

    print("Loading HMIS CSVs …", flush=True)
    exp = pd.read_csv(DATA_DIR / "Export.csv")
    as_of = pd.to_datetime(exp["ExportEndDate"].iloc[0])
    proj = pd.read_csv(DATA_DIR / "Project.csv", low_memory=False,
                       usecols=["ProjectID", "ProjectType"])
    cli = pd.read_csv(DATA_DIR / "Client.csv", low_memory=False,
                      usecols=["PersonalID", "DOB"])
    enr = pd.read_csv(DATA_DIR / "Enrollment.csv", low_memory=False,
                      usecols=["EnrollmentID", "PersonalID", "ProjectID", "EntryDate",
                               "HouseholdID", "RelationshipToHoH", "MoveInDate",
                               "DateToStreetESSH", "DateCreated"])
    ex = pd.read_csv(DATA_DIR / "Exit.csv", low_memory=False,
                     usecols=["EnrollmentID", "ExitDate"])

    for c in ("EntryDate", "MoveInDate", "DateToStreetESSH", "DateCreated"):
        enr[c] = pd.to_datetime(enr[c], errors="coerce")
    ex["ExitDate"] = pd.to_datetime(ex["ExitDate"], errors="coerce")
    cli["DOB"] = pd.to_datetime(cli["DOB"], errors="coerce")

    e = (enr.merge(ex, on="EnrollmentID", how="left")
            .merge(cli, on="PersonalID", how="left")
            .merge(proj, on="ProjectID", how="left"))
    # Universe: active within the trailing 12 months (older closed stays aren't actionable)
    lb = as_of - pd.Timedelta(days=LOOKBACK_DAYS)
    e = e[(e["EntryDate"].notna()) & (e["EntryDate"] <= as_of + pd.Timedelta(days=366))
          & (e["ExitDate"].isna() | (e["ExitDate"] >= lb))].copy()
    e["age_entry"] = (e["EntryDate"] - e["DOB"]).dt.days / 365.25

    findings: dict[str, pd.DataFrame] = {}   # check id -> offending enrollment rows

    def flag(cid: str, mask_or_df):
        df = e[mask_or_df] if not isinstance(mask_or_df, pd.DataFrame) else mask_or_df
        df = df[df["ProjectID"].notna()]
        if len(df):
            findings[cid] = df[["PersonalID", "ProjectID", "EntryDate"]].copy()

    # ── Household integrity ──────────────────────────────────────────────────
    hh = e.groupby("HouseholdID")["RelationshipToHoH"]
    n_hoh = hh.apply(lambda s: int((s == 1).sum()))
    no_hoh = set(n_hoh[n_hoh == 0].index)
    multi_hoh = set(n_hoh[n_hoh >= 2].index)
    flag("2", e["HouseholdID"].isin(no_hoh))
    flag("3", e["HouseholdID"].isin(multi_hoh))
    flag("4", e["RelationshipToHoH"].isna() | (e["RelationshipToHoH"] == 99))
    oldest = e.groupby("HouseholdID")["age_entry"].max()
    kids_only = set(oldest[(oldest.notna()) & (oldest < 12)].index)
    flag("86", e["HouseholdID"].isin(kids_only))

    # ── Impossible dates ─────────────────────────────────────────────────────
    flag("14", e["ExitDate"].notna() & (e["ExitDate"] > as_of))
    flag("99", e["ExitDate"].notna() & (e["ExitDate"] < e["EntryDate"]))
    flag("75", e["DateCreated"].notna()
               & (e["EntryDate"].dt.normalize() > e["DateCreated"].dt.normalize()))
    flag("84", e["age_entry"].notna() & (e["age_entry"] < 0))
    flag("143", e["age_entry"].notna() & (e["age_entry"] > 100))
    flag("40", e["ProjectType"].isin(PH_TYPES) & e["MoveInDate"].notna()
               & ((e["MoveInDate"] < e["EntryDate"])
                  | (e["ExitDate"].notna() & (e["MoveInDate"] > e["ExitDate"]))))
    flag("69", e["DateToStreetESSH"].notna() & (e["DateToStreetESSH"] > e["EntryDate"]))

    # ── Duplicate enrollments (High Priority) ────────────────────────────────
    dup = e.duplicated(subset=["PersonalID", "ProjectID", "EntryDate"], keep=False)
    flag("1", dup)

    # ── Report ───────────────────────────────────────────────────────────────
    period = (as_of.replace(day=1) - pd.Timedelta(days=1)).strftime("%Y-%m")  # latest complete month
    print(f"\nEva v1 findings (universe: active since {lb.date()}, as of {as_of.date()}; "
          f"emitted under period {period}):")
    total_rows = 0
    payload = []
    for cid in sorted(findings, key=lambda x: int(x)):
        df = findings[cid]
        by_proj = df.groupby("ProjectID")
        n_proj = by_proj.ngroups
        print(f"  eva:{cid:<4} {len(df):>6} enrollments · {df['PersonalID'].nunique():>6} clients · {n_proj:>3} projects")
        for pid, g in by_proj:
            pids = list(dict.fromkeys(g["PersonalID"].astype(str)))
            detail = [{"pid": str(r.PersonalID),
                       "entry": r.EntryDate.date().isoformat() if pd.notna(r.EntryDate) else None}
                      for r in g.itertuples()]
            payload.append({"period": period, "project_id": int(pid),
                            "metric": f"eva:{cid}", "personal_ids": pids, "detail": detail})
            total_rows += 1
    print(f"\n  -> {total_rows} drill_clients rows")

    if args.dry_run:
        print("Dry run — nothing written.")
        return

    url, key = load_env()
    sb = create_client(url, key)
    for i in range(0, len(payload), 150):
        sb.table("drill_clients").upsert(payload[i:i + 150],
                                         on_conflict="period,project_id,metric").execute()
        print(f"  upserted {min(i + 150, len(payload))}/{len(payload)}", flush=True)
    # Snapshot semantics: drop eva:* rows for THIS period that no longer fire
    keys = {(r["project_id"], r["metric"]) for r in payload}
    existing = sb.table("drill_clients").select("project_id, metric").eq("period", period) \
                 .like("metric", "eva:%").execute().data
    stale = [r for r in (existing or []) if (r["project_id"], r["metric"]) not in keys]
    for r in stale:
        sb.table("drill_clients").delete().eq("period", period) \
          .eq("project_id", r["project_id"]).eq("metric", r["metric"]).execute()
    if stale:
        print(f"  pruned {len(stale)} cleared eva rows")
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
