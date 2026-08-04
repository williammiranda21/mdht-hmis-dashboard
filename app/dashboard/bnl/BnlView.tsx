'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  POP_DEFS, MILESTONES,
  type BnlAgg, type BnlClient, type BnlDetail, type BnlHist3,
  type BnlTimelineEvent, type CeMilestonesAgg, type PopKey,
} from './types';
import HistoryCard from './HistoryCard';
import Notes from './Notes';

type SortKey = 'name' | 'age' | 'status' | 'project' | 'days_homeless' | 'sys_days3' | 'risk_pts' | 'ref_status' | 'assessed';

const COLS: Array<[SortKey | 'flags', string]> = [
  ['name', 'Client'],
  ['age', 'Age'],
  ['status', 'Status'],
  ['flags', 'Flags'],
  ['project', 'Project'],
  ['days_homeless', 'Self-reported days'],
  ['sys_days3', 'In HMIS (3y)'],
  ['risk_pts', 'Risk'],
  ['ref_status', 'Referral'],
  ['assessed', 'CE assessed'],
];

/** Rows per fetch. Must match PAGE_SIZE in lib/bnl-query.ts. */
const PAGE = 200;
/** Search is a server round-trip now, so wait for a pause in typing. */
const SEARCH_DEBOUNCE_MS = 250;

function Flags({ r }: { r: BnlClient }) {
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

// Inflow/Outflow chart removed 2026-07-31 (user: duplicated elsewhere — the
// flow data still lives in agg.pops[pop].flow if it's ever wanted back).

export default function BnlView({
  initialRows, initialTotal, agg, ceMilestones = null, isAdmin = false,
}: { initialRows: BnlClient[]; initialTotal: number; agg: BnlAgg; ceMilestones?: CeMilestonesAgg | null; isAdmin?: boolean }) {
  const [pop, setPop] = useState<PopKey>('all');
  // Add-to-cohort (admin-only) — cohort list loads lazily on first drawer open.
  const [cohortOpts, setCohortOpts] = useState<{ id: number; name: string }[] | null>(null);
  const [cohortMsg, setCohortMsg] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fFlag, setFFlag] = useState('');
  const [fAsmt, setFAsmt] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('days_homeless');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const [rows, setRows] = useState<BnlClient[]>(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [drill, setDrill] = useState<BnlClient | null>(null);
  const [timeline, setTimeline] = useState<BnlTimelineEvent[] | null>(null);
  const [hist3, setHist3] = useState<BnlHist3 | null>(null);
  const [detail, setDetail] = useState<BnlDetail | null>(null);

  // Cohort options load once, the first time an admin opens any drawer.
  useEffect(() => {
    setCohortMsg(null);
    if (drill && isAdmin && cohortOpts === null) {
      fetch('/api/cohorts')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j) => setCohortOpts((j.cohorts ?? []).map(
          (c: { id: number; name: string }) => ({ id: c.id, name: c.name }))))
        .catch(() => setCohortOpts([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drill, isAdmin]);

  // Debounced copy of the search box — only this triggers a fetch.
  const [qDebounced, setQDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  const pa = agg.pops[pop];

  const params = useCallback((offset: number) => new URLSearchParams({
    pop, status: fStatus, flag: fFlag, asmt: fAsmt, q: qDebounced,
    sort: sortKey, dir: sortDir, offset: String(offset), limit: String(PAGE),
  }), [pop, fStatus, fFlag, fAsmt, qDebounced, sortKey, sortDir]);

  // Which request is current. A slow response for an old filter must not
  // overwrite a newer one — without this, typing fast can leave stale rows.
  const reqId = useRef(0);
  const firstRender = useRef(true);

  useEffect(() => {
    // Skip the very first run: the server already delivered page 1.
    if (firstRender.current) { firstRender.current = false; return; }
    const id = ++reqId.current;
    setLoading(true);
    setLoadErr(null);
    fetch(`/api/bnl/roster?${params(0)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { rows: BnlClient[]; total: number }) => {
        if (id !== reqId.current) return;      // superseded
        setRows(j.rows);
        setTotal(j.total);
      })
      .catch(() => { if (id === reqId.current) setLoadErr('Could not load the roster.'); })
      .finally(() => { if (id === reqId.current) setLoading(false); });
  }, [params]);

  async function loadMore() {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/bnl/roster?${params(rows.length)}`);
      if (!res.ok) throw new Error();
      const j = (await res.json()) as { rows: BnlClient[]; total: number };
      if (id !== reqId.current) return;
      setRows((prev) => [...prev, ...j.rows]);
      setTotal(j.total);
    } catch {
      if (id === reqId.current) setLoadErr('Could not load more rows.');
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }

  async function openDrill(r: BnlClient) {
    setDrill(r);
    setTimeline(null); setHist3(null); setDetail(null);
    try {
      const res = await fetch(`/api/bnl/client?pid=${encodeURIComponent(r.pid)}`);
      if (res.ok) {
        const j = await res.json() as {
          timeline: BnlTimelineEvent[]; hist3: BnlHist3 | null; detail: BnlDetail | null;
        };
        setTimeline(j.timeline); setHist3(j.hist3); setDetail(j.detail);
      } else setTimeline([]);
    } catch {
      setTimeline([]);
    }
  }

  function setSort(k: SortKey | 'flags') {
    if (k === 'flags') return;
    setSortDir(sortKey === k ? (sortDir === 'desc' ? 'asc' : 'desc') : k === 'name' ? 'asc' : 'desc');
    setSortKey(k);
  }

  const kpis: Array<[string, number | string, string, string]> = useMemo(() => {
    const c = pa.counts;
    return [
      ['Actively homeless', c.active, `${c.vet.toLocaleString()} veterans · ${c.fam.toLocaleString()} in families`, 'var(--danger)'],
      ['Newly identified (30d)', c.new30, 'first HMIS contact', 'var(--warn)'],
      ['Housed', c.housed, 'moved in / exited to PH', 'var(--accent)'],
      ['Inactive (90d+)', c.inactive, 'no recent contact', 'var(--faint)'],
      ['Chronically homeless', c.chronic, 'HUD definition (approx.)', '#7E22CE'],
      ['CE assessed', c.active ? `${Math.round((100 * c.assessed) / c.active)}%` : '—', 'of actively homeless', 'var(--secondary)'],
    ];
  }, [pa]);

  // Bar scale comes from the population aggregate, not the loaded page — using
  // the page max would rescale every bar each time more rows arrived.
  const maxDays = Math.max(pa.max_days, 1);
  const exportHref = `/api/bnl/export?${params(0)}`;

  return (
    <>
      <div className="bnl-banner">
        🔒 Confidential — contains client names. Data as of <b>{agg.as_of}</b>.
        <a className="btn" href={exportHref} style={{ marginLeft: 'auto' }}>⬇ CSV</a>
      </div>

      <div className="panel" style={{ padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span className="flabel">Population</span>
        <div className="seg">
          {(Object.keys(POP_DEFS) as PopKey[]).map((k) => (
            <button key={k} className={pop === k ? 'on' : ''} onClick={() => setPop(k)}>
              {POP_DEFS[k].label}
            </button>
          ))}
        </div>
        <span className="bnl-sub">{pa.n.toLocaleString()} clients in this population</span>
      </div>

      {/* CE journey — SYSTEM view (all populations, unaffected by the selector):
          median days per milestone leg for the housed cohort, the longest leg
          highlighted, plus where not-yet-housed clients are waiting right now.
          Renders from ceMilestones.order so future milestones appear untouched. */}
      {ceMilestones && (() => {
        const labels = Object.fromEntries(MILESTONES);
        const ord = ceMilestones.order;
        const legs = ord.slice(0, -1).map((a, i) => [a, ord[i + 1]] as const);
        const meds = legs.map(([a, b]) => ceMilestones.housed[`${a}_${b}`]?.median ?? null);
        const worst = Math.max(...meds.map((m) => m ?? -1));
        const total = ceMilestones.housed[`${ord[0]}_${ord[ord.length - 1]}`];
        return (
          <div className="panel" style={{ marginTop: 16, padding: '12px 18px' }}>
            <div className="hc-sub" style={{ margin: '0 0 10px' }}>
              CE journey — median days between milestones
              <span className="bnl-sub" style={{ marginLeft: 8, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                clients housed in the last {ceMilestones.window_months} months · all populations
              </span>
            </div>
            {/* Journey bar — bold milestone labels as nodes; each connector's
                WIDTH is proportional to its median days (min width keeps 0d
                legs visible). The bar is on the labels' vertical center; the
                day count floats above its segment. Longest leg in warn. */}
            <div style={{ display: 'flex', alignItems: 'center', overflowX: 'auto', padding: '24px 4px 28px' }}>
              {ord.map((k, i) => {
                const isLast = i === ord.length - 1;
                const b = ord[i + 1];
                const s = isLast ? null : ceMilestones.housed[`${k}_${b}`];
                const isWorst = s?.median != null && s.median === worst && worst >= 0;
                return (
                  <span key={k} style={{ display: 'contents' }}>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--strong)', whiteSpace: 'nowrap', letterSpacing: '.01em' }}>
                      {labels[k] ?? k}
                    </span>
                    {!isLast && (() => {
                      // Live cohort stuck on THIS leg: their furthest milestone
                      // is k, so days-since-k is the leg's in-progress wait —
                      // e.g. accepted-but-not-moved-in = today − housing entry.
                      const w = ceMilestones.waiting[k];
                      // The live wait carries the visual weight when it dwarfs
                      // the completed experience (≥2× it, 7d floor) — i.e. the
                      // completed median is a workflow artifact (Accepted →
                      // Move-in's 0d) and the backlog is the real story.
                      const liveIsStory = (w?.median ?? 0) >= 2 * Math.max(s?.median ?? 0, 7);
                      return (
                        <span
                          title={`${labels[k] ?? k} → ${labels[b] ?? b}${s?.n ? ` — completed: median ${s.median}d · avg ${s.mean}d · ${s.n} clients${isWorst ? ' · longest leg' : ''}` : ' — no completed pairs'}${w?.n ? ` · waiting now: ${w.n} clients, median ${w.median}d${w.mean != null ? ` · avg ${w.mean}d` : ''} and counting` : ''}`}
                          style={{ position: 'relative', display: 'flex', alignItems: 'center',
                            flexGrow: Math.max(s?.median ?? 0, 4), flexBasis: 84, minWidth: 84, padding: '0 10px' }}>
                          <span style={{ position: 'absolute', top: -19, left: 0, right: 0, textAlign: 'center',
                            fontSize: 11.5, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                            color: isWorst ? 'var(--warn)' : 'var(--muted)' }}>
                            <b>{s?.median != null ? `${s.median}d` : '—'}</b>
                            {s?.mean != null && <span style={{ fontSize: 10, opacity: .85 }}> · avg {Math.round(s.mean)}d</span>}
                            {isWorst ? ' ⏳' : ''}
                          </span>
                          <span style={{ display: 'block', width: '100%', height: 6, borderRadius: 3,
                            background: isWorst ? 'var(--warn)' : 'var(--primary)',
                            opacity: s?.median != null ? 0.9 : 0.25 }} />
                          {(w?.n ?? 0) > 0 && (
                            <span style={{ position: 'absolute', top: 'calc(50% + 8px)', left: 0, right: 0, textAlign: 'center',
                              whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
                              fontSize: liveIsStory ? 11 : 10.5,
                              fontWeight: liveIsStory ? 700 : 400,
                              color: liveIsStory ? 'var(--warn)' : 'var(--muted)' }}>
                              {(w!.n).toLocaleString()} waiting · <b>{w!.median}d</b>
                              {w!.mean != null && <span style={{ fontSize: 10, opacity: .85 }}> · avg {Math.round(w!.mean!)}d</span>}
                            </span>
                          )}
                        </span>
                      );
                    })()}
                  </span>
                );
              })}
            </div>
            {total?.median != null && (
              <div className="bnl-sub" style={{ marginTop: 6 }}>
                End to end {labels[ord[0]] ?? ord[0]} → {labels[ord[ord.length - 1]] ?? ord[ord.length - 1]}:{' '}
                <b style={{ color: 'var(--strong)' }}>{total.median}d</b> median (n={total.n})
                {' '}· above each segment: completed journeys · below: clients on that leg right now, days so far
                {' '}· bold = median (typical client), avg = mean (pulled up by long-tail outliers)
              </div>
            )}
          </div>
        );
      })()}

      <div className="bnl-kpis" style={{ marginTop: 16 }}>
        {kpis.map(([label, val, note, color]) => (
          <div key={label} className="bnl-kpi" style={{ ['--kc' as any]: color }}>
            <div className="bnl-kpi-lbl">{label}</div>
            <div className="bnl-kpi-val num">{typeof val === 'number' ? val.toLocaleString() : val}</div>
            <div className="bnl-kpi-note">{note}</div>
          </div>
        ))}
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="fbar" style={{ marginBottom: 8 }}>
          <div className="frow">
            <div className="fgroup">
              <span className="flabel">Search</span>
              <input className="finput" placeholder="Name or project…" value={q}
                onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="fgroup">
              <span className="flabel">Status</span>
              <select className="fselect" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                <option value="">All</option>
                <option value="active">Actively homeless</option>
                <option value="housed">Housed</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
            <div className="fgroup">
              <span className="flabel">Flag</span>
              <select className="fselect" value={fFlag} onChange={(e) => setFFlag(e.target.value)}>
                <option value="">Any</option>
                <option value="is_new">Newly identified</option>
                <option value="returned">Returned</option>
                <option value="chronic">Chronic</option>
                <option value="veteran">Veteran</option>
                <option value="family">In a family</option>
                <option value="parenting">Parenting</option>
                <option value="unaccompanied">Unaccompanied</option>
                <option value="in_school">In school</option>
                <option value="dq">Has DQ issue</option>
              </select>
            </div>
            <div className="fgroup">
              <span className="flabel">CE assessed</span>
              <select className="fselect" value={fAsmt} onChange={(e) => setFAsmt(e.target.value)}>
                <option value="">Any</option>
                <option value="y">Assessed</option>
                <option value="n">Not assessed</option>
              </select>
            </div>
          </div>
        </div>

        <div className="scroll" style={loading ? { opacity: 0.55, transition: 'opacity .15s' } : undefined}>
          <table className="bnl-table">
            <thead>
              <tr>
                {COLS.map(([k, label]) => (
                  <th key={k} className={sortKey === k ? 'sorted' : ''} onClick={() => setSort(k)}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const col = r.days_homeless >= 365 ? 'var(--danger)' : r.days_homeless >= 180 ? 'var(--warn)' : 'var(--secondary)';
                return (
                  <tr key={r.pid} className="bnl-row" onClick={() => openDrill(r)}>
                    <td><div className="bnl-nm bnl-drillname" style={/unsheltered/.test(r.detail ?? '') ? { color: 'var(--danger)' } : undefined}>{r.name}</div><div className="bnl-sub">{r.detail}</div></td>
                    <td className="num">{r.age ?? '—'}</td>
                    <td><span className={`bnl-chip bnl-${r.status}`}>{r.status === 'active' ? 'Active' : r.status === 'housed' ? 'Housed' : 'Inactive'}</span></td>
                    <td><Flags r={r} /></td>
                    <td>{r.project ? <><span className="ty">{r.ptype ?? '?'}</span> {r.project}{r.enrolled ? null : <span className="bnl-sub" title="not a current enrollment — last known project"> (former)</span>}</> : <span className="bnl-sub">—</span>}</td>
                    <td>
                      <div className="bnl-dh">
                        <div className="bnl-dh-tr"><div className="bnl-dh-fl" style={{ width: `${Math.min(100, (100 * r.days_homeless) / maxDays)}%`, background: col }} /></div>
                        <span className="num">{r.days_homeless.toLocaleString()}</span>
                      </div>
                    </td>
                    <td className="num">{r.sys_days3.toLocaleString()} d <span className="bnl-sub">· {r.episodes3} ep</span></td>
                    <td>{r.risk_pts == null ? <span className="bnl-sub">—</span> : (
                      // Youth prioritization bands per spec: Low 0–7, High 8+.
                      // Two colors only — matches the ETL's risk_band exactly.
                      <span className={`bnl-rp ${r.risk_pts >= 8 ? 'bnl-rp-hi' : 'bnl-rp-lo'}`}
                        title={`${r.risk_pts >= 8 ? 'High' : 'Low'} priority — ${r.risk_pts} of ${r.risk_max} points (Low 0–7 · High 8+ · HNA items pending)`}>
                        {r.risk_pts} pts{r.risk_pts >= 8 ? ' · High' : ''}</span>
                    )}</td>
                    <td>{r.ref_type ? (
                      <><div>{r.ref_type} · <b>{r.ref_status}</b></div><div className="bnl-sub">{r.ref_date}{r.ref_prov ? ` · ${r.ref_prov}` : ''}</div></>
                    ) : <span className="bnl-sub">—</span>}</td>
                    <td className="num">{r.assessed
                      ? <>{r.assessed}{r.spdat_tool && (
                          <div className="bnl-sub">{r.spdat_tool}{r.spdat_score != null ? ` · ${r.spdat_score}` : ''}</div>
                        )}</>
                      : <span className="bnl-sub">no</span>}</td>
                  </tr>
                );
              })}
              {!rows.length && !loading && (
                <tr><td colSpan={COLS.length}><div className="hc-none">No clients match these filters.</div></td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="bnl-cnote" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span>
            {rows.length.toLocaleString()} of {total.toLocaleString()} shown ({POP_DEFS[pop].label})
            {loading && <span className="bnl-sub"> · loading…</span>}
          </span>
          {rows.length < total && (
            <button className="btn" onClick={loadMore} disabled={loading}>
              {loading ? 'Loading…' : `Show ${Math.min(PAGE, total - rows.length)} more`}
            </button>
          )}
          {loadErr && <span style={{ color: 'var(--danger)' }}>{loadErr}</span>}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-h"><h3>Methodology &amp; prioritization</h3></div>
        <p className="bnl-method">
          Cohort: everyone with HMIS activity in the last 24 months (ES, SH, TH, SO, PSH, RRH, PH, CE;
          Services-Only and Prevention excluded). <b>Actively homeless</b> = open ES/SH/TH/SO enrollment,
          PH match awaiting move-in, or a literal-homeless street-outreach sighting within 90 days.
          <b> Housed</b> = PH enrollment with move-in, or most recent exit to a permanent destination.
          <b> Inactive</b> = no open enrollment and no recent outreach sighting. Populations: Youth 18–24 ·
          Veterans (self-reported) · Families (household includes a child) · Single adults 25+ · Seniors 62+.
          <b> Default ordering is acuity-first:</b> actively homeless before inactive before housed, then
          longest time homeless first — the top of the list is always the highest-need, longest-waiting
          person in the selected population. <b>Self-reported (3.917)</b> uses the HUD 3.917 fields from
          intake: approximate episode start date (age-13 floor, 25-year cap; implausible dates get a DQ
          flag), times homeless in the past 3 years (3.917.4), and months homeless (3.917.5); PSH/RRH
          residency never counts. <b>In HMIS (3y)</b> is what the system observed in the last 3 years:
          merged ES/SH/TH/SO enrollment nights plus outreach contact days — per HUD&apos;s Defining
          &quot;Chronically Homeless&quot; Final Rule, a break of 7+ consecutive nights separates occasions.
          <b>CHRONIC</b> approximates the HMIS Reporting Glossary CH logic: disabling condition plus either
          12+ continuous months or 4+ occasions totaling 12+ months. Confirm statuses in case conferencing.
        </p>
      </div>

      {drill && (
        <div className="bnl-ov" onClick={(e) => e.target === e.currentTarget && setDrill(null)}>
          <div className="bnl-modal">
            <button className="bnl-x" onClick={() => setDrill(null)}>✕</button>
            <h3>{drill.name} <span className="bnl-sub">· age {drill.age ?? '—'}</span></h3>
            <div className="bnl-sub" style={{ fontFamily: 'ui-monospace, monospace', marginTop: 2, cursor: 'pointer' }}
              title="click to copy"
              onClick={(e) => { navigator.clipboard?.writeText(drill.pid); const el = e.currentTarget; el.textContent = 'ID copied ✓'; setTimeout(() => { el.textContent = drill.pid; }, 1200); }}>
              {drill.pid}
            </div>
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span className={`bnl-chip bnl-${drill.status}`}>{drill.status}</span>{' '}
              <Flags r={drill} />
              {isAdmin && (
                <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  {cohortMsg && <span className="bnl-sub">{cohortMsg}</span>}
                  <select className="fselect" style={{ padding: '3px 26px 3px 10px', fontSize: 12, minWidth: 150 }} value=""
                    onChange={async (e) => {
                      const cid = Number(e.target.value);
                      if (!cid) return;
                      setCohortMsg(null);
                      const r = await fetch('/api/cohorts', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'add_members', id: cid, pids: [drill.pid] }),
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
              <div className="bnl-mg"><div className="k">Self-reported (3.917)</div><div className="v num">{drill.days_homeless.toLocaleString()} d</div><div className="bnl-sub">{detail ? <>since {detail.ep_start}{detail.times3_sr ? ` · ${detail.times3_sr} time${detail.times3_sr === '1' ? '' : 's'} in 3 yrs` : ''}{detail.months3_sr ? ` · ${detail.months3_sr === 13 ? '12+' : detail.months3_sr} mo` : ''}</> : '…'}</div></div>
              <div className="bnl-mg"><div className="k">Observed in HMIS (3y)</div><div className="v num">{drill.sys_days3.toLocaleString()} d</div><div className="bnl-sub">{drill.episodes3} occasion{drill.episodes3 === 1 ? '' : 's'} (7-night break)</div></div>
              <div className="bnl-mg"><div className="k">CE assessed</div><div className="v num">{drill.assessed ?? 'No'}</div></div>
              <div className="bnl-mg"><div className="k">DOB · Sex · Race</div><div className="v" style={{ fontSize: '.8rem' }}>{detail ? <>{detail.dob ?? '—'} · {detail.sex ?? '—'}<div className="bnl-sub">{detail.race ?? 'race not recorded'}</div></> : '…'}</div></div>
              <div className="bnl-mg"><div className="k">Monthly income</div><div className="v num">{detail ? (detail.income != null ? `$${detail.income.toLocaleString()}` : '—') : '…'}</div><div className="bnl-sub">{detail?.income_date ? `as of ${detail.income_date}` : ''}</div></div>
              <div className="bnl-mg"><div className="k">DV</div><div className="v" style={{ fontSize: '.8rem' }}>{!detail ? '…' : detail.dv_fleeing ? <b style={{ color: 'var(--danger)' }}>Currently fleeing</b> : detail.dv_survivor ? 'Survivor' : detail.dv_survivor === false ? 'No' : '—'}</div></div>
              <div className="bnl-mg"><div className="k">Foster · Juv. justice</div><div className="v" style={{ fontSize: '.8rem' }}>{!detail ? '…' : <>{detail.foster == null ? 'unk' : detail.foster ? 'Yes' : 'No'} · {detail.jj == null ? 'unk' : detail.jj ? 'Yes' : 'No'}</>}</div></div>
              <div className="bnl-mg"><div className="k">Housing referral</div><div className="v" style={{ fontSize: '.8rem' }}>{drill.ref_type ? <>{drill.ref_type} · {drill.ref_status}{drill.ref_date ? ` · ${drill.ref_date}` : ''}{drill.ref_prov && <div className="bnl-sub">{drill.ref_prov}</div>}</> : '—'}</div></div>
              <div className="bnl-mg" style={{ gridColumn: '1 / -1' }}><div className="k">Status detail</div><div className="v" style={{ fontSize: '.78rem' }}>{drill.detail}</div></div>
            </div>
            {/* Youth risk — its own strip, deliberately NOT another .bnl-mg tile:
                the score is the prioritization signal, so it gets band color +
                the itemized factors behind the number. Youth (18-24) only. */}
            {drill.risk_pts != null && (
              <div className={`bnl-risk${drill.risk_band === 'High' ? ' hi' : ''}`}>
                <span className="bnl-risk-band">{drill.risk_band ?? '—'}</span>
                <b>Risk {drill.risk_pts} / {drill.risk_max}</b>
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
                  const end = mi ?? agg.as_of;
                  const t = Math.round((+new Date(end) - +new Date(ms[first[0]] as string)) / 86400000);
                  if (t < 0) return null;
                  return mi ? (
                    <span title={`${first[1]} ${ms[first[0]]} → moved in ${mi}`}
                      style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 700, color: 'var(--accent)', whiteSpace: 'nowrap' }}>
                      housed in {t.toLocaleString()}d
                    </span>
                  ) : (
                    <span title={`${first[1]} ${ms[first[0]]} → not yet housed as of ${agg.as_of}`}
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
            <Notes pid={drill.pid} />
          </div>
        </div>
      )}
    </>
  );
}
