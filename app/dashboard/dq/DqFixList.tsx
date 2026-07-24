'use client';

import { useEffect, useMemo, useState } from 'react';
import { periodLabel, fmtInt } from '../../../lib/format';

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
  { key: 'income', label: 'Income missing or unknown at entry',
    fix: 'Record income at entry — an amount or “no income” — and replace any “don’t know / refused”.',
    denomKey: 'DQ_ActiveTotal' },
  { key: 'annual', label: 'Overdue annual assessment',
    fix: 'Complete the annual assessment within ±30 days of the enrollment anniversary.',
    denomKey: 'DQ_AnnualDue' },
  // PII (Q6a) — fixed once on the client record, not per enrollment.
  { key: 'name', label: 'Name missing or incomplete',
    fix: 'Enter the client’s full legal name, or set the correct name data-quality value.',
    denomKey: 'DQ_ActiveTotal' },
  { key: 'ssn', label: 'SSN missing, partial, or unknown',
    fix: 'Enter the full 9-digit SSN, or record “client doesn’t know / refused” accurately.',
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

interface Category { key: string; ids: string[]; trend: { period: string; pct: number | null }[] }

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
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setCats(null); setErr(null);
    fetch(`/api/dq-fixlist?project=${projectId}&period=${encodeURIComponent(period)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => { if (live) setCats(j.categories as Category[]); })
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

  const totalToFix = shown.reduce((s, { cat }) => s + (cat?.ids.length ?? 0), 0);

  const exportCsv = () => {
    const lines = ['error,client_id'];
    shown.forEach(({ e, cat }) => cat!.ids.forEach((id) => lines.push(`${e.key},${id}`)));
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = `dq_fixlist_${projectId}_${period}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="bnl-ov" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bnl-modal">
        <button className="bnl-x" onClick={onClose}>✕</button>
        <h3>Data-quality fix-list</h3>
        <div className="bnl-sub" style={{ marginTop: 2 }}>{projectName} · {periodLabel(period)}</div>

        {!cats && !err && <div className="hc-none">Loading fix-list…</div>}
        {err && <div className="bnl-dq" style={{ marginTop: 12 }}>{err}</div>}

        {cats && !err && (
          shown.length === 0 ? (
            <div className="hc-none" style={{ padding: '24px 0' }}>
              🎉 No fixable data-quality issues on record for this project this period.
            </div>
          ) : (
            <>
              <div className="dr-head" style={{ marginTop: 12 }}>
                <span><b>{fmtInt(totalToFix)}</b> record{totalToFix === 1 ? '' : 's'} to fix across {shown.length} categor{shown.length === 1 ? 'y' : 'ies'}</span>
                <button className="btn" onClick={exportCsv}>⬇ Export CSV</button>
              </div>

              {shown.map(({ e, cat }) => (
                <div className="dqfx-cat" key={e.key}>
                  <div className="dqfx-cat-h">
                    <div>
                      <span className="dqfx-count">{cat!.ids.length}</span>
                      <b>{e.label}</b>
                    </div>
                    <TrendSpark trend={cat!.trend} />
                  </div>
                  <div className="dqfx-fix">→ {e.fix}</div>
                  <div className="dr-ids">
                    {cat!.ids.map((id) => <code key={id}>{id}</code>)}
                  </div>
                  <button className="btn dqfx-copy" onClick={(ev) => {
                    navigator.clipboard?.writeText(cat!.ids.join('\n'));
                    const el = ev.currentTarget; el.textContent = 'Copied ✓';
                    setTimeout(() => { el.textContent = '⧉ Copy these IDs'; }, 1200);
                  }}>⧉ Copy these IDs</button>
                </div>
              ))}

              <p className="bnl-sub" style={{ marginTop: 12 }}>
                Hashed PersonalIDs — paste one into HMIS client search to open the record and fix the
                field. The trend shows this project’s missing-% over recent months (falling = improving).
              </p>
            </>
          )
        )}
      </div>
    </div>
  );
}
