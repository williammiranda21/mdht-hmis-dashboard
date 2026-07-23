import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Shared server-side BNL roster query.
 *
 * Used by both the page's first render and the /api/bnl/roster route, so the
 * two can never drift into filtering differently.
 *
 * The population predicates here MUST match `POP_DEFS` in
 * app/dashboard/bnl/types.ts and the `POPS` dict in bnl_core.py. All three
 * describe the same six cohorts; if they diverge, the KPI cards (served from
 * precomputed aggregates) will describe a different set of people than the
 * table below them.
 */

/** Columns the TABLE needs. Detail-only fields (dob/sex/race/income/dv/foster/
 *  jj/times3_sr/…) are deliberately absent — the drawer fetches those per
 *  client, which is what keeps this payload small. */
export const ROSTER_COLS =
  'pid, name, age, status, detail, enrolled, project, ptype, last_contact, ' +
  'days_homeless, sys_days3, episodes3, risk_pts, risk_max, ' +
  'ref_type, ref_status, ref_date, ref_prov, assessed, dq_n, ' +
  'chronic, is_new, returned, veteran, family, parenting, unaccompanied, in_school';

export const PAGE_SIZE = 200;

export type PopKey = 'all' | 'youth' | 'vet' | 'family' | 'single' | 'senior';

export interface RosterQuery {
  pop: PopKey;
  status: string;   // '' | active | housed | inactive
  flag: string;     // '' | is_new | returned | chronic | veteran | family | parenting | unaccompanied | in_school | dq
  asmt: string;     // '' | y | n
  q: string;        // free-text over name + project
  sort: string;
  dir: 'asc' | 'desc';
  offset: number;
  limit: number;
}

/** Sortable columns. Whitelisted — never interpolate a user string into order(). */
const SORTABLE = new Set([
  'name', 'age', 'status', 'project', 'days_homeless', 'sys_days3',
  'risk_pts', 'ref_status', 'last_contact', 'assessed',
]);

const FLAG_COLS = new Set([
  'is_new', 'returned', 'chronic', 'veteran', 'family',
  'parenting', 'unaccompanied', 'in_school',
]);

export function parseRosterQuery(sp: URLSearchParams): RosterQuery {
  const sort = sp.get('sort') ?? 'days_homeless';
  const limit = Number(sp.get('limit') ?? PAGE_SIZE);
  return {
    pop: (sp.get('pop') ?? 'all') as PopKey,
    status: sp.get('status') ?? '',
    flag: sp.get('flag') ?? '',
    asmt: sp.get('asmt') ?? '',
    q: (sp.get('q') ?? '').trim(),
    sort: SORTABLE.has(sort) ? sort : 'days_homeless',
    dir: sp.get('dir') === 'asc' ? 'asc' : 'desc',
    offset: Math.max(0, Number(sp.get('offset') ?? 0) || 0),
    limit: Math.min(Math.max(1, limit || PAGE_SIZE), 500),
  };
}

/** PostgREST `or`/`ilike` treats , ( ) and * as syntax — strip them so a stray
 *  character in a client's name can't break the filter or alter its meaning. */
function safeLike(s: string): string {
  return s.replace(/[,()*\\%]/g, ' ').trim();
}

/**
 * @param cols  column list to select; defaults to the table's slim set. The CSV
 *              export passes the full set instead.
 * @param withCount  request an exact total. The table needs it to show "N of M"
 *              and to know when to stop paging; the export does not, and an
 *              exact count on every chunk would double the work for nothing.
 */
export async function queryRoster(
  sb: SupabaseClient,
  p: RosterQuery,
  cols: string = ROSTER_COLS,
  withCount = true,
) {
  let qb = withCount
    ? sb.from('bnl_clients').select(cols, { count: 'exact' })
    : sb.from('bnl_clients').select(cols);

  // ── population ────────────────────────────────────────────────────────────
  if (p.pop === 'youth') qb = qb.gte('age', 18).lt('age', 25);
  else if (p.pop === 'vet') qb = qb.eq('veteran', true);
  else if (p.pop === 'family') qb = qb.eq('family', true);
  else if (p.pop === 'single') qb = qb.gte('age', 25).eq('family', false);
  else if (p.pop === 'senior') qb = qb.gte('age', 62);
  // 'all' adds nothing. Note gte/lt on age also excludes NULL age, matching the
  // JS predicates which required `age != null`.

  // ── filters ───────────────────────────────────────────────────────────────
  if (p.status) qb = qb.eq('status', p.status);
  if (p.flag === 'dq') qb = qb.gt('dq_n', 0);
  else if (FLAG_COLS.has(p.flag)) qb = qb.eq(p.flag, true);
  if (p.asmt === 'y') qb = qb.not('assessed', 'is', null);
  else if (p.asmt === 'n') qb = qb.is('assessed', null);

  if (p.q) {
    const t = safeLike(p.q);
    if (t) qb = qb.or(`name.ilike.%${t}%,project.ilike.%${t}%`);
  }

  // ── sort + page ───────────────────────────────────────────────────────────
  // nullsFirst:false mirrors the old client sort, which pushed nulls to the end
  // in both directions.
  qb = qb.order(p.sort, { ascending: p.dir === 'asc', nullsFirst: false })
         // pid keeps paging stable when the sort column ties (many clients share
         // a days_homeless value — without this, rows can repeat across pages).
         .order('pid', { ascending: true })
         .range(p.offset, p.offset + p.limit - 1);

  return qb;
}
