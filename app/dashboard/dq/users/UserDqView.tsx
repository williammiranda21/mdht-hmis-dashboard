'use client';

import { useEffect, useMemo, useState } from 'react';
import { fmtInt } from '../../../../lib/format';
import { EVA_BY_ID } from '../../../../lib/evaChecks';

/**
 * Error rates by user — who is creating the records behind the fix-lists.
 * Data: /api/user-dq (user_dq, trailing 12 complete months, RLS-scoped).
 *
 * ATTRIBUTION IS "RECORD CREATOR": the HUD export carries only the creating
 * UserID — someone who later edited (or should have edited) a record is
 * invisible. Every surface here repeats that, because this is staff-facing
 * data and the number must not overclaim. Rates, not raw counts, rank users
 * (raw counts punish high-volume staff); users under MIN_VOL records rank
 * last and show a "low volume" note instead of a percentage pill.
 */

const MIN_VOL = 20;

const DQ_LABEL: Record<string, string> = {
  'dq:dest': 'Missing exit destination', 'dq:movein': 'Missing move-in date',
  'dq:income': 'Income at entry', 'dq:incexit': 'Income at exit',
  'dq:annual': 'Overdue annual assessment', 'dq:openstay': 'Enrollment left open',
  'dq:name': 'Name', 'dq:ssn': 'SSN', 'dq:dob': 'DOB',
  'dq:race': 'Race/ethnicity', 'dq:sex': 'Sex',
};
const label = (metric: string): string =>
  DQ_LABEL[metric]
  ?? (metric.startsWith('eva:') ? (EVA_BY_ID.get(metric.slice(4))?.label ?? `Check ${metric.slice(4)}`) : metric);

interface UserRow {
  user_id: string; name: string | null; email: string | null; is_import: boolean;
  created: number; errors: number; rate: number | null;
  top_metric: { metric: string; n: number } | null; projects: number;
}
interface CardData {
  user: { user_id: string; name: string | null; email: string | null; is_import: boolean } | null;
  monthly: { period: string; created: number; errors: number; rate: number | null }[];
  metrics: { metric: string; n: number }[];
  projects: { project_id: number; name: string | null; errors: number; created: number }[];
}

const ratePill = (rate: number | null, created: number) => {
  if (rate == null || created < MIN_VOL) {
    return <span className="bnl-sub">low volume{created ? ` (${created})` : ''}</span>;
  }
  const col = rate <= 5 ? 'var(--accent)' : rate <= 15 ? 'var(--warn)' : 'var(--danger)';
  return <span className="bnl-rp" style={{ background: 'var(--track)', color: col }}>{rate.toFixed(1)}%</span>;
};

function ScoreCard({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [d, setD] = useState<CardData | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/user-dq?user=${encodeURIComponent(userId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => { if (live) setD(j); })
      .catch(() => { if (live) setD(null); });
    return () => { live = false; };
  }, [userId]);

  const totals = useMemo(() => {
    if (!d) return null;
    const created = d.monthly.reduce((s, m) => s + m.created, 0);
    const errors = d.monthly.reduce((s, m) => s + m.errors, 0);
    const rate = created > 0 ? (errors / created) * 100 : null;
    const score = rate == null ? null : Math.max(0, Math.round(100 - rate));
    return { created, errors, rate, score };
  }, [d]);

  return (
    <div className="bnl-ov" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bnl-modal" style={{ maxWidth: 640 }}>
        <button className="bnl-x" onClick={onClose}>✕</button>
        {!d || !totals ? <div className="hc-none">Loading…</div> : (
          <>
            <h3>{d.user?.name ?? userId}</h3>
            <div className="bnl-sub">{d.user?.email ?? '—'} · trailing 12 complete months</div>

            <div className="bnl-mgrid">
              <div className="bnl-mg"><div className="k">Accuracy score</div>
                <div className="v num" style={{ fontSize: 22, color: totals.score == null ? 'var(--muted)'
                  : totals.score >= 95 ? 'var(--accent)' : totals.score >= 85 ? 'var(--warn)' : 'var(--danger)' }}>
                  {totals.score == null ? '—' : totals.score}
                </div>
                <div className="bnl-sub">100 − error rate</div></div>
              <div className="bnl-mg"><div className="k">Records created</div>
                <div className="v num">{fmtInt(totals.created)}</div></div>
              <div className="bnl-mg"><div className="k">Errors attributed</div>
                <div className="v num">{fmtInt(totals.errors)}</div>
                <div className="bnl-sub">{totals.rate == null ? '' : `${totals.rate.toFixed(1)}% of records`}</div></div>
              <div className="bnl-mg"><div className="k">Projects</div>
                <div className="v num">{d.projects.length}</div></div>
            </div>

            <div className="hc-sub">Errors by element</div>
            {d.metrics.length === 0 ? <div className="bnl-sub">No attributed errors. 🎉</div> : (
              <div style={{ display: 'grid', gap: 4 }}>
                {d.metrics.slice(0, 8).map((m) => (
                  <div key={m.metric} style={{ display: 'flex', gap: 8, fontSize: 12.5, alignItems: 'baseline' }}>
                    <span style={{ minWidth: 40, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtInt(m.n)}</span>
                    <span style={{ color: 'var(--muted)' }}>{label(m.metric)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="hc-sub">Monthly error rate</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 56 }}>
              {d.monthly.map((m) => {
                const r = m.rate ?? 0;
                const h = Math.min(52, 4 + r * 2);
                const col = m.rate == null ? 'var(--track)' : r <= 5 ? 'var(--accent)' : r <= 15 ? 'var(--warn)' : 'var(--danger)';
                return (
                  <div key={m.period} title={`${m.period}: ${m.rate == null ? 'no records created' : `${m.rate.toFixed(1)}% (${m.errors}/${m.created})`}`}
                    style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                    <span style={{ display: 'block', width: '100%', maxWidth: 26, height: h, borderRadius: 3, background: col, opacity: .9 }} />
                    <span style={{ fontSize: 9, color: 'var(--faint)' }}>{m.period.slice(5)}</span>
                  </div>
                );
              })}
            </div>

            <div className="hc-sub">By project</div>
            <div style={{ display: 'grid', gap: 4 }}>
              {d.projects.slice(0, 5).map((p) => (
                <div key={p.project_id} style={{ display: 'flex', gap: 8, fontSize: 12.5, alignItems: 'baseline' }}>
                  <span style={{ minWidth: 40, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtInt(p.errors)}</span>
                  <span style={{ color: 'var(--muted)' }}>{p.name}</span>
                  <span className="bnl-sub">of {fmtInt(p.created)} created</span>
                </div>
              ))}
            </div>

            <div className="bnl-dq" style={{ marginTop: 12 }}>
              Attribution is by RECORD CREATOR — the HMIS export doesn’t say who edited a
              record later. Use this as a coaching and training signal, not a verdict.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function UserDqView() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [err, setErr] = useState(false);
  const [showImports, setShowImports] = useState(false);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/user-dq')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => setUsers(j.users ?? []))
      .catch(() => setErr(true));
  }, []);

  const rows = useMemo(() => {
    if (!users) return [];
    const t = q.trim().toLowerCase();
    return users
      .filter((u) => showImports || !u.is_import)
      .filter((u) => !t || (u.name ?? '').toLowerCase().includes(t) || (u.email ?? '').toLowerCase().includes(t))
      .sort((a, b) => {
        // rate ranks only users with real volume; the rest sort below by errors
        const ar = a.created >= MIN_VOL && a.rate != null ? a.rate : -1;
        const br = b.created >= MIN_VOL && b.rate != null ? b.rate : -1;
        return br - ar || b.errors - a.errors;
      });
  }, [users, showImports, q]);

  if (err) return <div className="panel"><div className="empty">Could not load user data. Has <code>supabase/user_dq.sql</code> been run and <code>recompute_user_dq.py</code> loaded?</div></div>;
  if (!users) return <div className="panel"><div className="hc-none">Loading…</div></div>;

  return (
    <>
      <div className="panel">
        <div className="panel-h">
          <div>
            <h3>Data entry — error rates by user</h3>
            <div className="meta">
              Fix-list records attributed to the HMIS user who CREATED the responsible record,
              over the trailing 12 complete months. Rates are errors ÷ records created — raw
              counts would punish high-volume staff. Click a user for their score card.
              <a href="/dashboard/dq" style={{ marginLeft: 8 }}>← Data Quality</a>
            </div>
          </div>
          <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input className="finput" placeholder="Filter by name or email…" value={q}
              onChange={(e) => setQ(e.target.value)} style={{ minWidth: 180 }} />
            <label className="bnl-sub" style={{ display: 'flex', gap: 5, alignItems: 'center', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={showImports} onChange={(e) => setShowImports(e.target.checked)} />
              import accounts
            </label>
          </span>
        </div>
        <div className="scroll scroll-pin">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th className="num">Records created</th>
                <th className="num">Errors</th>
                <th className="num">Error rate</th>
                <th>Top issue</th>
                <th className="num">Projects</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.user_id} style={{ cursor: 'pointer' }} onClick={() => setOpen(u.user_id)}>
                  <td>
                    <div className="bnl-nm">{u.name ?? u.user_id}{u.is_import && <span className="bnl-fp bnl-fp-dq" style={{ marginLeft: 6 }}>IMPORT</span>}</div>
                    <div className="bnl-sub">{u.email ?? '—'}</div>
                  </td>
                  <td className="num">{fmtInt(u.created)}</td>
                  <td className="num">{fmtInt(u.errors)}</td>
                  <td className="num">{ratePill(u.rate, u.created)}</td>
                  <td>{u.top_metric
                    ? <span className="bnl-sub">{label(u.top_metric.metric)} ({fmtInt(u.top_metric.n)})</span>
                    : <span className="bnl-sub">—</span>}</td>
                  <td className="num">{u.projects}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="empty">No users match.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {open && <ScoreCard userId={open} onClose={() => setOpen(null)} />}
    </>
  );
}
