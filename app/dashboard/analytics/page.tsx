import { getAnalyticsInsights, getInterventionIntel, getPathwayIntel, getSystemAllSeries, getSystemForecast } from '../../../lib/queries';
import AnalyticsView, { type FlowMonth } from './AnalyticsView';

export const dynamic = 'force-dynamic';

/**
 * Analytics tab (user 2026-09-18, v2) — the full port of the old static
 * analytics page: Trend Projection · Return Risk · Survival · Capacity ·
 * Inflow. This page absorbed the Forecast tab (capacity + inflow render here
 * from the same system_forecast rows, in more detail); /dashboard/forecast
 * now redirects here.
 *
 * AGGREGATE-ONLY by doctrine: per-client risk scores are the parked Housing
 * Predictor and never load. The long-stay outlier client list is served by
 * /api/analytics/outliers from drill_clients `an:outlier` rows — agency-
 * scoped by RLS, hashed IDs only.
 */
export default async function AnalyticsPage() {
  const [a, forecast, pi, iv] = await Promise.all([
    getAnalyticsInsights(), getSystemForecast(), getPathwayIntel(),
    getInterventionIntel().catch(() => null),
  ]);
  // Inflow and outflow (2026-10-01): last 24 complete months of the SPM
  // pipeline's own monthly values — no new math here.
  let flow: FlowMonth[] = [];
  try {
    const sys = await getSystemAllSeries('monthly');
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    flow = Object.keys(sys).filter((p) => /^\d{4}-\d{2}$/.test(p)).sort().slice(-24)
      .map((m) => ({ m, first: num(sys[m].M5_FirstTime), newE: num(sys[m].M5_NewEntries), phx: num(sys[m].M_AllPHExits) }));
  } catch { /* section hides when empty */ }
  if (!a?.risk?.model) {
    return (
      <div className="panel" style={{ padding: 24 }}>
        <h3>Analytics</h3>
        <p className="bnl-sub" style={{ marginTop: 8 }}>
          The analytics payload hasn&rsquo;t been loaded yet — run the pipeline&rsquo;s meta load
          (upsert --only meta) after the next refresh and this page fills in.
        </p>
      </div>
    );
  }
  return <AnalyticsView a={a} forecast={forecast} pi={pi} iv={iv} flow={flow} />;
}
