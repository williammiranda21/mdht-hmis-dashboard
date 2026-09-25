'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Styled team pickers for the helpline (user 2026-09-25: the native <select>
 * "opens plain, just text"). A browser can't style <option> lists, so these
 * are small custom popovers in the app's design language:
 *   • TeamMenu         — single choice (Assign team), type-to-filter, ↑↓ + Enter, Esc
 *   • TeamMultiSelect  — multi choice (team board filter), checkbox list
 * Both close on outside click / Esc and keep focus inside while open.
 */

export interface TeamOpt { id: number; name: string; zones: string[]; open: number }

function useOutside(ref: React.RefObject<HTMLElement>, onOut: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onOut(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [ref, onOut, active]);
}

/**
 * Popovers float with position:fixed from the anchor's on-screen rect, so a
 * panel's overflow:hidden or a table's scroll box can never clip them (user
 * 2026-09-25: "list is being cut"). Right-aligns to the anchor when there is
 * no room to the right, opens upward when there is no room below, and closes
 * on page scroll/resize rather than drifting away from its button.
 */
const MENU_W = 300;
function useFloating(anchor: () => HTMLElement | null, open: boolean, onClose: () => void,
  menu?: React.RefObject<HTMLElement>) {
  const [pos, setPos] = useState<React.CSSProperties>({ visibility: 'hidden' });
  useEffect(() => {
    if (!open) return;
    const el = anchor();
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth; const vh = window.innerHeight;
    const left = r.left + MENU_W + 12 <= vw ? r.left : Math.max(12, r.right - MENU_W);
    const below = vh - r.bottom; const above = r.top;
    const maxH = Math.max(200, Math.min(460, (below >= 320 || below >= above ? below : above) - 18));
    setPos(below >= 320 || below >= above
      ? { position: 'fixed', left, top: r.bottom + 6, maxHeight: maxH }
      : { position: 'fixed', left, bottom: vh - r.top + 6, maxHeight: maxH });
    const close = () => onClose();
    // scrolling the list INSIDE the menu must not close it — only page scrolls
    const onScroll = (e: Event) => {
      if (menu?.current && e.target instanceof Node && menu.current.contains(e.target)) return;
      onClose();
    };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    return () => { window.removeEventListener('resize', close); window.removeEventListener('scroll', onScroll, true); };
  }, [open]);  // eslint-disable-line react-hooks/exhaustive-deps
  return pos;
}

const zoneLine = (t: TeamOpt) => (t.zones.length ? t.zones.join(', ') : 'no zones set');

/** Popover list for choosing ONE team. Render inside a position:relative parent. */
export function TeamMenu({ teams, suggestedId, onPick, onClose, align = 'right', title = 'Assign to team' }: {
  teams: TeamOpt[]; suggestedId?: number | null; onPick: (id: number) => void; onClose: () => void;
  align?: 'left' | 'right'; title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  useOutside(ref, onClose, true);
  const pos = useFloating(() => ref.current?.parentElement ?? null, true, onClose, ref);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const f = teams.filter((t) => !s || t.name.toLowerCase().includes(s) || t.zones.join(' ').toLowerCase().includes(s));
    // suggested first, then fewest open cases, then name
    return f.sort((a, b) => (a.id === suggestedId ? -1 : b.id === suggestedId ? 1 : 0)
      || a.open - b.open || a.name.localeCompare(b.name));
  }, [teams, q, suggestedId]);
  useEffect(() => setHi(0), [q]);
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, list.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (list[hi]) onPick(list[hi].id); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };
  return (
    <div ref={ref} className="tmenu" style={pos} data-align={align} role="dialog" aria-label={title}>
      <div className="tmenu-h">{title}</div>
      <input ref={inputRef} className="tmenu-q" placeholder="Filter teams…" value={q}
        onChange={(e) => setQ(e.target.value)} onKeyDown={key} aria-label="Filter teams" />
      <div className="tmenu-list" role="listbox">
        {list.map((t, i) => (
          <button key={t.id} type="button" role="option" aria-selected={i === hi}
            className={`tmenu-item${i === hi ? ' hi' : ''}${t.id === suggestedId ? ' sug' : ''}`}
            onMouseEnter={() => setHi(i)} onClick={() => onPick(t.id)}>
            <span className="tmenu-main">
              <span className="tmenu-nm">{t.name}</span>
              <span className="tmenu-sub">{zoneLine(t)}</span>
            </span>
            {t.id === suggestedId && <span className="tmenu-sugtag">suggested</span>}
            <span className="tmenu-cnt">{t.open} open</span>
          </button>
        ))}
        {!list.length && <div className="tmenu-empty">No team matches “{q}”.</div>}
      </div>
      <div className="tmenu-f">↑↓ to move · Enter to assign · Esc to close</div>
    </div>
  );
}

/** Dropdown for choosing SEVERAL teams (board filter). `value` null = all teams. */
export function TeamMultiSelect({ teams, value, onChange }: {
  teams: TeamOpt[]; value: Set<number> | null; onChange: (v: Set<number> | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  useOutside(ref, () => setOpen(false), open);
  const menuRef = useRef<HTMLDivElement>(null);
  const pos = useFloating(() => btnRef.current, open, () => setOpen(false), menuRef);
  const all = value == null;
  const chosen = teams.filter((t) => value?.has(t.id));
  const label = all ? 'All teams' : chosen.length === 1 ? chosen[0].name : `${chosen.length} teams`;
  const toggle = (id: number) => {
    const next = new Set(all ? [] : value);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next.size ? next : null);
  };
  const withOpen = teams.filter((t) => t.open > 0);
  const empty = teams.filter((t) => t.open === 0);
  const row = (t: TeamOpt) => (
    <label key={t.id} className="tmenu-item tmenu-check">
      <input type="checkbox" checked={!all && !!value?.has(t.id)} onChange={() => toggle(t.id)} />
      <span className="tmenu-main">
        <span className="tmenu-nm">{t.name}</span>
        <span className="tmenu-sub">{zoneLine(t)}</span>
      </span>
      <span className="tmenu-cnt">{t.open} open</span>
    </label>
  );
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button ref={btnRef} type="button" className={`tsel${all ? '' : ' on'}`} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => setOpen((o) => !o)} onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}>
        <span className="tsel-l">Team</span>
        <span className="tsel-v" title={chosen.map((t) => t.name).join(', ') || 'All teams'}>{label}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (
        <div ref={menuRef} className="tmenu" style={pos} role="listbox" aria-multiselectable="true" aria-label="Filter the board by team"
          onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}>
          <label className="tmenu-item tmenu-check tmenu-all">
            <input type="checkbox" checked={all} onChange={() => onChange(null)} />
            <span className="tmenu-main"><span className="tmenu-nm">All teams</span></span>
            <span className="tmenu-cnt">{withOpen.reduce((s, t) => s + t.open, 0)} open</span>
          </label>
          <div className="tmenu-list">
            {withOpen.map(row)}
            {empty.length > 0 && <div className="tmenu-h" style={{ paddingTop: 8 }}>No open cases</div>}
            {empty.map(row)}
          </div>
          <div className="tmenu-f" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>{all ? 'Showing every team' : `${chosen.length} selected`}</span>
            {!all && <button type="button" className="tmenu-link" onClick={() => onChange(null)}>Show all</button>}
          </div>
        </div>
      )}
    </div>
  );
}
