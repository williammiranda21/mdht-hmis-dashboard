'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { InterventionIntel, IvxDriver, IvxPathway } from '../../../lib/queries';
import { IconDownload } from '../../../components/icons';
import { CopyId, fmt } from './shared';

/**
 * Intervention Guide (2026-09-25) — ADDITIVE to the Housing Predictor / Return
 * Risk / Pathways sections (none of them are changed). Two questions per client:
 *   1. Will this client succeed?        P(stably housed) on today's typical path
 *   2. Which option works better?       P(stably housed) under RRH / PSH / TH,
 *                                        with ranges, overlap, similar clients
 * plus a risk-adjusted pathway table. Model card data = meta.intervention_intel;
 * clients = /api/analytics/intervention (drill `an:ivx`, agency-scoped by RLS).
 *
 * Framing is deliberate: the success prediction is validated on held-out years;
 * per-client program MATCHING is not (see the backtest), so every comparison is
 * labeled exploratory decision support for case conferencing, never assignment.
 */

type Opt = [number, number, number, number, number, number, number];
type Sim = [number, number, number, number | null, number | null, number] | null;
interface Row {
  pid: string; project_id: number; project: string; state: string; days: number; minor: number;
  p: number; p_lo: number; p_hi: number; best: string | null; verdict: string; best_p: number | null;
}
interface Detail {
  pid: string; project: string; state: string; start: string; days: number; hh: number; minor: number;
  inc: number | null; fmr: number; gap: number; p: number; p_lo: number; p_hi: number;
  opt: Record<string, Opt>; sim: Record<string, Sim>; best: string | null; verdict: string;
  why: [string, number][]; path_now: string; paths: [string, number, number, number | null][];
  spdat?: [number, number, string] | null;
}

const STATE_COLOR: Record<string, string> = {
  SO: '#f59e0b', ES: '#3b82f6', SH: '#06b6d4', TH: '#8b5cf6', RRH: '#f97316', PSH: '#10b981', NONE: '#94a3b8',
};
const VERDICT: Record<string, { label: string; tip: string }> = {
  clear: { label: 'Clear difference', tip: 'The top program beats the next one in at least 95% of model re-fits.' },
  lean: { label: 'Leans one way', tip: 'The top program wins in most model re-fits (70%+), but the ranges overlap.' },
  similar: { label: 'About the same', tip: 'Programs estimate within each other’s uncertainty — use case judgment.' },
  insufficient: { label: 'Not enough evidence', tip: 'Fewer than two programs have enough similar past clients to compare.' },
};
const pct = (v: number | null | undefined, d = 0) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const pts = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)} pts`;
const money = (v: number | null | undefined) => (v == null ? 'not recorded' : `$${Math.round(v).toLocaleString()}`);

type View = 'caseload' | 'pathways' | 'works' | 'evidence';
const VIEWS: [View, string][] = [
  ['caseload', 'Caseload'], ['pathways', 'Pathways'], ['works', 'What works'], ['evidence', 'Model & evidence'],
];

export function InterventionSection({ iv, initialPid = null }: { iv: InterventionIntel; initialPid?: string | null }) {
  const [view, setView] = useState<View>('caseload');
  const m = iv.model;
  const bt = m.backtest;
  const two = bt.rrh_psh_only;
  return (
    <>
      <div className="panel" style={{ padding: '12px 16px', marginBottom: 12, borderLeft: '4px solid var(--warn)' }}>
        <div style={{ fontSize: 13.5, fontWeight: 700 }}>Exploratory decision support — for case conferencing, not assignment</div>
        <p className="bnl-sub" style={{ marginTop: 5, lineHeight: 1.55 }}>
          <b>Will the client succeed?</b> Validated on held-out {bt.split.slice(0, 4)}+ episodes (accuracy AUC{' '}
          {['RRH', 'PSH', 'TH', 'NONE'].map((a) => `${a === 'NONE' ? 'shelter-only' : a} ${bt.auc[a]?.success?.toFixed(2)}`).join(' · ')}).{' '}
          <b>Which option works better?</b> Average differences are clear, but matching an individual client to RRH vs PSH is
          {' '}<b>not yet shown to beat current practice</b>
          {two ? <> (backtest {pts(two.lift)}, range {pts(two.lift_ci[0])} to {pts(two.lift_ci[1])})</> : null}.
          TH comparisons are partly definitional (TH success needs a PH exit; RRH/PSH count a move-in).
          Trained on {fmt(m.n_train)} episodes ({m.train_from.slice(0, 4)}–{m.train_to.slice(0, 4)}); caseload as of {iv.as_of}.
        </p>
      </div>
      <div className="seg" role="tablist" aria-label="Intervention guide views" style={{ marginBottom: 12 }}>
        {VIEWS.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k}
            className={view === k ? 'on' : undefined} onClick={() => setView(k)}>{l}</button>
        ))}
      </div>
      {view === 'caseload' && <Caseload iv={iv} initialPid={initialPid} />}
      {view === 'pathways' && <PathwayTable rows={m.pathways} />}
      {view === 'works' && <WhatWorks iv={iv} />}
      {view === 'evidence' && <Evidence iv={iv} />}
    </>
  );
}

/* ── Caseload + dossier ─────────────────────────────────────────────────── */

function Caseload({ iv, initialPid }: { iv: InterventionIntel; initialPid: string | null }) {
  const [data, setData] = useState<{ asOf: string | null; scoped: boolean; rows: Row[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState(initialPid ?? '');
  const [verdict, setVerdict] = useState('');
  const [best, setBest] = useState('');
  const [hh, setHh] = useState('');
  const [page, setPage] = useState(1);
  const [dossier, setDossier] = useState<Detail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Clicking View deep in the list must bring the dossier (rendered above the
  // table) into view — user 2026-09-25: "it stays in the same spot".
  const dossierRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (dossier) dossierRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [dossier]);

  useEffect(() => {
    fetch('/api/analytics/intervention').then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setData).catch((e) => setErr(String(e)));
  }, []);
  const open = (pid: string) => {
    setBusy(pid);
    fetch(`/api/analytics/intervention?pid=${encodeURIComponent(pid)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j) => { setDossier(j.client ?? null); setBusy(null); })
      .catch(() => setBusy(null));
  };
  useEffect(() => { if (initialPid) open(initialPid); }, [initialPid]);

  const rows = useMemo(() => (data?.rows ?? []).filter((r) =>
    (!q || r.pid.toLowerCase().includes(q.toLowerCase()) || r.project.toLowerCase().includes(q.toLowerCase()))
    && (!verdict || r.verdict === verdict) && (!best || r.best === best)
    && (!hh || (hh === 'family' ? r.minor : !r.minor))), [data, q, verdict, best, hh]);
  useEffect(() => setPage(1), [q, verdict, best, hh]);
  const PER = 50;
  const pages = Math.max(1, Math.ceil(rows.length / PER));
  const pageRows = rows.slice((page - 1) * PER, page * PER);

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <input className="finput" placeholder="Client ID or program…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="fselect" value={verdict} onChange={(e) => setVerdict(e.target.value)}>
          <option value="">All evidence levels</option>
          {Object.entries(VERDICT).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select className="fselect" value={best} onChange={(e) => setBest(e.target.value)}>
          <option value="">Any best-fit program</option>
          {iv.model.programs.map((a) => <option key={a} value={a}>{iv.model.arm_labels[a]}</option>)}
        </select>
        <select className="fselect" value={hh} onChange={(e) => setHh(e.target.value)}>
          <option value="">All households</option>
          <option value="adult">Adult only</option>
          <option value="family">With children</option>
        </select>
        <a className="btn" href="/api/analytics/intervention?format=csv"><IconDownload size={12} /> Export CSV</a>
      </div>

      <div ref={dossierRef} style={{ scrollMarginTop: 72 }}>
        {dossier && <Dossier c={dossier} iv={iv} onClose={() => setDossier(null)} />}
      </div>

      <div className="panel" style={{ padding: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>Active heads of household — lowest chance of success first</span>
          <span className="bnl-sub">
            {data ? <>{fmt(rows.length)} clients{data.scoped && <> · <b>your agency&rsquo;s projects only</b></>}{data.asOf ? ` · ${data.asOf}` : ''}</>
              : err ? `couldn't load (${err})` : 'loading…'}
          </span>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Client ID</th><th>Program now</th><th>Type</th>
                <th className="num">Days in episode</th>
                <th style={{ minWidth: 170 }} title="Chance of being stably housed on the path clients like this typically take">Success, typical path</th>
                <th>Best-fit program</th><th>Evidence</th><th />
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => (
                <tr key={`${r.pid}-${r.project_id}`}>
                  <td><CopyId id={r.pid} /></td>
                  <td style={{ maxWidth: 230, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.project}>{r.project}</td>
                  <td>{r.state}</td>
                  <td className="num">{fmt(r.days)}</td>
                  <td><RangeBar p={r.p} lo={r.p_lo} hi={r.p_hi} /></td>
                  <td>{r.best ? <Chip s={r.best} /> : '—'}{r.best_p != null && <span className="bnl-sub num" style={{ marginLeft: 6 }}>{pct(r.best_p)}</span>}</td>
                  <td title={VERDICT[r.verdict]?.tip}><span className="bnl-sub">{VERDICT[r.verdict]?.label ?? r.verdict}</span></td>
                  <td>
                    <button type="button" className="tbtn" onClick={() => open(r.pid)} disabled={busy === r.pid}>
                      {busy === r.pid ? '…' : 'View'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
            <button type="button" className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Prev</button>
            <span className="bnl-sub">Page {page} of {pages}</span>
            <button type="button" className="btn" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next →</button>
          </div>
        )}
      </div>
    </>
  );
}

function Dossier({ c, iv, onClose }: { c: Detail; iv: InterventionIntel; onClose: () => void }) {
  const m = iv.model;
  const opts = [...m.programs, 'NONE'];
  const bestOpt = c.best ? c.opt[c.best] : null;
  const runner = c.best
    ? m.programs.filter((a) => a !== c.best && c.opt[a]?.[3]).sort((a, b) => c.opt[b][0] - c.opt[a][0])[0]
    : null;
  const verdictLine = (() => {
    if (!c.best || c.verdict === 'insufficient') return 'Too few similar past clients received more than one program to compare options for this client.';
    const bl = m.arm_labels[c.best];
    const gap = runner ? c.opt[c.best][0] - c.opt[runner][0] : 0;
    if (c.verdict === 'clear') return `${bl} has the strongest estimate — ${pts(gap)} ahead of ${m.arm_labels[runner!] ?? 'the next option'} in at least 95% of model re-fits.`;
    if (c.verdict === 'lean') return `${bl} leans ahead (${pts(gap)} over ${m.arm_labels[runner!]}), but the ranges overlap — treat as a tiebreaker, not a verdict.`;
    return `The programs estimate within each other’s uncertainty for this client — case judgment and availability should decide.`;
  })();
  const pn = c.path_now;
  return (
    <div className="panel" style={{ padding: '14px 18px', marginBottom: 14, borderLeft: '4px solid var(--primary)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 800 }}><CopyId id={c.pid} /></span>
            <Chip s={c.state} />
          </div>
          <div className="bnl-sub" style={{ marginTop: 4 }}>
            {c.project} · episode began {c.start} ({fmt(c.days)} days) · {c.minor ? `family of ${c.hh}` : c.hh > 1 ? `household of ${c.hh}` : 'single adult'}
            {' '}· path so far: <PathChips path={pn} />
          </div>
          <div className="bnl-sub" style={{ marginTop: 3 }}>
            {c.spdat
              ? <>CE assessment (SPDAT) {c.spdat[2]}: <b>{Math.round(c.spdat[0] * 100)}% of max score</b>{c.spdat[1] ? ' · high acuity' : ''} — used in the estimates</>
              : <>No CE assessment (SPDAT) on file — estimates use HMIS data only</>}
          </div>
        </div>
        <button type="button" className="tbtn" onClick={onClose}>✕ Close</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginTop: 14 }}>
        <div className="hc-t" style={{ padding: '12px 14px' }}>
          <div className="k">Will this client succeed?</div>
          <div className="v">{pct(c.p)}</div>
          <div className="s">
            chance of being stably housed (housed within 18 months, no return for 12) on the path clients like this
            typically take · range {pct(c.p_lo)}–{pct(c.p_hi)}
          </div>
        </div>
        <div className="hc-t" style={{ padding: '12px 14px' }}>
          <div className="k">Which option works better?</div>
          <div className="v" style={{ fontSize: 17 }}>{c.best ? m.arm_labels[c.best] : '—'}{bestOpt && <span className="num" style={{ marginLeft: 8 }}>{pct(bestOpt[0])}</span>}</div>
          <div className="s">{verdictLine}</div>
        </div>
        <div className="hc-t" style={{ padding: '12px 14px' }}>
          <div className="k">Rent gap</div>
          <div className="v">{money(c.gap)}<span className="bnl-sub" style={{ fontSize: 11, marginLeft: 6 }}>/mo</span></div>
          <div className="s">Fair Market Rent for this household {money(c.fmr)} − monthly income at entry {money(c.inc)}.
            The bigger the gap, the harder rent is to carry once a subsidy ends.</div>
        </div>
      </div>

      <div className="grouplabel" style={{ marginTop: 18 }}>Each option for this client</div>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Option</th>
              <th style={{ minWidth: 190 }} title="Model estimate with the 90% range across 40 re-fits">Model estimate (range)</th>
              <th className="num" title="Chance the option gets the client housed">Gets housed</th>
              <th className="num" title="Chance of no return within 12 months, once housed">Stays housed</th>
              <th title="The 50 most similar past clients (same family status) who got this option — observed, no model">Similar past clients</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {opts.map((a) => {
              const o = c.opt[a]; const s = c.sim[a];
              if (!o) return null;
              const isBest = a === c.best;
              return (
                <tr key={a} style={isBest ? { background: 'var(--primary-soft)' } : undefined}>
                  <td><Chip s={a} /> <span style={{ marginLeft: 6, fontWeight: isBest ? 700 : 500 }}>{m.arm_labels[a]}</span>
                    {a === 'NONE' && <span className="bnl-sub"> · baseline</span>}</td>
                  <td><RangeBar p={o[0]} lo={o[1]} hi={o[2]} /></td>
                  <td className="num">{pct(o[5])}</td>
                  <td className="num">{pct(o[6])}</td>
                  <td className="num" style={{ fontSize: 12 }}>
                    {s ? <>{pct(s[1])} succeeded · {pct(s[3])} returned · {s[4] != null ? `${s[4]}d to housing` : '—'}
                      <span className="bnl-sub"> (n={s[0]})</span></> : '—'}
                  </td>
                  <td className="bnl-sub" style={{ fontSize: 11.5 }}>
                    {a === 'NONE' ? 'baseline, never a recommendation'
                      : !o[3] ? 'few clients like this got it — not compared'
                        : `best in ${Math.round(o[4] * 100)}% of re-fits`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginTop: 16 }}>
        <div>
          <div className="grouplabel" style={{ marginTop: 0 }}>Pathways similar clients took</div>
          {c.paths.length === 0 ? <p className="bnl-sub">Not enough similar clients shared a pathway.</p> : (
            <table>
              <thead><tr><th>Pathway</th><th className="num">Clients</th><th className="num">Succeeded</th><th className="num">Days to housing</th></tr></thead>
              <tbody>
                {c.paths.map(([p, n, sr, d]) => {
                  const cont = pn && p.startsWith(pn) && p !== pn;
                  return (
                    <tr key={p}>
                      <td><PathChips path={p} />{cont && <span className="bnl-sub" title="Begins the way this client's episode has gone so far"> · continues their path</span>}</td>
                      <td className="num">{n}</td>
                      <td className="num">{pct(sr)}</td>
                      <td className="num">{d ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="bnl-sub" style={{ marginTop: 6 }}>From the 200 most similar past clients; routes with 8+ clients.</p>
        </div>
        <div>
          <div className="grouplabel" style={{ marginTop: 0 }}>What moves the estimate {c.best ? `under ${c.best}` : ''}</div>
          {c.why.length === 0 ? <p className="bnl-sub">No single characteristic stands out.</p> : c.why.map(([f, v]) => (
            <div key={f} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 8px', margin: '3px 0', borderRadius: 6,
              background: v > 0 ? 'var(--accent-light)' : 'var(--danger-light)' }}>
              <span>{m.feature_labels[f] ?? f}</span>
              <b style={{ color: v > 0 ? 'var(--accent)' : 'var(--danger)' }}>{v > 0 ? '↑ raises' : '↓ lowers'}</b>
            </div>
          ))}
          <p className="bnl-sub" style={{ marginTop: 6 }}>Relative to the average client in the training data.</p>
        </div>
      </div>
    </div>
  );
}

/* ── Pathways ───────────────────────────────────────────────────────────── */

function PathwayTable({ rows }: { rows: IvxPathway[] }) {
  const [sort, setSort] = useState<'adjusted' | 'n' | 'success'>('adjusted');
  const [housingOnly, setHousingOnly] = useState(false);
  const shown = useMemo(() => rows
    .filter((r) => !housingOnly || ['RRH', 'PSH', 'TH'].includes(r.ends_in) || r.path.includes('RRH') || r.path.includes('PSH'))
    .slice().sort((a, b) => (b[sort] as number) - (a[sort] as number)), [rows, sort, housingOnly]);
  const maxAbs = Math.max(0.05, ...rows.map((r) => Math.max(Math.abs(r.adj_ci[0]), Math.abs(r.adj_ci[1]))));
  return (
    <div className="panel" style={{ padding: '12px 16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>Which pathways work better — adjusted for who takes them</div>
          <p className="bnl-sub" style={{ marginTop: 4, maxWidth: '80ch' }}>
            <b>Expected</b> is what clients like these would achieve on the typical path, from their characteristics at the start
            of the episode. <b>Better / worse than expected</b> separates a genuinely better route from one that simply serves
            easier clients. Episodes {''}2014–2023, 75+ clients per route.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="fselect" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="adjusted">Best vs expected first</option>
            <option value="success">Highest success first</option>
            <option value="n">Most common first</option>
          </select>
          <label className="switch" style={{ paddingBottom: 0 }}>
            <input type="checkbox" checked={housingOnly} onChange={(e) => setHousingOnly(e.target.checked)} style={{ display: 'none' }} />
            <span className="tk" style={{ background: housingOnly ? 'var(--primary)' : 'var(--border-strong)' }} />
            Routes through a housing program
          </label>
        </div>
      </div>
      <div className="scroll" style={{ marginTop: 10 }}>
        <table>
          <thead>
            <tr>
              <th>Pathway</th><th className="num">Clients</th><th className="num">Success</th><th className="num">Expected</th>
              <th style={{ minWidth: 190 }}>Better / worse than expected</th>
              <th className="num">Housed</th><th className="num">Returned</th><th className="num">Median days</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const sig = r.adj_ci[0] > 0 ? 'good' : r.adj_ci[1] < 0 ? 'bad' : 'neu';
              return (
                <tr key={r.path}>
                  <td><PathChips path={r.path} /></td>
                  <td className="num">{fmt(r.n)}</td>
                  <td className="num">{pct(r.success)}</td>
                  <td className="num bnl-sub">{pct(r.expected)}</td>
                  <td title={`95% range ${pts(r.adj_ci[0])} to ${pts(r.adj_ci[1])}`}>
                    <DivBar v={r.adjusted} lo={r.adj_ci[0]} hi={r.adj_ci[1]} max={maxAbs} sig={sig} />
                  </td>
                  <td className="num">{pct(r.housed)}</td>
                  <td className="num">{pct(r.returned_of_housed)}</td>
                  <td className="num">{r.median_days_to_housed ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="bnl-sub" style={{ marginTop: 8 }}>
        Green/red only when the whole 95% range sits above/below expected. Routes are the program types an episode passed through
        until housing (repeats collapsed). Returned = share of those housed who re-entered homelessness within 12 months.
      </p>
    </div>
  );
}

/* ── What works ─────────────────────────────────────────────────────────── */

function WhatWorks({ iv }: { iv: InterventionIntel }) {
  const m = iv.model;
  const L = (a: string) => (a === 'NONE' ? 'shelter/outreach only' : a);
  return (
    <>
      <div className="grouplabel" style={{ marginTop: 0 }}>Average difference in success between options</div>
      <div className="panel" style={{ padding: '12px 16px' }}>
        <table>
          <thead><tr><th>Comparison</th><th style={{ minWidth: 220 }}>Difference in stable housing</th><th className="num">Clients compared</th></tr></thead>
          <tbody>
            {m.effects.map((e) => (
              <tr key={`${e.a}-${e.b}`}>
                <td>{L(e.a)} vs {L(e.b)}</td>
                <td title={`95% range ${pts(e.ci[0])} to ${pts(e.ci[1])}`}>
                  <DivBar v={e.effect} lo={e.ci[0]} hi={e.ci[1]} max={0.65} sig={e.ci[0] > 0 ? 'good' : e.ci[1] < 0 ? 'bad' : 'neu'} />
                </td>
                <td className="num">{fmt(e.n_overlap)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="bnl-sub" style={{ marginTop: 8 }}>
          Doubly-robust estimates over clients who could plausibly have received either option. Program-vs-shelter gaps are large
          partly because entering RRH/PSH usually means a unit is found; the program-vs-program rows are the fairer comparisons.
        </p>
      </div>

      <div className="grouplabel">What makes one program work relatively better</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
        {Object.entries(m.modifiers).map(([k, list]) => {
          const [a, , b] = k.split('_');
          return <ModifierCard key={k} a={a} b={b} list={list} />;
        })}
      </div>

      <div className="grouplabel">Observed outcomes by option ({m.train_from.slice(0, 4)}–{m.train_to.slice(0, 4)})</div>
      <div className="panel" style={{ padding: '12px 16px' }}>
        <table>
          <thead><tr><th>Option</th><th className="num">Episodes</th><th className="num">Stably housed</th><th className="num">Housed</th><th className="num">Returned (of housed)</th><th className="num">Median days to housing</th></tr></thead>
          <tbody>
            {m.arms.map((a) => {
              const s = m.arm_stats[a];
              return (
                <tr key={a}>
                  <td><Chip s={a} /> <span style={{ marginLeft: 6 }}>{m.arm_labels[a]}</span></td>
                  <td className="num">{fmt(s.n)}</td><td className="num">{pct(s.success, 1)}</td><td className="num">{pct(s.housed, 1)}</td>
                  <td className="num">{pct(s.returned_of_housed, 1)}</td><td className="num">{s.median_days_to_housed ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="bnl-sub" style={{ marginTop: 8 }}>Raw, unadjusted — clients were not randomly assigned, so these rates mix program effects with who gets each program.</p>
      </div>
    </>
  );
}

function ModifierCard({ a, b, list }: { a: string; b: string; list: IvxDriver[] }) {
  const top = list.filter((d) => d.feat !== 'year_c').slice(0, 7);
  const max = Math.max(...top.map((d) => Math.abs(d.w)), 0.01);
  return (
    <div className="panel" style={{ padding: '12px 14px' }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}><Chip s={a} /> vs <Chip s={b} /></div>
      {top.map((d) => (
        <div key={d.feat} style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 8, alignItems: 'center', fontSize: 12, margin: '4px 0' }}>
          <span>{d.label}</span>
          <span style={{ position: 'relative', height: 8, background: 'var(--track)', borderRadius: 4 }}>
            <i style={{ position: 'absolute', top: 0, bottom: 0, borderRadius: 4, background: STATE_COLOR[d.w > 0 ? a : b],
              left: d.w > 0 ? '50%' : `${50 - (Math.abs(d.w) / max) * 50}%`, width: `${(Math.abs(d.w) / max) * 50}%` }} />
          </span>
        </div>
      ))}
      <p className="bnl-sub" style={{ marginTop: 6 }}>Bar right = favours {a}; left = favours {b} for clients with that characteristic.</p>
    </div>
  );
}

/* ── Model & evidence ───────────────────────────────────────────────────── */

function Evidence({ iv }: { iv: InterventionIntel }) {
  const m = iv.model; const bt = m.backtest; const two = bt.rrh_psh_only;
  return (
    <>
      <div className="hc-tiles" style={{ marginBottom: 14 }}>
        <div className="hc-t"><div className="k">Training episodes</div><div className="v">{fmt(m.n_train)}</div><div className="s">{m.train_from} → {m.train_to}</div></div>
        <div className="hc-t"><div className="k">Held-out test</div><div className="v">{fmt(bt.n_test)}</div><div className="s">episodes starting {bt.split}+</div></div>
        <div className="hc-t"><div className="k">Capacity test (all programs)</div><div className="v">{pts(bt.lift)}</div><div className="s">range {pts(bt.lift_ci[0])} to {pts(bt.lift_ci[1])} · mostly TH→RRH moves</div></div>
        {two && <div className="hc-t"><div className="k">Capacity test (RRH vs PSH only)</div><div className="v">{pts(two.lift)}</div><div className="s">range {pts(two.lift_ci[0])} to {pts(two.lift_ci[1])} · not demonstrated</div></div>}
        {bt.spdat_eval?.cv && (
          <div className="hc-t"><div className="k">SPDAT added (2022+ cross-validation)</div>
            <div className="v">{bt.spdat_eval.cv.success_auc_without.toFixed(3)} → {bt.spdat_eval.cv.success_auc_with.toFixed(3)}</div>
            <div className="s">success AUC · who-gets-PSH {bt.spdat_eval.cv.psh_assign_auc_without.toFixed(3)} → {bt.spdat_eval.cv.psh_assign_auc_with.toFixed(3)} · {fmt(bt.spdat_eval.cv.n_with_spdat)} assessed episodes</div></div>
        )}
      </div>

      <div className="grouplabel" style={{ marginTop: 0 }}>How accurate is “will the client succeed?” (held-out years)</div>
      <div className="panel" style={{ padding: '12px 16px' }}>
        <table>
          <thead><tr><th>Path</th><th className="num">Test episodes</th><th className="num">Success AUC</th><th className="num">Gets-housed AUC</th><th className="num">Stays-housed AUC</th></tr></thead>
          <tbody>
            {m.arms.map((a) => (
              <tr key={a}><td><Chip s={a} /> <span style={{ marginLeft: 6 }}>{m.arm_labels[a]}</span></td>
                <td className="num">{fmt(bt.auc[a]?.n)}</td><td className="num">{bt.auc[a]?.success?.toFixed(3)}</td>
                <td className="num">{bt.auc[a]?.housed?.toFixed(3)}</td><td className="num">{bt.auc[a]?.stable?.toFixed(3)}</td></tr>
            ))}
          </tbody>
        </table>
        <p className="bnl-sub" style={{ marginTop: 8 }}>AUC = how often the model ranks a client who succeeded above one who didn’t (0.5 = coin flip, 1 = perfect).</p>
      </div>

      <div className="grouplabel">Equity audit (race/ethnicity is never a model input — used only to check fairness)</div>
      <div className="panel" style={{ padding: '12px 16px' }}>
        <table>
          <thead><tr><th>Group</th><th className="num">Test episodes</th><th className="num">Observed success</th><th className="num">Predicted</th><th className="num">AUC</th><th className="num">PSH share: actual → model</th></tr></thead>
          <tbody>
            {m.equity.map((e) => (
              <tr key={e.group}><td>{e.group}</td><td className="num">{fmt(e.n)}</td><td className="num">{pct(e.observed, 1)}</td>
                <td className="num">{pct(e.predicted, 1)}</td><td className="num">{e.auc.toFixed(3)}</td>
                <td className="num">{pct(e.psh_share_actual, 1)} → {pct(e.psh_share_model, 1)}</td></tr>
            ))}
          </tbody>
        </table>
        {m.equity.filter((e) => e.psh_share_actual != null && e.psh_share_model != null
          && Math.abs(e.psh_share_model - e.psh_share_actual) >= 0.05).map((e) => (
          <p key={e.group} style={{ marginTop: 8, fontSize: 12.5, padding: '7px 10px', borderRadius: 8,
            background: 'var(--warn-light)', color: 'var(--text)' }}>
            <b style={{ color: 'var(--warn)' }}>Needs governance review:</b> following the option matches would move {e.group} clients&rsquo;
            PSH share from {pct(e.psh_share_actual)} to {pct(e.psh_share_model)}. Until reviewed, matches should not influence PSH prioritization.
          </p>
        ))}
        <p className="bnl-sub" style={{ marginTop: 8 }}>Watch for groups where predicted and observed diverge, or where the model would shift PSH access sharply.</p>
      </div>

      <div className="grouplabel">Definitions</div>
      <div className="panel" style={{ padding: '12px 16px' }}>
        <ul className="bnl-sub" style={{ lineHeight: 1.7, paddingLeft: 18 }}>
          <li><b>Episode:</b> a head of household entering shelter / outreach / safe haven, or a housing program directly from homelessness, with no enrollment in the prior {m.definitions.gap_days} days.</li>
          <li><b>Option:</b> the first housing program entered within {m.definitions.treat_days} days — RRH, PSH (incl. other PH), TH — or none (shelter/outreach only, the baseline).</li>
          <li><b>Stably housed:</b> moved in or exited to permanent housing within {m.definitions.housed_days} days, and no new homeless/TH entry within {m.definitions.return_days} days after ({m.definitions.grace_days}-day grace).</li>
          <li><b>CE assessment (SPDAT):</b> VI-SPDAT (single), F-VI-SPDAT (family) and TAY-VI-SPDAT total, subscales and key responses (ER visits, risky situations, sleeping outdoors, trauma-caused homelessness), scaled to each tool’s maximum. Only an assessment dated from a year before the episode up to program entry is used — never one taken after placement.</li>
          <li><b>Rent gap:</b> HUD Fair Market Rent (Miami-Miami Beach-Kendall HMFA, fiscal year of the episode, bedrooms by household size) minus monthly income at entry. {Object.values(m.fmr_note ?? {}).join(' ')}</li>
          <li><b>Method:</b> who-gets-what model + one success model per option (two parts: gets housed × stays housed), 40 bootstrap re-fits for ranges, options compared only where similar clients actually received them. Pretrained on the model_data archive; re-scored every refresh.</li>
        </ul>
      </div>
    </>
  );
}

/* ── Small pieces ───────────────────────────────────────────────────────── */

function Chip({ s }: { s: string }) {
  return (
    <span style={{ display: 'inline-block', fontSize: 10.5, fontWeight: 700, padding: '1px 7px', borderRadius: 6,
      color: '#fff', background: STATE_COLOR[s] ?? 'var(--muted)', whiteSpace: 'nowrap' }}>{s === 'NONE' ? 'None' : s}</span>
  );
}

function PathChips({ path }: { path: string }) {
  const parts = path ? path.split(' → ') : [];
  return (
    <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center', flexWrap: 'wrap' }}>
      {parts.map((p, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          {i > 0 && <span className="bnl-sub">→</span>}<Chip s={p} />
        </span>
      ))}
    </span>
  );
}

function RangeBar({ p, lo, hi }: { p: number; lo: number; hi: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, width: '100%' }} title={`range ${pct(lo)}–${pct(hi)}`}>
      <span style={{ position: 'relative', flex: 1, minWidth: 90, height: 8, background: 'var(--track)', borderRadius: 4 }}>
        <i style={{ position: 'absolute', top: 0, bottom: 0, left: `${lo * 100}%`, width: `${Math.max((hi - lo) * 100, 0.5)}%`,
          background: 'var(--primary-light)', borderRadius: 4 }} />
        <i style={{ position: 'absolute', top: -2, width: 3, height: 12, left: `calc(${p * 100}% - 1.5px)`, background: 'var(--primary)', borderRadius: 2 }} />
      </span>
      <b className="num" style={{ fontSize: 12, minWidth: 34, textAlign: 'right' }}>{pct(p)}</b>
    </span>
  );
}

function DivBar({ v, lo, hi, max, sig }: { v: number; lo: number; hi: number; max: number; sig: 'good' | 'bad' | 'neu' }) {
  const x = (t: number) => 50 + (Math.max(-max, Math.min(max, t)) / max) * 50;
  const col = sig === 'good' ? 'var(--accent)' : sig === 'bad' ? 'var(--danger)' : 'var(--muted)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, width: '100%' }}>
      <span style={{ position: 'relative', flex: 1, minWidth: 110, height: 10, background: 'var(--track)', borderRadius: 4 }}>
        <i style={{ position: 'absolute', top: -2, bottom: -2, left: '50%', width: 1, background: 'var(--border-strong)' }} />
        <i style={{ position: 'absolute', top: 3, height: 4, left: `${x(lo)}%`, width: `${Math.max(x(hi) - x(lo), 0.5)}%`, background: col, opacity: 0.35, borderRadius: 2 }} />
        <i style={{ position: 'absolute', top: 0, width: 4, height: 10, left: `calc(${x(v)}% - 2px)`, background: col, borderRadius: 2 }} />
      </span>
      <b className="num" style={{ fontSize: 12, minWidth: 64, textAlign: 'right', color: col }}>{pts(v)}</b>
    </span>
  );
}
