#!/usr/bin/env python3
"""Per-user data-entry quality → user_dq (error rates by user).

Attributes the EXISTING fix-list records (drill_clients dq:* and eva:*) to the
HMIS user who CREATED the responsible source record — no APR/Eva logic is
re-derived; this script only joins findings to creators:

  dq:dest      → Exit.csv creator (no exit row → Enrollment creator)
  dq:movein    → Enrollment creator
  dq:annual    → Enrollment creator (a missing assessment has no record of its
                 own — the enrollment's owner is the accountable proxy)
  dq:income    → IncomeBenefits entry-stage (1) creator, else Enrollment creator
  dq:incexit   → IncomeBenefits exit-stage (3) creator, else Exit, else Enrollment
  dq:name/ssn/dob/race/sex → Client.csv creator
  dq:openstay  → Enrollment creator (the record left open)
  eva:*        → Enrollment creator (household/date/duplicate structure issues)

ATTRIBUTION IS "RECORD CREATOR": the export carries the creating UserID only —
a later editor is invisible. The UI must say so.

Denominator (metric='created'): records created per user/project/month across
Enrollment + Exit + IncomeBenefits, so rates are errors ÷ volume, not raw
counts that punish high-volume staff. Import/conversion accounts are flagged
(is_import) for UI filtering, never dropped.

Coverage: the trailing 12 complete months (meta.dq_periods). Rows are pruned
per period on reload (snapshot semantics). RLS scoping comes from project_id
(user_dq.sql — admins all, agencies their projects).

Usage:  py pipeline/recompute_user_dq.py --dry-run
        py pipeline/recompute_user_dq.py
"""
from pathlib import Path
import argparse
import os
import re
import sys
from collections import Counter

import pandas as pd
import truststore

truststore.inject_into_ssl()
from supabase import create_client  # noqa: E402

WEB = Path(__file__).resolve().parent.parent
DATA = WEB.parent / "hud_data"
MONTHS = 12
IMPORT_PAT = re.compile(r"import|conversion|migrat|batch|system", re.I)


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

    monthly = (sb.table("meta").select("value").eq("key", "dq_periods")
               .single().execute().data["value"].get("monthly") or [])
    periods = monthly[-MONTHS:]
    if not periods:
        sys.exit("meta.dq_periods missing — run the upsert first.")

    print(f"Loading CSVs … (periods {periods[0]} – {periods[-1]})")
    en = pd.read_csv(DATA / "Enrollment.csv", low_memory=False,
                     usecols=["EnrollmentID", "PersonalID", "ProjectID",
                              "EntryDate", "UserID", "DateCreated"])
    ex = pd.read_csv(DATA / "Exit.csv", low_memory=False,
                     usecols=["EnrollmentID", "UserID", "DateCreated"])
    inc = pd.read_csv(DATA / "IncomeBenefits.csv", low_memory=False,
                      usecols=["EnrollmentID", "DataCollectionStage",
                               "UserID", "DateCreated"])
    cl = pd.read_csv(DATA / "Client.csv", low_memory=False,
                     usecols=["PersonalID", "UserID"])
    us = pd.read_csv(DATA / "User.csv", low_memory=False,
                     usecols=["UserID", "UserFirstName", "UserLastName", "UserEmail"])

    users: dict[str, dict] = {}
    for r in us.itertuples(index=False):
        name = " ".join(s for s in [str(r.UserFirstName or "").strip(),
                                    str(r.UserLastName or "").strip()]
                        if s and s != "nan") or f"User {r.UserID}"
        email = str(r.UserEmail).strip() if pd.notna(r.UserEmail) else None
        users[str(r.UserID)] = {
            "name": name, "email": email,
            "is_import": bool(IMPORT_PAT.search(f"{name} {email or ''}")),
        }

    en["EntryDate"] = pd.to_datetime(en["EntryDate"], errors="coerce")
    en_user = dict(zip(en["EnrollmentID"].astype(str), en["UserID"].astype(str)))
    en_proj = dict(zip(en["EnrollmentID"].astype(str), en["ProjectID"]))
    # lookups: exact (pid, project, entry) → enrollment; latest (pid, project)
    by_exact: dict[tuple, str] = {}
    by_pp: dict[tuple, tuple] = {}
    for r in en.itertuples(index=False):
        eid = str(r.EnrollmentID)
        pidp = (str(r.PersonalID), int(r.ProjectID) if pd.notna(r.ProjectID) else -1)
        if pd.notna(r.EntryDate):
            by_exact[(*pidp, r.EntryDate.date().isoformat())] = eid
            cur = by_pp.get(pidp)
            if cur is None or r.EntryDate > cur[0]:
                by_pp[pidp] = (r.EntryDate, eid)
    ex_user = dict(zip(ex["EnrollmentID"].astype(str), ex["UserID"].astype(str)))
    inc_user: dict[tuple, str] = {}
    for r in inc.itertuples(index=False):
        k = (str(r.EnrollmentID), int(r.DataCollectionStage) if pd.notna(r.DataCollectionStage) else -1)
        inc_user.setdefault(k, str(r.UserID))
    cl_user = dict(zip(cl["PersonalID"].astype(str), cl["UserID"].astype(str)))

    PII = {"dq:name", "dq:ssn", "dq:dob", "dq:race", "dq:sex"}

    def attribute(metric: str, pid: str, project: int, entry: str | None,
                  eid_hint: str | None = None) -> str | None:
        if metric in PII:
            return cl_user.get(pid)
        # detail rows written since 2026-08-13 carry the exact EnrollmentID —
        # use it outright; older rows fall back to the (pid, project, entry)
        # lookup and then to the client's latest stay.
        eid = eid_hint if eid_hint and eid_hint in en_user else None
        if eid is None:
            eid = by_exact.get((pid, project, entry)) if entry else None
        if eid is None:
            hit = by_pp.get((pid, project))
            eid = hit[1] if hit else None
        if eid is None:
            return cl_user.get(pid)
        if metric == "dq:dest":
            return ex_user.get(eid) or en_user.get(eid)
        if metric == "dq:income":
            return inc_user.get((eid, 1)) or en_user.get(eid)
        if metric == "dq:incexit":
            return inc_user.get((eid, 3)) or ex_user.get(eid) or en_user.get(eid)
        return en_user.get(eid)  # movein / annual / openstay / eva:*

    # ── errors ──────────────────────────────────────────────────────────────
    # Two shapes, because the fix-lists are LEVEL snapshots (an unfixed record
    # appears on every month's list):
    #   • per-period rows  — the open-error LEVEL each month (trend display)
    #   • period='window'  — UNIQUE units across the whole window (one record
    #     failing for a year counts ONCE) — the roster/rate numbers. Summing
    #     the monthly levels instead produced >1000% "error rates" (observed).
    counts: Counter = Counter()          # (period, user, project, metric) → n
    uniq: dict[tuple, set] = {}          # (user, project, metric) → unit set
    unattributed = 0
    total_units = 0
    for period in periods:
        drill = fetch_all(
            sb.table("drill_clients")
              .select("project_id, metric, personal_ids, detail")
              .eq("period", period)
              .or_("metric.like.dq:*,metric.like.eva:*")
              .order("project_id").order("metric"))
        for row in drill:
            project = int(row["project_id"])
            metric = row["metric"]
            units = row.get("detail") or [{"pid": p, "entry": None}
                                          for p in (row.get("personal_ids") or [])]
            for u in units:
                total_units += 1
                uid = attribute(metric, str(u["pid"]), project, u.get("entry"), u.get("eid"))
                if uid is None or uid == "nan":
                    unattributed += 1
                    continue
                counts[(period, uid, project, metric)] += 1
                uniq.setdefault((uid, project, metric), set()) \
                    .add((str(u["pid"]), u.get("entry")))

    # ── denominator: records created per user/project/month ─────────────────
    for df, ecol in ((en, None), (ex, "EnrollmentID"), (inc, "EnrollmentID")):
        created = pd.to_datetime(df["DateCreated"], errors="coerce")
        per = created.dt.strftime("%Y-%m")
        for i in range(len(df)):
            p = per.iat[i]
            if p not in periods:
                continue
            uid = str(df["UserID"].iat[i])
            if ecol is None:
                proj = df["ProjectID"].iat[i]
                proj = int(proj) if pd.notna(proj) else None
            else:
                proj = en_proj.get(str(df[ecol].iat[i]))
                proj = int(proj) if proj is not None and pd.notna(proj) else None
            if proj is None or uid == "nan":
                continue
            counts[(p, uid, proj, "created")] += 1

    # Window rows carry the actual units ({pid, entry}) so the score card can
    # list WHICH clients to fix, not just how many. Monthly rows stay count-only.
    details: dict[tuple, list] = {}
    for (uid, proj, m), s in uniq.items():
        counts[("window", uid, proj, m)] = len(s)
        details[("window", uid, proj, m)] = [
            {"pid": pid, "entry": entry}
            for pid, entry in sorted(s, key=lambda x: (x[1] or "", x[0]))]

    payload = [{"period": p, "user_id": uid, "project_id": proj, "metric": m,
                "n": n,
                "detail": details.get((p, uid, proj, m)),
                "user_name": users.get(uid, {}).get("name"),
                "user_email": users.get(uid, {}).get("email"),
                "is_import": users.get(uid, {}).get("is_import", False)}
               for (p, uid, proj, m), n in counts.items()]
    n_err = sum(1 for r in payload if r["metric"] != "created")
    print(f"user_dq: {len(payload)} rows ({n_err} error rows) · "
          f"{total_units} findings, {unattributed} unattributed "
          f"({100 * unattributed / max(total_units, 1):.1f}%)")

    if args.dry_run:
        top = Counter()
        for r in payload:
            if r["metric"] != "created" and not r["is_import"]:
                top[r["user_name"]] += r["n"]
        for name, n in top.most_common(10):
            print(f"  {n:>5}  {name}")
        print("Dry run — nothing written.")
        return

    for i in range(0, len(payload), 200):
        sb.table("user_dq").upsert(
            payload[i:i + 200],
            on_conflict="period,user_id,project_id,metric").execute()
        print(f"  upserted {min(i + 200, len(payload))}/{len(payload)}", flush=True)

    # prune per covered period (snapshot semantics)
    keys = {(r["period"], r["user_id"], r["project_id"], r["metric"]) for r in payload}
    existing = fetch_all(sb.table("user_dq")
                         .select("period, user_id, project_id, metric")
                         .in_("period", periods + ["window"])
                         .order("period").order("user_id"))
    stale = [r for r in existing
             if (r["period"], r["user_id"], int(r["project_id"]), r["metric"]) not in keys]
    for r in stale:
        sb.table("user_dq").delete().eq("period", r["period"]) \
          .eq("user_id", r["user_id"]).eq("project_id", r["project_id"]) \
          .eq("metric", r["metric"]).execute()
    if stale:
        print(f"  pruned {len(stale)} stale rows")
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
