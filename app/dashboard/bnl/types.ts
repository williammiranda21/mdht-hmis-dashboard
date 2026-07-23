export interface BnlTimelineEvent {
  project: string;
  type: string;
  entry: string;
  exit: string | null;
  dest: string | null;
  ph: boolean;
}

/**
 * 3-year history card payload. Every figure is precomputed in `bnl_core.py`
 * (`hist3`) off the SAME merged intervals that produce `sys_days3`/`episodes3`,
 * so the card can never disagree with the roster columns. The UI only formats —
 * it must not re-derive homeless math (CLAUDE.md §5).
 */
export interface BnlHist3 {
  s: string;            // window start (as_of − 3y)
  e: string;            // window end (as_of)
  days: number;         // == sys_days3
  eps: number;          // == episodes3
  housed_n: number;     // PH move-ins inside the window
  returns: number;      // episodes beginning after a move-in (client-level, NOT SPM M2)
  last: string | null;  // last observed homeless date
  types: { t: string; d: number; pct: number }[];
  ranges: { s: string; e: string; d: number }[];
  placed: { s: string; e: string; p: string | null; t: string; open: boolean }[];
}

/**
 * A TABLE row. Only what the roster grid renders, filters or sorts on — this is
 * fetched a page at a time (see lib/bnl-query.ts ROSTER_COLS).
 *
 * Detail-only fields (dob, sex, race, income, DV flags, foster, jj, times3_sr,
 * months3_sr, ep_start, entry, days_since_contact and the full `dq` text) live
 * on BnlDetail and load when a drawer opens. Adding one of them back here puts
 * it on every row of every page — check the grid really needs it first.
 */
export interface BnlClient {
  pid: string;
  name: string;
  age: number | null;
  status: 'active' | 'housed' | 'inactive';
  detail: string;
  enrolled: boolean;          // false → project below is a FORMER stay
  project: string | null;
  ptype: string | null;
  last_contact: string;
  days_homeless: number;
  sys_days3: number;
  episodes3: number;
  risk_pts: number | null;
  risk_max: number | null;
  ref_type: string | null;
  ref_status: string | null;
  ref_date: string | null;
  ref_prov: string | null;
  assessed: string | null;
  dq_n: number;               // count only; full text arrives with BnlDetail
  chronic: boolean;
  is_new: boolean;
  returned: boolean;
  veteran: boolean;
  family: boolean;
  parenting: boolean;
  unaccompanied: boolean;
  in_school: boolean;
}

/** Extra fields shown only in the client drawer, fetched per client. */
export interface BnlDetail {
  entry: string | null;
  days_since_contact: number | null;
  ep_start: string | null;
  times3_sr: string | null;
  months3_sr: number | null;
  dob: string | null;
  sex: string | null;
  race: string | null;
  income: number | null;
  income_date: string | null;
  dv_fleeing: boolean | null;
  dv_survivor: boolean | null;
  foster: boolean | null;
  jj: boolean | null;
  hoh: boolean;
  dq: string[];
}

/**
 * Precomputed per-population KPI counts and inflow/outflow, from
 * `meta.bnl_agg` (built in bnl_core.py). These figures depend only on the
 * population selector — never on the status/flag/search filters — which is why
 * they can be precomputed and why the page no longer needs the whole roster.
 */
export interface BnlPopAgg {
  n: number;
  counts: {
    active: number; housed: number; inactive: number; new30: number;
    chronic: number; vet: number; fam: number; assessed: number;
  };
  max_days: number;
  flow: { month: string; new_n: number; housed_n: number; inactive_n: number }[];
}
export interface BnlAgg {
  as_of: string;
  pops: Record<PopKey, BnlPopAgg>;
}

export type PopKey = 'all' | 'youth' | 'vet' | 'family' | 'single' | 'senior';

/**
 * Labels only. The population PREDICATES now live in two places that must stay
 * in agreement:
 *   • lib/bnl-query.ts  — the SQL the table is filtered with
 *   • bnl_core.py POPS  — the aggregates behind the KPI cards and chart
 * Filtering moved server-side, so there is deliberately no `test` here; a stray
 * client-side predicate would silently disagree with the counts above the table.
 */
export const POP_DEFS: Record<PopKey, { label: string }> = {
  all: { label: 'Everyone' },
  youth: { label: 'Youth 18–24' },
  vet: { label: 'Veterans' },
  family: { label: 'Families' },
  single: { label: 'Single adults 25+' },
  senior: { label: 'Seniors 62+' },
};
