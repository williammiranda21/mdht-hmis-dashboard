import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * Lease-up funnel (Pillar 3-4) — enrollment → move-in per PH-type project.
 * Rows come from leaseup_funnel (loaded by pipeline/recompute_leaseup.py, one
 * snapshot row per PH/RRH/PSH project as of the export end date). Referrals are
 * deliberately not a stage — Event.csv can't tie a referral to a target project.
 */
export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const ids = (new URL(req.url).searchParams.get('projects') ?? '')
    .split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
  if (!ids.length) return NextResponse.json({ error: 'projects required' }, { status: 400 });

  const sb = supabaseServer();
  const [luRes, projRes] = await Promise.all([
    sb.from('leaseup_funnel').select('project_id, as_of, data').in('project_id', ids),
    sb.from('projects').select('project_id, name, type_name').in('project_id', ids),
  ]);
  if (luRes.error) return NextResponse.json({ error: luRes.error.message }, { status: 500 });

  const names = new Map((projRes.data ?? []).map(
    (p: { project_id: number; name: string | null; type_name: string | null }) =>
      [Number(p.project_id), { name: p.name ?? `Project ${p.project_id}`, type: p.type_name }]));

  const rows = (luRes.data ?? []).map((r: { project_id: number; as_of: string; data: Record<string, unknown> }) => ({
    project_id: Number(r.project_id),
    name: names.get(Number(r.project_id))?.name ?? `Project ${r.project_id}`,
    type: names.get(Number(r.project_id))?.type ?? null,
    as_of: r.as_of,
    ...r.data,
  }));
  return NextResponse.json({ rows });
}
