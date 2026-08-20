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
  // City of Miami Commission Districts — the City's outreach sub-teams route
  // by these (per the district assignment doc). Until polygon lookup lands,
  // the operator verifies via the City's Find-My-District map (linked on the
  // intake form). Outside-city areas route by municipality, never district.
  'Miami District 1', 'Miami District 2', 'Miami District 3',
  'Miami District 4', 'Miami District 5', 'Government Center',
  'Downtown Miami', 'Overtown', 'Little Havana', 'Little Haiti', 'Wynwood',
  'Allapattah', 'Brickell', 'Coconut Grove', 'Liberty City', 'Brownsville',
  'Miami Beach', 'North Miami', 'North Miami Beach', 'Miami Gardens',
  'Opa-locka', 'Hialeah', 'Hialeah Gardens', 'Miami Lakes', 'Doral',
  'Sweetwater', 'Fountainebleau', 'Westchester', 'Coral Gables', 'South Miami',
  'Kendall', 'Kendale Lakes', 'Palmetto Bay', 'Pinecrest', 'Cutler Bay',
  'Perrine', 'Richmond Heights', 'Goulds', 'Naranja', 'Leisure City',
  'Homestead', 'Florida City', 'Aventura', 'Key Biscayne',
  // Remaining municipalities from the county Municipality layer (2026-08-20)
  // so a pin anywhere incorporated can stamp its area automatically.
  'Miami Shores', 'Miami Springs', 'El Portal', 'Biscayne Park',
  'North Bay Village', 'Bay Harbor Islands', 'Surfside', 'Bal Harbour',
  'Golden Beach', 'Indian Creek Village', 'Medley', 'Virginia Gardens',
  'West Miami', 'Sunny Isles Beach',
  'Unincorporated / other',
] as const;

/** County Municipality-layer NAME (uppercase, e.g. "MIAMI SHORES") → the
 *  AREAS value the pin should stamp. Null = no municipality stamp: the City
 *  of Miami routes by Commission District, unincorporated Miami-Dade by
 *  County Commission District — both stamped separately from the same pin. */
export function muniArea(name: string): string | null {
  const n = name.trim().toUpperCase();
  if (!n || n === 'MIAMI' || n === 'UNINCORPORATED MIAMI-DADE') return null;
  const t = n.toLowerCase().split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return (AREAS as readonly string[]).includes(t) ? t : null;
}

/** Miami-Dade County Commission Districts — the countywide zone layer.
 *  Strings match the `County District N` stamp intake writes to
 *  helpline_cases.county_district (point-in-polygon on the pin, IDs 1–13).
 *  Teams carry these in the same zones[] as AREAS values; the suggestion
 *  falls back to them when no team covers the specific area. */
export const COUNTY_ZONES = Array.from({ length: 13 }, (_, i) => `County District ${i + 1}`);

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

/** Auto-close rule (user directive 2026-08-19): a case with this many FAILED
 *  attempts and zero successful contacts closes itself as no_locate. Reopen
 *  stays one click, and a successful contact at any point disarms the rule. */
export const MAX_FAILED_ATTEMPTS = 3;

export const CASE_STATUSES = [
  'new', 'assigned', 'attempted', 'contacted', 'confirmed',
  'declined', 'no_locate', 'closed', 'referred_out',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** The minimal shapes team suggestion needs — HelplineView's HlCase and Team
 *  satisfy these, and the intake form builds them from live form state. */
export interface RoutableCase {
  factors: string[];
  household: string | null;
  area: string | null;
  county_district: string | null;
}
export interface RoutableTeam {
  id: number; name: string; zones: string[]; factors: string[]; active: boolean;
}

/**
 * Suggested team + the reason — ONE implementation shared by the intake form
 * and the triage queue, so the two can never disagree. Factor routing outranks
 * geography (a veteran team takes veterans countywide). Geography is the
 * specific area first, then the County Commission District stamped from the
 * pin — so a call outside the City of Miami still gets a geographic suggestion
 * once teams carry COUNTY_ZONES. Ties broken by fewer open cases.
 * Suggest-only — the operator picks the team either way.
 */
export function suggestTeam<T extends RoutableTeam>(
  c: RoutableCase, teams: T[], openByTeam: Map<number, number>,
): { team: T; why: string } | null {
  const active = teams.filter((t) => t.active);
  const load = (t: T) => openByTeam.get(t.id) ?? 0;
  const best = (xs: T[]) => [...xs].sort((a, b) => load(a) - load(b))[0];
  const FACTOR_WHY: Record<string, string> = {
    veteran: 'takes veteran callers countywide',
    youth: 'takes youth callers countywide',
    family: 'takes families with children countywide',
  };
  const matchTag = (t: T) => t.factors.find((f) =>
    (f === 'veteran' && c.factors.includes('Veteran'))
    || (f === 'youth' && c.factors.includes('Youth 18–24'))
    || (f === 'family' && c.household === 'With children'));
  const factorHit = active.filter((t) => matchTag(t) !== undefined);
  if (factorHit.length) {
    const team = best(factorHit);
    return { team, why: FACTOR_WHY[matchTag(team)!] ?? 'routing tag match' };
  }
  const areaHit = active.filter((t) => c.area && t.zones.includes(c.area));
  if (areaHit.length) return { team: best(areaHit), why: `covers ${c.area}` };
  const countyHit = active.filter((t) => c.county_district && t.zones.includes(c.county_district));
  if (countyHit.length) return { team: best(countyHit), why: `covers ${c.county_district}` };
  return null;
}
