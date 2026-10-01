'use client';

import { useEffect, useState, type CSSProperties } from 'react';

/**
 * Typed date-of-birth field — MM/DD/YYYY with slashes added as you type.
 *
 * Replaces <input type="date"> on intake forms (user 2026-10-01: "the DOB
 * field clears the year sometimes"). A controlled native date input reports
 * '' while the year is half-typed; writing that back into state made the
 * browser wipe the segments mid-entry, and partial years like 0019 fired
 * HMIS lookups. Here the parent only ever receives a COMPLETE, valid ISO
 * date (YYYY-MM-DD) or '' — never a half-typed value.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** 'MM/DD/YYYY' (or digits) → 'YYYY-MM-DD' when complete and plausible, else ''. */
export function parseDob(text: string): string {
  const d = text.replace(/\D/g, '');
  if (d.length !== 8) return '';
  const m = +d.slice(0, 2), day = +d.slice(2, 4), y = +d.slice(4, 8);
  if (m < 1 || m > 12 || y < 1900) return '';
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (day < 1 || day > dim) return '';
  const iso = `${y}-${pad(m)}-${pad(day)}`;
  return iso > new Date().toISOString().slice(0, 10) ? '' : iso;
}

/** Digits → 'MM/DD/YYYY' progressively (slash only once the next part starts,
 *  so backspace never gets stuck on a slash). */
function mask(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
}

const isoToText = (iso: string) => {
  const r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return r ? `${r[2]}/${r[3]}/${r[1]}` : '';
};

export default function DobInput({ value, onChange, className = 'tinput', style, ariaLabel = 'Date of birth' }: {
  /** ISO YYYY-MM-DD or '' */
  value: string;
  onChange: (iso: string) => void;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(() => isoToText(value));
  // Follow outside changes (form reset, prefill) without fighting the typist:
  // only rewrite the box when the parent's value differs from what it shows.
  useEffect(() => {
    const cur = parseDob(text);
    if (value === cur) return;
    if (value) setText(isoToText(value));
    else if (cur) setText('');             // parent cleared a complete date (reset)
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const digits = text.replace(/\D/g, '').length;
  const bad = digits === 8 && !parseDob(text);
  return (
    <>
      <input className={className} style={{ ...style, ...(bad ? { borderColor: 'var(--danger)' } : {}) }}
        inputMode="numeric" autoComplete="off" placeholder="MM/DD/YYYY" maxLength={10}
        aria-label={ariaLabel} aria-invalid={bad || undefined} value={text}
        onChange={(e) => {
          const t = mask(e.target.value);
          setText(t);
          const iso = parseDob(t);
          if (iso !== value) onChange(iso);
        }} />
      {bad && <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 3 }}>Not a valid date of birth</div>}
    </>
  );
}
