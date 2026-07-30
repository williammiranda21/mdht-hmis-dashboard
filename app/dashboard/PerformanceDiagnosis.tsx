'use client';

import type { Diagnosis, DiagInsight } from '../../lib/diagnosis';

/**
 * Pillar 2 — Performance diagnosis. Insight-first: a bottom line + the
 * cross-metric reads the per-metric peer chart cannot make (see lib/diagnosis).
 * Pure presentation — every value arrives server-computed from stored numbers.
 */

const KIND: Record<DiagInsight['kind'], { icon: string; color: string }> = {
  concern: { icon: '▲', color: 'var(--danger)' },
  caveat: { icon: '◆', color: 'var(--warn)' },
  strength: { icon: '●', color: 'var(--accent)' },
};

export default function PerformanceDiagnosis({ diagnosis: d }: { diagnosis: Diagnosis | null }) {
  if (!d || (!d.insights.length && !d.headline)) return null;

  return (
    <div style={{
      marginTop: 16, border: '1px solid var(--border)', borderRadius: 8,
      padding: '14px 16px', background: 'var(--card)',
    }}>
      <div className="hc-sub" style={{ marginTop: 0 }}>Performance diagnosis</div>
      <p style={{ margin: '4px 0 0', fontWeight: 600 }}>{d.headline}</p>

      {d.insights.length > 0 && (
        <ul style={{ margin: '10px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 10 }}>
          {d.insights.map((ins, i) => {
            const k = KIND[ins.kind];
            return (
              <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                <span aria-hidden style={{ color: k.color, fontSize: 11, flexShrink: 0 }}>{k.icon}</span>
                <span>
                  {ins.text}
                  {ins.action && (
                    <span style={{ color: 'var(--muted)' }}> {ins.action}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <p style={{ margin: '10px 0 0', fontSize: 11, color: 'var(--muted)' }}>
        Read across {d.peerN} similar {d.peerType} project{d.peerN === 1 ? '' : 's'} this period —
        every figure is a stored value; peer medians use the same method as the benchmarking chart.
      </p>
    </div>
  );
}
