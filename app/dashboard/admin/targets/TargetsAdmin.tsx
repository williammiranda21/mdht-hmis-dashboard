'use client';

import { useMemo, useState } from 'react';
import { TARGET_METRICS, fmtTarget, type TargetMetric } from '../../../../lib/target-metrics';

export interface ProjOpt { id: number; name: string; type: number | null; typeName: string }
export interface ProjectTargetRow { project_id: number; metric: string; target: number }
export interface TypeTargetRow { project_type: number; metric: string; target: number }

/**
 * Central target management: pick a scope (project type OR specific project),
 * then set any of the metrics defined in lib/target-metrics.ts. Type targets
 * are defaults inherited by every project of the type; a project target
 * overrides its type default for that metric. Writes go through /api/targets
 * (admin-checked + RLS "admins manage targets").
 */
export default function TargetsAdmin({
  projects, projectTargets, typeTargets, typeTableReady,
}: {
  projects: ProjOpt[];
  projectTargets: ProjectTargetRow[];
  typeTargets: TypeTargetRow[];
  typeTableReady: boolean;
}) {
  const [mode, setMode] = useState<'type' | 'project'>('type');
  const [typeSel, setTypeSel] = useState<number | ''>('');
  const [projSel, setProjSel] = useState<number | ''>('');
  const [filter, setFilter] = useState('');

  // Kept in state so a save is reflected immediately (counts, fallbacks).
  const [pT, setPT] = useState<Record<number, Record<string, number>>>(() => {
    const m: Record<number, Record<string, number>> = {};
    projectTargets.forEach((r) => { (m[r.project_id] ??= {})[r.metric] = r.target; });
    return m;
  });
  const [tT, setTT] = useState<Record<number, Record<string, number>>>(() => {
    const m: Record<number, Record<string, number>> = {};
    typeTargets.forEach((r) => { (m[r.project_type] ??= {})[r.metric] = r.target; });
    return m;
  });

  const types = useMemo(() => {
    const seen = new Map<number, { code: number; name: string; count: number }>();
    projects.forEach((p) => {
      if (p.type == null) return;
      const e = seen.get(p.type) ?? { code: p.type, name: p.typeName || `Type ${p.type}`, count: 0 };
      e.count += 1;
      seen.set(p.type, e);
    });
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [projects]);

  const filteredProjects = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q
      ? projects.filter((p) => p.name.toLowerCase().includes(q) || p.typeName.toLowerCase().includes(q))
      : projects;
  }, [projects, filter]);

  const proj = mode === 'project' && projSel !== '' ? projects.find((p) => p.id === projSel) ?? null : null;
  const scopeReady = mode === 'type' ? typeSel !== '' : proj != null;
  const saved: Record<string, number> = mode === 'type'
    ? (typeSel === '' ? {} : (tT[typeSel] ?? {}))
    : (proj == null ? {} : (pT[proj.id] ?? {}));
  const fallback = proj?.type != null ? (tT[proj.type] ?? {}) : null;
  const typeName = mode === 'type' && typeSel !== ''
    ? (types.find((t) => t.code === typeSel)?.name ?? `Type ${typeSel}`) : '';

  const context = (m: TargetMetric): string => {
    if (mode === 'type') {
      if (typeSel === '') return '';
      const n = projects.filter((p) => p.type === typeSel).length;
      const ov = projects.filter((p) => p.type === typeSel && pT[p.id]?.[m.key] != null).length;
      return `default for ${n} ${typeName} project${n === 1 ? '' : 's'}${ov ? ` · ${ov} overridden individually` : ''}`;
    }
    if (fallback?.[m.key] != null) {
      return `type default: ${fmtTarget(fallback[m.key], m.unit)} — a value here overrides it for this project only`;
    }
    return 'no type default — this target applies to this project only';
  };

  async function saveTarget(metric: string, value: number | null): Promise<string | null> {
    const body = mode === 'type'
      ? { project_type: typeSel, metric, target: value }
      : { project_id: projSel, metric, target: value };
    const r = await fetch('/api/targets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) {
      let msg = `Save failed (${r.status}).`;
      try { const j = await r.json(); if (j?.error) msg = String(j.error); } catch { /* keep default */ }
      return msg;
    }
    const apply = (s: Record<number, Record<string, number>>, id: number) => {
      const next = { ...s, [id]: { ...(s[id] ?? {}) } };
      if (value == null) delete next[id][metric]; else next[id][metric] = value;
      return next;
    };
    if (mode === 'type' && typeSel !== '') setTT((s) => apply(s, typeSel));
    if (mode === 'project' && projSel !== '') setPT((s) => apply(s, projSel as number));
    return null;
  }

  const modeBtn = (m: 'type' | 'project', label: string) => (
    <button className="btn" aria-pressed={mode === m}
      style={mode === m ? { background: 'var(--primary)', color: '#fff', borderColor: 'var(--primary)' } : undefined}
      onClick={() => setMode(m)}>
      {label}
    </button>
  );

  return (
    <div className="panel">
      <div className="panel-h">
        <div>
          <h3>Performance targets</h3>
          <div className="meta">
            Set a target for a whole project type (every project of that type inherits it) or for a
            specific project (overrides its type default). Targets appear as progress bars on each
            project&apos;s detail panel.
          </div>
        </div>
      </div>

      <div style={{ padding: '2px 18px 20px' }}>
        {!typeTableReady && (
          <div className="bnl-dq" style={{ margin: '0 0 14px' }}>
            Type-level targets need a one-time setup: run <code>supabase/targets.sql</code> in the
            Supabase SQL editor. Until then, saves on the &quot;Project type&quot; side will fail;
            per-project targets work.
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 18 }}>
          {modeBtn('type', 'Project type')}
          {modeBtn('project', 'Specific project')}
          {mode === 'type' ? (
            <select className="fselect" style={{ minWidth: 260 }} value={typeSel === '' ? '' : String(typeSel)}
              onChange={(e) => setTypeSel(e.target.value === '' ? '' : Number(e.target.value))}>
              <option value="">Choose a project type…</option>
              {types.map((t) => (
                <option key={t.code} value={t.code}>{t.name} ({t.count} projects)</option>
              ))}
            </select>
          ) : (
            <>
              <input className="finput" style={{ minWidth: 180 }} placeholder="Filter projects…"
                value={filter} onChange={(e) => setFilter(e.target.value)} />
              <select className="fselect" style={{ minWidth: 300, maxWidth: 420 }} value={projSel === '' ? '' : String(projSel)}
                onChange={(e) => setProjSel(e.target.value === '' ? '' : Number(e.target.value))}>
                <option value="">Choose a project… ({filteredProjects.length})</option>
                {filteredProjects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.typeName ? ` — ${p.typeName}` : ''}</option>
                ))}
              </select>
            </>
          )}
        </div>

        {scopeReady ? (
          <Editor key={`${mode}:${mode === 'type' ? typeSel : projSel}`}
            saved={saved} onSave={saveTarget} context={context} />
        ) : (
          <div className="bnl-sub">
            Pick a {mode === 'type' ? 'project type' : 'project'} above to view and set its targets.
          </div>
        )}
      </div>
    </div>
  );
}

function Editor({
  saved, onSave, context,
}: {
  saved: Record<string, number>;
  onSave: (metric: string, value: number | null) => Promise<string | null>;
  context: (m: TargetMetric) => string;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(TARGET_METRICS.map((m) => [m.key, saved[m.key] != null ? String(saved[m.key]) : ''])));
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ metric: string; text: string; ok: boolean } | null>(null);

  async function save(m: TargetMetric, forceClear = false) {
    const raw = forceClear ? '' : drafts[m.key].trim().replace(/%$/, '').replace(/\s*days?$/i, '').trim();
    const v = raw === '' ? null : Number(raw);
    if (v != null && (!Number.isFinite(v) || v < 0 || v > m.max)) {
      setNote({ metric: m.key, ok: false,
        text: `Enter a number between 0 and ${m.max}${m.unit === '%' ? ' (percent — no % sign needed)' : m.unit ? ' (days)' : ''}, or leave blank to clear.` });
      return;
    }
    setBusy(m.key); setNote(null);
    const err = await onSave(m.key, v);
    setBusy(null);
    setNote(err
      ? { metric: m.key, text: err, ok: false }
      : { metric: m.key, text: v == null ? 'Cleared.' : `Saved — target ${m.higherBetter ? '≥' : '≤'} ${fmtTarget(v, m.unit)}.`, ok: true });
    if (!err && v == null) setDrafts((d) => ({ ...d, [m.key]: '' }));
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {TARGET_METRICS.map((m) => (
        <div key={m.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <span style={{ minWidth: 200, paddingTop: 6 }}>
            {m.label}
            <span className="bnl-sub" style={{ marginLeft: 6 }}>{m.higherBetter ? '≥' : '≤'}</span>
          </span>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input className="finput" style={{ width: 100 }} value={drafts[m.key]}
              placeholder={m.placeholder} inputMode="decimal"
              onChange={(e) => setDrafts((d) => ({ ...d, [m.key]: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') save(m); }} />
            {m.unit.trim() !== '' && <span className="bnl-sub">{m.unit.trim()}</span>}
            <button className="btn" disabled={busy === m.key} onClick={() => save(m)}>
              {busy === m.key ? 'Saving…' : 'Save'}
            </button>
            {saved[m.key] != null && (
              <button className="btn" disabled={busy === m.key} onClick={() => save(m, true)}>Clear</button>
            )}
          </span>
          <span style={{ flexBasis: '100%', display: 'grid', gap: 2 }}>
            <span className="bnl-sub" style={{ fontSize: 12 }}>{m.hint}</span>
            {context(m) !== '' && <span className="bnl-sub" style={{ fontSize: 12 }}>{context(m)}</span>}
            {note?.metric === m.key && (
              <span style={{ fontSize: 12, color: note.ok ? 'var(--accent)' : 'var(--warn)' }}>{note.text}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
