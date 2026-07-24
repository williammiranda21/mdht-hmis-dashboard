/**
 * Client drill-down — shared metric map, labels, and URL helper.
 *
 * The drill is served as a real page (app/dashboard/clients) reached by a normal
 * link, NOT an in-browser fetch. County Web Isolation (Fireglass) proxies page
 * navigations fine — that's why the dashboard loads at all — but mangles
 * client-side XHR to the API routes, which is why the old fetch-into-a-modal
 * drill did nothing on the County network. A hard navigation carries the session
 * cookie the same way loading any tab does, so this works through isolation.
 */

/** Table column key → the metric key stored in drill_clients (build_drill_clients). */
export const DRILL_METRICS: Record<string, string> = {
  clients_served: 'c',
  leavers: 'l',
  exits_ph: 'p',
  exits_unsub: 'u',
  LOS_0_30: 'los0',
  LOS_31_90: 'los31',
  LOS_91_180: 'los91',
  LOS_181_365: 'los181',
  LOS_365plus: 'los365',
  // Returns (SPM M2) — clients who exited to PH and later returned, by band.
  returns_exits: 'ret:exits',
  returns_lt6: 'ret:lt6',
  returns_6to12: 'ret:6to12',
  returns_13to24: 'ret:13to24',
  returns_2yr: 'ret:ret2yr',
};

/** Human label per drillable column, shown as the page heading. */
export const DRILL_LABELS: Record<string, string> = {
  clients_served: 'Clients served',
  leavers: 'Leavers (exited)',
  exits_ph: 'Exits to permanent housing',
  exits_unsub: 'Exits to unsubsidized housing',
  LOS_0_30: 'Length of stay 0–30 days',
  LOS_31_90: 'Length of stay 31–90 days',
  LOS_91_180: 'Length of stay 91–180 days',
  LOS_181_365: 'Length of stay 181–365 days',
  LOS_365plus: 'Length of stay 365+ days',
  returns_exits: 'PH exits (returns lookback)',
  returns_lt6: 'Returned to homelessness within 6 months',
  returns_6to12: 'Returned to homelessness 6–12 months after exit',
  returns_13to24: 'Returned to homelessness 13–24 months after exit',
  returns_2yr: 'Returned to homelessness within 2 years',
};

/** Build the drill page URL. `back` is where the ← link returns to (the tab the
 *  user came from, with its filters), so a hard navigation doesn't strand them. */
export function clientsHref(o: {
  metric: string; project: number; period: string; back: string;
}): string {
  const p = new URLSearchParams({
    metric: o.metric, project: String(o.project), period: o.period, back: o.back,
  });
  return `/dashboard/clients?${p.toString()}`;
}
