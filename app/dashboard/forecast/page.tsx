import { getSystemForecast } from '../../../lib/queries';
import ForecastView from './ForecastView';

export const dynamic = 'force-dynamic';

/**
 * Forecast — system-level inflow projection and capacity-utilisation outlook.
 *
 * Leadership-facing, not agency-scoped: these are CoC-wide numbers, the same
 * ones the static analytics page shows, computed in generate_analytics.py and
 * loaded into `system_forecast`. Nothing is recomputed here.
 */
export default async function ForecastPage() {
  const forecast = await getSystemForecast();

  if (!forecast.inflow && !forecast.capacity) {
    return (
      <div className="panel">
        <div className="empty">
          <strong>No forecast data yet</strong>
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>
            Run <code>generate_analytics.py</code> and load{' '}
            <code>system_forecast</code> to populate this page.
          </div>
        </div>
      </div>
    );
  }

  return <ForecastView forecast={forecast} />;
}
