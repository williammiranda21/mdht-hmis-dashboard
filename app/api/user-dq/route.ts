import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * Per-user data-entry quality (user_dq — pipeline/recompute_user_dq.py).
 *
 * No ?user  → the roster: one row per HMIS user visible to the caller, with
 *             volume, attributed errors, rate and top element (trailing 12
 *             complete months).
 * ?user=<id> → the score card: monthly series + per-metric and per-project
 *             breakdowns for one user.
 *
 * Runs on the session client: RLS (`scoped read user dq`) hands admins
 * everyone and agency users exactly the staff visible through their granted
 * projects — no extra scoping here. Attribution is RECORD CREATOR (the export
 * carries no editor identity); the UI must keep saying that.
 */

export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const userId = sp.get('user');

  const sb = supabaseServer();
  type Row = {
    period: string; user_id: string; project_id: number; metric: string; n: number;
    user_name: string | null; user_email: string | null; is_import: boolean;
  };
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from('user_dq')
      .select('period, user_id, project_id, metric, n, user_name, user_email, is_import')
      .order('user_id').order('period').order('project_id').order('metric')
      .range(from, from + 999);
    if (userId) q = q.eq('user_id', userId);
    const r = await q;
    if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });
    rows.push(...((r.data ?? []) as Row[]));
    if ((r.data ?? []).length < 1000) break;
  }

  if (!userId) {
    // Errors come ONLY from the period='window' rows — unique records across
    // the trailing 12 months (a record failing for a year counts once). The
    // monthly rows are open-error LEVELS and must never be summed.
    const by = new Map<string, {
      user_id: string; name: string | null; email: string | null; is_import: boolean;
      created: number; errors: number; perMetric: Map<string, number>; projects: Set<number>;
    }>();
    for (const r of rows) {
      const e = by.get(r.user_id) ?? {
        user_id: r.user_id, name: r.user_name, email: r.user_email,
        is_import: r.is_import, created: 0, errors: 0,
        perMetric: new Map(), projects: new Set(),
      };
      if (r.metric === 'created') {
        if (r.period !== 'window') e.created += r.n;
      } else if (r.period === 'window') {
        e.errors += r.n;
        e.perMetric.set(r.metric, (e.perMetric.get(r.metric) ?? 0) + r.n);
        e.projects.add(r.project_id);
      }
      by.set(r.user_id, e);
    }
    const users = [...by.values()].map((u) => {
      const top = [...u.perMetric.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
      return {
        user_id: u.user_id, name: u.name, email: u.email, is_import: u.is_import,
        created: u.created, errors: u.errors,
        rate: u.created > 0 ? (u.errors / u.created) * 100 : null,
        top_metric: top ? { metric: top[0], n: top[1] } : null,
        projects: u.projects.size,
      };
    });
    return NextResponse.json({ users });
  }

  // ── single-user card ────────────────────────────────────────────────────
  // monthly = open-error LEVEL per month (trend); totals/breakdowns = the
  // deduped period='window' rows.
  const win = rows.filter((r) => r.period === 'window');
  const mon = rows.filter((r) => r.period !== 'window');
  const periods = [...new Set(mon.map((r) => r.period))].sort();
  const monthly = periods.map((p) => {
    const sub = mon.filter((r) => r.period === p);
    const created = sub.filter((r) => r.metric === 'created').reduce((s, r) => s + r.n, 0);
    const errors = sub.filter((r) => r.metric !== 'created').reduce((s, r) => s + r.n, 0);
    return { period: p, created, errors };
  });
  const perMetric = new Map<string, number>();
  const perProject = new Map<number, { errors: number; created: number }>();
  for (const r of mon) {
    if (r.metric !== 'created') continue;
    const pp = perProject.get(r.project_id) ?? { errors: 0, created: 0 };
    pp.created += r.n;
    perProject.set(r.project_id, pp);
  }
  for (const r of win) {
    if (r.metric === 'created') continue;
    const pp = perProject.get(r.project_id) ?? { errors: 0, created: 0 };
    pp.errors += r.n;
    perMetric.set(r.metric, (perMetric.get(r.metric) ?? 0) + r.n);
    perProject.set(r.project_id, pp);
  }
  // project names for the split
  const ids = [...perProject.keys()];
  const { data: projRows } = ids.length
    ? await sb.from('projects').select('project_id, name').in('project_id', ids)
    : { data: [] };
  const pname = new Map((projRows ?? []).map(
    (p: { project_id: number; name: string | null }) => [Number(p.project_id), p.name]));

  const first = rows[0];
  return NextResponse.json({
    user: first ? { user_id: first.user_id, name: first.user_name,
      email: first.user_email, is_import: first.is_import } : null,
    monthly,
    metrics: [...perMetric.entries()].map(([metric, n]) => ({ metric, n }))
      .sort((a, b) => b.n - a.n),
    projects: [...perProject.entries()].map(([project_id, v]) => ({
      project_id, name: pname.get(project_id) ?? `Project ${project_id}`, ...v,
    })).sort((a, b) => b.errors - a.errors),
  });
}
