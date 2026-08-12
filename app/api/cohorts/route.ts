import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';
import { enrichRoster } from '../../../lib/bnl-enrich';
import type { BnlClient } from '../../dashboard/bnl/types';

export const dynamic = 'force-dynamic';

/**
 * Client cohorts (admin-managed; per-cohort grants — supabase/cohorts.sql +
 * cohort_tasks.sql).
 *
 * GET            → cohort list with member counts (admins: all; others: the
 *                  cohorts they were granted via cohort_access — RLS filters)
 * GET ?id=N      → one cohort: members joined LIVE to bnl_clients + last notes
 *                  (bnl_notes enrichment, same as the BNL roster), aggregate
 *                  metrics, snapshot trend, staffing tasks, and access grants
 * POST {action}  → admin: create | delete | add_members | remove_member |
 *                         grant_access | revoke_access | delete_task
 *                  any grantee (RLS-enforced): add_task | toggle_task
 *
 * add_members takes pasted hashed PersonalIDs (the CopyId chips everywhere in
 * the app produce exactly these); unknown IDs are reported back, not silently
 * dropped. Membership is static — nothing here auto-removes housed clients.
 * Member names/notes still ride on can_see_bnl(): a grantee without BNL access
 * gets the cohort shell but an empty member list (flagged `restricted`).
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
  // Not admin-only anymore: RLS scopes non-admins to cohorts they were granted
  // (cohort_access, supabase/cohort_tasks.sql). Approval is still required.
  if (!viewer.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

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
      manage: viewer.isAdmin,
      cohorts: (cRes.data ?? []).map((c: Record<string, unknown>) => ({
        ...c, members: counts.get(Number(c.id)) ?? 0,
      })),
    });
  }

  const cohortId = Number(id);
  const [cRes, mRes, sRes, msRes] = await Promise.all([
    sb.from('cohorts').select('id, name, description, created_by, created_at').eq('id', cohortId).maybeSingle(),
    sb.from('cohort_members').select('pid, added_at').eq('cohort_id', cohortId),
    sb.from('cohort_snapshots').select('captured_on, counts').eq('cohort_id', cohortId).order('captured_on'),
    // system-wide journey benchmark — rendered as the ghost figures on the
    // cohort's journey bar ("are we faster than the system?")
    sb.from('meta').select('value').eq('key', 'ce_milestones').maybeSingle(),
  ]);
  // Staffing tasks + access grants + the assignee/grant picker. Queried apart
  // from the Promise.all above because cohort_tasks.sql may not have been run
  // yet — a missing table degrades to tasks:null (the UI shows the setup hint)
  // instead of failing the whole cohort. profiles RLS shapes the staff list by
  // itself: admins see every approved account, others only their own row.
  const [tRes, aRes, stRes] = await Promise.all([
    sb.from('cohort_tasks')
      .select('id, pid, body, assignees, status, created_by, created_at, done_at, done_by')
      .eq('cohort_id', cohortId).order('created_at'),
    sb.from('cohort_access').select('user_id, granted_at').eq('cohort_id', cohortId),
    sb.from('profiles').select('id, display_name, email, bnl_access, is_admin').eq('status', 'approved').order('display_name'),
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
    ms_stage: string | null; ms_wait: number | null;
    // server-side only (housed-curve reconstruction) — stripped before the response
    hist3?: { placed?: Placed[] } | null;
  };
  const members: Member[] = [];
  for (let i = 0; i < pids.length; i += 200) {
    const r = await sb.from('bnl_clients')
      .select('pid, name, age, status, project, ptype, enrolled, days_homeless, chronic, returned, risk_band, milestones, as_of, ms_stage, ms_wait, hist3')
      .in('pid', pids.slice(i, i + 200));
    if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });
    members.push(...((r.data ?? []) as Member[]));
  }
  const found = new Set(members.map((m) => m.pid));
  const missing = pids.filter((p) => !found.has(p));   // left the roster since being added

  // Last-notes column, same enrichment as the BNL roster (notes2, cap 5 per
  // client). bnl_notes rides on can_see_bnl(); for a viewer without BNL access
  // it simply returns nothing — notes2 stays null, no error.
  await enrichRoster(sb, members as unknown as BnlClient[]);

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
    // Live stalls — straight from the ETL's per-row worklist fields
    // (ms_stage/ms_wait, the SAME source as the BNL journey bar), so the
    // cohort bar's waiting numbers and the click-through member list can
    // never disagree.
    if (m.ms_stage && m.ms_wait != null) (waitDays[m.ms_stage] ??= []).push(m.ms_wait);
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
  // ── Housing retention — did the housing stick? ──────────────────────────
  // Anchor = each member's FIRST placement in the 3y window; retained at a
  // horizon = no HUD-qualifying return within that many days of it. Members
  // whose placement is YOUNGER than a horizon are excluded from that
  // horizon's denominator (censoring) — never counted as retained by default.
  const firstPlaced = members
    .map((m) => (m.hist3?.placed ?? [])
      .map((p) => ({ s: D(p.s), ret: p.ret ? D(p.ret) : null }))
      .sort((a, b) => a.s - b.s)[0])
    .filter((p): p is { s: number; ret: number | null } => p != null);
  const retDays = firstPlaced.filter((p) => p.ret != null)
    .map((p) => Math.round(((p.ret as number) - p.s) / DAY));
  const retention = {
    placed_n: firstPlaced.length,
    returned_n: retDays.length,
    median_days_to_return: median(retDays),
    horizons: [180, 365, 730].map((h) => {
      const eligible = firstPlaced.filter((p) => tEnd - p.s >= h * DAY);
      const kept = eligible.filter((p) => p.ret == null || (p.ret as number) - p.s > h * DAY);
      return {
        days: h, n: eligible.length, kept: kept.length,
        pct: eligible.length ? (100 * kept.length) / eligible.length : null,
      };
    }),
  };

  for (const m of members) delete m.hist3;   // heavy + drawer fetches its own

  members.sort((a, b) =>
    ({ active: 0, housed: 1, inactive: 2 }[a.status] ?? 3) - ({ active: 0, housed: 1, inactive: 2 }[b.status] ?? 3)
    || (a.name ?? '').localeCompare(b.name ?? ''));

  return NextResponse.json({
    cohort: cRes.data,
    members,
    missing,
    snapshots: sRes.data ?? [],
    // null = cohort_tasks.sql not run yet (missing table) → UI shows setup hint
    tasks: tRes.error ? null : (tRes.data ?? []),
    access: aRes.error ? null : (aRes.data ?? []),
    staff: stRes.data ?? [],
    manage: viewer.isAdmin,
    // pids exist but every member row was filtered away → the viewer lacks
    // BNL access (bnl_clients RLS), not an empty cohort
    restricted: !viewer.isAdmin && pids.length > 0 && members.length === 0,
    agg: {
      n: members.length,
      ...by,
      housed_pct: members.length ? (by.housed / members.length) * 100 : null,
      returned, chronic, high_risk: highRisk,
      median_days_homeless: median(dh),
      legs: Object.fromEntries(Object.entries(legDays).map(([k, v]) => [k, { n: v.length, median: median(v), mean: mean(v) }])),
      waiting: Object.fromEntries(Object.entries(waitDays).map(([k, v]) => [k, { n: v.length, median: median(v), mean: mean(v) }])),
      housed_curve: housedCurve,
      retention,
      // system benchmark legs (medians/means) for the ghost figures
      sys_legs: (msRes.data?.value as { housed?: unknown } | null)?.housed ?? null,
    },
  });
}

export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  let body: {
    action?: string; id?: number; name?: string; description?: string;
    pids?: string[]; pid?: string; user_id?: string;
    task_id?: number; body?: string; assignee_ids?: string[]; done?: boolean;
  };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const sb = supabaseServer();

  // Cohort management stays admin-only; task add/toggle is open to grantees —
  // the cohort_tasks RLS policies (cohort_access membership) are the boundary,
  // this split just gives honest error messages.
  const TASK_ACTIONS = new Set(['add_task', 'toggle_task']);
  if (!viewer.isAdmin && !TASK_ACTIONS.has(body.action ?? '')) {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }

  // Assignees are dashboard accounts only (user decision 2026-08-12), several
  // per task allowed. Resolves ids → [{id, name}] snapshots; null = an id was
  // unknown or not approved. Order of the input is preserved.
  const resolveAssignees = async (ids: string[]): Promise<{ id: string; name: string | null }[] | null> => {
    if (!ids.length) return [];
    const { data, error } = await sb.from('profiles')
      .select('id, display_name, email, status').in('id', ids);
    if (error) return null;
    const byId = new Map((data ?? []).map((p: { id: string; display_name: string | null; email: string | null; status: string }) => [p.id, p]));
    const out: { id: string; name: string | null }[] = [];
    for (const id of ids) {
      const p = byId.get(id);
      if (!p || p.status !== 'approved') return null;
      out.push({ id, name: p.display_name || p.email || null });
    }
    return out;
  };

  if (body.action === 'add_task') {
    const id = Number(body.id);
    const text = (body.body ?? '').trim();
    if (!Number.isFinite(id)) return NextResponse.json({ error: 'id required' }, { status: 400 });
    if (!text) return NextResponse.json({ error: 'task text required' }, { status: 400 });
    if (!body.pid) return NextResponse.json({ error: 'pid required' }, { status: 400 });
    const ids = [...new Set((body.assignee_ids ?? []).map(String).filter(Boolean))];
    // A non-admin can assign only to themself — they cannot read other
    // profiles to pick from anyway (profiles RLS).
    if (!viewer.isAdmin && ids.some((a) => a !== viewer.id)) {
      return NextResponse.json({ error: 'you can only assign tasks to yourself' }, { status: 403 });
    }
    const assignees = await resolveAssignees(ids);
    if (assignees === null) {
      return NextResponse.json({ error: 'assignees must be approved accounts' }, { status: 400 });
    }
    const { data, error } = await sb.from('cohort_tasks')
      .insert({
        cohort_id: id, pid: body.pid, body: text,
        assignees,
        created_by: viewer.email ?? null,
      })
      .select('id').single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, id: data.id });
  }

  if (body.action === 'set_assignees') {
    // Reassign an existing task (admin-only via the gate above).
    const taskId = Number(body.task_id);
    if (!Number.isFinite(taskId)) return NextResponse.json({ error: 'task_id required' }, { status: 400 });
    const ids = [...new Set((body.assignee_ids ?? []).map(String).filter(Boolean))];
    const assignees = await resolveAssignees(ids);
    if (assignees === null) {
      return NextResponse.json({ error: 'assignees must be approved accounts' }, { status: 400 });
    }
    const { data, error } = await sb.from('cohort_tasks')
      .update({ assignees }).eq('id', taskId).select('id');
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data?.length) return NextResponse.json({ error: 'task not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'toggle_task') {
    const taskId = Number(body.task_id);
    if (!Number.isFinite(taskId)) return NextResponse.json({ error: 'task_id required' }, { status: 400 });
    const done = body.done === true;
    const { data, error } = await sb.from('cohort_tasks')
      .update(done
        ? { status: 'done', done_at: new Date().toISOString(), done_by: viewer.email ?? null }
        : { status: 'open', done_at: null, done_by: null })
      .eq('id', taskId)
      .select('id, pid, body, cohort_id');
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    // RLS silently matches nothing when the viewer lacks a grant — say so.
    if (!data?.length) return NextResponse.json({ error: 'task not found or no access' }, { status: 404 });
    // Auto-note on completion (user request 2026-08-12): the client's
    // narrative thread records the outcome without anyone typing it, in the
    // SAME append-only bnl_notes thread every other surface reads. Attributed
    // to whoever clicked Complete (RLS pins author_id to the caller).
    // Best-effort: a cohort grantee WITHOUT BNL access cannot write bnl_notes
    // — the completion itself still stands, the note is just skipped.
    // Reopening deliberately writes nothing (notes are append-only history;
    // the task's own state already says it was reopened).
    let noted = false;
    if (done) {
      const t = data[0] as { pid: string; body: string; cohort_id: number };
      const c = await sb.from('cohorts').select('name').eq('id', t.cohort_id).maybeSingle();
      const ins = await sb.from('bnl_notes').insert({
        pid: t.pid,
        body: `✓ Next step completed — ${t.body}${c.data?.name ? ` (${c.data.name})` : ''}`,
        author_id: viewer.id,
        author_name: viewer.displayName ?? null,
        author_email: viewer.email ?? null,
      });
      noted = !ins.error;
    }
    return NextResponse.json({ ok: true, noted });
  }

  if (body.action === 'delete_task') {
    const taskId = Number(body.task_id);
    if (!Number.isFinite(taskId)) return NextResponse.json({ error: 'task_id required' }, { status: 400 });
    const { error } = await sb.from('cohort_tasks').delete().eq('id', taskId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'grant_access' || body.action === 'revoke_access') {
    const id = Number(body.id);
    if (!Number.isFinite(id)) return NextResponse.json({ error: 'id required' }, { status: 400 });
    if (!body.user_id) return NextResponse.json({ error: 'user_id required' }, { status: 400 });
    const q = body.action === 'grant_access'
      ? sb.from('cohort_access').upsert(
          { cohort_id: id, user_id: body.user_id, granted_by: viewer.email ?? null },
          { onConflict: 'cohort_id,user_id', ignoreDuplicates: true })
      : sb.from('cohort_access').delete().eq('cohort_id', id).eq('user_id', body.user_id);
    const { error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

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
