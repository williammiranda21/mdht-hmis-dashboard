#!/usr/bin/env python3
"""Eva-based data-quality check registry — v2 (per reporting period).

Computes HUD Eva's client/enrollment-level checks (github.com/abtassociates/eva,
EvaChecks.csv ids kept) against the local hud_data export and emits findings in
the SAME shape as the dq:* fix-lists: drill_clients rows keyed
  period = each COMPLETE month | project_id | metric = 'eva:<id>'
with personal_ids (unique clients) and detail = [{pid, entry, eid}] per
offending enrollment — so the fix-list UI, CSV export, digest new/cleared
diffs, and agency RLS scoping all inherit Eva checks with no new plumbing.

v2 (2026-08-13, user directive): findings are emitted PER REPORTING PERIOD —
every complete month since PERIODS_START — with each period's universe =
enrollments ACTIVE during that month. The DQ tab's Household/Dates/Duplicates
columns follow the period picker like every other column. Records are judged
AS THEY STAND in the current export (WellSky exports carry no history), so a
fix clears the flag in every period — the frozen-history job belongs to the
dq_snapshots ledger, not here. The newest month additionally includes
enrollments future-dated past the export end, so extreme future-dating (e.g.
a 2030 typo) is visible somewhere instead of falling outside every window.

Checks (user-approved 2026-07-30; specs in outputs/eva_check_inventory.md):
  Household integrity  2 no-HoH · 3 multiple-HoH · 4 missing-relationship · 86 children-only
  Impossible dates     14 future-exit · 99 exit-before-entry · 75 entry-after-created
                       (PSH/OPH entries before 10/1/2017 excused, per Eva) ·
                       84 entered-before-born · 143 age>100 · 40 move-in-outside-stay
                       (incl. move-in dated after the export end) ·
                       69 homeless-start-after-entry
  Duplicates           1 same client+project+entry-date (High Priority) ·
                       77 overlapping stays at the same project, different entry
                       dates — incl. an earlier stay never exited (Warning;
                       added 2026-08-13, closes the concurrent-open blind spot
                       neither eva:1 nor APR Q6b's start-date check covers)

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
PH_TYPES = {3, 9, 10, 13}
# First complete month covered — matches the dashboard's FY23 reporting start.
PERIODS_START = pd.Timestamp("2022-10-01")
# Eva excuses check 75 for PSH/OPH entries predating the FY2018 data standards.
PSH_OPH_TYPES = {3, 9, 10}
ENTRY_CREATED_FLOOR = pd.Timestamp("2017-10-01")


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


def month_periods(as_of: pd.Timestamp) -> list[tuple[str, pd.Timestamp, pd.Timestamp]]:
    """(key, start, end) for every COMPLETE month from PERIODS_START to as_of."""
    latest_end = as_of.normalize().replace(day=1) - pd.Timedelta(days=1)
    out = []
    cur = PERIODS_START
    while cur + pd.offsets.MonthEnd(0) <= latest_end:
        end = cur + pd.offsets.MonthEnd(0)
        out.append((cur.strftime("%Y-%m"), cur, end))
        cur = (cur + pd.offsets.MonthBegin(1)).normalize()
    return out


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

    e0 = (enr.merge(ex, on="EnrollmentID", how="left")
             .merge(cli, on="PersonalID", how="left")
             .merge(proj, on="ProjectID", how="left"))
    e0 = e0[e0["EntryDate"].notna() & e0["ProjectID"].notna()].copy()
    e0["age_entry"] = (e0["EntryDate"] - e0["DOB"]).dt.days / 365.25

    # ── Check 77 (Project Overlaps) — precomputed once over ALL stays: same
    # client + same project, stays overlapping in time with DIFFERENT entry
    # dates (identical dates are eva:1's). An OPEN earlier stay overlaps
    # everything after it — the re-enrolled-without-exiting near-duplicate.
    # Same-day touch (exit == next entry) is excused (strict <, matches Q6b).
    # Both members of the pair are flagged so the fix-list shows both rows.
    _s = e0.sort_values("EntryDate", kind="stable")
    _grp = [_s["PersonalID"], _s["ProjectID"]]
    _prev_exit = _s.groupby(["PersonalID", "ProjectID"])["ExitDate"].shift()
    _prev_entry = _s.groupby(["PersonalID", "ProjectID"])["EntryDate"].shift()
    _later = (_prev_entry.notna() & (_prev_entry != _s["EntryDate"])
              & (_prev_exit.isna() | (_s["EntryDate"] < _prev_exit)))
    _earlier = _later.groupby(_grp).shift(-1).fillna(False).astype(bool)
    e0["_ovl77"] = _later | _earlier

    periods = month_periods(as_of)
    if not periods:
        sys.exit("No complete months in range — check Export.csv ExportEndDate.")
    latest_key = periods[-1][0]
    print(f"Export end {as_of.date()} → {len(periods)} complete months "
          f"({periods[0][0]} … {latest_key})")

    payload = []
    latest_counts: dict[str, tuple[int, int]] = {}

    for key, p_start, p_end in periods:
        # Universe: enrollments ACTIVE during this month. The newest month also
        # takes future-dated entries so year-typo records are visible somewhere.
        m = (e0["EntryDate"] <= p_end) & (e0["ExitDate"].isna() | (e0["ExitDate"] >= p_start))
        if key == latest_key:
            m = m | (e0["EntryDate"] > p_end)
        e = e0[m]
        if not len(e):
            continue

        findings: dict[str, pd.DataFrame] = {}

        def flag(cid: str, mask):
            df = e[mask]
            if len(df):
                findings[cid] = df[["PersonalID", "ProjectID", "EntryDate", "EnrollmentID"]]

        # ── Household integrity (composition within this month's universe) ──
        n_hoh = e.groupby("HouseholdID")["RelationshipToHoH"].apply(lambda s: int((s == 1).sum()))
        flag("2", e["HouseholdID"].isin(set(n_hoh[n_hoh == 0].index)))
        flag("3", e["HouseholdID"].isin(set(n_hoh[n_hoh >= 2].index)))
        flag("4", e["RelationshipToHoH"].isna() | (e["RelationshipToHoH"] == 99))
        oldest = e.groupby("HouseholdID")["age_entry"].max()
        flag("86", e["HouseholdID"].isin(set(oldest[(oldest.notna()) & (oldest < 12)].index)))

        # ── Impossible dates ─────────────────────────────────────────────────
        flag("14", e["ExitDate"].notna() & (e["ExitDate"] > as_of))
        flag("99", e["ExitDate"].notna() & (e["ExitDate"] < e["EntryDate"]))
        # 75: Eva excuses PSH/OPH entries before 10/1/2017 (long-tenure stays
        # predate the data standard that made DateCreated meaningful).
        flag("75", e["DateCreated"].notna()
                   & (e["EntryDate"].dt.normalize() > e["DateCreated"].dt.normalize())
                   & ~(e["ProjectType"].isin(PSH_OPH_TYPES)
                       & (e["EntryDate"] < ENTRY_CREATED_FLOOR)))
        flag("84", e["age_entry"].notna() & (e["age_entry"] < 0))
        flag("143", e["age_entry"].notna() & (e["age_entry"] > 100))
        # 40: outside the stay OR dated after the export end (future move-in on
        # an open enrollment was previously invisible).
        flag("40", e["ProjectType"].isin(PH_TYPES) & e["MoveInDate"].notna()
                   & ((e["MoveInDate"] < e["EntryDate"])
                      | (e["ExitDate"].notna() & (e["MoveInDate"] > e["ExitDate"]))
                      | (e["MoveInDate"] > as_of)))
        flag("69", e["DateToStreetESSH"].notna() & (e["DateToStreetESSH"] > e["EntryDate"]))

        # ── Duplicate enrollments (High Priority) ────────────────────────────
        flag("1", e.duplicated(subset=["PersonalID", "ProjectID", "EntryDate"], keep=False))
        # ── Overlapping stays (Warning) — pair membership precomputed above ──
        flag("77", e["_ovl77"])

        for cid, df in findings.items():
            if key == latest_key:
                latest_counts[cid] = (len(df), df["PersonalID"].nunique())
            for pid, g in df.groupby("ProjectID"):
                pids = list(dict.fromkeys(g["PersonalID"].astype(str)))
                detail = [{"pid": str(r.PersonalID),
                           "entry": r.EntryDate.date().isoformat() if pd.notna(r.EntryDate) else None,
                           "eid": str(r.EnrollmentID) if pd.notna(r.EnrollmentID) else None}
                          for r in g.itertuples()]
                payload.append({"period": key, "project_id": int(pid),
                                "metric": f"eva:{cid}", "personal_ids": pids, "detail": detail})

    print(f"\nEva v2 — latest month ({latest_key}) findings:")
    for cid in sorted(latest_counts, key=lambda x: int(x)):
        n_enr, n_cli = latest_counts[cid]
        print(f"  eva:{cid:<4} {n_enr:>6} enrollments · {n_cli:>6} clients")
    print(f"  -> {len(payload):,} drill_clients rows across {len(periods)} periods")

    if args.dry_run:
        print("Dry run — nothing written.")
        return

    url, key_ = load_env()
    sb = create_client(url, key_)
    for i in range(0, len(payload), 150):
        sb.table("drill_clients").upsert(payload[i:i + 150],
                                         on_conflict="period,project_id,metric").execute()
        if (i // 150) % 10 == 0 or i + 150 >= len(payload):
            print(f"  upserted {min(i + 150, len(payload))}/{len(payload)}", flush=True)

    # Snapshot semantics per period: drop eva:* rows that no longer fire.
    # Paged fetch — the multi-period result set can exceed PostgREST's 1000 cap.
    period_keys = [p[0] for p in periods]
    keys = {(r["period"], r["project_id"], r["metric"]) for r in payload}
    existing = []
    for i in range(0, 100000, 1000):
        r = (sb.table("drill_clients").select("period, project_id, metric")
             .in_("period", period_keys).like("metric", "eva:%")
             .order("period").order("project_id").order("metric")
             .range(i, i + 999).execute().data)
        existing.extend(r or [])
        if not r or len(r) < 1000:
            break
    stale = [r for r in existing if (r["period"], r["project_id"], r["metric"]) not in keys]
    for r in stale:
        sb.table("drill_clients").delete().eq("period", r["period"]) \
          .eq("project_id", r["project_id"]).eq("metric", r["metric"]).execute()
    if stale:
        print(f"  pruned {len(stale)} cleared eva rows")
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
