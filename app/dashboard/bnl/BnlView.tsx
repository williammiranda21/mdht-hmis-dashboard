'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  POP_DEFS,
  type BnlAgg, type BnlClient, type BnlDetail, type BnlHist3,
  type BnlTimelineEvent, type PopKey,
} from './types';
import HistoryCard from './HistoryCard';
import Notes from './Notes';

type SortKey = 'name' | 'age' | 'status' | 'project' | 'days_homeless' | 'sys_days3' | 'risk_pts' | 'ref_status' | 'last_contact' | 'assessed';

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
  ['last_contact', 'Last contact'],
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

/** Inflow / outflow, straight from the precomputed aggregate for this population. */
function FlowChart({ flow }: { flow: BnlAgg['pops'][PopKey]['flow'] }) {
  const W = 1000, H = 190, P = 26;
  const max = Math.max(...flow.flatMap((m) => [m.new_n, m.housed_n, m.inactive_n]), 1);
  const bw = (W - P * 2) / Math.max(flow.length, 1), g = 5, b = (bw - g * 4) / 3;
  const series: Array<['new_n' | 'housed_n' | 'inactive_n', string]> = [
    ['new_n', 'var(--warn)'],
    ['housed_n', 'var(--accent)'],
    ['inactive_n', 'var(--faint)'],
  ];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="bnl-flow" preserveAspectRatio="none">
      {flow.map((m, i) => (
        <g key={m.month}>
          {series.map(([k, color], j) => {
            const v = m[k];
            const h = Math.round(((H - 44) * v) / max);
            return (
              <rect key={k} x={P + i * bw + g + j * (b + g)} y={H - 26 - h}
                width={b} height={h} rx={2} fill={color} />
            );
          })}
          <text x={P + i * bw + bw / 2} y={H - 9} textAnchor="middle"
            fontSize={10} fill="var(--muted)">{m.month.slice(2)}</text>
        </g>
      ))}
    </svg>
  );
}

export default function BnlView({
  initialRows, initialTotal, agg,
}: { initialRows: BnlClient[]; initialTotal: number; agg: BnlAgg }) {
  const [pop, setPop] = useState<PopKey>('all');
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
        <div className="panel-h"><h3>Inflow / Outflow — last 12 months · {POP_DEFS[pop].label}</h3></div>
        <FlowChart flow={pa.flow} />
        <div className="bnl-legend">
          <span className="bnl-lg-new">Newly identified</span>
          <span className="bnl-lg-housed">Housed</span>
          <span className="bnl-lg-inact">Became inactive</span>
        </div>
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
                      <span className={`bnl-rp ${r.risk_pts >= 5 ? 'bnl-rp-hi' : r.risk_pts >= 3 ? 'bnl-rp-md' : 'bnl-rp-lo'}`}
                        title={`partial score — out of ${r.risk_max} available points`}>{r.risk_pts} pts</span>
                    )}</td>
                    <td>{r.ref_type ? (
                      <><div>{r.ref_type} · <b>{r.ref_status}</b></div><div className="bnl-sub">{r.ref_date}{r.ref_prov ? ` · ${r.ref_prov}` : ''}</div></>
                    ) : <span className="bnl-sub">—</span>}</td>
                    <td className="num">{r.last_contact}</td>
                    <td className="num">{r.assessed ?? <span className="bnl-sub">no</span>}</td>
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
            <div style={{ marginTop: 6 }}>
              <span className={`bnl-chip bnl-${drill.status}`}>{drill.status}</span>{' '}
              <Flags r={drill} />
            </div>
            <div className="bnl-mgrid">
              <div className="bnl-mg"><div className="k">Self-reported (3.917)</div><div className="v num">{drill.days_homeless.toLocaleString()} d</div><div className="bnl-sub">{detail ? <>since {detail.ep_start}{detail.times3_sr ? ` · ${detail.times3_sr} time${detail.times3_sr === '1' ? '' : 's'} in 3 yrs` : ''}{detail.months3_sr ? ` · ${detail.months3_sr === 13 ? '12+' : detail.months3_sr} mo` : ''}</> : '…'}</div></div>
              <div className="bnl-mg"><div className="k">Observed in HMIS (3y)</div><div className="v num">{drill.sys_days3.toLocaleString()} d</div><div className="bnl-sub">{drill.episodes3} occasion{drill.episodes3 === 1 ? '' : 's'} (7-night break)</div></div>
              <div className="bnl-mg"><div className="k">Last contact</div><div className="v num">{drill.last_contact}</div></div>
              <div className="bnl-mg"><div className="k">CE assessed</div><div className="v num">{drill.assessed ?? 'No'}</div></div>
              <div className="bnl-mg"><div className="k">DOB · Sex · Race</div><div className="v" style={{ fontSize: '.8rem' }}>{detail ? <>{detail.dob ?? '—'} · {detail.sex ?? '—'}<div className="bnl-sub">{detail.race ?? 'race not recorded'}</div></> : '…'}</div></div>
              <div className="bnl-mg"><div className="k">Monthly income</div><div className="v num">{detail ? (detail.income != null ? `$${detail.income.toLocaleString()}` : '—') : '…'}</div><div className="bnl-sub">{detail?.income_date ? `as of ${detail.income_date}` : ''}</div></div>
              <div className="bnl-mg"><div className="k">DV</div><div className="v" style={{ fontSize: '.8rem' }}>{!detail ? '…' : detail.dv_fleeing ? <b style={{ color: 'var(--danger)' }}>Currently fleeing</b> : detail.dv_survivor ? 'Survivor' : detail.dv_survivor === false ? 'No' : '—'}</div></div>
              <div className="bnl-mg"><div className="k">Foster · Juv. justice</div><div className="v" style={{ fontSize: '.8rem' }}>{!detail ? '…' : <>{detail.foster == null ? 'unk' : detail.foster ? 'Yes' : 'No'} · {detail.jj == null ? 'unk' : detail.jj ? 'Yes' : 'No'}</>}</div></div>
              <div className="bnl-mg"><div className="k">Housing referral</div><div className="v" style={{ fontSize: '.8rem' }}>{drill.ref_type ? <>{drill.ref_type} · {drill.ref_status}{drill.ref_date ? ` · ${drill.ref_date}` : ''}{drill.ref_prov && <div className="bnl-sub">{drill.ref_prov}</div>}</> : '—'}</div></div>
              {drill.risk_pts != null && <div className="bnl-mg"><div className="k">Risk points (partial)</div><div className="v num">{drill.risk_pts} / {drill.risk_max}</div><div className="bnl-sub">TAY · Housing Needs · income pending</div></div>}
              <div className="bnl-mg" style={{ gridColumn: '1 / -1' }}><div className="k">Status detail</div><div className="v" style={{ fontSize: '.78rem' }}>{drill.detail}</div></div>
            </div>
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
