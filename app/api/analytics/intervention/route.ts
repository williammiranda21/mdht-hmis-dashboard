import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../../lib/supabase-server';
import { audit } from '../../../../lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Intervention Guide caseload (2026-09-25) — ADDITIVE to /api/analytics/predictor.
 * Rows come from drill_clients `an:ivx` (one per project, detail = one entry per
 * active head of household, written by generate_intervention.py).
 *
 * Agency-scoped BY RLS like every an:* list; hashed IDs only; reads audited.
 * The LIST strips the heavy per-option / similar-client / pathway blocks;
 * `?pid=` returns one client's full estimate for the dossier.
 */

type Opt = [number, number, number, number, number, number, number];
type Sim = [number, number, number, number | null, number | null, number] | null;
interface DetailRow {
  pid: string; state: string; start: string; days: number; hh: number; minor: number;
  inc: number | null; fmr: number; gap: number; p: number; p_lo: number; p_hi: number;
  opt: Record<string, Opt>; sim: Record<string, Sim>; best: string | null; verdict: string;
  why: [string, number][]; path_now: string; paths: [string, number, number, number | null][];
}

export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const pid = sp.get('pid');
  const wantCsv = sp.get('format') === 'csv';
  await audit(wantCsv ? 'ivx_export' : 'ivx_view', viewer, pid ? { pid } : {});

  const sb = supabaseServer();
  const { data, error } = await sb.from('drill_clients')
    .select('period, project_id, detail')
    .eq('metric', 'an:ivx');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const drills = (data ?? []) as { period: string; project_id: number; detail: DetailRow[] | null }[];
  const projIds = [...new Set(drills.map((r) => r.project_id))];
  const { data: projRows } = projIds.length
    ? await sb.from('projects').select('project_id, name').in('project_id', projIds)
    : { data: [] as never[] };
  const projById = new Map((projRows ?? []).map(
    (p: { project_id: number; name: string | null }) => [p.project_id, p.name]));
  const asOf = drills[0]?.period ?? null;

  if (pid) {
    for (const r of drills) {
      const hit = (r.detail ?? []).find((d) => d.pid === pid);
      if (hit) {
        return NextResponse.json({
          asOf,
          client: { ...hit, project_id: r.project_id, project: projById.get(r.project_id) ?? `Project ${r.project_id}` },
        });
      }
    }
    return NextResponse.json({ asOf, client: null }, { status: 404 });
  }

  const rows = drills.flatMap((r) => {
    const project = projById.get(r.project_id) ?? `Project ${r.project_id}`;
    return (r.detail ?? []).map((d) => ({
      pid: d.pid, project_id: r.project_id, project, state: d.state, days: d.days,
      minor: d.minor, p: d.p, p_lo: d.p_lo, p_hi: d.p_hi, best: d.best, verdict: d.verdict,
      best_p: d.best ? d.opt[d.best]?.[0] ?? null : null,
    }));
  }).sort((a, b) => a.p - b.p);

  if (wantCsv) {
    const lines = ['client_id,program,program_type,days_in_episode,family,success_typical_path_pct,range_low_pct,range_high_pct,best_program,best_program_success_pct,evidence'];
    for (const r of rows) {
      lines.push([r.pid, '"' + r.project.replace(/"/g, '""') + '"', r.state, r.days, r.minor ? 1 : 0,
        (r.p * 100).toFixed(1), (r.p_lo * 100).toFixed(1), (r.p_hi * 100).toFixed(1),
        r.best ?? '', r.best_p != null ? (r.best_p * 100).toFixed(1) : '', r.verdict].join(','));
    }
    return new NextResponse('﻿' + lines.join('\r\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="intervention_guide_${asOf ?? 'current'}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  return NextResponse.json({ asOf, scoped: !viewer.isAdmin, rows });
}
