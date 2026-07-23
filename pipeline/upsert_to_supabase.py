#!/usr/bin/env python3
"""
Upsert the computed HMIS dashboard dataset into Supabase.

Reads the JSON the Python pipeline already produces (no recompute) and loads it
into the Postgres tables defined in ../supabase/schema.sql via the Supabase REST
API (PostgREST over HTTPS:443 — note this does NOT use the direct Postgres
:5432 path that the County firewall TLS-inspects, so it works where psql does
not).

Sources (relative to the repo root, one level up from hmis-web/):
  outputs/netlify/data.json     cols/rows, projects, periods, sys_data,
                                ret_cols/ret_rows, ret_dest, util_data, partial_period
  outputs/netlify/data_qf.json  qtr_rows/fy_rows, ret_qtr/fy, dq_qtr/fy + period lists
  outputs/netlify/data_dq.json  dq_rows (monthly) + dq_cols (from data.json)
  outputs/netlify/drill_all.json ids + snap/sys/ret (admin drill-downs, hashed PersonalIDs)

Tables loaded: projects, project_metrics, dq_metrics, system_metrics,
returns_metrics, returns_by_dest, util_metrics, drill_clients, meta.

Usage:
  python upsert_to_supabase.py                 # load everything
  python upsert_to_supabase.py --dry-run       # parse + print row counts, no network
  python upsert_to_supabase.py --only projects,project_metrics
  python upsert_to_supabase.py --skip drill_clients
  python upsert_to_supabase.py --verify        # after load, compare table counts to source

Env (read from hmis-web/.env.local or the process environment):
  NEXT_PUBLIC_SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY        # service role — bypasses RLS; never expose to the browser
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────────────────
HERE = Path(__file__).resolve().parent            # hmis-web/pipeline
WEB = HERE.parent                                 # hmis-web
REPO = WEB.parent                                 # repo root (the existing project)
NETLIFY = REPO / "outputs" / "netlify"

BATCH = 1000                                       # default rows per upsert request
# drill_clients rows carry large personal_ids[] arrays — keep payloads small.
BATCH_OVERRIDE = {"drill_clients": 150}

# Granularity codes used as table period keys.
GRAN_MONTHLY, GRAN_QUARTERLY, GRAN_FISCAL = "monthly", "quarterly", "fiscal"

_MONTHLY_RE = re.compile(r"^\d{4}-\d{2}$")
_QUARTER_RE = re.compile(r"^FY\d{4}-Q[1-4]$")
_FISCAL_RE = re.compile(r"^FY\d{4}$")


def granularity_of(period: str) -> str:
    """Infer monthly/quarterly/fiscal from a period key (e.g. '2026-05', 'FY2026-Q3', 'FY2026')."""
    if _MONTHLY_RE.match(period):
        return GRAN_MONTHLY
    if _QUARTER_RE.match(period):
        return GRAN_QUARTERLY
    if _FISCAL_RE.match(period):
        return GRAN_FISCAL
    raise ValueError(f"Unrecognized period key: {period!r}")


# ── Env / client ─────────────────────────────────────────────────────────────
def load_env() -> tuple[str, str]:
    """Read Supabase URL + service-role key from hmis-web/.env.local or the environment."""
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
    if not url or url.startswith("https://YOUR-") or not key or key.startswith("YOUR-"):
        sys.exit(
            "Missing Supabase credentials. Copy hmis-web/.env.local.example to "
            "hmis-web/.env.local and fill NEXT_PUBLIC_SUPABASE_URL + "
            "SUPABASE_SERVICE_ROLE_KEY (Supabase → Settings → API)."
        )
    return url, key


def make_client(url: str, key: str):
    # The County firewall TLS-inspects outbound HTTPS, presenting a corporate root
    # CA that Python's bundled certs don't trust (CERTIFICATE_VERIFY_FAILED). Windows
    # already trusts that CA, so route Python's TLS verification through the OS store.
    try:
        import truststore

        truststore.inject_into_ssl()
    except ImportError:
        print(
            "  (truststore not installed — if you hit CERTIFICATE_VERIFY_FAILED, run "
            "pip install -r pipeline/requirements.txt)",
            flush=True,
        )
    try:
        from supabase import create_client
    except ImportError:
        sys.exit("supabase not installed. Run: pip install -r pipeline/requirements.txt")
    return create_client(url, key)


# ── JSON loading ─────────────────────────────────────────────────────────────
import json


def load_json(name: str) -> dict:
    p = NETLIFY / name
    if not p.exists():
        raise FileNotFoundError(f"Expected source file not found: {p}")
    print(f"  reading {p.name} ({p.stat().st_size / 1e6:.1f} MB) …", flush=True)
    with p.open(encoding="utf-8") as f:
        return json.load(f)


# ── Row builders (parse → list[dict] keyed to table columns) ─────────────────
def build_projects(data: dict) -> list[dict]:
    out = []
    for p in data["projects"]:
        ptype = p.get("ProjectType")
        try:
            ptype = int(ptype) if ptype not in (None, "", "nan") else None
        except (TypeError, ValueError):
            ptype = None
        out.append(
            {
                "project_id": int(p["ProjectID"]),
                "name": p.get("ProjectName"),
                "project_type": ptype,
                "type_name": p.get("ProjectTypeName"),
                "operating_start": p.get("OperatingStartDate") or None,
                "operating_end": p.get("OperatingEndDate") or None,
            }
        )
    return _dedupe(out, ("project_id",))


def build_project_metrics(data: dict, qf: dict) -> list[dict]:
    cols = data["cols"]
    idx = {c: i for i, c in enumerate(cols)}
    out = []
    sources = [data["rows"], qf["qtr_rows"], qf["fy_rows"]]
    for rows in sources:
        for r in rows:
            period = r[idx["Period"]]
            out.append(
                {
                    "period": period,
                    "granularity": granularity_of(period),
                    "project_id": int(r[idx["ProjectID"]]),
                    "household_type": r[idx["HouseholdType"]] or "All",
                    "subpopulation": r[idx["Subpopulation"]] or "All",
                    "project_name": r[idx["ProjectName"]],
                    "type_name": r[idx["ProjectTypeName"]],
                    "clients_served": r[idx["ClientsServed"]],
                    "leavers": r[idx["Leavers"]],
                    "exits_ph": r[idx["ExitsToPH"]],
                    "ph_exit_rate": r[idx["PHExitRate"]],
                    "exits_unsub": r[idx["ExitsToUnsubsidizedHousing"]],
                    "unsub_rate": r[idx["UnsubsidizedRate"]],
                    "avg_los": r[idx["AvgLengthOfStay"]],
                    "is_partial": bool(r[idx["IsPartial"]]),
                    "data": {c: r[i] for i, c in enumerate(cols)},
                }
            )
    return _dedupe(
        out, ("period", "granularity", "project_id", "household_type", "subpopulation")
    )


def build_dq_metrics(data: dict, dq: dict, qf: dict) -> list[dict]:
    cols = data["dq_cols"]
    idx = {c: i for i, c in enumerate(cols)}
    out = []
    for rows in (dq["dq_rows"], qf["dq_qtr_rows"], qf["dq_fy_rows"]):
        for r in rows:
            period = r[idx["Period"]]
            out.append(
                {
                    "period": period,
                    "granularity": granularity_of(period),
                    "project_id": int(r[idx["ProjectID"]]),
                    "data": {c: r[i] for i, c in enumerate(cols)},
                }
            )
    return _dedupe(out, ("period", "granularity", "project_id"))


def build_system_metrics(data: dict) -> list[dict]:
    out = []
    for period, by_combo in data["sys_data"].items():
        gran = granularity_of(period)
        for combo, record in by_combo.items():
            hh, _, subpop = combo.partition("|")
            out.append(
                {
                    "period": period,
                    "granularity": gran,
                    "household_type": hh or "All",
                    "subpopulation": subpop or "All",
                    "data": record,
                }
            )
    return _dedupe(out, ("period", "granularity", "household_type", "subpopulation"))


def build_returns_metrics(data: dict, qf: dict) -> list[dict]:
    cols = data["ret_cols"]
    idx = {c: i for i, c in enumerate(cols)}
    out = []
    for rows in (data["ret_rows"], qf["ret_qtr_rows"], qf["ret_fy_rows"]):
        for r in rows:
            period = r[idx["Period"]]
            out.append(
                {
                    "period": period,
                    "granularity": granularity_of(period),
                    "project_id": int(r[idx["ProjectID"]]),
                    "household_type": r[idx["HouseholdType"]] or "All",
                    "subpopulation": r[idx["Subpopulation"]] or "All",
                    "total_ph_exits": r[idx["TotalPHExits"]],
                    "returns_lt6mo": r[idx["ReturnsLt6mo"]],
                    "returns_6to12mo": r[idx["Returns6to12mo"]],
                    "returns_13to24mo": r[idx["Returns13to24mo"]],
                    "returns_2yr": r[idx["Returns2yr"]],
                }
            )
    return _dedupe(
        out, ("period", "granularity", "project_id", "household_type", "subpopulation")
    )


def build_returns_by_dest(data: dict) -> list[dict]:
    out = []
    for key, record in data["ret_dest"].items():
        period, projid, hh, subpop = key.split("|")
        out.append(
            {
                "period": period,
                "project_id": int(projid),
                "household_type": hh or "All",
                "subpopulation": subpop or "All",
                "data": record,
            }
        )
    return _dedupe(out, ("period", "project_id", "household_type", "subpopulation"))


def build_util_metrics(data: dict) -> list[dict]:
    out = [{"period": period, "data": record} for period, record in data["util_data"].items()]
    return _dedupe(out, ("period",))


def build_drill_clients(drill: dict) -> list[dict]:
    """snap[period|projid|metric] and sys[period|metric] and ret[period|projid|band] → drill_clients.

    Values are integer indices into drill['ids'] (the interned hashed-PersonalID table);
    ret values are [idIndex, ExitDate, ReturnDate] triples. We store the resolved hashed
    PersonalIDs only (the dates live in returns_metrics already). System-level (sys) rows
    use project_id 0 as a sentinel.
    """
    ids = drill["ids"]
    out = []

    def resolve(indices):
        return [ids[i] for i in indices]

    for key, vals in drill.get("snap", {}).items():
        period, projid, metric = key.split("|")
        out.append(
            {
                "period": period,
                "project_id": int(projid),
                "metric": metric,
                "personal_ids": resolve(vals),
            }
        )
    for key, vals in drill.get("sys", {}).items():
        period, metric = key.split("|")
        out.append(
            {
                "period": period,
                "project_id": 0,
                "metric": f"sys:{metric}",
                "personal_ids": resolve(vals),
            }
        )
    for key, vals in drill.get("ret", {}).items():
        period, projid, band = key.split("|")
        out.append(
            {
                "period": period,
                "project_id": int(projid),
                "metric": f"ret:{band}",
                "personal_ids": [ids[v[0]] for v in vals],
            }
        )
    return _dedupe(out, ("period", "project_id", "metric"))


def build_system_returns(data: dict, qf: dict) -> dict:
    """System-level returns (M2) aggregated by period + subpopulation at household 'All'.

    Mirrors the existing dashboard's renderSpmTab: it sums TotalPHExits and the
    return bands across all projects for HouseholdType='All'. Precomputing here keeps
    the SPM tab to a single meta read (vs. summing thousands of rows past PostgREST's
    1000-row cap). Shape: { period: { subpop: {exits, lt6, r6, r13, r2} } }.
    """
    cols = data["ret_cols"]
    ix = {c: i for i, c in enumerate(cols)}
    agg: dict[str, dict[str, dict[str, int]]] = {}
    for rows in (data["ret_rows"], qf["ret_qtr_rows"], qf["ret_fy_rows"]):
        for r in rows:
            if (r[ix["HouseholdType"]] or "All") != "All":
                continue
            period = r[ix["Period"]]
            subpop = r[ix["Subpopulation"]] or "All"
            bucket = agg.setdefault(period, {}).setdefault(
                subpop, {"exits": 0, "lt6": 0, "r6": 0, "r13": 0, "r2": 0}
            )
            bucket["exits"] += r[ix["TotalPHExits"]] or 0
            bucket["lt6"] += r[ix["ReturnsLt6mo"]] or 0
            bucket["r6"] += r[ix["Returns6to12mo"]] or 0
            bucket["r13"] += r[ix["Returns13to24mo"]] or 0
            bucket["r2"] += r[ix["Returns2yr"]] or 0
    return agg


def _distinct_periods(*row_lists, idx: int = 0) -> list[str]:
    seen: dict[str, None] = {}
    for rows in row_lists:
        for r in rows:
            seen[r[idx]] = None
    return sorted(seen)


def build_meta(data: dict, qf: dict, dq: dict, bnl: dict | None = None) -> list[dict]:
    now = datetime.now(timezone.utc).isoformat()
    # Per-dataset period lists. Datasets that only cover COMPLETE periods (DQ, SPM)
    # end earlier than project_metrics (which includes the partial current month),
    # so each tab must read its own list rather than the project-side `periods`.
    dq_periods = {
        "monthly": _distinct_periods(dq["dq_rows"]),
        "quarterly": _distinct_periods(qf["dq_qtr_rows"]),
        "fiscal": _distinct_periods(qf["dq_fy_rows"]),
    }
    # Returns (M2) only exist for periods with a full 24-month lookback.
    ret_periods = {
        "monthly": _distinct_periods(data["ret_rows"]),
        "quarterly": _distinct_periods(qf["ret_qtr_rows"]),
        "fiscal": _distinct_periods(qf["ret_fy_rows"]),
    }
    # Utilization periods come from the util_data dict's keys (one per granularity).
    _ukeys = list(data.get("util_data", {}).keys())
    util_periods = {
        "monthly": sorted(k for k in _ukeys if _MONTHLY_RE.match(k)),
        "quarterly": sorted(k for k in _ukeys if _QUARTER_RE.match(k)),
        "fiscal": sorted(k for k in _ukeys if _FISCAL_RE.match(k)),
    }
    rows = [
        {"key": "generated_at", "value": now},
        {"key": "partial_period", "value": data.get("partial_period")},
        {"key": "periods", "value": data.get("periods", [])},
        {"key": "qtr_periods", "value": qf.get("qtr_periods", [])},
        {"key": "fy_periods", "value": qf.get("fy_periods", [])},
        {"key": "sys_returns", "value": build_system_returns(data, qf)},
        {"key": "dq_periods", "value": dq_periods},
        {"key": "ret_periods", "value": ret_periods},
        {"key": "util_periods", "value": util_periods},
    ]
    # BNL per-population KPI counts + inflow/outflow, so the By-Name List page
    # can render its cards and chart WITHOUT loading the 23k-row roster.
    # Omitted (rather than written empty) when bnl_data.json is absent, so a
    # `--only meta` run can never blank out a good value.
    if bnl and bnl.get("agg"):
        rows.append({"key": "bnl_agg",
                     "value": {"as_of": bnl.get("as_of"), "pops": bnl["agg"]}})
    return rows


# ── Helpers ──────────────────────────────────────────────────────────────────
def _dedupe(rows: list[dict], pk: tuple[str, ...]) -> list[dict]:
    """Keep the last row per primary-key tuple (a payload with dup PKs fails on upsert)."""
    seen: dict[tuple, dict] = {}
    for r in rows:
        seen[tuple(r[k] for k in pk)] = r
    return list(seen.values())


def chunked(rows: list[dict], n: int):
    for i in range(0, len(rows), n):
        yield rows[i : i + n]


# ── Youth By-Name List (PII — names). Source: outputs/bnl_data.json ─────────
# (written by ../generate_bnl.py; lives in outputs/, NOT netlify/)
def load_bnl() -> dict | None:
    p = REPO / "outputs" / "bnl_data.json"
    if not p.exists():
        print("  bnl_data.json not found — run generate_bnl.py first; skipping BNL tables", flush=True)
        return None
    print(f"  reading {p.name} ({p.stat().st_size / 1e6:.1f} MB) …", flush=True)
    with p.open(encoding="utf-8") as f:
        return json.load(f)


def build_bnl_clients(bnl: dict | None) -> list[dict]:
    if not bnl:
        return []
    rows = []
    for r in bnl["roster"]:
        rows.append({
            "pid": r["pid"], "as_of": bnl["as_of"], "name": r["name"], "age": r["age"],
            "status": r["status"], "detail": r["detail"], "enrolled": r["enrolled"],
            "project_id": r.get("project_id"),
            "project": r["project"], "ptype": r["ptype"], "entry": r["entry"],
            "last_contact": r["last_contact"],
            # deep-dive worklist flags (computed in bnl_core)
            "days_at_project": r.get("days_at_project"),
            "long_stay": r.get("long_stay", False),
            "open_suspect": r.get("open_suspect", False),
            "days_since_contact": r["days_since_contact"], "days_homeless": r["days_homeless"],
            "ep_start": r["ep_start"], "sys_days3": r["sys_days3"], "episodes3": r["episodes3"],
            "times3_sr": r["times3_sr"], "months3_sr": r["months3_sr"],
            "dob": r["dob"], "sex": r["sex"], "race": r["race"],
            "income": r["income"], "income_date": r["income_date"],
            "dv_fleeing": r["dv_fleeing"], "dv_survivor": r["dv_survivor"],
            "foster": r["foster"], "jj": r["jj"],
            "ref_type": r["ref_type"], "ref_status": r["ref_status"],
            "ref_date": r["ref_date"], "ref_prov": r["ref_prov"],
            "risk_pts": r["risk_pts"], "risk_max": r["risk_max"],
            "chronic": r["chronic"], "is_new": r["new"], "returned": r["returned"],
            "veteran": r["veteran"], "family": r["family"], "hoh": r["hoh"],
            "parenting": r["parenting"], "unaccompanied": r["unaccompanied"],
            "assessed": r["assessed"], "in_school": r["in_school"],
            "dq": r["dq"], "dq_n": r.get("dq_n", len(r["dq"])),
            "timeline": r["timeline"], "hist3": r.get("hist3"),
            "fm": r["fm"], "hm": r["hm"], "im": r["im"],
        })
    return rows


def build_bnl_flow(bnl: dict | None) -> list[dict]:
    if not bnl:
        return []
    return [{"month": m["month"], "new_n": m["new"], "housed_n": m["housed"],
             "inactive_n": m["inactive"]} for m in bnl["flow"]]


# ── Loaders registry ─────────────────────────────────────────────────────────
# table -> (builder, on_conflict primary-key string)
def build_all(dry: bool):
    print("Loading source JSON …", flush=True)
    data = load_json("data.json")
    qf = load_json("data_qf.json")
    dq = load_json("data_dq.json")
    drill = None  # loaded lazily — it's the biggest file

    def get_drill():
        nonlocal drill
        if drill is None:
            drill = load_json("drill_all.json")
        return drill

    bnl: dict | None = None
    bnl_loaded = False

    def get_bnl():
        nonlocal bnl, bnl_loaded
        if not bnl_loaded:
            bnl = load_bnl()
            bnl_loaded = True
        return bnl

    return {
        "projects": (
            lambda: build_projects(data),
            "project_id",
        ),
        "project_metrics": (
            lambda: build_project_metrics(data, qf),
            "period,granularity,project_id,household_type,subpopulation",
        ),
        "dq_metrics": (
            lambda: build_dq_metrics(data, dq, qf),
            "period,granularity,project_id",
        ),
        "system_metrics": (
            lambda: build_system_metrics(data),
            "period,granularity,household_type,subpopulation",
        ),
        "returns_metrics": (
            lambda: build_returns_metrics(data, qf),
            "period,granularity,project_id,household_type,subpopulation",
        ),
        "returns_by_dest": (
            lambda: build_returns_by_dest(data),
            "period,project_id,household_type,subpopulation",
        ),
        "util_metrics": (
            lambda: build_util_metrics(data),
            "period",
        ),
        "drill_clients": (
            lambda: build_drill_clients(get_drill()),
            "period,project_id,metric",
        ),
        "meta": (
            lambda: build_meta(data, qf, dq, get_bnl()),
            "key",
        ),
        "bnl_clients": (
            lambda: build_bnl_clients(get_bnl()),
            "pid",
        ),
        "bnl_flow": (
            lambda: build_bnl_flow(get_bnl()),
            "month",
        ),
    }


# Insertion order respects the projects FK-ish dependency (projects first).
# NOTE: util_metrics is intentionally NOT in the default load order. The util payload
# in data.json includes DV / Victim Service Provider beds, which must be excluded
# (see recompute_util.py). Utilization is loaded by `python pipeline/recompute_util.py`,
# which recomputes from raw inventory with DV removed. Run that after this upsert.
# (`--only util_metrics` still works if you ever need the raw data.json values.)
ORDER = [
    "projects",
    "project_metrics",
    "dq_metrics",
    "system_metrics",
    "returns_metrics",
    "returns_by_dest",
    "drill_clients",
    "meta",
    "bnl_clients", # PII (names) — private table, no RLS select policy
    "bnl_flow",
]


def main() -> None:
    ap = argparse.ArgumentParser(description="Upsert HMIS dashboard data into Supabase.")
    ap.add_argument("--dry-run", action="store_true", help="Parse + count only; no network.")
    ap.add_argument("--only", help="Comma list of tables to load (default: all).")
    ap.add_argument("--skip", help="Comma list of tables to skip.")
    ap.add_argument("--verify", action="store_true", help="After load, compare table counts to source.")
    args = ap.parse_args()

    only = set(args.only.split(",")) if args.only else None
    skip = set(args.skip.split(",")) if args.skip else set()

    builders = build_all(args.dry_run)
    # Default run uses ORDER (excludes util_metrics — see note above). An explicit
    # --only may name any table the builders know about, including util_metrics.
    candidates = ORDER if only is None else [t for t in builders if t in only]
    targets = [t for t in candidates if t not in skip]

    client = None
    if not args.dry_run:
        url, key = load_env()
        client = make_client(url, key)
        print(f"Connected to {url}", flush=True)

    counts: dict[str, int] = {}
    for table in targets:
        builder, on_conflict = builders[table]
        print(f"\n[{table}] building rows …", flush=True)
        rows = builder()
        counts[table] = len(rows)
        print(f"[{table}] {len(rows):,} rows", flush=True)
        if args.dry_run:
            continue
        n = 0
        for batch in chunked(rows, BATCH_OVERRIDE.get(table, BATCH)):
            client.table(table).upsert(batch, on_conflict=on_conflict).execute()
            n += len(batch)
            print(f"  upserted {n:,}/{len(rows):,}", flush=True)

    if args.verify and not args.dry_run:
        print("\nVerifying row counts (source vs table) …", flush=True)
        for table in targets:
            res = client.table(table).select("*", count="exact", head=True).execute()
            db = res.count or 0
            src = counts[table]
            flag = "ok" if db >= src else "MISMATCH"
            print(f"  {table:<18} source {src:>8,}  db {db:>8,}  {flag}", flush=True)

    print("\nDone." + (" (dry run — nothing written)" if args.dry_run else ""), flush=True)


if __name__ == "__main__":
    main()
