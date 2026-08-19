/**
 * Youth Connect — the ONE answer domain for categorical intake fields.
 *
 * Both doors (youth self-entry portal and staff intake form) import these, so
 * every record answers from the same closed list and reporting can GROUP BY
 * without free-text cleanup. Change a label here and both forms follow.
 *
 * A skipped question stores NULL — that is the "unknown", so no option for it.
 */
export const SLEEPING_OPTIONS = [
  'Street / outside',
  'Car',
  "Friend's place",
  'Shelter',
  'Other',
] as const;

export const UNSAFE_OPTIONS = [
  'Yes',
  'No',
  'Rather not say',
] as const;
