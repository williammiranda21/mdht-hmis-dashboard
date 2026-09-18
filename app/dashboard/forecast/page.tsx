import { redirect } from 'next/navigation';

// Forecast retired 2026-09-18 (user decision): the Analytics tab carries the
// capacity + inflow forecasts now, in fuller detail (adult/family splits,
// per-program breakdown, occupancy history). Old bookmarks land there.
export default function ForecastPage() {
  redirect('/dashboard/analytics');
}
