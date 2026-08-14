#!/usr/bin/env python3
"""Capture the current DQ state into dq_snapshots — the fixed-since-refresh ledger
— and maintain dq_items / dq_timeliness, the provider-responsiveness tracker.

Run at the END of every refresh (after upsert + recompute_eva + recompute_openstay).

PHASE 1 (original): freezes, for the latest COMPLETE month:
  • every dq:* fix-list row (EXCLUDING dq:openstay — it prunes older periods,
    so a period roll would read as a mass "fix")
  • every eva:* check row (eva keeps older-period rows, so it diffs cleanly)
  • each project's DQ_Score (metric='score')
Because a complete month's universe can never change, any client present in a
capture but absent from the same month's live rows later = a real data fix —
including retroactive ones that the month-vs-month digest can't see.

PHASE 2 (2026-08-14, user directive — provider timeliness): advances dq_items,
one row per offending unit (period, project, metric, pid):
  • first appearance on a capture → first_seen (the clock starts when the
    error SURFACES on a fix-list, not when the bad data was entered)
  • vanished from a later capture of the SAME period → status='fixed', with
    fixed_on = the underlying HMIS record's DateUpdated — the TRUE clean date
    (user insight 8/14: the upload only bounds detection; the record says when
    staff actually fixed it). Falls back to the capture date when no candidate
    edit lands in the (last_seen, capture] window.
  • period roll while still open → status='rolled' (excluded from timeliness —
    can't distinguish a fix from leaving the new period's universe); a
    successor row in the new period inherits first_seen so ages persist.
  • a closed unit that REAPPEARS in the same period reopens with a fresh
    clock — that's a new error instance, not a 200-day-old one.
First run replays the whole dq_snapshots history (ascending capture dates) so
first_seen is seeded from the earliest capture on record, then upserts only
changed rows.

PHASE 3: recomputes dq_timeliness — per-project median days-to-fix (fixed in
the last {STATS_DAYS}d), fixed/open counts, and the 30d+ aging tail — so the
DQ tab can rank provider responsiveness without aggregate queries.

Also maintains meta key 'dq_snapshot_dates' (ascending list of capture dates)
so /api/digest can find the comparison base without scanning the table, and
prunes captures older than KEEP_DAYS.

Usage:  py pipeline/snapshot_dq.py --dry-run
        py pipeline/snapshot_dq.py
"""
from pathlib import Path
import argparse
import os
import statistics
import sys
from datetime import date, timedelta

import truststore

truststore.inject_into_ssl()
from supabase import create_client  # noqa: E402

WEB = Path(__file__).resolve().parent.parent
DATA = WEB.parent / "hud_data"
KEEP_DAYS = 180     # dq_snapshots retention
STATS_DAYS = 180    # fixed-items window for the timeliness medians

PII_METRICS = {"dq:name", "dq:ssn", "dq:dob", "dq:race", "dq:sex", "dq:veteran"}
# Household-level errors flag EVERY member, but the fix is an edit to ONE
# member's enrollment (e.g. setting Self on the true head) — so their clean
# date must consider DateUpdated across the WHOLE household, not just the
# flagged client's own records (user question 2026-08-14).
HH_METRICS = {"dq:relhoh", "eva:2", "eva:3", "eva:4", "eva:86"}


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


# ── True-fix dating from the HMIS export's DateUpdated columns ───────────────
class FixDater:
    """metric + (pid, project) → the most plausible clean date.

    Candidates per element mirror recompute_user_dq's source attribution:
    PII/veteran → Client · dest → Exit(+Enrollment) · income stages →
    IncomeBenefits(+Exit/Enrollment) · everything else (incl. eva:*) →
    Enrollment(+Exit). Pick the LATEST candidate inside (window_lo, window_hi];
    none → fall back to window_hi (the capture that noticed the fix).
    CSVs load lazily — a run with zero fixes never touches pandas.
    """

    def __init__(self):
        self._loaded = False

    def _load(self):
        import pandas as pd
        self._loaded = True
        as_date = lambda s: pd.to_datetime(s, errors="coerce").dt.date  # noqa: E731
        cli = pd.read_csv(DATA / "Client.csv", low_memory=False,
                          usecols=["PersonalID", "DateUpdated"])
        self.cli_upd = dict(zip(cli["PersonalID"].astype(str),
                                as_date(cli["DateUpdated"])))
        enr = pd.read_csv(DATA / "Enrollment.csv", low_memory=False,
                          usecols=["EnrollmentID", "PersonalID", "ProjectID",
                                   "HouseholdID", "DateUpdated"])
        enr["DateUpdated"] = as_date(enr["DateUpdated"])
        self.enr = {}          # (pid, project) → [(eid, updated), ...]
        self.hh_of = {}        # (pid, project) → {householdID, ...}
        self.hh_upd = {}       # (householdID, project) → [updated, ...] all members
        for r in enr.itertuples(index=False):
            if r.ProjectID != r.ProjectID:      # NaN
                continue
            proj = int(r.ProjectID)
            self.enr.setdefault((str(r.PersonalID), proj), []) \
                .append((str(r.EnrollmentID), r.DateUpdated))
            if r.HouseholdID == r.HouseholdID:  # not NaN
                hh = str(r.HouseholdID)
                self.hh_of.setdefault((str(r.PersonalID), proj), set()).add(hh)
                self.hh_upd.setdefault((hh, proj), []).append(r.DateUpdated)
        ex = pd.read_csv(DATA / "Exit.csv", low_memory=False,
                         usecols=["EnrollmentID", "DateUpdated"])
        self.exit_upd = dict(zip(ex["EnrollmentID"].astype(str),
                                 as_date(ex["DateUpdated"])))
        inc = pd.read_csv(DATA / "IncomeBenefits.csv", low_memory=False,
                          usecols=["EnrollmentID", "DataCollectionStage",
                                   "DateUpdated"])
        inc["DateUpdated"] = as_date(inc["DateUpdated"])
        self.inc_upd = {}      # (eid, stage) → latest updated
        for r in inc.itertuples(index=False):
            k = (str(r.EnrollmentID),
                 int(r.DataCollectionStage) if r.DataCollectionStage == r.DataCollectionStage else -1)
            cur = self.inc_upd.get(k)
            if r.DateUpdated is not None and (cur is None or r.DateUpdated > cur):
                self.inc_upd[k] = r.DateUpdated

    def __call__(self, project: int, metric: str, pid: str,
                 window_lo: str, window_hi: str) -> str:
        if not self._loaded:
            try:
                self._load()
            except Exception as e:              # CSVs unavailable → detection date
                print(f"  (fix-dating unavailable — {e}; using capture dates)")
                self._loaded = True
                self.cli_upd, self.enr, self.exit_upd, self.inc_upd = {}, {}, {}, {}
                self.hh_of, self.hh_upd = {}, {}
        cands = []
        if metric in PII_METRICS:
            d = self.cli_upd.get(pid)
            if d is not None:
                cands.append(d)
        stays = self.enr.get((pid, project), [])
        eids = [e for e, _ in stays]
        cands += [d for _, d in stays if d is not None]
        if metric in HH_METRICS:
            # The fixing edit usually lands on a HOUSEMATE's enrollment row.
            for hh in self.hh_of.get((pid, project), ()):
                cands += [d for d in self.hh_upd.get((hh, project), ()) if d is not None]
        if metric in ("dq:dest", "dq:incexit") or metric.startswith("eva:"):
            cands += [self.exit_upd[e] for e in eids if self.exit_upd.get(e)]
        stage = {"dq:income": 1, "dq:incexit": 3, "dq:annual": 5}.get(metric)
        if stage is not None:
            cands += [self.inc_upd[(e, stage)] for e in eids
                      if self.inc_upd.get((e, stage))]
        lo, hi = date.fromisoformat(window_lo), date.fromisoformat(window_hi)
        in_win = [d for d in cands if d is not None and lo < d <= hi]
        return (max(in_win) if in_win else hi).isoformat()


def apply_capture(items: dict, dirty: set, cap_date: str, period: str,
                  units: set, fix_dater) -> dict:
    """Advance the dq_items ledger by one capture. Returns counts for logging."""
    open_same = {k: v for k, v in items.items()
                 if v["status"] == "open" and k[0] == period}
    open_prev = {k: v for k, v in items.items()
                 if v["status"] == "open" and k[0] != period}

    # Period roll — close leftovers; successors inherit the running clock.
    inherit = {}
    for k, v in open_prev.items():
        v["status"] = "rolled"
        dirty.add(k)
        unit = (v["project_id"], v["metric"], v["pid"])
        prev = inherit.get(unit)
        if unit in units and (prev is None or v["first_seen"] < prev):
            inherit[unit] = v["first_seen"]

    n_new = n_fixed = 0
    for unit in units:
        proj, metric, pid = unit
        k = (period, proj, metric, pid)
        v = items.get(k)
        if v is None:
            items[k] = {"period": period, "project_id": proj, "metric": metric,
                        "pid": pid,
                        "first_seen": inherit.get(unit, cap_date),
                        "last_seen": cap_date, "status": "open",
                        "fixed_on": None, "detected_on": None, "days_to_fix": None}
            dirty.add(k)
            n_new += 1
        elif v["status"] != "open":
            # Reappeared after being closed — a NEW error instance, fresh clock.
            v.update({"first_seen": cap_date, "last_seen": cap_date,
                      "status": "open", "fixed_on": None, "detected_on": None,
                      "days_to_fix": None})
            dirty.add(k)
            n_new += 1
        elif v["last_seen"] != cap_date:
            v["last_seen"] = cap_date
            dirty.add(k)

    for k, v in open_same.items():
        unit = (v["project_id"], v["metric"], v["pid"])
        if unit not in units:
            fixed_on = fix_dater(v["project_id"], v["metric"], v["pid"],
                                 v["last_seen"], cap_date)
            v["status"] = "fixed"
            v["fixed_on"] = fixed_on
            v["detected_on"] = cap_date
            v["days_to_fix"] = max(0, (date.fromisoformat(fixed_on)
                                       - date.fromisoformat(v["first_seen"])).days)
            dirty.add(k)
            n_fixed += 1
    return {"new": n_new, "fixed": n_fixed, "rolled": len(open_prev)}


def drill_units(rows) -> set:
    """drill/snapshot rows → set of (project_id, metric, pid) units."""
    return {(int(r["project_id"]), r["metric"], str(p))
            for r in rows for p in (r.get("personal_ids") or [])}


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
        if i == 0 or i + 200 >= len(rows):
            print(f"  upserted {min(i + 200, len(rows))}/{len(rows)}", flush=True)

    # Capture-date index for the digest (ascending, deduped).
    meta = sb.table("meta").select("value").eq("key", "dq_snapshot_dates") \
             .maybe_single().execute()
    dates = list((meta.data or {}).get("value") or []) if meta and meta.data else []
    hist_dates = [d for d in dates if d < today]      # pre-today, for seeding
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

    # ── Phase 2: dq_items ledger ─────────────────────────────────────────────
    stats_cutoff = (date.today() - timedelta(days=STATS_DAYS)).isoformat()
    try:
        stored = fetch_all(
            sb.table("dq_items").select("*")
              .or_(f"status.eq.open,detected_on.gte.{stats_cutoff}")
              .order("project_id").order("metric").order("pid"))
    except Exception as e:
        # Tables not created yet — phase 1 (the capture) is already written,
        # so the runbook step still succeeds. Ledger starts once the SQL runs.
        print(f"  dq_items unavailable ({e}) — run supabase/dq_timeliness.sql "
              "once, then the next capture seeds the ledger from history.")
        print("Done.", flush=True)
        return
    items = {(r["period"], int(r["project_id"]), r["metric"], str(r["pid"])): r
             for r in stored}
    dirty: set = set()
    fix_dater = FixDater()

    if not items and hist_dates:
        print(f"  dq_items empty — replaying {len(hist_dates)} historical capture(s)…")
        for d in hist_dates:
            hrows = fetch_all(
                sb.table("dq_snapshots")
                  .select("period, project_id, metric, personal_ids")
                  .eq("captured_on", d).neq("metric", "score")
                  .order("project_id").order("metric"))
            if not hrows:
                continue
            hperiod = hrows[0]["period"]
            c = apply_capture(items, dirty, d, hperiod, drill_units(hrows), fix_dater)
            print(f"    {d} ({hperiod}): +{c['new']} new · {c['fixed']} fixed"
                  f" · {c['rolled']} rolled")

    c = apply_capture(items, dirty, today, period, drill_units(drill), fix_dater)
    print(f"  dq_items {today}: +{c['new']} new · {c['fixed']} fixed"
          f" · {c['rolled']} rolled · {len(dirty)} rows to write")

    payload = [items[k] for k in dirty]
    for i in range(0, len(payload), 200):
        sb.table("dq_items").upsert(
            payload[i:i + 200],
            on_conflict="period,project_id,metric,pid").execute()
        if i == 0 or i + 200 >= len(payload):
            print(f"  items upserted {min(i + 200, len(payload))}/{len(payload)}",
                  flush=True)

    # ── Phase 3: dq_timeliness rollup (one row per project) ─────────────────
    per: dict = {}
    today_d = date.today()
    for v in items.values():
        p = per.setdefault(int(v["project_id"]),
                           {"open": 0, "open30": 0, "fixes": []})
        if v["status"] == "open":
            p["open"] += 1
            if (today_d - date.fromisoformat(v["first_seen"])).days >= 30:
                p["open30"] += 1
        elif (v["status"] == "fixed" and v["days_to_fix"] is not None
              and (v.get("detected_on") or "") >= stats_cutoff):
            p["fixes"].append(v["days_to_fix"])
    troll = [{"project_id": pj,
              "median_fix_days": (round(statistics.median(d["fixes"]), 1)
                                  if d["fixes"] else None),
              "n_fixed": len(d["fixes"]), "n_open": d["open"],
              "n_open_30d": d["open30"], "computed_on": today}
             for pj, d in sorted(per.items())]
    for i in range(0, len(troll), 200):
        sb.table("dq_timeliness").upsert(troll[i:i + 200],
                                         on_conflict="project_id").execute()
    n_med = sum(1 for t in troll if t["median_fix_days"] is not None)
    print(f"  timeliness: {len(troll)} projects · {n_med} with a fix median")
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
