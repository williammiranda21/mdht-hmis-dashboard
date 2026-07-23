'use client';

import { useEffect, useMemo, useState } from 'react';
import { fmtInt, periodLabel } from '../../../lib/format';
import PerformanceGrid from './PerformanceGrid';
import ProjectPathways from './ProjectPathways';

interface Opt { id: number; name: string; type: string }

interface Client {
  pid: string; name: string; age: number | null; status: string; detail: string;
  project_id: number | null; project: string | null; ptype: string | null;
  entry: string | null; last_contact: string; days_since_contact: number | null;
  days_homeless: number; days_at_project: number | null; sys_days3: number; episodes3: number;
  chronic: boolean; veteran: boolean; family: boolean; assessed: string | null;
  dq: string[]; dq_n: number; long_stay: boolean; open_suspect: boolean;
}

type ListKey = 'long_stay' | 'open_suspect' | 'awaiting_movein' | 'data_quality' | 'chronic';

/** Each worklist states WHY a client is on it and what to do — a list of names
 *  with no rationale just gets ignored. */
const LISTS: { key: ListKey; title: string; why: string; empty: string }[] = [
  {
    key: 'long_stay',
    title: 'Staying far longer than typical',
    why: 'Time AT THIS PROJECT is more than 1.5× the project’s own median stay (its project type’s median where a project has fewer than 10 clients). Median, not mean — a few very long stays would otherwise drag the bar up and hide everyone else. This is length of stay here, not how long the client has been homeless.',
    empty: 'Nobody is staying much longer than usual at these projects.',
  },
  {
    key: 'awaiting_movein',
    title: 'Matched to housing, not moved in',
    why: 'Matched to a PH project but no move-in date recorded. Oldest match first — these are either stalled lease-ups or a missing move-in date.',
    empty: 'No clients are waiting on a move-in.',
  },
  {
    key: 'open_suspect',
    title: 'Enrollment may have been left open',
    why: 'The client exited to permanent housing after this enrollment opened, or later enrollments have since opened and closed around it. Verify whether they are still active here.',
    empty: 'No enrollments look left open.',
  },
  {
    key: 'chronic',
    title: 'Chronically homeless',
    why: 'Meets the HUD chronic-homelessness definition. Longest self-reported episode first. This is about the client’s history across the whole system — not their stay at your project — and it drives prioritisation for permanent housing.',
    empty: 'No chronically homeless clients.',
  },
  {
    key: 'data_quality',
    title: 'Data quality to fix',
    why: 'Records carrying HUD data-quality flags. These affect your APR and system reporting.',
    empty: 'No data-quality flags.',
  },
];

const days = (n: number | null) => (n == null ? '—' : `${n.toLocaleString()}d`);

/** Click-to-copy hashed PersonalID — this is the value you paste into HMIS
 *  client search, so it needs to be one click away on every row. */
function CopyId({ pid }: { pid: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`dd-pid${done ? ' ok' : ''}`}
      title={`${pid} — click to copy for HMIS lookup`}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(pid);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? 'copied ✓' : pid}
    </button>
  );
}

interface DeepDiveData {
  served: number; matched: number; unmatched: number; restricted?: boolean;
  lists: Record<ListKey, Client[]>;
}

export default function DeepDiveView({
  options, preselect, isAdmin, periods,
}: { options: Opt[]; preselect: number[]; isAdmin: boolean; periods: string[] }) {
  const [sel, setSel] = useState<number[]>(preselect.length ? preselect : []);
  const [period, setPeriod] = useState(periods[0] ?? '');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<ListKey | null>('long_stay');
  const [data, setData] = useState<DeepDiveData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? options.filter((o) => o.name.toLowerCase().includes(t) || o.type.toLowerCase().includes(t)) : options;
  }, [options, q]);

  useEffect(() => {
    if (!sel.length || !period) { setData(null); return; }
    let live = true;
    setLoading(true); setErr(null);
    fetch(`/api/deepdive?projects=${sel.join(',')}&period=${encodeURIComponent(period)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => { if (live) setData(j); })
      .catch(() => { if (live) setErr('Could not load worklists.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sel, period]);

  const toggle = (id: number) =>
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <>
      <div className="panel dd-pick">
        <div className="panel-h" style={{ paddingBottom: 0 }}>
          <div>
            <h3>Deep Dive</h3>
            <div className="meta">
              {isAdmin
                ? 'Choose one or more projects to review.'
                : 'Showing the projects assigned to you.'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select className="fselect" value={period} onChange={(e) => setPeriod(e.target.value)}
              title="Clients served by these projects in this period">
              {periods.map((p) => <option key={p} value={p}>{periodLabel(p)}</option>)}
            </select>
            <input className="finput" placeholder="Filter projects…" value={q}
              onChange={(e) => setQ(e.target.value)} style={{ minWidth: 200 }} />
            <button className="btn" onClick={() => setSel(shown.map((o) => o.id))}
              disabled={!shown.length}>Select all shown</button>
            <button className="btn" onClick={() => setSel([])} disabled={!sel.length}>Clear</button>
          </div>
        </div>

        <div className="dd-opts">
          {shown.map((o) => (
            // Names are ellipsised to keep the grid tidy, so the full name lives
            // in a title on the whole row — hovering anywhere reveals it.
            <label key={o.id} className={`dd-opt${sel.includes(o.id) ? ' on' : ''}`}
              title={o.type ? `${o.name} · ${o.type}` : o.name}>
              <input type="checkbox" checked={sel.includes(o.id)} onChange={() => toggle(o.id)} />
              <span className="dd-nm">{o.name}</span>
              {o.type && <span className="ty">{o.type}</span>}
            </label>
          ))}
          {!shown.length && <div className="hc-none">No projects match that filter.</div>}
        </div>

        <div className="bnl-cnote">
          {sel.length
            ? <>
                {sel.length} project{sel.length === 1 ? '' : 's'} selected
                {data ? <> · {fmtInt(data.served)} clients served in {periodLabel(period)}</> : null}
                {data && data.unmatched > 0 ? (
                  <span className="bnl-sub"> · {fmtInt(data.unmatched)} not in the By-Name List cohort,
                    so they cannot appear on a worklist</span>
                ) : null}
              </>
            : 'Select at least one project to begin.'}
        </div>
      </div>

      {/* Which PROJECTS need attention, before the worklists say which CLIENTS.
          Driven by the selection only — the period picker scopes worklist
          membership, while the grid always shows the trailing 24 months. */}
      {sel.length > 0 && <PerformanceGrid projectIds={sel} options={options} />}

      {/* Pathways — one project at a time (picker inside), so it sits below the
          multi-project grid. Only projects meeting the cohort minimum return data. */}
      {sel.length > 0 && <ProjectPathways projectIds={sel} options={options} />}

      {err && <div className="panel"><div className="bnl-dq">{err}</div></div>}
      {loading && <div className="panel"><div className="hc-none">Loading worklists…</div></div>}

      {data && !loading && (
        <>
          <div className="bnl-kpis" style={{ marginTop: 16 }}>
            {LISTS.map((l) => {
              const n = data.lists[l.key]?.length ?? 0;
              return (
                <div key={l.key} className="bnl-kpi dd-kpi" style={{ ['--kc' as any]: n ? 'var(--warn)' : 'var(--accent)' }}
                  role="button" tabIndex={0}
                  onClick={() => setOpen(l.key)}
                  onKeyDown={(e) => e.key === 'Enter' && setOpen(l.key)}>
                  <div className="bnl-kpi-lbl">{l.title}</div>
                  <div className="bnl-kpi-val num">{n}{n === 100 ? '+' : ''}</div>
                  <div className="bnl-kpi-note">{n ? 'needs review' : 'all clear'}</div>
                </div>
              );
            })}
          </div>

          {LISTS.map((l) => {
            const rows = data.lists[l.key] ?? [];
            const isOpen = open === l.key;
            return (
              <div className="panel" style={{ marginTop: 16 }} key={l.key}>
                <div className="panel-h dd-head" role="button" tabIndex={0}
                  onClick={() => setOpen(isOpen ? null : l.key)}
                  onKeyDown={(e) => e.key === 'Enter' && setOpen(isOpen ? null : l.key)}>
                  <div>
                    <h3>{l.title} <span className="bnl-sub">({rows.length}{rows.length === 100 ? '+' : ''})</span></h3>
                    <div className="meta">{l.why}</div>
                  </div>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {rows.length > 0 && (
                      <button className="btn" title="Copy every PersonalID in this list"
                        onClick={(e) => {
                          e.stopPropagation();
                          // newline-separated so it pastes straight into a
                          // spreadsheet column or an HMIS batch lookup
                          navigator.clipboard?.writeText(rows.map((r) => r.pid).join('\n'));
                          const el = e.currentTarget;
                          el.textContent = 'Copied ✓';
                          setTimeout(() => { el.textContent = '⧉ Copy IDs'; }, 1200);
                        }}>⧉ Copy IDs</button>
                    )}
                    <span className="dd-caret">{isOpen ? '▾' : '▸'}</span>
                  </span>
                </div>

                {isOpen && (
                  rows.length === 0
                    ? <div className="hc-none">{l.empty}</div>
                    : (
                      <div className="scroll">
                        <table className="bnl-table">
                          <thead>
                            <tr>
                              <th>Client</th><th className="num">Age</th><th>Project</th>
                              <th className="num">Days here</th>
                              <th>{l.key === 'data_quality' ? 'Issues' : 'Status'}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((c) => (
                              <tr key={c.pid}>
                                <td>
                                  <div className="bnl-nm">{c.name}</div>
                                  <div className="bnl-sub">{c.detail}</div>
                                  <CopyId pid={c.pid} />
                                </td>
                                <td className="num">{c.age ?? '—'}</td>
                                <td>
                                  {c.ptype && <span className="ty">{c.ptype}</span>} {c.project ?? '—'}
                                </td>
                                <td className="num">
                                  {days(c.days_at_project)}
                                  <div className="bnl-sub" title="Self-reported homeless episode (HUD 3.917) — spans all projects">
                                    {days(c.days_homeless)} homeless
                                  </div>
                                </td>
                                <td>
                                  {l.key === 'data_quality'
                                    ? <span className="bnl-sub">{c.dq.join(' · ')}</span>
                                    : <span className={`bnl-chip bnl-${c.status}`}>{c.status}</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {rows.length === 100 && (
                          <div className="bnl-cnote">
                            Showing the first 100 — narrow your project selection to see the rest.
                          </div>
                        )}
                      </div>
                    )
                )}
              </div>
            );
          })}

          <div className="panel" style={{ marginTop: 16 }}>
            <div className="panel-h"><h3>About these lists</h3></div>
            <p className="bnl-method">
              Worklists are rebuilt each time the pipeline runs, from the same By-Name List
              logic used elsewhere — nothing here is recalculated in the browser.
              <b> Days here</b> is time at the currently-open enrollment; the smaller figure
              beneath it is the client’s self-reported homeless episode (HUD 3.917), which spans
              every project and can be far longer. Membership comes from who each project actually
              served in the selected period, so clients who have since moved on still appear.
            </p>
          </div>
        </>
      )}
    </>
  );
}
