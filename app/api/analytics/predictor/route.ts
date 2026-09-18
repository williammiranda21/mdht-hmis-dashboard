import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../../lib/supabase-server';
import { audit } from '../../../../lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Housing-predictor caseload for the Analytics tab (user 2026-09-18): every
 * ACTIVE client scored by the housing logistic model, from drill_clients
 * `an:predict` rows (one per project, detail = [{pid, state, entry, los,
 * eps, ph, age, minor, src, score, feat, hist}]).
 *
 * Agency-scoped BY RLS like the outlier/risk lists. Hashed IDs only, reads
 * audited. The LIST response strips `feat`/`hist`/`age`/`src` (12k clients —
 * keep it light); `?pid=` returns ONE client's full detail for the dossier,
 * where the browser computes factor contributions and intervention scores
 * from meta's model weights (weights × features — arithmetic, not
 * re-derivation).
 */

interface DetailRow {
  pid: string; state: string; entry: string | null; los: number; eps: number;
  ph: number; age: number; minor: number; src: string | null; score: number;
  feat: number[]; hist: { s: string; e: string; x: string; l: number; ph: number }[] | null;
}

export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const pid = sp.get('pid');
  const wantCsv = sp.get('format') === 'csv';
  await audit(wantCsv ? 'predict_export' : 'predict_view', viewer, pid ? { pid } : {});

  const sb = supabaseServer();
  const { data, error } = await sb.from('drill_clients')
    .select('period, project_id, detail')
    .eq('metric', 'an:predict');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const drills = (data ?? []) as { period: string; project_id: number; detail: DetailRow[] | null }[];
  const projIds = [...new Set(drills.map((r) => r.project_id))];
  const { data: projRows } = projIds.length
    ? await sb.from('projects').select('project_id, name').in('project_id', projIds)
    : { data: [] as never[] };
  const projById = new Map((projRows ?? []).map(
    (p: { project_id: number; name: string | null }) => [p.project_id, p.name]));
  const asOf = drills[0]?.period ?? null;

  // Single-client dossier fetch.
  if (pid) {
    for (const r of drills) {
      const hit = (r.detail ?? []).find((d) => d.pid === pid);
      if (hit) {
        return NextResponse.json({
          asOf,
          client: {
            ...hit,
            project_id: r.project_id,
            project: projById.get(r.project_id) ?? `Project ${r.project_id}`,
          },
        });
      }
    }
    return NextResponse.json({ asOf, client: null }, { status: 404 });
  }

  const rows = drills.flatMap((r) => {
    const project = projById.get(r.project_id) ?? `Project ${r.project_id}`;
    return (r.detail ?? []).map((d) => ({
      pid: d.pid,
      project_id: r.project_id,
      project,
      state: d.state,
      entry: d.entry,
      los: d.los,
      eps: d.eps,
      ph: d.ph,
      minor: d.minor,
      score: d.score,
    }));
  }).sort((a, b) => a.score - b.score);

  if (wantCsv) {
    const lines = ['client_id,program,program_type,entry_date,days_enrolled,prior_episodes,family,housing_score_pct'];
    for (const r of rows) {
      lines.push([r.pid, '"' + r.project.replace(/"/g, '""') + '"', r.state,
        r.entry ?? '', r.los, r.eps, r.minor ? 1 : 0,
        (r.score * 100).toFixed(1)].join(','));
    }
    return new NextResponse('﻿' + lines.join('\r\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="housing_predictor_caseload_${asOf ?? 'current'}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  return NextResponse.json({ asOf, scoped: !viewer.isAdmin, rows });
}
