'use client';

/*
 * System Performance (SPM) tab — a faithful port of renderSpmTab() in
 * apr_monthly_report.py. The values come straight from the HUD-compliant pipeline
 * (system_metrics.data); this file only maps fields → cards/heatmap. Do NOT change
 * the math or field bindings without checking them against apr_monthly_report.py.
 *
 * Conventions matched exactly:
 *  - Card value uses the selected household (subpop fixed 'All'): combos[hh|All].
 *  - 12-month average + prior-period delta come from the All|All MONTHLY series.
 *  - M2 returns aggregate at household 'All', subpop 'All' (meta.sys_returns).
 *  - Heatmap: Clients, M5_FirstTime, M1a_AvgLOS_ESSTH, M7b1_PHRate, M7a_Rate,
 *    M7b2_Rate, 2-yr return rate (Σ Returns2yr / Σ TotalPHExits per subpop).
 */

import { useRouter } from 'next/navigation';
import type { Granularity } from '../../../lib/types';
import { HOUSEHOLD_OPTIONS } from '../../../lib/types';
import type { SystemCombo, ReturnsBucket } from '../../../lib/queries';
import { periodLabel } from '../../../lib/format';

type SysRec = Record<string, number | null>;

type Props = {
  periods: string[];
  granularity: Granularity;
  period: string;
  household: string;
  combos: SystemCombo[];
  monthlyAll: Record<string, SysRec>;
  sysReturns: Record<string, Record<string, ReturnsBucket>>;
};

const ICON_PATHS: Record<string, string> = {
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>',
  in: '<path d="M12 5v14M5 12l7 7 7-7"/>',
  tent: '<path d="M3 20h18M12 4 4 20M12 4l8 16M12 4v16"/>',
  spark: '<path d="M3 17l5-6 4 3 5-7"/><path d="M3 21h18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  home: '<path d="M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5"/>',
  key: '<circle cx="7.5" cy="15.5" r="4"/><path d="M10.5 12.5 20 3M16 7l3 3"/>',
  star: '<path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9 6.8 19.2l1-5.8L3.5 9.2l5.9-.9z"/>',
  ret: '<path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/>',
  pct: '<path d="M19 5 5 19M6.5 6.5h.01M17.5 17.5h.01"/>',
};

const Icon = ({ name }: { name: string }) => (
  <span className="ic" dangerouslySetInnerHTML={{
    __html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ''}</svg>`,
  }} />
);

const bHi = (v: number) => (v >= 75 ? 'var(--accent)' : v >= 50 ? 'var(--warn)' : v >= 30 ? 'var(--mid)' : 'var(--danger)');
const bLo = (v: number) => (v <= 15 ? 'var(--accent)' : v <= 25 ? 'var(--warn)' : v <= 35 ? 'var(--mid)' : 'var(--danger)');
const hmHi = (v: number | null) => (v == null ? 'var(--track)' : v >= 75 ? 'var(--accent)' : v >= 50 ? 'var(--warn)' : v >= 35 ? 'var(--mid)' : 'var(--danger)');
const hmLo = (v: number | null) => (v == null ? 'var(--track)' : v <= 15 ? 'var(--accent)' : v <= 25 ? 'var(--warn)' : v <= 35 ? 'var(--mid)' : 'var(--danger)');
const fmt = (n: number) => n.toLocaleString();
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

type Row = { n: string; of: string; v: number; pct?: boolean; max?: number };
type Card = {
  icon: string; tag: string; title: string; vlabel: string;
  val: number | null; suf?: string; avg?: number | null; prev?: number | null;
  deltaMode?: 'pct' | 'pts' | 'abs'; deltaUnit?: string; deltaText?: string;
  target?: number | null; tgtL?: string; scale?: number; lowerBetter?: boolean;
  gl: string; gr: string; secTitle?: string; rows?: Row[]; rowsLowerBetter?: boolean;
};

function Gauge({ valP, avgP, tgtP, avgL, tgtL }: { valP: number; avgP: number; tgtP: number | null; avgL: string; tgtL: string }) {
  const v = clamp(valP, 2, 100);
  const a = clamp(avgP, 0, 100);
  return (
    <div className="gt">
      <div className="gf" style={{ width: `${v.toFixed(0)}%` }} />
      <div className="gm" style={{ left: `${a.toFixed(0)}%` }}><span className="gd">{avgL}</span></div>
      {tgtP != null && (
        <div className="gm tg" style={{ left: `${Math.min(100, tgtP).toFixed(0)}%` }}><span className="gd">{tgtL}</span></div>
      )}
    </div>
  );
}

function CardView({ c }: { c: Card }) {
  if (c.val == null) return null;
  const isPct = c.suf === '%';
  let d: number | null = null;
  if (c.prev != null) {
    if (c.deltaMode === 'pts') d = +(c.val - c.prev).toFixed(1);
    else if (c.deltaMode === 'abs') d = Math.round(c.val - c.prev);
    else d = c.prev !== 0 ? Math.round(((c.val - c.prev) / c.prev) * 100) : null;
  }
  const dgood = d == null ? null : c.lowerBetter ? d < 0 : d > 0;
  const scale = c.scale || (isPct ? 100 : Math.max(c.val, c.avg || 0) * 1.35 || 10);
  const avgL = 'avg ' + (c.avg != null ? (isPct ? c.avg.toFixed(1) + '%' : Math.round(c.avg).toLocaleString()) : '—');
  const tgtL = c.tgtL || (c.target != null ? 'target ' + c.target + (isPct ? '%' : '') : '');

  return (
    <div className="pcard">
      <div className="pc-head">
        <div className="pc-title"><Icon name={c.icon} /><span>{c.title}</span></div>
        <span className="pc-tag">{c.tag}</span>
      </div>
      <div className="pc-body">
        <div className="pc-metric">
          <div>
            <div className="pc-vlabel">{c.vlabel}</div>
            <div className="pc-val">{isPct ? c.val : fmt(c.val)}<span className="suf">{c.suf || ''}</span></div>
            {d != null && (
              <div className={`pc-delta ${dgood ? 'good' : 'bad'}`}>
                {d < 0 ? '▼' : '▲'} {Math.abs(d)}{c.deltaUnit || '%'} <span className="mut">{c.deltaText || 'vs prior'}</span>
              </div>
            )}
          </div>
          <div className="pc-gauge">
            <Gauge valP={(c.val / scale) * 100} avgP={((c.avg || 0) / scale) * 100} tgtP={c.target != null ? (c.target / scale) * 100 : null} avgL={avgL} tgtL={tgtL} />
            <div className="gl"><span>{c.gl}</span><span dangerouslySetInnerHTML={{ __html: c.gr }} /></div>
          </div>
        </div>
        {c.rows && c.rows.length > 0 && (
          <div className="pc-sec">
            <h4>{c.secTitle}</h4>
            {c.rows.map((r, i) => {
              let w: number, col: string, disp: string;
              if (r.pct) { w = Math.round(r.v); col = c.rowsLowerBetter ? bLo(r.v) : bHi(r.v); disp = r.v + '%'; }
              else { w = r.max ? Math.round((r.v / r.max) * 100) : 0; col = 'var(--primary)'; disp = r.v.toLocaleString(); }
              return (
                <div className="brow" key={i}>
                  <span className="bnm">{r.n}<br /><span className="bsub">{r.of}</span></span>
                  <span className="bmini"><i style={{ width: `${w}%`, background: col }} /></span>
                  <span className="bvl">{disp}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function SpmView({ periods, granularity, period, household, combos, monthlyAll, sysReturns }: Props) {
  const router = useRouter();

  const byKey: Record<string, SysRec> = {};
  combos.forEach((c) => { byKey[`${c.household_type}|${c.subpopulation}`] = c.data as SysRec; });
  const e = byKey[`${household}|All`] || byKey['All|All'];

  // 12-month trailing window + prior period, both on the All|All MONTHLY series.
  const mk = Object.keys(monthlyAll).filter((k) => /^\d{4}-\d{2}$/.test(k)).sort();
  const idx = mk.indexOf(period);
  const recent = idx < 0 ? mk.slice(-12) : mk.slice(Math.max(0, idx - 11), idx + 1);
  const prev = idx > 0 ? monthlyAll[mk[idx - 1]] : null;
  const avgOf = (f: string): number | null => {
    const vs = recent.map((k) => monthlyAll[k]?.[f]).filter((v): v is number => v != null);
    return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
  };

  function navigate(patch: Partial<{ g: string; p: string; hh: string }>) {
    const sp = new URLSearchParams();
    sp.set('g', patch.g ?? granularity);
    if (!('g' in patch) || patch.g === granularity) sp.set('p', patch.p ?? period);
    sp.set('hh', patch.hh ?? household);
    router.push(`/dashboard/system?${sp.toString()}`);
  }

  if (!e) {
    return <div className="panel"><div className="empty">No SPM data for this period.</div></div>;
  }

  // ── Returns (M2) at household 'All', subpop 'All' ──
  const rb = sysReturns[period]?.['All'];
  const rExit = rb?.exits || 0;
  const rate = (v: number) => (rExit > 0 ? +((v / rExit) * 100).toFixed(1) : 0);
  const ret24 = rExit > 0 && rb ? +((rb.r2 / rExit) * 100).toFixed(1) : null;
  const ret24avg = (() => {
    const xs = recent.map((k) => {
      const b = sysReturns[k]?.['All'];
      return b && b.exits > 0 ? (b.r2 / b.exits) * 100 : null;
    }).filter((v): v is number => v != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  })();

  const num = (f: string) => (e[f] ?? null);

  const groups: [string, Card[]][] = [
    ['Population & inflow', [
      { icon: 'users', tag: 'System', title: 'Full system clients', vlabel: 'All project types · dedup', val: num('Clients'), avg: avgOf('Clients'), prev: prev?.Clients, deltaMode: 'pct', gl: 'unduplicated', gr: '<b>this period</b>' },
      { icon: 'users', tag: 'Universe', title: 'SPM clients', vlabel: 'SO/ES/SH/TH/RRH/PSH', val: num('SPM_Clients'), avg: avgOf('SPM_Clients'), prev: prev?.SPM_Clients, deltaMode: 'pct', gl: 'SPM universe', gr: '<b>core</b> universe' },
      { icon: 'in', tag: 'M3.2', title: 'System inflow', vlabel: 'New enrollments this period', val: num('Inflow'), avg: avgOf('Inflow'), prev: prev?.Inflow, deltaMode: 'pct', gl: 'entries', gr: '<b>new</b> this period' },
      { icon: 'tent', tag: 'M3', title: 'Shelter clients', vlabel: 'ES + SH + TH · dedup', val: num('M3_Total'), avg: avgOf('M3_Total'), prev: prev?.M3_Total, deltaMode: 'pct', gl: 'sheltered', gr: `<b>${(num('M3_Total') || 0).toLocaleString()}</b> clients`, secTitle: 'By shelter type', rows: [
        { n: 'Emergency shelter', of: 'ES (0/1)', v: num('M3_ES') || 0, max: num('M3_Total') || 0 },
        { n: 'Transitional housing', of: 'TH (2)', v: num('M3_TH') || 0, max: num('M3_Total') || 0 },
        { n: 'Safe Haven', of: 'SH (8)', v: num('M3_SH') || 0, max: num('M3_Total') || 0 },
      ] },
      (() => { const ft = num('M5_FirstTime') || 0, ne = num('M5_NewEntries') || 0, reE = Math.max(0, ne - ft);
        return { icon: 'spark', tag: 'M5', title: 'First-time homeless', vlabel: 'No prior 24-mo enrollment', val: num('M5_FirstTime'), avg: avgOf('M5_FirstTime'), prev: prev?.M5_FirstTime, deltaMode: 'pct', lowerBetter: true, gl: 'first-time', gr: ne > 0 ? `<b>${Math.round(ft / ne * 100)}%</b> of ${ne.toLocaleString()} entries` : '—', secTitle: 'Entries into the system', rows: [
          { n: 'First-time homeless', of: 'no prior history', v: ft, max: ne },
          { n: 'Re-entering', of: 'returning / inactive', v: reE, max: ne },
        ] } as Card; })(),
    ]],
    ['Length of time homeless (M1a)', [
      { icon: 'clock', tag: 'M1a', title: 'Avg length of stay', vlabel: 'ES + SH + TH days', val: num('M1a_AvgLOS_ESSTH') != null ? Math.round(num('M1a_AvgLOS_ESSTH')!) : null, avg: avgOf('M1a_AvgLOS_ESSTH'), prev: prev?.M1a_AvgLOS_ESSTH != null ? Math.round(prev!.M1a_AvgLOS_ESSTH!) : null, deltaMode: 'abs', deltaUnit: 'd', lowerBetter: true, gl: 'days (mean)', gr: '<b>shelter</b> stay' },
      { icon: 'clock', tag: 'M1a', title: 'Median length of stay', vlabel: 'ES + SH + TH days', val: num('M1a_MedLOS_ESSTH') != null ? Math.round(num('M1a_MedLOS_ESSTH')!) : null, avg: avgOf('M1a_MedLOS_ESSTH'), prev: prev?.M1a_MedLOS_ESSTH != null ? Math.round(prev!.M1a_MedLOS_ESSTH!) : null, deltaMode: 'abs', deltaUnit: 'd', lowerBetter: true, gl: 'days (median)', gr: '<b>shelter</b> stay' },
    ]],
    ['Outreach', [
      { icon: 'flag', tag: 'Q9b', title: 'SO engagements', vlabel: 'Unduplicated clients', val: num('M_SOEngagements'), avg: avgOf('M_SOEngagements'), prev: prev?.M_SOEngagements, deltaMode: 'pct', gl: 'engagements', gr: '<b>street outreach</b>' },
    ]],
    ['Placements & retention (M7)', [
      { icon: 'home', tag: 'M7', title: 'Total PH exits', vlabel: 'SO/ES/TH/SH/PSH/RRH → PH', val: num('M_AllPHExits'), avg: avgOf('M_AllPHExits'), prev: prev?.M_AllPHExits, deltaMode: 'pct', gl: 'to permanent housing', gr: `<b>${(num('M_AllPHExits') || 0).toLocaleString()}</b> clients` },
      { icon: 'home', tag: '7b.1', title: '7b.1 PH exits', vlabel: 'ES/TH/SH/RRH leavers → PH', val: num('M7b1_PHExits'), avg: avgOf('M7b1_PHExits'), prev: prev?.M7b1_PHExits, deltaMode: 'pct', gl: `of ${num('M7b1_Denom') || 0} leavers`, gr: `<b>${num('M7b1_PHExits') || 0}</b> exits` },
      { icon: 'pct', tag: '7b.1', title: '7b.1 PH exit rate', vlabel: 'ES/TH/SH/RRH leavers → PH', val: num('M7b1_PHRate'), suf: '%', avg: avgOf('M7b1_PHRate'), prev: prev?.M7b1_PHRate, deltaMode: 'pts', deltaUnit: 'pts', target: 50, gl: 'PH exit rate', gr: `<b>${num('M7b1_PHExits') || 0}</b> of ${num('M7b1_Denom') || 0}` },
      { icon: 'key', tag: '7b.1', title: '7b.1 unsubsidized rate', vlabel: 'ES/TH/SH/RRH → own income', val: num('M7b1_UnsubRate'), suf: '%', avg: avgOf('M7b1_UnsubRate'), prev: prev?.M7b1_UnsubRate, deltaMode: 'pts', deltaUnit: 'pts', gl: 'unsubsidized', gr: `<b>${num('M7b1_UnsubExits') || 0}</b> of ${num('M7b1_Denom') || 0}` },
      { icon: 'flag', tag: '7a.1', title: '7a SO success rate', vlabel: 'SO leavers → positive dest.', val: num('M7a_Rate'), suf: '%', avg: avgOf('M7a_Rate'), prev: prev?.M7a_Rate, deltaMode: 'pts', deltaUnit: 'pts', gl: 'positive exits', gr: `<b>${num('M7a_Positive') || 0}</b> of ${num('M7a_Denom') || 0}` },
      { icon: 'star', tag: '7b.2', title: '7b.2 PH retention', vlabel: 'PSH/PH-HO/HwS w/ move-in', val: num('M7b2_Rate'), suf: '%', avg: avgOf('M7b2_Rate'), prev: prev?.M7b2_Rate, deltaMode: 'pts', deltaUnit: 'pts', target: 95, gl: 'stayed / re-housed', gr: `<b>${(num('M7b2_Retained') || 0).toLocaleString()}</b> of ${(num('M7b2_Universe') || 0).toLocaleString()}` },
    ]],
    ['Returns to homelessness (M2)', [
      { icon: 'ret', tag: 'M2', title: 'Return rate < 6 mo', vlabel: 'Within 180 days of PH exit', val: rb ? rate(rb.lt6) : null, suf: '%', scale: 40, target: 20, tgtL: 'flag 20%', lowerBetter: true, gl: 'early returns', gr: `<b>${(rb?.lt6 || 0).toLocaleString()}</b> returns` },
      { icon: 'ret', tag: 'M2', title: '2-yr return rate', vlabel: 'Within 2 years of PH exit', val: ret24, avg: ret24avg, suf: '%', scale: 40, target: 20, tgtL: 'flag 20%', lowerBetter: true, gl: '2-yr return rate', gr: `<b>${(rb?.r2 || 0).toLocaleString()}</b> of ${rExit.toLocaleString()}`, secTitle: 'By time since exit', rowsLowerBetter: true, rows: rb ? [
        { n: 'Within 6 months', of: `${rb.lt6.toLocaleString()} returns`, v: rate(rb.lt6), pct: true },
        { n: '6–12 months', of: `${rb.r6.toLocaleString()} returns`, v: rate(rb.r6), pct: true },
        { n: '13–24 months', of: `${rb.r13.toLocaleString()} returns`, v: rate(rb.r13), pct: true },
      ] : [] },
    ]],
  ];

  // ── Heatmap ──
  const subs: [string, string][] = [
    ['All clients', 'All'], ['Chronic', 'Chronic'], ['Disabled', 'Disabled'],
    ['Elderly 65+', 'Elderly 65+'], ['Youth (18–24)', 'Youth (18-24)'],
    ['Unaccompanied Youth', 'Unaccompanied Youth'], ['Parenting Youth', 'Parenting Youth'],
  ];
  const hmRows = subs.map(([lbl, key]) => {
    const r = byKey[`All|${key}`];
    if (!r) return null;
    const b = sysReturns[period]?.[key];
    const ret2 = b && b.exits > 0 ? +((b.r2 / b.exits) * 100).toFixed(1) : null;
    return { lbl, r, ret2 };
  }).filter(Boolean) as { lbl: string; r: SysRec; ret2: number | null }[];

  return (
    <>
      <div className="fbar">
        <div className="frow">
          <div className="fgroup">
            <span className="flabel">View by</span>
            <div className="seg">
              {(['monthly', 'quarterly', 'fiscal'] as Granularity[]).map((g) => (
                <button key={g} className={granularity === g ? 'on' : ''} onClick={() => navigate({ g })}>
                  {g === 'monthly' ? 'Monthly' : g === 'quarterly' ? 'Quarterly' : 'Fiscal Year'}
                </button>
              ))}
            </div>
          </div>
          <div className="fgroup">
            <span className="flabel">Report period</span>
            <select className="fselect" value={period} onChange={(ev) => navigate({ p: ev.target.value })}>
              {periods.map((p) => <option key={p} value={p}>{periodLabel(p)}</option>)}
            </select>
          </div>
          <div className="fgroup">
            <span className="flabel">Household type</span>
            <select className="fselect" value={household} onChange={(ev) => navigate({ hh: ev.target.value })}>
              {HOUSEHOLD_OPTIONS.map((h) => <option key={h} value={h}>{h === 'All' ? 'All households' : h}</option>)}
            </select>
          </div>
        </div>
      </div>

      {groups.map(([label, cards]) => (
        <div key={label}>
          <div className="grouplabel">{label}</div>
          <div className="spmgrid">
            {cards.map((c, i) => <CardView key={i} c={c} />)}
          </div>
        </div>
      ))}

      <div className="grouplabel">Subpopulation breakdown</div>
      <div className="hm-wrap">
        <div className="hm-h">
          <div><h3>Performance by subpopulation</h3><div className="meta">Color = performance band · returns &amp; LOS: lower is better</div></div>
        </div>
        <div className="scroll">
          <table className="hm">
            <thead>
              <tr>
                <th>Subpopulation</th><th>Clients</th><th>First-time (M5)</th><th>Avg LOS (M1a)</th>
                <th>PH exit % (7b.1)</th><th>SO success % (7a)</th><th>Retention % (7b.2)</th><th>Returns 2yr % (M2)</th>
              </tr>
            </thead>
            <tbody>
              {hmRows.map(({ lbl, r, ret2 }) => {
                const los = r.M1a_AvgLOS_ESSTH != null ? `${Math.round(r.M1a_AvgLOS_ESSTH)}d` : '—';
                const cell = (v: number | null) => (
                  <td><span className="cell" style={{ background: hmHi(v) }}>{v != null ? `${v}%` : '—'}</span></td>
                );
                return (
                  <tr key={lbl}>
                    <td>{lbl}</td>
                    <td>{r.Clients != null ? r.Clients.toLocaleString() : '—'}</td>
                    <td>{r.M5_FirstTime != null ? r.M5_FirstTime : '—'}</td>
                    <td>{los}</td>
                    {cell(r.M7b1_PHRate)}
                    {cell(r.M7a_Rate)}
                    {cell(r.M7b2_Rate)}
                    <td><span className="cell" style={{ background: hmLo(ret2) }}>{ret2 != null ? `${ret2}%` : '—'}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="leg">
          <span><i style={{ background: 'var(--accent)' }} />strong</span>
          <span><i style={{ background: 'var(--warn)' }} />moderate</span>
          <span><i style={{ background: 'var(--mid)' }} />watch</span>
          <span><i style={{ background: 'var(--danger)' }} />low</span>
        </div>
      </div>
    </>
  );
}
