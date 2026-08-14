'use client';

import { TARGET_METRICS, fmtTarget, metricAppliesTo } from '../../lib/target-metrics';
import { periodLabel } from '../../lib/format';

/**
 * Targets & progress (Pillar 3-4) — READ-ONLY progress bars against the SAME
 * stored values shown elsewhere on the panel. Metric definitions live in
 * lib/target-metrics.ts, shared with the admin Targets console.
 *
 * Targets are managed ONLY at /dashboard/admin/targets (user decision
 * 2026-07-31 — no inline editing on the project card). A target resolves
 * project override (project_targets) → type default (type_targets); inherited
 * rows are labelled "type default". Only metrics with an effective target
 * render; the section disappears entirely when there are none (admins get a
 * pointer to the console instead).
 */

export interface TargetsData {
  editable: boolean;                               // admin? → show manage link
  rows: { metric: string; target: number }[];      // project overrides
  typeRows: { metric: string; target: number }[];  // type defaults
  current: Record<string, number | null>;
  /** metric → period its value comes from, when NOT the selected period
   *  (DQ is measured on complete months, so under a partial month the score
   *  falls back to the latest complete one and is labelled with it). */
  asOf?: Record<string, string>;
}

/** Return-rate targets render on the RETURNS drawer, everything else on the
 *  Performance drawer (user decision 2026-08-13) — same data, split view. */
const RETURNS_KEYS = new Set(['returns_6mo', 'returns_2yr']);

export default function TargetsSection({ data, scope = 'performance', projectType = null }: {
  projectId: number; data: TargetsData | null; scope?: 'performance' | 'returns';
  /** HUD type code — rows for metrics that don't apply to this type are hidden. */
  projectType?: number | null;
}) {
  if (!data) return null;
  const override: Record<string, number | undefined> =
    Object.fromEntries((data.rows ?? []).map((r) => [r.metric, r.target]));
  const typeDefault: Record<string, number | undefined> =
    Object.fromEntries((data.typeRows ?? []).map((r) => [r.metric, r.target]));

  const pool = TARGET_METRICS.filter((m) =>
    (scope === 'returns' ? RETURNS_KEYS.has(m.key) : !RETURNS_KEYS.has(m.key))
    && metricAppliesTo(m, projectType));
  const visible = pool.filter((m) => (override[m.key] ?? typeDefault[m.key]) != null);
  // Returns drawer: appear only when return targets actually exist. The
  // Performance drawer keeps the admin "no targets yet" pointer.
  if (scope === 'returns' && !visible.length) return null;
  if (!visible.length && !data.editable) return null;

  return (
    <>
      <div className="hc-sub">
        {scope === 'returns' ? 'Return targets & progress' : 'Targets & progress'}
        {data.editable && (
          <a href="/dashboard/admin/targets" className="bnl-sub"
            style={{ marginLeft: 8, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
            manage →
          </a>
        )}
      </div>
      {!visible.length ? (
        <div className="bnl-sub">No targets set for this project or its type yet.</div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {visible.map((m) => {
            const target = override[m.key] ?? typeDefault[m.key] ?? null;
            const inherited = override[m.key] == null;
            const cur = data.current[m.key] ?? null;
            const met = target != null && cur != null
              && (m.higherBetter ? cur >= target : cur <= target);
            // Bar = progress toward the target (capped); for lower-is-better the
            // bar fills as the value drops toward the target.
            const pct = target == null || cur == null ? 0
              : m.higherBetter
                ? Math.min(100, (cur / Math.max(target, 1e-9)) * 100)
                : Math.min(100, (Math.max(target, 1e-9) / Math.max(cur, 1e-9)) * 100);
            // Explicit per-metric verdict (user request 2026-08-13): how far
            // off, in the metric's own unit (pp for rates).
            const gap = target == null || cur == null ? null
              : m.higherBetter ? target - cur : cur - target;
            const gapTxt = gap == null ? ''
              : `${Number(Math.abs(gap).toFixed(1))}${m.unit === '%' ? 'pp' : m.unit} ${m.higherBetter ? (met ? 'above' : 'below') : (met ? 'under' : 'over')}`;
            const chip = cur == null
              ? { txt: 'no data', bg: 'var(--track)', fg: 'var(--muted)', tip: 'No stored value for this metric in the selected period.' }
              : met
                ? { txt: '✓ on target', bg: 'var(--accent-light)', fg: 'var(--accent)', tip: gapTxt }
                : { txt: '⚑ off target', bg: 'var(--warn-light)', fg: 'var(--warn)', tip: gapTxt };
            const asOf = cur != null ? data.asOf?.[m.key] : undefined;
            return (
              <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
                <span style={{ minWidth: 150, color: 'var(--muted)' }}>
                  {m.label}
                  {asOf && (
                    <span className="bnl-sub" title={`Measured on complete months — showing ${periodLabel(asOf)}, the latest available.`}
                      style={{ marginLeft: 6, fontWeight: 400 }}>
                      ({periodLabel(asOf)})
                    </span>
                  )}
                </span>
                <span style={{ minWidth: 60, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtTarget(cur, m.unit)}</span>
                <span style={{ flex: 1, minWidth: 120, height: 7, borderRadius: 4, background: 'var(--border)', overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', width: `${pct}%`,
                    background: cur == null ? 'var(--border)' : met ? 'var(--accent)' : 'var(--warn)' }} />
                </span>
                <span className="bnl-sub" style={{ minWidth: 110 }}>
                  {`target ${m.higherBetter ? '≥' : '≤'} ${fmtTarget(target, m.unit)}${inherited ? ' · type default' : ''}`}
                </span>
                <span title={chip.tip} style={{ minWidth: 84, textAlign: 'center', fontSize: 10.5, fontWeight: 700,
                  padding: '2px 8px', borderRadius: 999, background: chip.bg, color: chip.fg,
                  cursor: chip.tip ? 'help' : undefined, whiteSpace: 'nowrap' }}>
                  {chip.txt}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
