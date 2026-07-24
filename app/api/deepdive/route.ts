import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * Deep Dive — "who needs attention?" worklists for a set of projects.
 *
 * HYBRID SOURCING — read before changing.
 *   membership  drill_clients (period | project_id | metric='c') — the clients a
 *               project actually SERVED in that period. Covers every project
 *               type, including Services Only and Prevention, which are absent
 *               from the By-Name List cohort entirely.
 *   attributes  bnl_clients, joined by pid — names, days homeless, DQ flags.
 *
 * Sourcing membership from bnl_clients instead would break two ways: 37 Services
 * Only / Prevention projects would return nothing at all, and a BNL row records
 * a client's CURRENT project, so "who did my project serve" would silently
 * become "who is at my project now".
 *
 * Clients served but outside the BNL cohort (~39% for a sampled Services Only
 * project) are counted in `served` and reported in `unmatched`, but cannot
 * appear on a worklist — the flags that populate those lists live on the BNL row.
 *
 * RLS: drill_clients is agency-scoped (`scoped read drill`); bnl_clients needs
 * can_see_bnl(). A user with project grants but no BNL access therefore gets
 * counts but no names — which is the intended degradation, not a bug.
 */

const ATTR_COLS =
  'pid, name, age, status, detail, ptype, entry, last_contact, days_since_contact, ' +
  'days_homeless, days_at_project, sys_days3, episodes3, chronic, veteran, family, assessed, ' +
  'dq, dq_n, long_stay, open_suspect, open_suspect_projects';

const PAGE = 1000;   // Supabase caps a response at 1000 rows
const LIMIT = 100;   // per worklist — these are lists to action, not exports
/** Guard against someone selecting every project at once. */
const MAX_FLAGGED = 8000;

/** Page through a flag-filtered slice of bnl_clients. Each of these sets is
 *  bounded (a few thousand system-wide), which is why we fetch the flagged rows
 *  and intersect in memory rather than sending a huge pid IN-list. */
async function fetchFlagged(
  sb: ReturnType<typeof supabaseServer>,
  apply: (q: any) => any,
): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; from < MAX_FLAGGED; ) {
    const { data, error } = await apply(
      sb.from('bnl_clients').select(ATTR_COLS),
    ).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    out.push(...batch);
    if (batch.length < PAGE) break;
    from += batch.length;      // advance by rows RECEIVED, never the page size
  }
  return out;
}

export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const ids = (sp.get('projects') ?? '')
    .split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
  const period = sp.get('period') ?? '';
  if (!ids.length) return NextResponse.json({ error: 'projects required' }, { status: 400 });
  if (!period) return NextResponse.json({ error: 'period required' }, { status: 400 });

  const sb = supabaseServer();

  // ── membership: who did these projects serve in this period ───────────────
  const { data: drill, error: drillErr } = await sb
    .from('drill_clients')
    .select('project_id, personal_ids')
    .eq('period', period)
    .eq('metric', 'c')
    .in('project_id', ids);
  if (drillErr) return NextResponse.json({ error: drillErr.message }, { status: 500 });

  // pid → the project that served them. A client served by two selected
  // projects is attributed to the first; the worklists are per-client, not
  // per-enrollment, so showing them twice would just read as a duplicate.
  const servedBy = new Map<string, number>();
  for (const row of drill ?? []) {
    for (const pid of (row.personal_ids as string[]) ?? []) {
      if (!servedBy.has(pid)) servedBy.set(pid, Number(row.project_id));
    }
  }
  const served = servedBy.size;

  // Names for the SERVING project. bnl_clients carries the client's *current*
  // project, which is not necessarily the one that served them in this period —
  // showing that would quietly contradict the selection the user just made.
  const { data: projRows } = await sb
    .from('projects').select('project_id, name, type_name').in('project_id', ids);
  // Name AND type must come from the same place. Overriding only the name left
  // rows reading "SO · Chapman Partnership Emergency Shelter" — the name from
  // the serving project, the type from whichever enrollment anchors the client's
  // homeless episode on their BNL row.
  const projInfo = new Map<number, { name: string; type: string | null }>(
    (projRows ?? []).map((p: { project_id: number; name: string | null; type_name: string | null }) =>
      [Number(p.project_id), { name: p.name ?? `Project ${p.project_id}`, type: p.type_name }]),
  );

  if (!served) {
    return NextResponse.json({
      served: 0, matched: 0, unmatched: 0,
      lists: { long_stay: [], awaiting_movein: [], open_suspect: [], data_quality: [], chronic: [] },
    });
  }

  // ── attributes: fetch each bounded flagged set, then intersect ────────────
  // data_quality is NOT here — it used to fetch clients by `dq_n>0`, but those
  // BNL flags are CLIENT-level (they describe the person's SO / outreach record,
  // e.g. "open SO enrollment superseded" or "no contact in Nd") and got shown
  // under whatever project served the client — so an ES project was blamed for a
  // client's Street Outreach issues. data_quality now uses the project-scoped
  // dq:* records instead (built below), the same source as the DQ-tab fix-list.
  let flagged: { long_stay: any[]; awaiting_movein: any[]; open_suspect: any[]; chronic: any[] };
  try {
    const [longStay, awaiting, openSuspect, chronic] = await Promise.all([
      fetchFlagged(sb, (q) => q.eq('long_stay', true)),
      // `detail` is written by bnl_core's status cascade — this prefix is stable.
      fetchFlagged(sb, (q) => q.like('detail', 'Matched to%')),
      fetchFlagged(sb, (q) => q.eq('open_suspect', true)),
      // HUD chronic-homelessness flag. Kept as its own list because the old
      // long_stay definition used to surface these people by accident, and the
      // signal is genuinely useful for prioritisation — just not the same
      // question as 'is this person stuck in my program'.
      fetchFlagged(sb, (q) => q.eq('chronic', true)),
    ]);
    flagged = { long_stay: longStay, awaiting_movein: awaiting, open_suspect: openSuspect, chronic };
  } catch (e) {
    // A user without BNL access trips RLS here — return counts, no names.
    return NextResponse.json({
      served, matched: 0, unmatched: served, restricted: true,
      lists: { long_stay: [], awaiting_movein: [], open_suspect: [], data_quality: [], chronic: [] },
    });
  }

  const matchedPids = new Set<string>();
  const take = (rows: any[], sort: (a: any, b: any) => number) => {
    const hit = rows.filter((r) => servedBy.has(r.pid));
    hit.forEach((r) => matchedPids.add(r.pid));
    return hit
      .map((r) => {
        const pidProj = servedBy.get(r.pid)!;
        const info = projInfo.get(pidProj);
        // serving project, not the client's current one — name and type together
        return { ...r, project_id: pidProj, project: info?.name ?? null, ptype: info?.type ?? r.ptype };
      })
      .sort(sort)
      .slice(0, LIMIT);
  };

  const desc = (k: string) => (a: any, b: any) => (b[k] ?? 0) - (a[k] ?? 0);

  // ── data_quality: project-scoped APR Q6 errors (dq:* records) ─────────────
  // Only errors on enrollments AT the selected projects — this project's own
  // exits missing a destination, its enrollments missing a move-in / income /
  // annual. It can never surface another project's SO enrollment. Same source
  // as the DQ-tab fix-list, so the two can't disagree.
  const DQ_LABELS: Record<string, string> = {
    'dq:dest': 'Missing exit destination',
    'dq:movein': 'Missing move-in date',
    'dq:income': 'Income missing or unknown at entry',
    'dq:annual': 'Overdue annual assessment',
  };
  const dqByPid = new Map<string, { project_id: number; issues: string[] }>();
  const { data: dqRows } = await sb
    .from('drill_clients')
    .select('project_id, metric, personal_ids')
    .eq('period', period)
    .in('project_id', ids)
    .like('metric', 'dq:%');
  for (const row of dqRows ?? []) {
    const label = DQ_LABELS[row.metric as string];
    if (!label) continue;
    for (const pid of (row.personal_ids as string[]) ?? []) {
      const e = dqByPid.get(pid) ?? { project_id: Number(row.project_id), issues: [] };
      e.issues.push(label);
      dqByPid.set(pid, e);
    }
  }
  // Names/attributes for the flagged clients (those in the BNL cohort). A client
  // with a DQ error but outside the cohort still shows — by hashed ID — because
  // the error is real and project-scoped; it just carries no name.
  const dqPids = [...dqByPid.keys()];
  const dqAttrs = new Map<string, any>();
  for (let i = 0; i < dqPids.length; i += 200) {
    const { data } = await sb.from('bnl_clients').select(ATTR_COLS).in('pid', dqPids.slice(i, i + 200));
    for (const r of (data ?? []) as any[]) dqAttrs.set(r.pid, r);
  }
  const dataQuality = [...dqByPid.entries()]
    .map(([pid, { project_id, issues }]) => {
      const a = dqAttrs.get(pid);
      const info = projInfo.get(project_id);
      return {
        ...(a ?? {}), pid, project_id,
        project: info?.name ?? null, ptype: info?.type ?? a?.ptype ?? null,
        dq: issues, dq_n: issues.length,
      };
    })
    // most errors first, then longest at the project
    .sort((x, y) => (y.dq.length - x.dq.length) || ((y.days_at_project ?? 0) - (x.days_at_project ?? 0)))
    .slice(0, LIMIT);

  // ── open_suspect: scope to the project that OWNS the left-open enrollment ──
  // The flag lives on the client's BNL row but describes one specific open
  // enrollment; open_suspect_projects carries THAT enrollment's project(s). Show
  // a client under project P only when P owns the suspect enrollment — so an ES
  // project's missed exit is never attributed to an unrelated SO project that
  // merely served the same client. Unlike the period-scoped lists this is a
  // live-snapshot cleanup list, so it is not gated by `served in this period`
  // and does not feed the matched/unmatched summary.
  const idset = new Set(ids);
  const openSuspectList = flagged.open_suspect
    .map((r) => {
      const owner = ((r.open_suspect_projects as number[]) ?? []).find((p) => idset.has(p));
      return owner == null ? null : { r, owner };
    })
    .filter((x): x is { r: any; owner: number } => x !== null)
    .map(({ r, owner }) => {
      const info = projInfo.get(owner);
      return { ...r, project_id: owner, project: info?.name ?? null, ptype: info?.type ?? r.ptype };
    })
    .sort(desc('days_since_contact'))
    .slice(0, LIMIT);

  return NextResponse.json({
    served,
    matched: matchedPids.size,
    unmatched: served - matchedPids.size,
    lists: {
      // longest at THIS project first
      long_stay: take(flagged.long_stay, desc('days_at_project')),
      // oldest match first — these are the longest-stalled lease-ups
      awaiting_movein: take(flagged.awaiting_movein,
        (a, b) => String(a.entry ?? '').localeCompare(String(b.entry ?? ''))),
      open_suspect: openSuspectList,
      data_quality: dataQuality,
      // longest-homeless first — this one IS about the 3.917 episode
      chronic: take(flagged.chronic, desc('days_homeless')),
    },
  });
}
