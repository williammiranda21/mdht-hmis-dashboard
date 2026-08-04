'use client';

import { useState } from 'react';

/**
 * Click-to-copy hashed PersonalID — the value staff paste into HMIS client
 * search, so it is ONE CLICK away everywhere an ID appears (user directive
 * 2026-08-04: applied app-wide — Deep Dive worklists, drill modals, DQ
 * fix-lists, user score cards). Renders as the .dd-pid mono chip; optional
 * `suffix` shows muted meta (e.g. an entry date) inside the chip.
 */
export default function CopyId({ pid, suffix }: { pid: string; suffix?: string | null }) {
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
      {!done && suffix ? <span style={{ color: 'var(--muted)' }}> · {suffix}</span> : null}
    </button>
  );
}
