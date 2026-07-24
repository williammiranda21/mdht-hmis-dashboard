import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * Data-quality fix-list for one project: the hashed PersonalIDs behind each
 * fixable error element, plus that element's missing-% history for a trend.
 *
 * The per-client records live in `drill_clients` as `dq:<element>` rows (written
 * by apr_monthly_report.py's DQ pass, same records the APR Q6 counts are built
 * from) — so RLS `scoped read drill` scopes them to the caller's own projects,
 * exactly like every other client drill. Hashed IDs only, never names.
 *
 * The trend comes from `dq_metrics` (aggregate, approved-read) — the element's
 * missing-% across recent monthly periods, so an agency can see itself improving.
 */

// element → (drill metric, the dq_metrics % key for the trend). Order = display order.
const ELEMENTS: { key: string; metric: string; pctKey: string }[] = [
  { key: 'dest', metric: 'dq:dest', pctKey: 'DQ_Dest_pct' },
  { key: 'movein', metric: 'dq:movein', pctKey: 'DQ_MoveIn_pct' },
  { key: 'income', metric: 'dq:income', pctKey: 'DQ_IncMiss_pct' },
  { key: 'annual', metric: 'dq:annual', pctKey: 'DQ_Annual_pct' },
];
const TREND_MONTHS = 12;

export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const projectId = Number(sp.get('project'));
  const period = sp.get('period') ?? '';
  if (!Number.isFinite(projectId)) return NextResponse.json({ error: 'project required' }, { status: 400 });
  if (!/^\d{4}-\d{2}$/.test(period)) return NextResponse.json({ error: 'monthly period required' }, { status: 400 });

  const sb = supabaseServer();

  const [drillRes, histRes] = await Promise.all([
    sb.from('drill_clients')
      .select('metric, personal_ids')
      .eq('period', period)
      .eq('project_id', projectId)
      .in('metric', ELEMENTS.map((e) => e.metric)),
    // Element trend — this project's monthly DQ history (aggregate, approved-read).
    sb.from('dq_metrics')
      .select('period, data')
      .eq('project_id', projectId)
      .eq('granularity', 'monthly')
      .order('period'),
  ]);

  if (drillRes.error) return NextResponse.json({ error: drillRes.error.message }, { status: 500 });

  const byMetric = new Map<string, string[]>(
    (drillRes.data ?? []).map((r: { metric: string; personal_ids: string[] }) => [r.metric, r.personal_ids ?? []]),
  );

  const hist = (histRes.data ?? []) as { period: string; data: Record<string, number | null> }[];
  const recent = hist.slice(-TREND_MONTHS);

  const categories = ELEMENTS.map((e) => ({
    key: e.key,
    ids: byMetric.get(e.metric) ?? [],
    trend: recent.map((h) => ({ period: h.period, pct: (h.data?.[e.pctKey] as number | null) ?? null })),
  }));

  return NextResponse.json({ project_id: projectId, period, categories });
}
