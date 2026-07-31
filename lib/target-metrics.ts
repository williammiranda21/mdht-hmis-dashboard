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
}

export const TARGET_METRICS: TargetMetric[] = [
  {
    key: 'ph_exit_rate', label: 'PH exit rate', unit: '%', higherBetter: true, max: 100,
    placeholder: 'e.g. 40',
    hint: 'Percent of leavers exiting to permanent housing. Enter 0–100 without the % sign (40 = 40%); decimals OK.',
  },
  {
    key: 'unsub_rate', label: 'Unsubsidized PH exit rate', unit: '%', higherBetter: true, max: 100,
    placeholder: 'e.g. 15',
    hint: 'Percent of leavers exiting to unsubsidized permanent housing (no ongoing subsidy). Enter 0–100 without the % sign.',
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
    key: 'avg_los', label: 'Avg length of stay', unit: ' days', higherBetter: false, max: 3650,
    placeholder: 'e.g. 60',
    hint: 'Average days enrolled in the period — lower is better. Enter a number of days (0–3650). Most meaningful for ES/TH; long stays are expected in PSH.',
  },
  {
    key: 'median_days', label: 'Median days to housing', unit: ' days', higherBetter: false, max: 3650,
    placeholder: 'e.g. 90',
    hint: 'Median days from entry to housing (rolling 24-month cohort; does not follow the period picker). Enter a number of days (0–3650).',
  },
];

export const metricByKey: ReadonlyMap<string, TargetMetric> =
  new Map(TARGET_METRICS.map((m) => [m.key, m]));

export const fmtTarget = (v: number | null, unit: string): string =>
  v == null ? '—' : `${Number(v.toFixed(1))}${unit}`;
