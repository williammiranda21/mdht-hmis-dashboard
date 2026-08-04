'use client';

import { useEffect, useMemo, useState } from 'react';
import { periodLabel, fmtInt } from '../../../lib/format';
import { EVA_BY_ID, EVA_SEVERITY_META, type EvaCheck } from '../../../lib/evaChecks';

/**
 * Data-quality fix-list for one project — turns the APR Q6 percentages into the
 * actual records to fix. Reached from the DQ tab (monthly view). Client IDs come
 * from /api/dq-fixlist (drill_clients, agency-scoped RLS); the counts/labels come
 * from the row already on screen. Hashed IDs only — HMIS lookup, not names.
 *
 * These four elements are all ENROLLMENT-level: fix each stay's field. (Client-
 * level PII — DOB/SSN — would be a fix-once-per-client list; a later addition.)
 */
interface RowData { [k: string]: number | null }

// denomKey decides whether the element applies to this project (has a universe).
// The count of records comes from the actual IDs; the trend shows the APR % over
// time — we don't print a single "% of N" that could disagree with the count.
const ELEMENTS = [
  { key: 'dest', label: 'Missing exit destination',
    fix: 'Enter the client’s destination at exit in HMIS.', denomKey: 'DQ_ExitsTotal' },
  { key: 'movein', label: 'Missing move-in date',
    fix: 'Record the housing move-in date on the enrollment.', denomKey: 'DQ_PHEnrolls' },
  { key: 'income', label: 'Income missing, unknown, or inconsistent at entry',
    fix: 'In Community Services, income sources are dated records (HUD Verification on the Entry assessment). If the client has income: set Income from Any Source = Yes and make sure a source record with an amount is active at entry (start date on/before entry, not end-dated). If they don’t: set No and end-date any open source records. Replace any “don’t know / refused” with a real answer.',
    denomKey: 'DQ_ActiveTotal' },
  { key: 'incexit', label: 'Income missing, unknown, or inconsistent at exit',
    fix: 'On the Exit assessment, answer Income from Any Source for adult/HoH leavers and reconcile the dated source records: a “Yes” needs a source record active as of the exit date; a “No” means open records should be end-dated on or before exit.',
    denomKey: 'DQ_ExitsTotal' },
  { key: 'annual', label: 'Overdue annual assessment',
    fix: 'Complete the annual assessment within ±30 days of the enrollment anniversary.',
    denomKey: 'DQ_AnnualDue' },
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

interface DetailRow { pid: string; entry: string | null }
interface EvaFinding { id: string; ids: string[]; detail: DetailRow[] | null }
interface Category {
  key: string;
  ids: string[];
  // enrollment-precise rows (dest/movein/income/annual) — one per offending stay;
  // null for the client-level PII elements.
  detail: DetailRow[] | null;
  trend: { period: string; pct: number | null }[];
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
      })
      .catch(() => { if (live) setErr('Could not load the fix-list.'); });
    return () => { live = false; };
  }, [projectId, period]);

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
                    </div>
                    <TrendSpark trend={cat!.trend} />
                  </div>
                  <div className="dqfx-fix">→ {e.fix}</div>
                  <div className="dr-ids">
                    {(cat!.detail ?? cat!.ids.map((id) => ({ pid: id, entry: null }))).map((d, i) => (
                      <code key={`${d.pid}-${i}`} title={d.entry ? `Entry date ${d.entry}` : undefined}>
                        {d.pid}{d.entry ? <span style={{ color: 'var(--muted)' }}> · {d.entry}</span> : null}
                      </code>
                    ))}
                  </div>
                  <button className="btn dqfx-copy" onClick={(ev) => {
                    navigator.clipboard?.writeText((cat!.detail?.map((d) => d.pid) ?? cat!.ids).join('\n'));
                    const el = ev.currentTarget; el.textContent = 'Copied ✓';
                    setTimeout(() => { el.textContent = '⧉ Copy these IDs'; }, 1200);
                  }}>⧉ Copy these IDs</button>
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
                          </div>
                        </div>
                        <div className="bnl-sub" style={{ marginTop: 4 }}>{check.meaning}</div>
                        <div className="dqfx-fix">→ {check.fix}</div>
                        <div className="bnl-sub" style={{ marginTop: 2 }}>Affects: {check.breaks}</div>
                        <div className="dr-ids">
                          {(f.detail ?? f.ids.map((id) => ({ pid: id, entry: null }))).map((d, i) => (
                            <code key={`${d.pid}-${i}`} title={d.entry ? `Entry date ${d.entry}` : undefined}>
                              {d.pid}{d.entry ? <span style={{ color: 'var(--muted)' }}> · {d.entry}</span> : null}
                            </code>
                          ))}
                        </div>
                        <button className="btn dqfx-copy" onClick={(ev) => {
                          navigator.clipboard?.writeText(f.ids.join('\n'));
                          const el = ev.currentTarget; el.textContent = 'Copied ✓';
                          setTimeout(() => { el.textContent = '⧉ Copy these IDs'; }, 1200);
                        }}>⧉ Copy these IDs</button>
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
