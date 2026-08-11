'use client';

import { useEffect, useState } from 'react';
import { fmtInt } from '../../../../lib/format';
import CopyId from '../../../../components/CopyId';
import JourneyBar from '../../../../components/JourneyBar';
import ClientDrawer from '../../bnl/ClientDrawer';
import { MILESTONES, type BnlClient } from '../../bnl/types';

/**
 * Client cohorts — create a named group, paste hashed PersonalIDs (every ID
 * in the app is click-to-copy, so any worklist/fix-list/drill becomes a
 * cohort), then track the group's housing outcomes over time. Metrics are
 * LIVE from bnl_clients; the trend comes from cohort_snapshots (one point
 * per refresh, pipeline/snapshot_cohorts.py). Membership is static — housed
 * clients stay, that's the point.
 */

/** Milestone order + labels come from the shared BNL registry (bnl/types.ts),
 *  so a future milestone added there flows into this bar untouched. */
const MS_ORDER = MILESTONES.map(([k]) => k);
const MS_LABELS = Object.fromEntries(MILESTONES);

interface CohortRow { id: number; name: string; description: string | null; created_by: string | null; created_at: string; members: number }
interface Member {
  pid: string; name: string | null; age: number | null; status: string;
  project: string | null; ptype: string | null; enrolled: boolean;
  days_homeless: number | null; chronic: boolean; returned: boolean; risk_band: string | null;
  as_of: string | null;
}
interface Detail {
  cohort: { id: number; name: string; description: string | null; created_by: string | null; created_at: string };
  members: Member[];
  missing: string[];
  snapshots: { captured_on: string; counts: { housed_pct?: number | null; n?: number } }[];
  agg: {
    n: number; active: number; housed: number; inactive: number;
    housed_pct: number | null; returned: number; chronic: number; high_risk: number;
    median_days_homeless: number | null;
    legs: Record<string, { n: number; median: number | null; mean: number | null }>;
    waiting: Record<string, { n: number; median: number | null; mean: number | null }>;
  };
}

export default function CohortsView() {
  const [cohorts, setCohorts] = useState<CohortRow[] | null>(null);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [paste, setPaste] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Member click → the SAME client card as the BNL (ClientDrawer). The member
  // row is slim, so fetch the full roster row by pid first.
  const [drill, setDrill] = useState<BnlClient | null>(null);
  const [drillAsOf, setDrillAsOf] = useState<string | null>(null);

  async function openMember(m: Member) {
    try {
      const r = await fetch(`/api/bnl/roster?pid=${encodeURIComponent(m.pid)}&limit=1`);
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { rows: BnlClient[] };
      if (j.rows[0]) { setDrillAsOf(m.as_of); setDrill(j.rows[0]); }
      else setMsg('Client is no longer on the By-Name List roster.');
    } catch {
      setMsg('Could not load the client card.');
    }
  }

  const loadList = () => {
    fetch('/api/cohorts')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => setCohorts(j.cohorts ?? []))
      .catch(() => { setCohorts([]); setSetupNeeded(true); });
  };
  useEffect(loadList, []);

  const loadDetail = (id: number) => {
    setSel(id); setDetail(null); setMsg(null);
    fetch(`/api/cohorts?id=${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setDetail)
      .catch(() => setMsg('Could not load this cohort.'));
  };

  const act = async (body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    setBusy(true); setMsg(null);
    const r = await fetch('/api/cohorts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    setBusy(false);
    if (!r.ok) {
      let m = `Failed (${r.status}).`;
      try { const j = await r.json(); if (j?.error) m = String(j.error); } catch { /* keep default */ }
      setMsg(m);
      return null;
    }
    return r.json();
  };

  return (
    <>
      <div className="panel">
        <div className="panel-h">
          <div>
            <h3>Client cohorts</h3>
            <div className="meta">
              Create a group, paste client IDs (every ID in the app is click-to-copy), and track
              the group&apos;s housing outcomes. Membership is static — clients stay after they&apos;re
              housed; that&apos;s what makes the trend meaningful. Admin-only.
            </div>
          </div>
        </div>
        <div style={{ padding: '2px 18px 18px' }}>
          {setupNeeded && (
            <div className="bnl-dq" style={{ marginBottom: 12 }}>
              One-time setup: run <code>supabase/cohorts.sql</code> in the Supabase SQL editor, then reload.
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
            <input className="finput" placeholder="New cohort name…" value={name}
              onChange={(e) => setName(e.target.value)} style={{ minWidth: 200 }} />
            <input className="finput" placeholder="Description (optional)" value={desc}
              onChange={(e) => setDesc(e.target.value)} style={{ minWidth: 260 }} />
            <button className="btn" disabled={busy || !name.trim()} onClick={async () => {
              const r = await act({ action: 'create', name, description: desc });
              if (r?.ok) { setName(''); setDesc(''); loadList(); loadDetail(Number(r.id)); }
            }}>+ Create cohort</button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(cohorts ?? []).map((c) => (
              <button key={c.id} className="btn" aria-pressed={sel === c.id}
                style={sel === c.id ? { background: 'var(--primary)', color: '#fff', borderColor: 'var(--primary)' } : undefined}
                onClick={() => loadDetail(c.id)}>
                {c.name} <span style={{ opacity: .75 }}>({fmtInt(c.members)})</span>
              </button>
            ))}
            {cohorts !== null && cohorts.length === 0 && !setupNeeded && (
              <span className="bnl-sub">No cohorts yet — create the first one above.</span>
            )}
          </div>
          {msg && <div className="bnl-dq" style={{ marginTop: 10 }}>{msg}</div>}
        </div>
      </div>

      {sel != null && detail && (
        <>
          <div className="bnl-kpis" style={{ marginTop: 16 }}>
            <div className="bnl-kpi" style={{ ['--kc' as never]: 'var(--primary)' }}>
              <div className="bnl-kpi-lbl">Members</div>
              <div className="bnl-kpi-val num">{fmtInt(detail.agg.n)}</div>
              <div className="bnl-kpi-note">since {detail.cohort.created_at.slice(0, 10)}</div>
            </div>
            <div className="bnl-kpi" style={{ ['--kc' as never]: 'var(--accent)' }}>
              <div className="bnl-kpi-lbl">Housed</div>
              <div className="bnl-kpi-val num">{fmtInt(detail.agg.housed)}</div>
              <div className="bnl-kpi-note">{detail.agg.housed_pct == null ? '—' : `${detail.agg.housed_pct.toFixed(0)}% of cohort`}</div>
            </div>
            <div className="bnl-kpi" style={{ ['--kc' as never]: 'var(--warn)' }}>
              <div className="bnl-kpi-lbl">Actively homeless</div>
              <div className="bnl-kpi-val num">{fmtInt(detail.agg.active)}</div>
              <div className="bnl-kpi-note">{detail.agg.median_days_homeless != null ? `median ${fmtInt(detail.agg.median_days_homeless)}d homeless` : '—'}</div>
            </div>
            <div className="bnl-kpi" style={{ ['--kc' as never]: 'var(--danger)' }}>
              <div className="bnl-kpi-lbl">Returned after housing</div>
              <div className="bnl-kpi-val num">{fmtInt(detail.agg.returned)}</div>
              <div className="bnl-kpi-note">{fmtInt(detail.agg.chronic)} chronic · {fmtInt(detail.agg.high_risk)} high risk</div>
            </div>
          </div>

          {/* Cohort CE journey — the same proportional bar as the BNL system
              card (components/JourneyBar), fed by this cohort's members only:
              completed legs above the bar, members stuck on each leg below. */}
          <div className="panel" style={{ marginTop: 16, padding: '12px 18px' }}>
            <div className="hc-sub" style={{ margin: '0 0 10px' }}>
              Cohort CE journey — median days between milestones
              <span className="bnl-sub" style={{ marginLeft: 8, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                this cohort&apos;s members only
              </span>
            </div>
            <JourneyBar order={MS_ORDER} labels={MS_LABELS}
                        housed={detail.agg.legs} waiting={detail.agg.waiting ?? {}} />
            {detail.agg.legs['ident_movein']?.median != null && (
              <div className="bnl-sub" style={{ marginTop: 6 }}>
                End to end {MS_LABELS['ident'] ?? 'Identified'} → {MS_LABELS['movein'] ?? 'Moved in'}:{' '}
                <b style={{ color: 'var(--strong)' }}>{fmtInt(detail.agg.legs['ident_movein'].median!)}d</b> median
                {detail.agg.legs['ident_movein'].mean != null && <> · avg {Math.round(detail.agg.legs['ident_movein'].mean!)}d</>}
                {' '}(n={detail.agg.legs['ident_movein'].n})
                {' '}· above each segment: completed legs · below: members on that leg right now, days so far
              </div>
            )}
          </div>

          {/* Trend — % housed per refresh capture */}
          {detail.snapshots.length > 0 && (
            <div className="panel" style={{ marginTop: 16, padding: '12px 18px' }}>
              <div className="hc-sub" style={{ margin: '0 0 20px' }}>Housed % over time <span className="bnl-sub" style={{ textTransform: 'none', letterSpacing: 0 }}>one point per data refresh</span></div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 84 }}>
                {detail.snapshots.map((s) => {
                  const pct = s.counts.housed_pct ?? 0;
                  return (
                    <div key={s.captured_on} title={`${s.captured_on}: ${pct.toFixed(0)}% housed (n=${s.counts.n ?? '—'})`}
                      style={{ flex: 1, maxWidth: 44, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}>
                      <span style={{ fontSize: 10.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{pct.toFixed(0)}%</span>
                      <span style={{ display: 'block', width: '100%', height: 4 + pct * 0.48, borderRadius: 3, background: 'var(--accent)', opacity: .9 }} />
                      <span style={{ fontSize: 9.5, color: 'var(--muted)' }}>{s.captured_on.slice(5)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Members */}
          <div className="panel" style={{ marginTop: 16 }}>
            <div className="panel-h">
              <div>
                <h3>{detail.cohort.name} — members</h3>
                <div className="meta">
                  {detail.cohort.description || 'No description.'}
                  {detail.missing.length > 0 && ` · ⚠ ${detail.missing.length} member(s) no longer on the roster`}
                </div>
              </div>
              <button className="btn" disabled={busy} onClick={async () => {
                if (!window.confirm(`Delete cohort “${detail.cohort.name}”? Members are not affected — only the grouping is removed.`)) return;
                const r = await act({ action: 'delete', id: sel });
                if (r?.ok) { setSel(null); setDetail(null); loadList(); }
              }}>Delete cohort</button>
            </div>
            <div style={{ padding: '0 18px 12px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <textarea className="finput" rows={2} style={{ minWidth: 320, flex: 1 }}
                placeholder="Paste hashed client IDs (one per line, or comma/space separated)…"
                value={paste} onChange={(e) => setPaste(e.target.value)} />
              <button className="btn" disabled={busy || !paste.trim()} onClick={async () => {
                const pids = paste.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
                const r = await act({ action: 'add_members', id: sel, pids });
                if (r?.ok) {
                  setPaste('');
                  setMsg(`Added ${r.added}.${(r.unknown as string[]).length ? ` Not on the roster (skipped): ${(r.unknown as string[]).join(', ')}` : ''}`);
                  loadDetail(sel!); loadList();
                }
              }}>+ Add clients</button>
            </div>
            <div className="scroll scroll-pin">
              <table>
                <thead>
                  <tr>
                    <th>Client</th><th className="num">Age</th><th>Status</th><th>Project</th>
                    <th className="num">Days homeless</th><th>Flags</th><th className="num"></th>
                  </tr>
                </thead>
                <tbody>
                  {detail.members.map((m) => (
                    /* row opens the shared client card; CopyId and the remove
                       button stop propagation so they stay independent */
                    <tr key={m.pid} onClick={() => openMember(m)} style={{ cursor: 'pointer' }}
                        title="Open client card">
                      <td>
                        <div className="bnl-nm bnl-drillname">{m.name ?? m.pid}</div>
                        <CopyId pid={m.pid} />
                      </td>
                      <td className="num">{m.age ?? '—'}</td>
                      <td><span className={`bnl-chip bnl-${m.status}`}>{m.status}</span></td>
                      <td>{m.ptype && <span className="ty">{m.ptype}</span>} {m.project ?? '—'}{!m.enrolled && m.project ? <span className="bnl-sub"> (former)</span> : ''}</td>
                      <td className="num">{m.days_homeless != null ? fmtInt(m.days_homeless) : '—'}</td>
                      <td>
                        {m.chronic && <span className="bnl-fp bnl-fp-chr">CHRONIC</span>}
                        {m.returned && <span className="bnl-fp bnl-fp-ret">RETURNED</span>}
                        {m.risk_band === 'High' && <span className="bnl-fp bnl-fp-dq">HIGH RISK</span>}
                      </td>
                      <td className="num">
                        <button className="btn" style={{ padding: '0 8px', fontSize: 12 }} title="Remove from cohort"
                          disabled={busy}
                          onClick={async (e) => {
                            e.stopPropagation();
                            const r = await act({ action: 'remove_member', id: sel, pid: m.pid });
                            if (r?.ok) { loadDetail(sel!); loadList(); }
                          }}>✕</button>
                      </td>
                    </tr>
                  ))}
                  {detail.members.length === 0 && (
                    <tr><td colSpan={7} className="empty">No members yet — paste IDs above.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      {sel != null && !detail && !msg && <div className="panel" style={{ marginTop: 16 }}><div className="hc-none">Loading…</div></div>}

      {/* The SAME client card as the BNL — cohorts is admin-only, so the
          add-to-cohort control inside the drawer is always shown. */}
      {drill && (
        <ClientDrawer row={drill} asOf={drillAsOf} isAdmin
                      onClose={() => setDrill(null)} />
      )}
    </>
  );
}
