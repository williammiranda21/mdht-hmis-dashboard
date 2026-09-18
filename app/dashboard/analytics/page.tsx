import { getAnalyticsInsights, getPathwayIntel, getSystemForecast } from '../../../lib/queries';
import AnalyticsView from './AnalyticsView';

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
  const [a, forecast, pi] = await Promise.all([
    getAnalyticsInsights(), getSystemForecast(), getPathwayIntel(),
  ]);
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
  return <AnalyticsView a={a} forecast={forecast} pi={pi} />;
}
