/**
 * Target metric definitions — the single source of truth shared by the project
 * panel (TargetsSection), the admin Targets page, and /api/targets validation.
 * Percent/score metrics cap at 100; day-count metrics at 3650.
 *
 * A target can live at two scopes: project_targets (specific project) and
 * type_targets (every project of a type). A project override always beats the
 * type default for that metric.
 */

export interface TargetMetric {
  key: string;
  label: string;
  unit: string;            // '%' | '' (score) | ' days' — appended to values
  higherBetter: boolean;   // false → at-or-below target
  max: number;             // inclusive upper bound for target entry
  placeholder: string;
  hint: string;            // entry-format guidance shown while editing
  /** HUD project-type codes this metric is FOR (absent = every type). */
  onlyFor?: number[];
  /** HUD project-type codes this metric is hidden for. */
  hideFor?: number[];
}

/**
 * Type applicability (user request 2026-08-13): the admin editor, the drawer
 * section, and the ⚑ flag evaluation ALL consult this, so an SO metric can
 * never be set on — or flagged against — a PSH project, and vice versa.
 * HUD codes: 0/1 ES (1 = night-by-night) · 2 TH · 3 PSH · 4 SO · 8 SH ·
 * 9/10 PH · 13 RRH.
 */
export const metricAppliesTo = (m: TargetMetric, ptype: number | null | undefined): boolean => {
  if (ptype == null) return true; // unknown type → show everything
  if (m.onlyFor && !m.onlyFor.includes(ptype)) return false;
  if (m.hideFor && m.hideFor.includes(ptype)) return false;
  return true;
};

export const TARGET_METRICS: TargetMetric[] = [
  {
    key: 'ph_exit_rate', label: 'PH exit rate', unit: '%', higherBetter: true, max: 100,
    placeholder: 'e.g. 40', hideFor: [4],
    hint: 'Percent of leavers exiting to permanent housing. Enter 0–100 without the % sign (40 = 40%); decimals OK.',
  },
  {
    key: 'unsub_rate', label: 'Unsubsidized PH exit rate', unit: '%', higherBetter: true, max: 100,
    placeholder: 'e.g. 15', hideFor: [4],
    hint: 'Percent of leavers exiting to unsubsidized permanent housing (no ongoing subsidy). Enter 0–100 without the % sign.',
  },
  {
    key: 'income_impr', label: 'Earned income improvement', unit: '%', higherBetter: true, max: 100,
    placeholder: 'e.g. 20', hideFor: [4],
    hint: 'Percent of active clients with income data whose earned income improved (APR Q19 lineage). Meant for ES/TH/RRH/PSH. Enter 0–100 without the % sign.',
  },
  {
    key: 'dq_score', label: 'DQ score', unit: '', higherBetter: true, max: 100,
    placeholder: 'e.g. 90',
    hint: 'Data-quality score, 0–100 points (a score, not a percent). Enter the number only.',
  },
  {
    key: 'returns_6mo', label: '6-month return rate', unit: '%', higherBetter: false, max: 100,
    placeholder: 'e.g. 5',
    hint: 'Percent of PH exits returning to homelessness within 6 months — lower is better. Enter 0–100 without the % sign.',
  },
  {
    key: 'returns_2yr', label: '2-year return rate', unit: '%', higherBetter: false, max: 100,
    placeholder: 'e.g. 15',
    hint: 'Percent of PH exits returning to homelessness within 2 years — lower is better. Enter 0–100 without the % sign.',
  },
  {
    // Hidden for SO (enrollment length is noise) AND the PSH family 3/9/10 —
    // long PSH stays are success; a LOS ceiling there would punish retention.
    key: 'avg_los', label: 'Avg length of stay', unit: ' days', higherBetter: false, max: 3650,
    placeholder: 'e.g. 60', hideFor: [3, 4, 9, 10],
    hint: 'Average days enrolled in the period — lower is better. Enter a number of days (0–3650). Most meaningful for ES/TH.',
  },
  {
    // Hidden for ES night-by-night (type 1) — excluded from time-to-housing.
    key: 'median_days', label: 'Median days to housing', unit: ' days', higherBetter: false, max: 3650,
    placeholder: 'e.g. 90', hideFor: [1],
    hint: 'Median days from entry to the housing event, rolling 24-month cohort (does not follow the period picker). For RRH/PSH the event is the MOVE-IN — this is the entry-to-move-in target; for ES/TH/SH it is the exit to permanent housing. Enter a number of days (0–3650).',
  },
  {
    key: 'pos_outreach_rate', label: 'SO positive exit rate', unit: '%', higherBetter: true, max: 100,
    placeholder: 'e.g. 55', onlyFor: [4],
    hint: 'Street Outreach only — percent of SO leavers exiting to a positive destination (APR Appendix A). Enter 0–100 without the % sign.',
  },
  {
    key: 'so_engagement_rate', label: 'SO engagement rate', unit: '%', higherBetter: true, max: 100,
    placeholder: 'e.g. 50', onlyFor: [4],
    hint: 'Street Outreach only — engagements as a percent of clients contacted in the period (SOEngagements ÷ SOContacts, derived from the stored counts like the returns rates are). Enter 0–100 without the % sign.',
  },
];

export const metricByKey: ReadonlyMap<string, TargetMetric> =
  new Map(TARGET_METRICS.map((m) => [m.key, m]));

export const fmtTarget = (v: number | null, unit: string): string =>
  v == null ? '—' : `${Number(v.toFixed(1))}${unit}`;
