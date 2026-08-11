'use client';

import { useEffect, useState } from 'react';
import {
  MILESTONES,
  type BnlClient, type BnlDetail, type BnlHist3, type BnlTimelineEvent,
} from './types';
import HistoryCard from './HistoryCard';
import Notes from './Notes';

/**
 * The client card (drawer) — extracted from BnlView 2026-08-11 so the cohort
 * dashboard opens the SAME card as the By-Name List (user request). Fetches
 * its own lazy detail (/api/bnl/client) per client; the caller only supplies
 * the roster row. Access is still the server's problem: the fetch runs
 * through the session, so can_see_bnl RLS is the boundary on every field.
 */

export function Flags({ r }: { r: BnlClient }) {
  return (
    <>
      {r.is_new && <span className="bnl-fp bnl-fp-new">NEW</span>}
      {r.returned && <span className="bnl-fp bnl-fp-ret">RETURNED</span>}
      {r.chronic && <span className="bnl-fp bnl-fp-chr">CHRONIC</span>}
      {r.veteran && <span className="bnl-fp bnl-fp-vet">VET</span>}
      {r.family && <span className="bnl-fp bnl-fp-fam">FAMILY</span>}
      {r.parenting && <span className="bnl-fp bnl-fp-par">PARENTING</span>}
      {r.unaccompanied && r.age != null && r.age < 25 && <span className="bnl-fp bnl-fp-una">UNACC.</span>}
      {r.in_school && <span className="bnl-fp bnl-fp-sch">SCHOOL</span>}
      {r.dq_n > 0 && <span className="bnl-fp bnl-fp-dq" title={`${r.dq_n} data-quality flag${r.dq_n === 1 ? '' : 's'} — open the client for detail`}>⚠ DQ</span>}
    </>
  );
}

export default function ClientDrawer({ row, asOf, isAdmin = false, onClose }: {
  row: BnlClient;
  /** Roster generation date — the "and counting" clock for un-housed journeys. */
  asOf?: string | null;
  isAdmin?: boolean;
  onClose: () => void;
}) {
  const [timeline, setTimeline] = useState<BnlTimelineEvent[] | null>(null);
  const [hist3, setHist3] = useState<BnlHist3 | null>(null);
  const [detail, setDetail] = useState<BnlDetail | null>(null);
  // Add-to-cohort (admin-only) — cohort list loads lazily on first open.
  const [cohortOpts, setCohortOpts] = useState<{ id: number; name: string }[] | null>(null);
  const [cohortMsg, setCohortMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setTimeline(null); setHist3(null); setDetail(null);
    fetch(`/api/bnl/client?pid=${encodeURIComponent(row.pid)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((j: { timeline: BnlTimelineEvent[]; hist3: BnlHist3 | null; detail: BnlDetail | null }) => {
        if (!alive) return;
        setTimeline(j.timeline); setHist3(j.hist3); setDetail(j.detail);
      })
      .catch(() => { if (alive) setTimeline([]); });
    return () => { alive = false; };
  }, [row.pid]);

  useEffect(() => {
    setCohortMsg(null);
    if (isAdmin && cohortOpts === null) {
      fetch('/api/cohorts')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j) => setCohortOpts((j.cohorts ?? []).map(
          (c: { id: number; name: string }) => ({ id: c.id, name: c.name }))))
        .catch(() => setCohortOpts([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.pid, isAdmin]);

  return (
    <div className="bnl-ov" onClick={(e) => e.target === e.currentTarget && onClose()}>
      {/* id + @media print rules = the card alone prints; browser dialog
          offers "Save as PDF" (stylesheet approach, same as the project
          panel — no blobs, survives the county's web isolation). */}
      <div className="bnl-modal" id="bnl-printable">
        <button className="btn pp-noprint" style={{ float: 'right', marginLeft: 8 }}
          onClick={() => window.print()}
          title="Opens the print dialog — choose “Save as PDF”">🖨 PDF</button>
        <button className="bnl-x pp-noprint" onClick={onClose}>✕</button>
        <h3>{row.name} <span className="bnl-sub">· age {row.age ?? '—'}</span></h3>
        <div className="bnl-sub" style={{ fontFamily: 'ui-monospace, monospace', marginTop: 2, cursor: 'pointer' }}
          title="click to copy"
          onClick={(e) => { navigator.clipboard?.writeText(row.pid); const el = e.currentTarget; el.textContent = 'ID copied ✓'; setTimeout(() => { el.textContent = row.pid; }, 1200); }}>
          {row.pid}
        </div>
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span className={`bnl-chip bnl-${row.status}`}>{row.status}</span>{' '}
          <Flags r={row} />
          {isAdmin && (
            <span className="pp-noprint" style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              {cohortMsg && <span className="bnl-sub">{cohortMsg}</span>}
              <select className="fselect" style={{ padding: '3px 26px 3px 10px', fontSize: 12, minWidth: 150 }} value=""
                onChange={async (e) => {
                  const cid = Number(e.target.value);
                  if (!cid) return;
                  setCohortMsg(null);
                  const r = await fetch('/api/cohorts', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'add_members', id: cid, pids: [row.pid] }),
                  });
                  setCohortMsg(r.ok ? 'Added to cohort ✓' : 'Could not add.');
                }}>
                <option value="">+ Add to cohort…</option>
                {(cohortOpts ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </span>
          )}
        </div>
        <div className="bnl-mgrid">
          <div className="bnl-mg"><div className="k">Self-reported (3.917)</div><div className="v num">{row.days_homeless.toLocaleString()} d</div><div className="bnl-sub">{detail ? <>since {detail.ep_start}{detail.times3_sr ? ` · ${detail.times3_sr} time${detail.times3_sr === '1' ? '' : 's'} in 3 yrs` : ''}{detail.months3_sr ? ` · ${detail.months3_sr === 13 ? '12+' : detail.months3_sr} mo` : ''}</> : '…'}</div></div>
          <div className="bnl-mg"><div className="k">Observed in HMIS (3y)</div><div className="v num">{row.sys_days3.toLocaleString()} d</div><div className="bnl-sub">{row.episodes3} occasion{row.episodes3 === 1 ? '' : 's'} (7-night break)</div></div>
          <div className="bnl-mg"><div className="k">CE assessed</div><div className="v num">{row.assessed ?? 'No'}</div></div>
          <div className="bnl-mg"><div className="k">DOB · Sex · Race</div><div className="v" style={{ fontSize: '.8rem' }}>{detail ? <>{detail.dob ?? '—'} · {detail.sex ?? '—'}<div className="bnl-sub">{detail.race ?? 'race not recorded'}</div></> : '…'}</div></div>
          <div className="bnl-mg"><div className="k">Monthly income</div><div className="v num">{detail ? (detail.income != null ? `$${detail.income.toLocaleString()}` : '—') : '…'}</div><div className="bnl-sub">{detail?.income_date ? `as of ${detail.income_date}` : ''}</div></div>
          <div className="bnl-mg"><div className="k">DV</div><div className="v" style={{ fontSize: '.8rem' }}>{!detail ? '…' : detail.dv_fleeing ? <b style={{ color: 'var(--danger)' }}>Currently fleeing</b> : detail.dv_survivor ? 'Survivor' : detail.dv_survivor === false ? 'No' : '—'}</div></div>
          <div className="bnl-mg"><div className="k">Foster · Juv. justice</div><div className="v" style={{ fontSize: '.8rem' }}>{!detail ? '…' : <>{detail.foster == null ? 'unk' : detail.foster ? 'Yes' : 'No'} · {detail.jj == null ? 'unk' : detail.jj ? 'Yes' : 'No'}</>}</div></div>
          <div className="bnl-mg"><div className="k">Housing referral</div><div className="v" style={{ fontSize: '.8rem' }}>{row.ref_type ? <>{row.ref_type} · {row.ref_status}{row.ref_date ? ` · ${row.ref_date}` : ''}{row.ref_prov && <div className="bnl-sub">{row.ref_prov}</div>}</> : '—'}</div></div>
          {/* Household roster — every population, not just Family: who
              shares the current enrollment's household. HoH badged, ages
              in parens (minors read directly off the age). */}
          {(detail?.hh_n ?? 1) > 1 && (
            <div className="bnl-mg" style={{ gridColumn: '1 / -1' }}>
              <div className="k">Household · {detail!.hh_n} members</div>
              <div className="v" style={{ fontSize: '.78rem', lineHeight: 1.7 }}>
                {(detail!.hh_members ?? []).map((m, i) => (
                  <span key={m.pid} style={{ whiteSpace: 'nowrap' }}>
                    {i > 0 && <span style={{ color: 'var(--faint)' }}> · </span>}
                    <span style={{ fontWeight: m.pid === row.pid ? 700 : 400 }}>{m.name || 'Name withheld'}</span>
                    <span className="bnl-sub"> ({m.age != null ? m.age : '?'})</span>
                    {m.hoh && <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--primary)', marginLeft: 3, letterSpacing: '.04em' }}>HoH</span>}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="bnl-mg" style={{ gridColumn: '1 / -1' }}><div className="k">Status detail</div><div className="v" style={{ fontSize: '.78rem' }}>{row.detail}</div></div>
        </div>
        {/* Youth risk — its own strip, deliberately NOT another .bnl-mg tile:
            the score is the prioritization signal, so it gets band color +
            the itemized factors behind the number. Youth (18-24) only. */}
        {row.risk_pts != null && (
          <div className={`bnl-risk${row.risk_band === 'High' ? ' hi' : ''}`}>
            <span className="bnl-risk-band">{row.risk_band ?? '—'}</span>
            <b>Risk {row.risk_pts} / {row.risk_max}</b>
            <span className="bnl-sub" style={{ flex: 1 }}>
              {!detail ? '…'
                : detail.risk_detail?.length
                  ? detail.risk_detail.map(([l, p]) => `${l} +${p}`).join(' · ')
                  : 'no scored factors'}
              <span title="Housing Needs Assessment items (ADA unit, RS offender) are not scored yet"> · HNA pending</span>
            </span>
          </div>
        )}
        {/* CE journey — same proportional bar as the system card: bold
            milestone nodes with their dates beneath, segment width ∝ the
            day gap between adjacent known milestones. A segment fades (no
            number) when either of its dates is missing. */}
        {detail?.milestones && (
          <div className="bnl-ms">
            <span className="bnl-ms-t">CE journey</span>
            <div style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 360, overflowX: 'auto', padding: '16px 2px 2px' }}>
              {MILESTONES.map(([k, label], i) => {
                const d = detail.milestones?.[k] ?? null;
                const next = i < MILESTONES.length - 1
                  ? (detail.milestones?.[MILESTONES[i + 1][0]] ?? null) : null;
                const gap = d && next
                  ? Math.round((+new Date(next) - +new Date(d)) / 86400000) : null;
                const known = gap != null && gap >= 0;
                // Terminal reached via an exit to a permanent destination
                // (no program move-in) — label it honestly.
                const exitHoused = k === 'movein' && detail.milestones?.['_via'] === 'exit';
                return (
                  <span key={k} style={{ display: 'contents' }}>
                    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}
                      title={exitHoused ? 'Housed via an exit to a permanent destination — there is no program move-in' : undefined}>
                      <span style={{ fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', color: d ? 'var(--strong)' : 'var(--faint)' }}>{exitHoused ? 'Housed (exit)' : label}</span>
                      <span style={{ fontSize: 10.5, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{d ?? '—'}</span>
                    </span>
                    {i < MILESTONES.length - 1 && (
                      <span
                        title={known ? `${label} → ${MILESTONES[i + 1][1]}: ${gap} days` : 'not measurable — a milestone date is missing'}
                        style={{ position: 'relative', display: 'flex', alignItems: 'center',
                          flexGrow: known ? Math.max(gap, 4) : 3, flexBasis: 40, minWidth: 40, padding: '0 8px' }}>
                        {known && (
                          <span style={{ position: 'absolute', top: -15, left: 0, right: 0, textAlign: 'center',
                            fontSize: 10.5, fontWeight: 700, color: 'var(--primary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                            +{gap}d
                          </span>
                        )}
                        <span style={{ display: 'block', width: '100%', height: 5, borderRadius: 3,
                          background: 'var(--primary)', opacity: known ? 0.9 : 0.18 }} />
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
            {/* Total journey: first known milestone → move-in (housed) or
                the data date (still waiting — count keeps growing). */}
            {(() => {
              const ms = detail.milestones!;
              const first = MILESTONES.find(([k]) => ms[k]);
              if (!first) return null;
              const mi = ms['movein'] ?? null;
              const end = mi ?? asOf;
              if (!end) return null;
              const t = Math.round((+new Date(end) - +new Date(ms[first[0]] as string)) / 86400000);
              if (t < 0) return null;
              return mi ? (
                <span title={`${first[1]} ${ms[first[0]]} → moved in ${mi}`}
                  style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 700, color: 'var(--accent)', whiteSpace: 'nowrap' }}>
                  housed in {t.toLocaleString()}d
                </span>
              ) : (
                <span title={`${first[1]} ${ms[first[0]]} → not yet housed as of ${asOf}`}
                  style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 700, color: 'var(--warn)', whiteSpace: 'nowrap' }}>
                  {t.toLocaleString()}d and counting
                </span>
              );
            })()}
          </div>
        )}
        {!!detail?.dq?.length && <div className="bnl-dq">⚠ {detail.dq.join(' — ')}</div>}
        <HistoryCard h={hist3} />
        <div className="bnl-tl">
          {timeline === null && <div className="bnl-sub">Loading history…</div>}
          {timeline?.map((t, i) => (
            <div key={i} className={`bnl-ev ${t.exit ? (t.ph ? 'ph' : '') : 'open'}`}>
              <b>{t.type}</b> · {t.project}
              <div className="bnl-sub">{t.entry} → {t.exit ?? 'open'}{t.dest ? <> · to <b>{t.dest}</b></> : null}{t.ph ? <span style={{ color: 'var(--accent)' }}> ✓ PH</span> : null}</div>
            </div>
          ))}
        </div>
        {/* Last in the drawer: the record is read top-down (who they are →
            history → enrollments), and notes are what you add after reading. */}
        <Notes pid={row.pid} />
      </div>
    </div>
  );
}
