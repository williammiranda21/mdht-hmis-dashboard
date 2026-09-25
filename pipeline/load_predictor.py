"""
load_predictor.py — push ONLY the Housing Predictor to Supabase (2026-09-25).

Reloads meta `pathway_intel` (model + weights + labels) and drill_clients
`an:predict` (scored caseload) from outputs/netlify/pathways_system.json, then
removes an:predict rows this run did not write. Same rows the full
upsert_to_supabase.py run writes — this just avoids a 170k-row drill reload
after a model retrain. Sequential, small batches.
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone

import upsert_to_supabase as u


def main() -> int:
    ps = u.load_pathways_system()
    if not ps or not ps.get("sankey"):
        return 1
    url, key = u.load_env()
    client = u.make_client(url, key)
    run_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    # same shape build_meta writes for pathway_intel
    pm = ps.get("predictor_ml") or {}
    val = {k: ps.get(k) for k in ("generated", "sankey", "sankey_filters", "period_defs",
                                  "hh_defs", "bottleneck", "predictor", "markov")}
    val["predictor_ml"] = {k: pm.get(k) for k in (
        "weights", "feature_names", "n_features", "accuracy", "n_trained", "model_label",
        "profile_buckets", "n_active", "version", "feature_labels", "feature_tips", "holdout")}
    u.upsert_batch(client, "meta", [{"key": "pathway_intel", "value": val}], "key")
    print("  meta pathway_intel upserted", flush=True)
    rows = u.build_predictor_drills(ps)
    for r in rows:
        r["loaded_at"] = run_ts
    n = 0
    for batch in u.chunked(rows, 10):
        u.upsert_batch(client, "drill_clients", batch, "period,project_id,metric")
        n += len(batch)
    print(f"  an:predict upserted {n} project rows "
          f"({sum(len(r['detail']) for r in rows):,} clients)", flush=True)
    res = (client.table("drill_clients").delete()
           .eq("metric", "an:predict").or_(f"loaded_at.is.null,loaded_at.lt.{run_ts}").execute())
    print(f"  an:predict pruned {len(res.data or [])} stale rows", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
