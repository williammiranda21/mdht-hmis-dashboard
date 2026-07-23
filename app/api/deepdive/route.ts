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
  'days_homeless, sys_days3, episodes3, chronic, veteran, family, assessed, ' +
  'dq, dq_n, long_stay, open_suspect';

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
    .from('projects').select('project_id, name').in('project_id', ids);
  const projName = new Map<number, string>(
    (projRows ?? []).map((p: { project_id: number; name: string | null }) =>
      [Number(p.project_id), p.name ?? `Project ${p.project_id}`]),
  );

  if (!served) {
    return NextResponse.json({
      served: 0, matched: 0, unmatched: 0,
      lists: { long_stay: [], awaiting_movein: [], open_suspect: [], data_quality: [] },
    });
  }

  // ── attributes: fetch each bounded flagged set, then intersect ────────────
  let flagged: { long_stay: any[]; awaiting_movein: any[]; open_suspect: any[]; data_quality: any[] };
  try {
    const [longStay, awaiting, openSuspect, dq] = await Promise.all([
      fetchFlagged(sb, (q) => q.eq('long_stay', true)),
      // `detail` is written by bnl_core's status cascade — this prefix is stable.
      fetchFlagged(sb, (q) => q.like('detail', 'Matched to%')),
      fetchFlagged(sb, (q) => q.eq('open_suspect', true)),
      fetchFlagged(sb, (q) => q.gt('dq_n', 0)),
    ]);
    flagged = { long_stay: longStay, awaiting_movein: awaiting, open_suspect: openSuspect, data_quality: dq };
  } catch (e) {
    // A user without BNL access trips RLS here — return counts, no names.
    return NextResponse.json({
      served, matched: 0, unmatched: served, restricted: true,
      lists: { long_stay: [], awaiting_movein: [], open_suspect: [], data_quality: [] },
    });
  }

  const matchedPids = new Set<string>();
  const take = (rows: any[], sort: (a: any, b: any) => number) => {
    const hit = rows.filter((r) => servedBy.has(r.pid));
    hit.forEach((r) => matchedPids.add(r.pid));
    return hit
      .map((r) => {
        const pidProj = servedBy.get(r.pid)!;
        // serving project, not the client's current one
        return { ...r, project_id: pidProj, project: projName.get(pidProj) ?? null };
      })
      .sort(sort)
      .slice(0, LIMIT);
  };

  const desc = (k: string) => (a: any, b: any) => (b[k] ?? 0) - (a[k] ?? 0);

  return NextResponse.json({
    served,
    matched: matchedPids.size,
    unmatched: served - matchedPids.size,
    lists: {
      long_stay: take(flagged.long_stay, desc('days_homeless')),
      // oldest match first — these are the longest-stalled lease-ups
      awaiting_movein: take(flagged.awaiting_movein,
        (a, b) => String(a.entry ?? '').localeCompare(String(b.entry ?? ''))),
      open_suspect: take(flagged.open_suspect, desc('days_since_contact')),
      data_quality: take(flagged.data_quality, desc('dq_n')),
    },
  });
}
