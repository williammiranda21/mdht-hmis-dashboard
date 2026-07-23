'use client';

import { useEffect, useState } from 'react';

/**
 * Shown automatically while the BNL server component streams.
 *
 * Next wraps `page.tsx` in a Suspense boundary whenever a `loading.tsx` exists
 * in the same segment — there is nothing to wire up.
 *
 * The roster is ~23,800 clients fetched in 1,000-row pages, so this can sit on
 * screen for a while. A static skeleton alone reads as "frozen" after ~20s, so
 * an elapsed counter and escalating copy are here to show it is still working.
 * This is perceived performance only — it does not make the load faster.
 */

const KPI_COUNT = 6;
const ROW_COUNT = 12;

export default function Loading() {
  const [secs, setSecs] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const message =
    secs < 8 ? 'Loading the By-Name List…'
      : secs < 25 ? 'Fetching client records…'
        : secs < 60 ? 'Still working — this roster is large.'
          : 'Nearly there — assembling the full roster.';

  return (
    <div aria-busy="true" aria-live="polite">
      <div className="panel sk-note">
        <span className="sk-spin" aria-hidden="true" />
        <div>
          <div className="sk-msg">{message}</div>
          <div className="bnl-sub">
            ~23,800 clients · {secs}s elapsed
          </div>
        </div>
      </div>

      {/* population selector */}
      <div className="panel" style={{ padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <span className="sk sk-line" style={{ width: 74 }} />
        <span className="sk sk-pill" style={{ width: 260 }} />
      </div>

      {/* KPI cards */}
      <div className="bnl-kpis" style={{ marginTop: 16 }}>
        {Array.from({ length: KPI_COUNT }, (_, i) => (
          <div key={i} className="bnl-kpi">
            <span className="sk sk-line" style={{ width: '55%', height: 9 }} />
            <span className="sk sk-line" style={{ width: '42%', height: 22, marginTop: 8 }} />
            <span className="sk sk-line" style={{ width: '68%', height: 8, marginTop: 7 }} />
          </div>
        ))}
      </div>

      {/* inflow / outflow chart */}
      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-h"><span className="sk sk-line" style={{ width: 300, height: 13 }} /></div>
        <div style={{ padding: '0 18px 18px' }}><span className="sk sk-block" style={{ height: 150 }} /></div>
      </div>

      {/* roster table */}
      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-h"><span className="sk sk-line" style={{ width: 200, height: 13 }} /></div>
        <div style={{ padding: '0 18px 18px' }}>
          <span className="sk sk-block" style={{ height: 34, marginBottom: 10 }} />
          {Array.from({ length: ROW_COUNT }, (_, i) => (
            <span
              key={i}
              className="sk sk-line"
              style={{ height: 16, marginBottom: 10, width: `${94 - (i % 4) * 7}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
