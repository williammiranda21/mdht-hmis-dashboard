"""
load_intervention.py — push ONLY the Intervention Guide to Supabase (2026-09-25).

Loads meta `intervention_intel` + drill_clients `an:ivx` from
outputs/netlify/intervention.json, then removes an:ivx rows this run did not
write. The full upsert_to_supabase.py run carries the same rows (so its drill
prune keeps them); this script exists so a model refresh never needs a full
170k-row drill reload. Sequential, small batches — the heavy-table lesson of
2026-09-25.
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone

import upsert_to_supabase as u


def main() -> int:
    iv = u.load_intervention()
    if not iv:
        return 1
    url, key = u.load_env()
    client = u.make_client(url, key)
    run_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    meta = u.build_intervention_meta(iv)
    for r in meta:
        u.upsert_batch(client, "meta", [r], "key")
    print(f"  meta intervention_intel upserted", flush=True)
    rows = u.build_intervention_drills(iv)
    for r in rows:
        r["loaded_at"] = run_ts
    n = 0
    for batch in u.chunked(rows, 20):
        u.upsert_batch(client, "drill_clients", batch, "period,project_id,metric")
        n += len(batch)
    print(f"  an:ivx upserted {n} project rows "
          f"({sum(len(r['detail']) for r in rows):,} clients)", flush=True)
    res = (client.table("drill_clients").delete()
           .eq("metric", "an:ivx").or_(f"loaded_at.is.null,loaded_at.lt.{run_ts}").execute())
    print(f"  an:ivx pruned {len(res.data or [])} stale rows", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
