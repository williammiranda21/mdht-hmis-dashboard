import type { Granularity } from './types';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** '2026-05' → 'May 2026'; 'FY2026-Q3' → 'Q3 FY2026'; 'FY2026' → 'FY2026'. */
export function periodLabel(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (m) return `${MONTHS[+m[2] - 1]} ${m[1]}`;
  const q = /^FY(\d{4})-Q([1-4])$/.exec(period);
  if (q) return `Q${q[2]} FY${q[1]}`;
  return period;
}

/** Band for a "higher is better" rate vs a good/mid threshold (defaults match the mockups). */
export function rateBand(v: number | null, good = 50, mid = 40): 'good' | 'warn' | 'bad' | 'none' {
  if (v == null) return 'none';
  return v >= good ? 'good' : v >= mid ? 'warn' : 'bad';
}

export function bandColorVar(band: 'good' | 'warn' | 'bad' | 'none'): string {
  return band === 'good' ? 'var(--accent)' : band === 'warn' ? 'var(--warn)' : 'var(--danger)';
}

export const fmtInt = (n: number | null | undefined): string =>
  n == null ? '—' : Math.round(n).toLocaleString();

export const fmtPct = (n: number | null | undefined, digits = 0): string =>
  n == null ? '—' : `${n.toFixed(digits)}%`;

/** End date of a period. FY = Oct 1 – Sep 30 (FY2026 = Oct 2025 → Sep 2026). */
export function periodEndDate(period: string): Date {
  const mo = /^(\d{4})-(\d{2})$/.exec(period);
  if (mo) return new Date(+mo[1], +mo[2], 0); // last day of that month
  const q = /^FY(\d{4})-Q([1-4])$/.exec(period);
  if (q) {
    const y = +q[1];
    return [new Date(y - 1, 12, 0), new Date(y, 3, 0), new Date(y, 6, 0), new Date(y, 9, 0)][+q[2] - 1];
  }
  const fy = /^FY(\d{4})$/.exec(period);
  if (fy) return new Date(+fy[1], 9, 0); // Sep 30
  return new Date(period);
}

/** "Jun 2024 – Jun 2026" — the 24-month lookback window ending at the period end (SPM M2). */
export function lookbackLabel(period: string): string {
  const end = periodEndDate(period);
  const start = new Date(end);
  start.setMonth(start.getMonth() - 24);
  const f = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  return `${f(start)} – ${f(end)}`;
}

/** HUD destination code → human label (subset used in the dashboard). */
export const DEST_LABELS: Record<number, string> = {
  101: 'Emergency Shelter', 118: 'Safe Haven',
  204: 'Psychiatric Facility', 205: 'Substance Abuse Treatment',
  206: 'Hospital', 207: 'Not Applicable', 215: 'Foster Care',
  225: 'Long-Term Care', 302: 'Transitional Housing', 312: 'Staying w/ Family (temp)',
  313: 'Staying w/ Friends (temp)', 314: 'Hotel/Motel', 327: 'HOPWA TH',
  332: 'Host Home (TH)', 329: 'Halfway House',
  410: 'Rental, No Subsidy', 411: 'Owned, No Subsidy',
  421: 'Owned, with Subsidy', 422: 'Staying w/ Family (perm)',
  423: 'Staying w/ Friends (perm)', 426: 'HOPWA PH',
  435: 'Rental, with Subsidy',
  116: 'Street/Outdoors', 100: 'Place Not Meant for Habitation',
  24: 'Deceased',
};

export const granularityFromPeriod = (period: string): Granularity =>
  /^\d{4}-\d{2}$/.test(period) ? 'monthly' : /-Q[1-4]$/.test(period) ? 'quarterly' : 'fiscal';
