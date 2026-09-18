import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../../lib/supabase-server';
import { audit } from '../../../../lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Long-stay outliers for the Analytics tab's Survival section: currently
 * enrolled clients past 1.5× their program type's median length of stay
 * (computed by generate_analytics.py, loaded as drill_clients `an:outlier`
 * rows — one row per project, detail = [{pid, entry, days, med, over}]).
 *
 * Agency-scoped BY RLS, not by this route: "scoped read drill" returns only
 * the caller's projects (everything, for an admin), so a non-admin's outlier
 * table is exactly their own agency's clients. Hashed IDs only, never names.
 * Reads are audited (person-level record IDs, compliance gap #2).
 */

interface DetailRow { pid: string; entry: string | null; days: number; med: number | null; over: number }

export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const wantCsv = sp.get('format') === 'csv';
  await audit(wantCsv ? 'outliers_export' : 'outliers_view', viewer, {});

  const sb = supabaseServer();
  // One row per project (29 system-wide as of 2026-09) — no paging needed;
  // the 1000-row PostgREST cap is per row, not per personal_ids entry.
  const { data, error } = await sb.from('drill_clients')
    .select('period, project_id, personal_ids, detail')
    .eq('metric', 'an:outlier');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const drills = (data ?? []) as {
    period: string; project_id: number; personal_ids: string[]; detail: DetailRow[] | null;
  }[];
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
      entry: d.entry,
      days: d.days,
      med: d.med,
      over: d.over,
    }));
  }).sort((a, b) => b.days - a.days);

  const asOf = drills[0]?.period ?? null;

  // CSV as a real server download — blob downloads die under the county's
  // Web Isolation proxy (same pattern as the DQ fix-list export).
  if (wantCsv) {
    const lines = ['client_id,program,program_type,entry_date,days_enrolled,type_median,days_over_median'];
    for (const r of rows) {
      lines.push([r.pid, '"' + r.project.replace(/"/g, '""') + '"', '"' + r.ptype + '"',
        r.entry ?? '', r.days, r.med ?? '', r.over].join(','));
    }
    return new NextResponse('﻿' + lines.join('\r\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="long_stay_outliers_${asOf ?? 'current'}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  return NextResponse.json({ asOf, scoped: !viewer.isAdmin, rows });
}
