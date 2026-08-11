import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * Client cohorts (admin-only, backed by RLS "admins all" — supabase/cohorts.sql).
 *
 * GET            → cohort list with member counts
 * GET ?id=N      → one cohort: members joined LIVE to bnl_clients (current
 *                  status/journey — always as fresh as the last refresh),
 *                  aggregate metrics computed here, and the snapshot trend
 * POST {action}  → create | rename | delete | add_members | remove_member
 *
 * add_members takes pasted hashed PersonalIDs (the CopyId chips everywhere in
 * the app produce exactly these); unknown IDs are reported back, not silently
 * dropped. Membership is static — nothing here auto-removes housed clients.
 */

const MS_ORDER = ['ident', 'assessed', 'referred', 'accepted', 'movein'];

const median = (v: number[]): number | null => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const mean = (v: number[]): number | null =>
  v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;

export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isAdmin) return NextResponse.json({ error: 'admin only' }, { status: 403 });

  const sb = supabaseServer();
  const id = new URL(req.url).searchParams.get('id');

  if (!id) {
    const [cRes, mRes] = await Promise.all([
      sb.from('cohorts').select('id, name, description, created_by, created_at').order('created_at', { ascending: false }),
      sb.from('cohort_members').select('cohort_id'),
    ]);
    if (cRes.error) return NextResponse.json({ error: cRes.error.message }, { status: 500 });
    const counts = new Map<number, number>();
    for (const m of (mRes.data ?? []) as { cohort_id: number }[]) {
      counts.set(Number(m.cohort_id), (counts.get(Number(m.cohort_id)) ?? 0) + 1);
    }
    return NextResponse.json({
      cohorts: (cRes.data ?? []).map((c: Record<string, unknown>) => ({
        ...c, members: counts.get(Number(c.id)) ?? 0,
      })),
    });
  }

  const cohortId = Number(id);
  const [cRes, mRes, sRes] = await Promise.all([
    sb.from('cohorts').select('id, name, description, created_by, created_at').eq('id', cohortId).maybeSingle(),
    sb.from('cohort_members').select('pid, added_at').eq('cohort_id', cohortId),
    sb.from('cohort_snapshots').select('captured_on, counts').eq('cohort_id', cohortId).order('captured_on'),
  ]);
  if (cRes.error) return NextResponse.json({ error: cRes.error.message }, { status: 500 });
  if (!cRes.data) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const pids = ((mRes.data ?? []) as { pid: string }[]).map((m) => m.pid);
  type Placed = { s: string; e: string; k: string; open: boolean; ret?: string | null };
  type Member = {
    pid: string; name: string | null; age: number | null; status: string;
    project: string | null; ptype: string | null; enrolled: boolean;
    days_homeless: number | null; chronic: boolean; returned: boolean;
    risk_band: string | null; milestones: Record<string, string | null> | null;
    as_of: string | null;
    // server-side only (housed-curve reconstruction) — stripped before the response
    hist3?: { placed?: Placed[] } | null;
  };
  const members: Member[] = [];
  for (let i = 0; i < pids.length; i += 200) {
    const r = await sb.from('bnl_clients')
      .select('pid, name, age, status, project, ptype, enrolled, days_homeless, chronic, returned, risk_band, milestones, as_of, hist3')
      .in('pid', pids.slice(i, i + 200));
    if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });
    members.push(...((r.data ?? []) as Member[]));
  }
  const found = new Set(members.map((m) => m.pid));
  const missing = pids.filter((p) => !found.has(p));   // left the roster since being added

  // ── aggregates ──────────────────────────────────────────────────────────
  const by = { active: 0, housed: 0, inactive: 0 };
  let returned = 0, chronic = 0, highRisk = 0;
  const dh: number[] = [];
  const legDays: Record<string, number[]> = {};
  const waitDays: Record<string, number[]> = {};
  // Roster generation date — live waits are measured to it (same clock as
  // the BNL's system card), never to the browser's "now".
  const asOf = members[0]?.as_of ?? null;
  for (const m of members) {
    if (m.status in by) by[m.status as keyof typeof by]++;
    if (m.returned) returned++;
    if (m.chronic) chronic++;
    if (m.risk_band === 'High') highRisk++;
    if (m.status === 'active' && m.days_homeless != null) dh.push(m.days_homeless);
    const ms = m.milestones ?? {};
    for (let i = 0; i < MS_ORDER.length - 1; i++) {
      const a = ms[MS_ORDER[i]], b = ms[MS_ORDER[i + 1]];
      if (a && b) {
        const d = Math.round((+new Date(b) - +new Date(a)) / 86400000);
        if (d >= 0) (legDays[`${MS_ORDER[i]}_${MS_ORDER[i + 1]}`] ??= []).push(d);
      }
    }
    if (ms['ident'] && ms['movein']) {
      const d = Math.round((+new Date(ms['movein']) - +new Date(ms['ident'])) / 86400000);
      if (d >= 0) (legDays['ident_movein'] ??= []).push(d);
    }
    // Live stalls — mirrors bnl_core's ce_milestones `waiting` semantics:
    // ACTIVE members not yet moved in, bucketed by furthest milestone
    // reached, measuring days since that date. Feeds the under-segment
    // "N waiting · Xd" line of the shared JourneyBar.
    if (m.status === 'active' && !ms['movein'] && asOf) {
      const last = [...MS_ORDER].reverse().find((k) => k !== 'movein' && ms[k]);
      if (last) {
        const d = Math.round((+new Date(asOf) - +new Date(ms[last]!)) / 86400000);
        if (d >= 0) (waitDays[last] ??= []).push(d);
      }
    }
  }

  // ── Housed % by EVENT date, not refresh date ────────────────────────────
  // Reconstructed from each member's hist3 placements: housed from the actual
  // placement start until its HUD-qualifying return (`ret`, same M2 test as
  // the roster flag). A movein placement with no return ends at the project
  // exit (left PH to a non-perm destination); exit->PH placements and open
  // stays run to the data as_of. Weekly samples. The cohort_snapshots series
  // stays alongside as the as-measured audit trail — if a snapshot dot and
  // this line disagree for the same date, someone edited history after the
  // fact (backdated move-ins, corrected exits).
  const DAY = 86400000;
  const D = (s: string) => +new Date(`${s}T00:00:00Z`);
  const tEnd = asOf ? D(asOf) : Date.now();
  const intervals = members.map((m) =>
    (m.hist3?.placed ?? []).map((p) => {
      const s = D(p.s);
      const e = p.ret ? D(p.ret) : (p.k === 'exit' || p.open) ? tEnd : D(p.e);
      return [s, Math.max(s, e)] as [number, number];
    }));
  const housedCurve: { d: string; pct: number; n: number }[] = [];
  const starts = intervals.flat().map(([s]) => s);
  if (starts.length && members.length) {
    const t0 = Math.min(...starts);
    for (let t = t0; ; t += 7 * DAY) {
      const at = Math.min(t, tEnd);
      const n = intervals.filter((iv) => iv.some(([s, e]) => s <= at && at <= e)).length;
      housedCurve.push({
        d: new Date(at).toISOString().slice(0, 10),
        pct: (100 * n) / members.length,
        n,
      });
      if (at >= tEnd) break;
    }
  }
  for (const m of members) delete m.hist3;   // heavy + drawer fetches its own

  members.sort((a, b) =>
    ({ active: 0, housed: 1, inactive: 2 }[a.status] ?? 3) - ({ active: 0, housed: 1, inactive: 2 }[b.status] ?? 3)
    || (a.name ?? '').localeCompare(b.name ?? ''));

  return NextResponse.json({
    cohort: cRes.data,
    members,
    missing,
    snapshots: sRes.data ?? [],
    agg: {
      n: members.length,
      ...by,
      housed_pct: members.length ? (by.housed / members.length) * 100 : null,
      returned, chronic, high_risk: highRisk,
      median_days_homeless: median(dh),
      legs: Object.fromEntries(Object.entries(legDays).map(([k, v]) => [k, { n: v.length, median: median(v), mean: mean(v) }])),
      waiting: Object.fromEntries(Object.entries(waitDays).map(([k, v]) => [k, { n: v.length, median: median(v), mean: mean(v) }])),
      housed_curve: housedCurve,
    },
  });
}

export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isAdmin) return NextResponse.json({ error: 'admin only' }, { status: 403 });

  let body: { action?: string; id?: number; name?: string; description?: string; pids?: string[]; pid?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const sb = supabaseServer();

  if (body.action === 'create') {
    const name = (body.name ?? '').trim();
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
    const { data, error } = await sb.from('cohorts')
      .insert({ name, description: body.description?.trim() || null, created_by: viewer.email ?? null })
      .select('id').single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, id: data.id });
  }

  const id = Number(body.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: 'id required' }, { status: 400 });

  if (body.action === 'delete') {
    const { error } = await sb.from('cohorts').delete().eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'add_members') {
    const pids = [...new Set((body.pids ?? []).map((p) => String(p).trim()).filter(Boolean))];
    if (!pids.length) return NextResponse.json({ error: 'no IDs supplied' }, { status: 400 });
    // Validate against the roster so typos are surfaced, not silently stored.
    const known = new Set<string>();
    for (let i = 0; i < pids.length; i += 200) {
      const r = await sb.from('bnl_clients').select('pid').in('pid', pids.slice(i, i + 200));
      if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });
      for (const row of (r.data ?? []) as { pid: string }[]) known.add(row.pid);
    }
    const valid = pids.filter((p) => known.has(p));
    if (valid.length) {
      const { error } = await sb.from('cohort_members').upsert(
        valid.map((pid) => ({ cohort_id: id, pid, added_by: viewer.email ?? null })),
        { onConflict: 'cohort_id,pid', ignoreDuplicates: true });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, added: valid.length, unknown: pids.filter((p) => !known.has(p)) });
  }

  if (body.action === 'remove_member') {
    if (!body.pid) return NextResponse.json({ error: 'pid required' }, { status: 400 });
    const { error } = await sb.from('cohort_members').delete().eq('cohort_id', id).eq('pid', body.pid);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
