import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../../lib/supabase-server';
import { audit } from '../../../../lib/audit';
import { DEST_LABELS, SUBSIDY_LABELS } from '../../../../lib/format';

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
  // Destination + subsidy codes (added 2026-09-18) — absent on older loads.
  dest?: number | null; sub?: number | null;
  // Horizon probabilities in percent (≤6mo / ≤12mo) — the headline `score`
  // is the 24-month (overall) figure. Absent on older loads.
  s6?: number | null; s12?: number | null;
  // Raw model feature vector (dossier fetch only — stripped from the list).
  feat?: number[] | null;
  // Already-returned: the observed return happened `retd` days after this
  // exit — a realized outcome, not a forecast. Absent on older loads.
  ret?: number | null; retd?: number | null;
}

export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const wantCsv = sp.get('format') === 'csv';
  const pid = sp.get('pid');
  await audit(wantCsv ? 'risklist_export' : 'risklist_view', viewer, pid ? { pid } : {});

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
  const asOf = drills[0]?.period ?? null;

  // Single-client dossier fetch — includes the feature vector so the browser
  // can compute personal factor contributions and exit-package what-ifs from
  // meta's risk.model.scoring parameters.
  if (pid) {
    for (const r of drills) {
      const hit = (r.detail ?? []).find((d) => d.pid === pid);
      if (hit) {
        const p = projById.get(r.project_id);
        return NextResponse.json({
          asOf,
          client: {
            ...hit,
            project_id: r.project_id,
            project: p?.name ?? `Project ${r.project_id}`,
            ptype: p?.type_name ?? '',
          },
        });
      }
    }
    return NextResponse.json({ asOf, client: null }, { status: 404 });
  }

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
      dest: d.dest ?? null,
      sub: d.sub ?? null,
      s6: d.s6 ?? null,
      s12: d.s12 ?? null,
      ret: d.ret ?? null,
      retd: d.retd ?? null,
    }));
  }).sort((a, b) => b.score - a.score);

  // CSV as a real server download (county Web Isolation kills blob URLs).
  if (wantCsv) {
    const lines = ['client_id,program,program_type,exit_date,destination,subsidy_type,los_days,prior_episodes,risk_6mo_pct,risk_12mo_pct,risk_24mo_pct,risk_tier,already_returned,returned_after_days'];
    for (const r of rows) {
      const destLbl = r.dest != null ? (DEST_LABELS[r.dest] ?? String(r.dest)) : '';
      const subLbl = r.sub != null ? (SUBSIDY_LABELS[r.sub] ?? String(r.sub)) : '';
      lines.push([r.pid, '"' + r.project.replace(/"/g, '""') + '"', '"' + r.ptype + '"',
        r.exit ?? '', '"' + destLbl + '"', '"' + subLbl + '"',
        r.los != null ? Math.round(r.los) : '', r.eps ?? '',
        r.s6 != null ? Number(r.s6).toFixed(1) : '',
        r.s12 != null ? Number(r.s12).toFixed(1) : '',
        Number(r.score).toFixed(1), '"' + r.bucket + '"',
        r.ret ? 1 : 0, r.retd ?? ''].join(','));
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
