import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';
import { EVA_BY_ID } from '../../../lib/evaChecks';

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
  { key: 'incexit', metric: 'dq:incexit', pctKey: 'DQ_IncExit_pct' },
  { key: 'annual', metric: 'dq:annual', pctKey: 'DQ_Annual_pct' },
  // Q6b FY2026 elements + Q6d chronic (ETL rebuild 2026-08-13) — rows appear
  // once the first post-rebuild refresh loads dq:* drills for them.
  { key: 'veteran', metric: 'dq:veteran', pctKey: 'DQ_Veteran_pct' },
  { key: 'psd', metric: 'dq:psd', pctKey: 'DQ_PSD_pct' },
  { key: 'relhoh', metric: 'dq:relhoh', pctKey: 'DQ_RelHoH_pct' },
  { key: 'coc', metric: 'dq:coc', pctKey: 'DQ_CoC_pct' },
  { key: 'disabling', metric: 'dq:disabling', pctKey: 'DQ_Disabling_pct' },
  { key: 'chronic', metric: 'dq:chronic', pctKey: 'DQ_Chronic_pct' },
  // Left-open enrollment suspects (pipeline/recompute_openstay.py) — a SNAPSHOT
  // keyed to the latest complete month; no trend % exists for it.
  { key: 'openstay', metric: 'dq:openstay', pctKey: 'DQ_OpenStay_pct' },
  // PII (Q6a) — client-level, fix once per client. Deduped to unique clients in
  // the ETL, so the count here is people-to-fix, while the trend % stays the
  // APR's per-enrollment rate (same count-vs-% split as income).
  { key: 'name', metric: 'dq:name', pctKey: 'DQ_Name_pct' },
  { key: 'ssn', metric: 'dq:ssn', pctKey: 'DQ_SSN_pct' },
  { key: 'dob', metric: 'dq:dob', pctKey: 'DQ_DOB_pct' },
  { key: 'race', metric: 'dq:race', pctKey: 'DQ_Race_pct' },
  { key: 'sex', metric: 'dq:sex', pctKey: 'DQ_Sex_pct' },
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
      .select('metric, personal_ids, detail')
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

  type DetailRow = { pid: string; entry: string | null; eid?: string | null };
  const rowsByMetric = new Map<string, { ids: string[]; detail: DetailRow[] | null }>(
    (drillRes.data ?? []).map((r: { metric: string; personal_ids: string[]; detail: DetailRow[] | null }) =>
      [r.metric, { ids: r.personal_ids ?? [], detail: r.detail ?? null }]),
  );

  const hist = (histRes.data ?? []) as { period: string; data: Record<string, number | null> }[];
  const recent = hist.slice(-TREND_MONTHS);

  const categories = ELEMENTS.map((e) => {
    const row = rowsByMetric.get(e.metric);
    return {
      key: e.key,
      ids: row?.ids ?? [],
      // per-stay rows {pid, entry, eid} — every element since the 2026-08-13
      // ETL change (client-level elements use the latest stay); null for rows
      // loaded before it.
      detail: row?.detail ?? null,
      trend: recent.map((h) => ({ period: h.period, pct: (h.data?.[e.pctKey] as number | null) ?? null })),
    };
  });

  // ── Eva checks (snapshot, latest complete month — independent of `period`) ──
  // Findings from pipeline/recompute_eva.py; labels/severity/fix copy live in
  // lib/evaChecks.ts on the client. Empty array when the project is clean.
  const { data: dqpMeta } = await sb.from('meta').select('value').eq('key', 'dq_periods').maybeSingle();
  const evaMonthly: string[] = ((dqpMeta?.value as { monthly?: string[] } | null)?.monthly ?? []);
  const evaPeriod = evaMonthly[evaMonthly.length - 1] ?? period;
  const { data: evaRows } = await sb.from('drill_clients')
    .select('metric, personal_ids, detail')
    .eq('period', evaPeriod)
    .eq('project_id', projectId)
    .like('metric', 'eva:%');
  const eva = (evaRows ?? []).map((r: { metric: string; personal_ids: string[]; detail: DetailRow[] | null }) => ({
    id: r.metric.slice(4),
    ids: r.personal_ids ?? [],
    detail: r.detail ?? null,
  }));

  // ── CSV export (?format=csv) — a real server download, NOT a browser blob.
  // Blob downloads break under the county's Web Isolation (its scanning proxy
  // 500s them); a plain GET with Content-Disposition survives it.
  if (sp.get('format') === 'csv') {
    const lines = ['error,client_id,enrollment_id,entry_date'];
    const noDetail = (id: string): DetailRow => ({ pid: id, entry: null, eid: null });
    for (const c of categories) {
      const rows = c.detail ?? c.ids.map(noDetail);
      for (const d of rows) lines.push(`${c.key},${d.pid},${d.eid ?? ''},${d.entry ?? ''}`);
    }
    for (const f of eva) {
      // readable error key ('overlapping_stays', 'duplicate_enrollment', …) —
      // 'eva_2' told staff nothing (user request 2026-08-13). Unregistered
      // check ids keep the eva_<id> fallback.
      const slug = EVA_BY_ID.get(f.id)?.slug ?? `eva_${f.id}`;
      const rows = f.detail ?? f.ids.map(noDetail);
      for (const d of rows) lines.push(`${slug},${d.pid},${d.eid ?? ''},${d.entry ?? ''}`);
    }
    return new NextResponse(lines.join('\r\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="dq_fixlist_${projectId}_${period}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  return NextResponse.json({ project_id: projectId, period, categories, eva, evaPeriod });
}
