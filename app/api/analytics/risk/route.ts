import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../../lib/supabase-server';
import { audit } from '../../../../lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Client return-risk list for the Analytics tab's Risk section (user
 * directive 2026-09-18): every recently-scored PH exit with its predicted
 * 2-year return probability, from drill_clients `an:risk` rows (one per
 * project, detail = [{pid, exit, los, eps, score, bucket}]).
 *
 * Agency-scoped BY RLS, exactly like the outlier list: "scoped read drill"
 * returns only the caller's projects (everything, for an admin). Hashed IDs
 * only, never names. Reads are audited (person-level record IDs).
 */

interface DetailRow {
  pid: string; exit: string | null; los: number | null; eps: number | null;
  score: number; bucket: string;
}

export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const wantCsv = sp.get('format') === 'csv';
  await audit(wantCsv ? 'risklist_export' : 'risklist_view', viewer, {});

  const sb = supabaseServer();
  // One row per project with scored exits (~100 system-wide) — under the
  // PostgREST row cap without paging.
  const { data, error } = await sb.from('drill_clients')
    .select('period, project_id, detail')
    .eq('metric', 'an:risk');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const drills = (data ?? []) as { period: string; project_id: number; detail: DetailRow[] | null }[];
  const projIds = [...new Set(drills.map((r) => r.project_id))];
  const { data: projRows } = projIds.length
    ? await sb.from('projects').select('project_id, name, type_name').in('project_id', projIds)
    : { data: [] as never[] };
  const projById = new Map((projRows ?? []).map(
    (p: { project_id: number; name: string | null; type_name: string | null }) => [p.project_id, p]));

  const rows = drills.flatMap((r) => {
    const p = projById.get(r.project_id);
    return (r.detail ?? []).map((d) => ({
      pid: d.pid,
      project_id: r.project_id,
      project: p?.name ?? `Project ${r.project_id}`,
      ptype: p?.type_name ?? '',
      exit: d.exit,
      los: d.los,
      eps: d.eps,
      score: d.score,
      bucket: d.bucket,
    }));
  }).sort((a, b) => b.score - a.score);

  const asOf = drills[0]?.period ?? null;

  // CSV as a real server download (county Web Isolation kills blob URLs).
  if (wantCsv) {
    const lines = ['client_id,program,program_type,exit_date,los_days,prior_episodes,risk_score_pct,risk_tier'];
    for (const r of rows) {
      lines.push([r.pid, '"' + r.project.replace(/"/g, '""') + '"', '"' + r.ptype + '"',
        r.exit ?? '', r.los != null ? Math.round(r.los) : '', r.eps ?? '',
        Number(r.score).toFixed(1), '"' + r.bucket + '"'].join(','));
    }
    return new NextResponse('﻿' + lines.join('\r\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="return_risk_scores_${asOf ?? 'current'}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  return NextResponse.json({ asOf, scoped: !viewer.isAdmin, rows });
}
