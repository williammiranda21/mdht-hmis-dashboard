'use client';

import { useEffect, useMemo, useState } from 'react';
import { fmtInt, periodLabel } from '../../../lib/format';

interface Opt { id: number; name: string; type: string }

interface Client {
  pid: string; name: string; age: number | null; status: string; detail: string;
  project_id: number | null; project: string | null; ptype: string | null;
  entry: string | null; last_contact: string; days_since_contact: number | null;
  days_homeless: number; sys_days3: number; episodes3: number;
  chronic: boolean; veteran: boolean; family: boolean; assessed: string | null;
  dq: string[]; dq_n: number; long_stay: boolean; open_suspect: boolean;
}

type ListKey = 'long_stay' | 'open_suspect' | 'awaiting_movein' | 'data_quality';

/** Each worklist states WHY a client is on it and what to do — a list of names
 *  with no rationale just gets ignored. */
const LISTS: { key: ListKey; title: string; why: string; empty: string }[] = [
  {
    key: 'long_stay',
    title: 'Staying far longer than typical',
    why: 'Currently homeless and past 1.5× the median stay for their project type. Median, not mean — a few multi-year clients would otherwise hide everyone else.',
    empty: 'No clients are past 1.5× the typical stay for their project type.',
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
    key: 'data_quality',
    title: 'Data quality to fix',
    why: 'Records carrying HUD data-quality flags. These affect your APR and system reporting.',
    empty: 'No data-quality flags.',
  },
];

const days = (n: number | null) => (n == null ? '—' : `${n.toLocaleString()}d`);

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
                  <span className="dd-caret">{isOpen ? '▾' : '▸'}</span>
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
                              <th className="num">Days homeless</th>
                              <th className="num">Last contact</th>
                              <th>{l.key === 'data_quality' ? 'Issues' : 'Status'}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((c) => (
                              <tr key={c.pid}>
                                <td>
                                  <div className="bnl-nm">{c.name}</div>
                                  <div className="bnl-sub">{c.detail}</div>
                                </td>
                                <td className="num">{c.age ?? '—'}</td>
                                <td>
                                  {c.ptype && <span className="ty">{c.ptype}</span>} {c.project ?? '—'}
                                </td>
                                <td className="num">{days(c.days_homeless)}</td>
                                <td className="num">
                                  {c.last_contact}
                                  <div className="bnl-sub">{days(c.days_since_contact)} ago</div>
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
              <b> One caveat on “last contact”:</b> it is derived from enrollment entries and
              exits, CurrentLivingSituation records and CE assessments — it does <i>not</i> yet
              include service transactions, so a client receiving daily services can still show a
              stale contact date. Treat the date as “last recorded HMIS event”, not “last seen”.
            </p>
          </div>
        </>
      )}
    </>
  );
}
