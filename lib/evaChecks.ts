/**
 * Eva check registry — the single auditable map for the Eva-based DQ rebuild.
 *
 * Check ids match HUD Eva (github.com/abtassociates/eva, EvaChecks.csv); the
 * findings themselves are computed by pipeline/recompute_eva.py and stored as
 * drill_clients rows (period = latest complete month, metric = 'eva:<id>').
 * This file adds the GUIDED layer: severity, plain-language meaning, concrete
 * ServicePoint fix steps, and which published number the error corrupts
 * ("breaks") — the blast radius that drives prioritization. Edit copy here;
 * never invent numbers in it.
 */

export type EvaSeverity = 'hp' | 'error' | 'warning';

export interface EvaCheck {
  id: string;            // Eva check id, e.g. '2' → metric 'eva:2'
  label: string;
  severity: EvaSeverity;
  category: 'Household' | 'Dates' | 'Duplicates';
  meaning: string;       // what this actually says about the record
  fix: string;           // concrete ServicePoint steps
  breaks: string;        // which published numbers this corrupts (blast radius)
}

export const EVA_SEVERITY_META: Record<EvaSeverity, { label: string; rank: number }> = {
  hp: { label: 'High priority', rank: 0 },
  error: { label: 'Error', rank: 1 },
  warning: { label: 'Warning', rank: 2 },
};

export const EVA_CHECKS: EvaCheck[] = [
  // ── Household integrity ────────────────────────────────────────────────────
  {
    id: '2', label: 'Household has no head of household', severity: 'hp', category: 'Household',
    meaning: 'No member of this household is marked "Self (head of household)", so HUD reports cannot tell who anchors the household.',
    fix: 'Open the household in ServicePoint and set Relationship to Head of Household = "Self" on exactly one member (usually the adult who did intake).',
    breaks: 'APR household counts, move-in inheritance for the whole household, family/individual splits, income-at-entry universe.',
  },
  {
    id: '3', label: 'Household has more than one head', severity: 'hp', category: 'Household',
    meaning: 'Two or more members are marked "Self (head of household)" — reports will double-count or arbitrarily pick one.',
    fix: 'Keep "Self" on the true head and change the other member(s) to their actual relationship (spouse, child, other).',
    breaks: 'APR household counts, unit/household-based utilization, move-in logic.',
  },
  {
    id: '4', label: 'Relationship to head missing', severity: 'hp', category: 'Household',
    meaning: 'The member has no Relationship to Head of Household recorded (blank or "data not collected").',
    fix: 'Set the member’s Relationship to Head of Household on the enrollment.',
    breaks: 'Household composition everywhere — family flags, income universe, HoH-based checks.',
  },
  {
    id: '86', label: 'Children-only household', severity: 'error', category: 'Household',
    meaning: 'The oldest member of this household was under 12 at entry — the children are almost certainly detached from their adults’ enrollment.',
    fix: 'Find the parent/guardian’s enrollment and re-link the children into the same household (same Household ID), or correct the DOBs if wrong.',
    breaks: 'Family counts, youth counts, household typing across every report.',
  },
  // ── Impossible dates ───────────────────────────────────────────────────────
  {
    id: '14', label: 'Exit date in the future', severity: 'error', category: 'Dates',
    meaning: 'The exit is dated after today (data as of the export) — it hasn’t happened yet.',
    fix: 'Correct the exit date to the actual date the client left. If they haven’t left, delete the exit.',
    breaks: 'Exit counts, length of stay, returns tracking, utilization.',
  },
  {
    id: '99', label: 'Exit before entry', severity: 'error', category: 'Dates',
    meaning: 'The exit date is earlier than the entry date — the stay has negative length.',
    fix: 'Compare against case notes and correct whichever date is wrong.',
    breaks: 'Length of stay, utilization, every date-window count.',
  },
  {
    // Severity matches Eva (Warning) — downgraded from our earlier 'error'
    // per the 2026-08-13 parity audit. PSH/OPH entries before 10/1/2017 are
    // excused pipeline-side, also per Eva.
    id: '75', label: 'Entry date after record creation', severity: 'warning', category: 'Dates',
    meaning: 'The entry date is later than the day the record was created — a future-dated entry.',
    fix: 'Correct the entry date to the actual project start date.',
    breaks: 'Clients-served counts, entry cohorts, time-to-housing.',
  },
  {
    id: '84', label: 'Entered project before born', severity: 'error', category: 'Dates',
    meaning: 'Entry date is before the client’s date of birth — DOB or entry date is wrong.',
    fix: 'Check ID documents and correct the DOB (or the entry date).',
    breaks: 'Age-based universes — adult/child splits, youth counts, income requirements.',
  },
  {
    id: '143', label: 'Client older than 100 at entry', severity: 'warning', category: 'Dates',
    meaning: 'Age at entry exceeds 100 — usually a placeholder DOB (e.g. 1/1/1900).',
    fix: 'Verify and correct the date of birth.',
    breaks: 'Age demographics; senior counts.',
  },
  {
    id: '40', label: 'Move-in outside the stay', severity: 'error', category: 'Dates',
    meaning: 'The housing move-in date falls before entry, after exit, or after the data’s as-of date — it can’t belong to this stay.',
    fix: 'Correct the Housing Move-In Date to the real lease-up date within the enrollment.',
    breaks: 'Move-in counts, RRH/PSH utilization, time-to-housing.',
  },
  {
    // Severity matches Eva (Warning) — downgraded from 'error' per the
    // 2026-08-13 parity audit.
    id: '69', label: 'Homelessness start after entry', severity: 'warning', category: 'Dates',
    meaning: 'The "approximate date homelessness started" (3.917) is after the project entry date.',
    fix: 'Correct the approximate start date on the entry assessment — it should be on or before the entry.',
    breaks: 'Chronic-homelessness determination, length-of-time-homeless measures (SPM 1).',
  },
  // ── Duplicates ─────────────────────────────────────────────────────────────
  {
    id: '77', label: 'Overlapping stays at the same project', severity: 'warning', category: 'Duplicates',
    meaning: 'The client has two stays at this project that overlap in time with different entry dates — usually staff re-enrolled them instead of updating the open enrollment, and the first stay was never exited.',
    fix: 'Decide which enrollment is the real, current stay. Exit the superseded one as of the date the client actually left it (or delete it if it never happened).',
    breaks: 'Double-counts the client in served and utilization; corrupts length of stay and entry cohorts.',
  },
  {
    id: '1', label: 'Duplicate enrollment', severity: 'hp', category: 'Duplicates',
    meaning: 'The same client has two or more enrollments at the same project with the same entry date — one stay entered twice.',
    fix: 'Open the client’s enrollments, confirm which record carries the real assessments, and delete the duplicate (or ask the HMIS Lead to merge).',
    breaks: 'Double-counts the client in served, utilization, and every per-enrollment measure.',
  },
];

export const EVA_BY_ID: Map<string, EvaCheck> = new Map(EVA_CHECKS.map((c) => [c.id, c]));

/** metric string ('eva:88') → registry entry */
export const evaForMetric = (metric: string): EvaCheck | undefined =>
  metric.startsWith('eva:') ? EVA_BY_ID.get(metric.slice(4)) : undefined;
