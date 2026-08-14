'use client';

import { useEffect, useMemo, useState } from 'react';
import { periodLabel, fmtInt } from '../../../lib/format';
import { EVA_BY_ID, EVA_SEVERITY_META, type EvaCheck } from '../../../lib/evaChecks';
import CopyId from '../../../components/CopyId';

/**
 * Data-quality fix-list for one project — turns the APR Q6 percentages into the
 * actual records to fix. Reached from the DQ tab (monthly view). Client IDs come
 * from /api/dq-fixlist (drill_clients, agency-scoped RLS); the counts/labels come
 * from the row already on screen. Hashed IDs only — HMIS lookup, not names.
 *
 * Every element carries per-stay detail {pid, entry, eid} since the 2026-08-13
 * ETL change — enrollment-level elements list each offending stay; client-level
 * elements (PII/Q6b/chronic) list the latest stay they were judged on.
 */
interface RowData { [k: string]: number | null }

// denomKey decides whether the element applies to this project (has a universe).
// The count of records comes from the actual IDs; the trend shows the APR % over
// time — we don't print a single "% of N" that could disagree with the count.
const ELEMENTS = [
  { key: 'dest', label: 'Missing exit destination',
    fix: 'Enter the client’s destination at exit in HMIS.', denomKey: 'DQ_ExitsTotal' },
  { key: 'movein', label: 'Missing move-in date',
    fix: 'Record the housing move-in date on the enrollment. The date must fall WITHIN this enrollment (on/after entry, on/before exit) — a move-in earlier than the entry date is invalid and gets dropped from HUD reporting even though Community Services still displays it. For a funding-source transfer where the client was already housed, the new enrollment’s move-in = its entry date; the original move-in stays on the prior enrollment.',
    denomKey: 'DQ_PHEnrolls' },
  { key: 'income', label: 'Income missing, unknown, or inconsistent at entry',
    fix: 'In Community Services, income sources are dated records (HUD Verification on the Entry assessment). If the client has income: set Income from Any Source = Yes and make sure a source record with an amount is active at entry (start date on/before entry, not end-dated). If they don’t: set No and end-date any open source records. Replace any “don’t know / refused” with a real answer.',
    denomKey: 'DQ_ActiveTotal' },
  { key: 'incexit', label: 'Income missing, unknown, or inconsistent at exit',
    fix: 'On the Exit assessment, answer Income from Any Source for adult/HoH leavers and reconcile the dated source records: a “Yes” needs a source record active as of the exit date; a “No” means open records should be end-dated on or before exit.',
    denomKey: 'DQ_ExitsTotal' },
  { key: 'annual', label: 'Annual assessment income missing or unknown',
    fix: 'Complete the annual assessment within ±30 days of the household anniversary (the head of household’s project start date) and answer Income from Any Source with its dated source records on that assessment.',
    denomKey: 'DQ_AnnualDue' },
  { key: 'veteran', label: 'Veteran status missing — or a child marked veteran',
    fix: 'Answer veteran status for every adult; a client under 18 marked as a veteran needs the age or the status corrected.',
    denomKey: 'DQ_ActiveTotal' },
  { key: 'psd', label: 'Overlapping or impossible project stays',
    fix: 'This client has a stay that starts before an earlier stay in the same project ended, or an exit dated before its entry. Correct the entry/exit dates so the stays don’t overlap.',
    denomKey: 'DQ_ActiveTotal' },
  { key: 'relhoh', label: 'Household has no (or multiple) heads of household',
    fix: 'Every household needs exactly one member with Relationship to HoH = Self. Fix the relationship values for the listed household members.',
    denomKey: 'DQ_ActiveTotal' },
  { key: 'coc', label: 'Enrollment CoC missing or invalid',
    fix: 'Record the Enrollment CoC (FL-600) on the head of household’s enrollment at project start.',
    denomKey: 'DQ_ActiveTotal' },
  { key: 'disabling', label: 'Disabling condition missing or contradicted',
    fix: 'Answer the disabling-condition question. A “No” is contradicted when an entry disability record says otherwise (developmental or HIV/AIDS = yes, or another condition marked as substantially impairing independent living) — reconcile the two.',
    denomKey: 'DQ_ActiveTotal' },
  { key: 'chronic', label: 'Homeless history (3.917) incomplete',
    fix: 'Complete the prior-situation fields at entry: length of stay, approximate date homelessness started, and number of times/months homeless in the past three years. Required to determine chronic homelessness.',
    denomKey: 'DQ_ChronicUniverse' },
  { key: 'openstay', label: 'Enrollment may have been left open',
    fix: 'The client appears to have moved on — they exited to permanent housing elsewhere, or later enrollments opened and closed after this one, yet this enrollment never closed. Verify whether they are still active here; if not, enter an exit in Community Services with the correct exit date and destination. (Current snapshot — this list reflects today’s open enrollments, not the selected month.)',
    denomKey: 'DQ_ActiveTotal' },
  // PII (Q6a) — fixed once on the client record, not per enrollment.
  { key: 'name', label: 'Name missing or incomplete',
    fix: 'Enter the client’s full legal name, or set the correct name data-quality value.',
    denomKey: 'DQ_ActiveTotal' },
  { key: 'ssn', label: 'SSN missing or quality mismatched',
    fix: 'Enter the SSN (last 4 is fine — mark quality “partial”), or record “doesn’t know / refused”. A last-4 entry marked “full” needs its quality corrected.',
    denomKey: 'DQ_ActiveTotal' },
  { key: 'dob', label: 'Date of birth missing or unknown',
    fix: 'Enter the client’s date of birth and set the DOB data-quality value.',
    denomKey: 'DQ_ActiveTotal' },
  { key: 'race', label: 'Race/ethnicity not collected',
    fix: 'Record the client’s race and ethnicity, or “client doesn’t know / refused”.',
    denomKey: 'DQ_ActiveTotal' },
  { key: 'sex', label: 'Sex missing or unknown',
    fix: 'Record the client’s sex, or “client doesn’t know / refused”.',
    denomKey: 'DQ_ActiveTotal' },
] as const;

interface DetailRow { pid: string; entry: string | null; eid?: string | null }
interface EvaFinding { id: string; ids: string[]; detail: DetailRow[] | null }
interface Category {
  key: string;
  ids: string[];
  // per-stay rows {pid, entry, eid} — one per offending stay (client-level
  // elements use the latest stay); null for rows loaded before 2026-08-13.
  detail: DetailRow[] | null;
  trend: { period: string; pct: number | null }[];
}

/** Due-date chip + admin editor for one category (project + element).
 *  Campaign-level (Homeless Trust sets it; agencies see it). Overdue = past
 *  due with records still on the list. */
function DueControl({ metric, due, remaining, canSet, onSet }: {
  metric: string; due: string | null; remaining: number; canSet: boolean;
  onSet: (metric: string, due: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(due ?? '');
  const [busy, setBusy] = useState(false);
  if (!due && !canSet) return null;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = !!due && remaining > 0 && due! < today;
  const commit = async (d: string | null) => {
    setBusy(true);
    try { await onSet(metric, d); setEditing(false); } finally { setBusy(false); }
  };
  if (editing) {
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginLeft: 8 }}>
        <input type="date" className="finput" style={{ padding: '2px 6px', fontSize: 12 }}
          value={val} onChange={(e) => setVal(e.target.value)} disabled={busy} />
        <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} disabled={busy || !val}
          onClick={() => commit(val)}>Set</button>
        {due && <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} disabled={busy}
          onClick={() => commit(null)}>Clear</button>}
        <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} disabled={busy}
          onClick={() => setEditing(false)}>✕</button>
      </span>
    );
  }
  const col = overdue ? 'var(--danger)' : 'var(--muted)';
  return (
    <span
      role={canSet ? 'button' : undefined}
      title={canSet ? 'Homeless Trust due date — click to change' : 'Homeless Trust due date'}
      onClick={canSet ? () => { setVal(due ?? ''); setEditing(true); } : undefined}
      style={{
        marginLeft: 8, fontSize: 11, fontWeight: 700, color: col,
        border: `1px solid ${col}`, borderRadius: 999, padding: '1px 8px',
        cursor: canSet ? 'pointer' : 'default', whiteSpace: 'nowrap',
      }}>
      {due ? `${overdue ? '⚑ overdue — was ' : 'due '}${due}` : '+ due date'}
    </span>
  );
}

interface Comment {
  id: number; metric: string; author: string; author_name: string;
  is_admin: boolean; body: string; created_at: string;
}

/** Record-anchored notes for one category (project + element) — the
 *  agency ↔ Homeless Trust loop ("re-entered the source record" / "confirmed,
 *  watching Friday's refresh"). Anchored and auditable, not a DM system. */
function Thread({ metric, comments, viewerId, onPost, onDelete }: {
  metric: string; comments: Comment[]; viewerId: string | null;
  onPost: (metric: string, body: string) => Promise<boolean>;
  onDelete: (id: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const post = async () => {
    if (!val.trim() || busy) return;
    setBusy(true);
    try { if (await onPost(metric, val.trim())) setVal(''); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'inline-block', marginLeft: 8 }}>
      <button className="btn dqfx-copy" style={{ marginTop: 0 }} onClick={() => setOpen((o) => !o)}>
        💬 Notes{comments.length ? ` (${comments.length})` : ''}
      </button>
      {open && (
        <div style={{ marginTop: 8, display: 'grid', gap: 8, maxWidth: 640 }}>
          {comments.map((c) => (
            <div key={c.id} style={{ fontSize: 13, lineHeight: 1.45 }}>
              <span style={{ fontWeight: 600 }}>{c.author_name}</span>
              {c.is_admin && (
                <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, color: 'var(--accent)',
                  border: '1px solid var(--accent)', borderRadius: 999, padding: '0 6px' }}>
                  Homeless Trust
                </span>
              )}
              <span className="bnl-sub" style={{ marginLeft: 6 }}>
                {new Date(c.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </span>
              {viewerId === c.author && (
                <button className="bnl-sub" title="Delete this note"
                  style={{ marginLeft: 6, background: 'none', border: 'none', cursor: 'pointer' }}
                  onClick={() => onDelete(c.id)}>✕</button>
              )}
              <div>{c.body}</div>
            </div>
          ))}
          {comments.length === 0 && (
            <div className="bnl-sub">No notes yet — leave one for this category.</div>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="finput" style={{ flex: 1, fontSize: 13 }} maxLength={2000}
              placeholder="Add a note — what was fixed, what's blocking…"
              value={val} onChange={(e) => setVal(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && post()} disabled={busy} />
            <button className="btn" onClick={post} disabled={busy || !val.trim()}>Post</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Missing-% over time. Lower is better, so a falling line is good — colored green
 *  when the latest point is at/under the previous, amber/red when rising. */
function TrendSpark({ trend }: { trend: { period: string; pct: number | null }[] }) {
  const pts = trend.filter((t) => t.pct != null) as { period: string; pct: number }[];
  if (pts.length < 2) return <span className="bnl-sub">not enough history</span>;
  const W = 120, H = 26, P = 2;
  const max = Math.max(10, ...pts.map((p) => p.pct));
  const x = (i: number) => P + (i * (W - 2 * P)) / (pts.length - 1);
  const y = (v: number) => H - P - ((H - 2 * P) * v) / max;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.pct).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1].pct, prev = pts[pts.length - 2].pct;
  const col = last <= prev ? 'var(--accent)' : last - prev > 3 ? 'var(--danger)' : 'var(--warn)';
  return (
    <span className="dqfx-spark" title={pts.map((p) => `${p.period}: ${p.pct}%`).join(' · ')}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} preserveAspectRatio="none">
        <path d={d} fill="none" stroke={col} strokeWidth={1.6} />
        <circle cx={x(pts.length - 1)} cy={y(last)} r={2.2} fill={col} />
      </svg>
      <b style={{ color: col }}>{last}%</b>
    </span>
  );
}

export default function DqFixList({
  projectId, projectName, period, data, onClose,
}: {
  projectId: number; projectName: string; period: string; data: RowData; onClose: () => void;
}) {
  const [cats, setCats] = useState<Category[] | null>(null);
  const [eva, setEva] = useState<EvaFinding[]>([]);
  const [evaPeriod, setEvaPeriod] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Timeliness (dq_items ledger): '<metric>|<pid>' → days open; due dates per
  // element metric; canSetDue = the viewer is a Homeless Trust admin.
  const [openAges, setOpenAges] = useState<Record<string, number>>({});
  const [dueDates, setDueDates] = useState<Record<string, string>>({});
  const [canSetDue, setCanSetDue] = useState(false);
  // Record-anchored notes (dq_comments) — one thread per category.
  const [comments, setComments] = useState<Comment[]>([]);
  const [viewerId, setViewerId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setCats(null); setErr(null); setEva([]);
    fetch(`/api/dq-fixlist?project=${projectId}&period=${encodeURIComponent(period)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        if (!live) return;
        setCats(j.categories as Category[]);
        setEva((j.eva ?? []) as EvaFinding[]);
        setEvaPeriod(j.evaPeriod ?? null);
        setOpenAges((j.openAges ?? {}) as Record<string, number>);
        setDueDates((j.dueDates ?? {}) as Record<string, string>);
        setCanSetDue(!!j.canSetDue);
      })
      .catch(() => { if (live) setErr('Could not load the fix-list.'); });
    fetch(`/api/comments?project=${projectId}`)
      .then((r) => (r.ok ? r.json() : { comments: [], viewerId: null }))
      .then((j) => {
        if (!live) return;
        setComments((j.comments ?? []) as Comment[]);
        setViewerId((j.viewerId ?? null) as string | null);
      })
      .catch(() => { /* threads are additive — the fix-list still renders */ });
    return () => { live = false; };
  }, [projectId, period]);

  const postComment = async (metric: string, body: string): Promise<boolean> => {
    const r = await fetch('/api/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectId, metric, body }),
    });
    if (!r.ok) return false;
    const j = await r.json();
    setComments((c) => [...c, j.comment as Comment]);
    return true;
  };
  const deleteComment = async (id: number) => {
    const r = await fetch(`/api/comments?id=${id}`, { method: 'DELETE' });
    if (r.ok) setComments((c) => c.filter((x) => x.id !== id));
  };
  const threadFor = (metric: string) => comments.filter((c) => c.metric === metric);

  const setDue = async (metric: string, due: string | null) => {
    const r = await fetch('/api/dq-due', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectId, metric, due }),
    });
    if (r.ok) {
      setDueDates((d) => {
        const n = { ...d };
        if (due == null) delete n[metric]; else n[metric] = due;
        return n;
      });
    }
  };
  // Chip meta line: entry date + how long the unit has been on the list.
  const chipSuffix = (metric: string, pid: string, entry: string | null) => {
    const a = openAges[`${metric}|${pid}`];
    return [entry, a != null ? `${a}d open` : null].filter(Boolean).join(' · ') || null;
  };

  const byKey = useMemo(
    () => new Map((cats ?? []).map((c) => [c.key, c])), [cats],
  );

  // Only elements that apply to this project (have a denominator) AND have records.
  const shown = ELEMENTS
    .map((e) => ({ e, cat: byKey.get(e.key) }))
    .filter(({ e, cat }) => (data[e.denomKey] ?? 0) > 0 && (cat?.ids.length ?? 0) > 0);

  // count of rows to fix: enrollments when we have per-stay detail, else clients
  const rowCount = (cat?: Category) => cat?.detail?.length ?? cat?.ids.length ?? 0;
  const totalToFix = shown.reduce((s, { cat }) => s + rowCount(cat), 0);

  // Eva findings joined to the guided registry, worst severity first then size.
  const evaRecords = eva.reduce((s, f) => s + (f.detail?.length ?? f.ids.length), 0);
  const evaSorted = useMemo(() =>
    eva
      .map((f) => ({ f, check: EVA_BY_ID.get(f.id) }))
      .filter((x): x is { f: EvaFinding; check: EvaCheck } => !!x.check && x.f.ids.length > 0)
      .sort((a, b) =>
        (EVA_SEVERITY_META[a.check.severity].rank - EVA_SEVERITY_META[b.check.severity].rank)
        || (b.f.ids.length - a.f.ids.length)),
    [eva]);

  // Server-side download (?format=csv) — browser-built blob: downloads fail
  // under the county's Web Isolation (its scanning proxy returns 500), so the
  // CSV is generated by the API route with a Content-Disposition attachment.
  const exportCsv = () => {
    window.location.href =
      `/api/dq-fixlist?project=${projectId}&period=${encodeURIComponent(period)}&format=csv`;
  };

  return (
    <div className="bnl-ov" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bnl-modal">
        <button className="bnl-x" onClick={onClose}>✕</button>
        <h3>Data-quality fix-list{' '}
          <a className="bnl-sub" style={{ fontWeight: 400 }}
            href={`/dashboard/deep-dive?projects=${projectId}`}
            title="Open this project's worklists on Deep Dive">
            Deep Dive →
          </a>
        </h3>
        <div className="bnl-sub" style={{ marginTop: 2 }}>{projectName} · {periodLabel(period)}</div>

        {!cats && !err && <div className="hc-none">Loading fix-list…</div>}
        {err && <div className="bnl-dq" style={{ marginTop: 12 }}>{err}</div>}

        {cats && !err && (
          shown.length === 0 && evaSorted.length === 0 ? (
            <div className="hc-none" style={{ padding: '24px 0' }}>
              🎉 No fixable data-quality issues on record for this project this period.
            </div>
          ) : (
            <>
              <div className="dr-head" style={{ marginTop: 12 }}>
                <span><b>{fmtInt(totalToFix + evaRecords)}</b> record{totalToFix + evaRecords === 1 ? '' : 's'} to fix across {shown.length + evaSorted.length} categor{shown.length + evaSorted.length === 1 ? 'y' : 'ies'}</span>
                <button className="btn" onClick={exportCsv}>⬇ Export CSV</button>
              </div>

              {shown.map(({ e, cat }) => (
                <div className="dqfx-cat" key={e.key}>
                  <div className="dqfx-cat-h">
                    <div>
                      <span className="dqfx-count">{rowCount(cat)}</span>
                      <b>{e.label}</b>
                      <DueControl metric={`dq:${e.key}`} due={dueDates[`dq:${e.key}`] ?? null}
                        remaining={rowCount(cat)} canSet={canSetDue} onSet={setDue} />
                    </div>
                    <TrendSpark trend={cat!.trend} />
                  </div>
                  <div className="dqfx-fix">→ {e.fix}</div>
                  <div className="dr-ids">
                    {(cat!.detail ?? cat!.ids.map((id) => ({ pid: id, entry: null }))).map((d, i) => (
                      <CopyId key={`${d.pid}-${i}`} pid={d.pid}
                        suffix={chipSuffix(`dq:${e.key}`, d.pid, d.entry)} />
                    ))}
                  </div>
                  <button className="btn dqfx-copy" onClick={(ev) => {
                    navigator.clipboard?.writeText((cat!.detail?.map((d) => d.pid) ?? cat!.ids).join('\n'));
                    const el = ev.currentTarget; el.textContent = 'Copied ✓';
                    setTimeout(() => { el.textContent = '⧉ Copy these IDs'; }, 1200);
                  }}>⧉ Copy these IDs</button>
                  <Thread metric={`dq:${e.key}`} comments={threadFor(`dq:${e.key}`)}
                    viewerId={viewerId} onPost={postComment} onDelete={deleteComment} />
                </div>
              ))}

              {/* ── HUD Eva checks — guided, severity-ranked (snapshot) ── */}
              {evaSorted.length > 0 && (
                <>
                  <div className="dr-head" style={{ marginTop: 18 }}>
                    <span>
                      <b>Data quality checks</b>
                      <span className="bnl-sub"> · record hygiene as of {evaPeriod ? periodLabel(evaPeriod) : 'latest month'}</span>
                    </span>
                  </div>
                  {evaSorted.map(({ f, check }) => {
                    const sev = EVA_SEVERITY_META[check.severity];
                    const sevColor = check.severity === 'hp' ? 'var(--danger)'
                      : check.severity === 'error' ? 'var(--warn)' : 'var(--muted)';
                    return (
                      <div className="dqfx-cat" key={`eva-${f.id}`}>
                        <div className="dqfx-cat-h">
                          <div>
                            <span className="dqfx-count">{f.ids.length}</span>
                            <b>{check.label}</b>
                            <span style={{
                              marginLeft: 8, fontSize: 11, fontWeight: 700, color: sevColor,
                              border: `1px solid ${sevColor}`, borderRadius: 999, padding: '1px 8px',
                            }}>{sev.label}</span>
                            <DueControl metric={`eva:${f.id}`} due={dueDates[`eva:${f.id}`] ?? null}
                              remaining={f.ids.length} canSet={canSetDue} onSet={setDue} />
                          </div>
                        </div>
                        <div className="bnl-sub" style={{ marginTop: 4 }}>{check.meaning}</div>
                        <div className="dqfx-fix">→ {check.fix}</div>
                        <div className="bnl-sub" style={{ marginTop: 2 }}>Affects: {check.breaks}</div>
                        <div className="dr-ids">
                          {(f.detail ?? f.ids.map((id) => ({ pid: id, entry: null }))).map((d, i) => (
                            <CopyId key={`${d.pid}-${i}`} pid={d.pid}
                              suffix={chipSuffix(`eva:${f.id}`, d.pid, d.entry)} />
                          ))}
                        </div>
                        <button className="btn dqfx-copy" onClick={(ev) => {
                          navigator.clipboard?.writeText(f.ids.join('\n'));
                          const el = ev.currentTarget; el.textContent = 'Copied ✓';
                          setTimeout(() => { el.textContent = '⧉ Copy these IDs'; }, 1200);
                        }}>⧉ Copy these IDs</button>
                        <Thread metric={`eva:${f.id}`} comments={threadFor(`eva:${f.id}`)}
                          viewerId={viewerId} onPost={postComment} onDelete={deleteComment} />
                      </div>
                    );
                  })}
                </>
              )}

              <p className="bnl-sub" style={{ marginTop: 12 }}>
                Hashed PersonalIDs — paste one into HMIS client search to open the record and fix the
                field. The trend shows this project’s missing-% over recent months (falling = improving).
                The data-quality checks follow HUD’s Eva methodology (snapshot of the latest complete month).
              </p>
            </>
          )
        )}
      </div>
    </div>
  );
}
