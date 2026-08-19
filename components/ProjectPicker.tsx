'use client';

import { useState } from 'react';

/**
 * Multi-project filter — button + fixed popover with search and checkboxes.
 * Extracted VERBATIM from BnlView's project picker (7c566b4) so the BNL,
 * Project Performance, and Returns tabs share one implementation: selected
 * first, then active projects, (INACTIVE) demoted+dimmed instead of
 * alphabetically first; selection shown in the button; empty selection = all.
 *
 * Owns its popover/search state; the SELECTION lives in the page so filters,
 * totals, and CSV exports derive from it. Render inside a .fgroup with a
 * "Projects" flabel, matching the other filter controls.
 */

export interface ProjectOpt { id: number; name: string; type?: string | null }

export default function ProjectPicker({ options, selected, onChange, title, mode, onModeChange }: {
  options: ProjectOpt[];
  selected: number[];
  onChange: (next: number[]) => void;
  /** button tooltip, e.g. "Filter the roster to one or more projects" */
  title?: string;
  /** Optional include/exclude support: pass BOTH `mode` and `onModeChange` to
   *  render the Include/Exclude toggle. 'in' = only selected · 'out' = all
   *  except selected. Pages that don't pass them keep include-only behavior. */
  mode?: 'in' | 'out';
  onModeChange?: (m: 'in' | 'out') => void;
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [q, setQ] = useState('');

  return (
    <>
      <button className="btn" title={title ?? 'Filter to one or more projects'}
        style={selected.length ? { color: 'var(--primary)', fontWeight: 700 } : undefined}
        onClick={(e) => {
          if (anchor) { setAnchor(null); return; }
          const rect = e.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.left, y: rect.bottom });
        }}>
        {(() => {
          if (!selected.length) return 'All';
          const not = mode === 'out' ? 'Not: ' : '';
          return selected.length === 1
            ? not + (options.find((o) => o.id === selected[0])?.name ?? '1 selected').slice(0, 24)
            : `${not}${selected.length} projects`;
        })()} {anchor ? '▴' : '▾'}
      </button>

      {/* Popover — fixed + anchored to the button (panels clip overflow),
          transparent backdrop closes it. Single column so names breathe. */}
      {anchor && (() => {
        const norm = q.trim().toLowerCase();
        const isInactive = (n: string) => /^\s*\(\s*INACTIVE/i.test(n);
        const opts = options
          .filter((o) => !norm || o.name.toLowerCase().includes(norm))
          .sort((a, b) => {
            const sa = selected.includes(a.id) ? 0 : 1;
            const sb = selected.includes(b.id) ? 0 : 1;
            if (sa !== sb) return sa - sb;
            const ia = isInactive(a.name) ? 1 : 0, ib = isInactive(b.name) ? 1 : 0;
            if (ia !== ib) return ia - ib;
            return a.name.localeCompare(b.name);
          });
        return (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onClick={() => setAnchor(null)} />
            <div className="panel" style={{
              position: 'fixed', zIndex: 50,
              left: Math.min(anchor.x, Math.max(window.innerWidth - 480, 8)),
              top: anchor.y + 6,
              width: 460, maxWidth: '92vw',
              boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
            }}>
              <div style={{ padding: '10px 12px 8px' }}>
                {mode !== undefined && onModeChange && (
                  <div style={{ display: 'flex', gap: 6, marginBottom: 8 }} role="radiogroup"
                    aria-label="Filter direction">
                    {(['in', 'out'] as const).map((m) => (
                      <button key={m} className="btn" aria-pressed={mode === m}
                        onClick={() => onModeChange(m)}
                        style={mode === m
                          ? { color: 'var(--primary)', fontWeight: 700, borderColor: 'var(--primary)' }
                          : undefined}
                        title={m === 'in'
                          ? 'Show only the selected projects'
                          : 'Show everything EXCEPT the selected projects (clients with no current project stay visible)'}>
                        {m === 'in' ? 'Include selected' : 'Exclude selected'}
                      </button>
                    ))}
                  </div>
                )}
                <input className="finput" autoFocus placeholder="Search projects…" value={q}
                  onChange={(e) => setQ(e.target.value)} style={{ width: '100%' }} />
              </div>
              <div style={{ maxHeight: 320, overflowY: 'auto', padding: '0 6px' }}>
                {opts.map((o) => (
                  <label key={o.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
                      borderRadius: 6, cursor: 'pointer',
                      background: selected.includes(o.id) ? 'var(--primary-soft)' : undefined }}
                    title={o.type ? `${o.name} · ${o.type}` : o.name}>
                    <input type="checkbox" checked={selected.includes(o.id)}
                      onChange={() => onChange(selected.includes(o.id)
                        ? selected.filter((x) => x !== o.id) : [...selected, o.id])} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap', fontSize: 13,
                      color: isInactive(o.name) ? 'var(--muted)' : undefined }}>{o.name}</span>
                    {o.type && <span className="ty" style={{ marginLeft: 0, flexShrink: 0 }}>{o.type}</span>}
                  </label>
                ))}
                {!opts.length && <div className="hc-none">No projects match that search.</div>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                borderTop: '1px solid rgba(148,163,184,0.2)' }}>
                <span className="bnl-sub">{selected.length
                  ? `${selected.length} selected${mode === 'out' ? ' · excluded from view' : ''}`
                  : 'showing all projects'}</span>
                <span style={{ flex: 1 }} />
                {selected.length > 0 && (
                  <button className="btn" onClick={() => onChange([])}>Clear</button>
                )}
                <button className="btn" onClick={() => setAnchor(null)}>Done</button>
              </div>
            </div>
          </>
        );
      })()}
    </>
  );
}
