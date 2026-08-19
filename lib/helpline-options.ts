/**
 * Helpline Triage — the ONE answer domain for categorical fields (same rule
 * as Youth Connect's lib/yc-options.ts: closed lists, both directions of
 * entry import them, reporting can GROUP BY without cleanup). A skipped
 * question stores NULL — that is the "unknown".
 */

/** Areas that route calls to teams (outreach_teams.zones holds these values).
 *  Municipalities + the Miami neighborhoods outreach actually dispatches by.
 *  Additions are safe; renames strand old rows — migrate when renaming. */
export const AREAS = [
  'Downtown Miami', 'Overtown', 'Little Havana', 'Little Haiti', 'Wynwood',
  'Allapattah', 'Brickell', 'Coconut Grove', 'Liberty City', 'Brownsville',
  'Miami Beach', 'North Miami', 'North Miami Beach', 'Miami Gardens',
  'Opa-locka', 'Hialeah', 'Hialeah Gardens', 'Miami Lakes', 'Doral',
  'Sweetwater', 'Fountainebleau', 'Westchester', 'Coral Gables', 'South Miami',
  'Kendall', 'Kendale Lakes', 'Palmetto Bay', 'Pinecrest', 'Cutler Bay',
  'Perrine', 'Richmond Heights', 'Goulds', 'Naranja', 'Leisure City',
  'Homestead', 'Florida City', 'Aventura', 'Key Biscayne',
  'Unincorporated / other',
] as const;

export const SLEEPING_OPTIONS = [
  'Street / outside',
  'Car',
  'About to lose housing',
  'Shelter',
  'Other',
] as const;

export const HOUSEHOLD_OPTIONS = [
  'Alone',
  'With children',
  'Adult family',
] as const;

/** Factors: tap-all-that-apply on intake. `route` tags outrank geography when
 *  suggesting a team (outreach_teams.factors carries the same tags). */
export const FACTORS: { key: string; pts: number; route?: string }[] = [
  { key: 'Fleeing DV', pts: 3 },
  { key: 'Medical emergency', pts: 3 },
  { key: 'Pregnant', pts: 3 },
  { key: '60+', pts: 2 },
  { key: 'Veteran', pts: 1, route: 'veteran' },
  { key: 'Youth 18–24', pts: 1, route: 'youth' },
  { key: 'Disabling condition', pts: 1 },
];

/** Transparent priority math — shown on the row, never a black box.
 *  factors + household + sleeping situation. Bands: HIGH ≥5 · MED ≥2 · LOW. */
export function priorityOf(factors: string[], household: string | null, sleeping: string | null): number {
  let p = 0;
  for (const f of FACTORS) if (factors.includes(f.key)) p += f.pts;
  if (household === 'With children') p += 2;
  if (sleeping === 'Street / outside' || sleeping === 'Car') p += 2;
  return p;
}
export function priorityBand(p: number): 'HIGH' | 'MED' | 'LOW' {
  return p >= 5 ? 'HIGH' : p >= 2 ? 'MED' : 'LOW';
}

export const CASE_STATUSES = [
  'new', 'assigned', 'attempted', 'contacted', 'confirmed',
  'declined', 'no_locate', 'closed',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
