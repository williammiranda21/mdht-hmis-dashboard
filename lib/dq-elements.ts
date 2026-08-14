/**
 * DQ fix-list element registry — the drill metric and dq_metrics % key for
 * each element. Shared by /api/dq-fixlist (drawer + CSV) and the DQ page's
 * overdue computation, so the metric↔pct mapping can never drift between
 * them. Display copy (labels, fix instructions) stays in DqFixList.tsx.
 * Order = drawer display order.
 */
export const DQ_ELEMENTS: { key: string; metric: string; pctKey: string }[] = [
  { key: 'dest', metric: 'dq:dest', pctKey: 'DQ_Dest_pct' },
  { key: 'movein', metric: 'dq:movein', pctKey: 'DQ_MoveIn_pct' },
  { key: 'income', metric: 'dq:income', pctKey: 'DQ_IncMiss_pct' },
  { key: 'incexit', metric: 'dq:incexit', pctKey: 'DQ_IncExit_pct' },
  { key: 'annual', metric: 'dq:annual', pctKey: 'DQ_Annual_pct' },
  // Q6b FY2026 elements + Q6d chronic (ETL rebuild 2026-08-13)
  { key: 'veteran', metric: 'dq:veteran', pctKey: 'DQ_Veteran_pct' },
  { key: 'psd', metric: 'dq:psd', pctKey: 'DQ_PSD_pct' },
  { key: 'relhoh', metric: 'dq:relhoh', pctKey: 'DQ_RelHoH_pct' },
  { key: 'coc', metric: 'dq:coc', pctKey: 'DQ_CoC_pct' },
  { key: 'disabling', metric: 'dq:disabling', pctKey: 'DQ_Disabling_pct' },
  { key: 'chronic', metric: 'dq:chronic', pctKey: 'DQ_Chronic_pct' },
  // Left-open enrollment suspects — SNAPSHOT keyed to the latest complete
  // month; no trend % exists for it.
  { key: 'openstay', metric: 'dq:openstay', pctKey: 'DQ_OpenStay_pct' },
  // PII (Q6a) — client-level, fix once per client.
  { key: 'name', metric: 'dq:name', pctKey: 'DQ_Name_pct' },
  { key: 'ssn', metric: 'dq:ssn', pctKey: 'DQ_SSN_pct' },
  { key: 'dob', metric: 'dq:dob', pctKey: 'DQ_DOB_pct' },
  { key: 'race', metric: 'dq:race', pctKey: 'DQ_Race_pct' },
  { key: 'sex', metric: 'dq:sex', pctKey: 'DQ_Sex_pct' },
];
