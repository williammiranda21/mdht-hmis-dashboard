/**
 * BNL Family status (user 2026-10-01) — the family housing-search pipeline
 * stage, set by case managers on the By-Name List's Family tab and used as a
 * filter there. Keys are what the database stores; the CHECK constraint in
 * supabase/bnl_family_status.sql must list exactly these keys. Labels are
 * display-only and can be reworded without a migration.
 */
export const FAMILY_STATUSES = [
  { key: 'pending_employment', label: 'Pending employment' },
  { key: 'needs_income', label: 'Needs to increase income' },
  { key: 'pending_income_verif', label: 'Pending income verification' },
  { key: 'rrh_pending_submittal', label: 'RRH pending submittal' },
  { key: 'rrh_submitted_incomplete', label: 'RRH submitted incomplete' },
  { key: 'rrh_complete', label: 'RRH complete' },
  { key: 'seeking_unit', label: 'Seeking unit' },
  { key: 'unit_identified', label: 'Unit identified' },
  { key: 'll_docs_received', label: 'LL docs received' },
  { key: 'inspection_pending', label: 'Inspection pending' },
  { key: 'inspection_complete', label: 'Inspection complete' },
  { key: 'cash_request_submitted', label: 'Cash request submitted' },
  { key: 'non_compliant', label: 'Non-compliant' },
  { key: 'search_on_hold_funds', label: 'Search on hold, insufficient funds' },
  { key: 'pending_move_out', label: 'Pending move-out' },
] as const;

export type FamilyStatusKey = (typeof FAMILY_STATUSES)[number]['key'];

export const FAMILY_STATUS_LABEL: Record<string, string> =
  Object.fromEntries(FAMILY_STATUSES.map((s) => [s.key, s.label]));

export const isFamilyStatus = (k: string): k is FamilyStatusKey => k in FAMILY_STATUS_LABEL;
