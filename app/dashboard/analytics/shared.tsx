'use client';

import { useState } from 'react';

/** Formatters + the click-to-copy ID control shared by the Analytics sections. */

export const fmt = (n: number | null | undefined) =>
  (n == null ? '—' : Math.round(n).toLocaleString());
export const pct1 = (n: number | null | undefined) =>
  (n == null ? '—' : `${Number(n).toFixed(1)}%`);

/** Click-to-copy hashed client ID (user 2026-09-18) — used by the outlier,
 *  risk, and predictor tables. Clipboard API first, hidden-textarea fallback
 *  (county browsers behind Web Isolation have refused the async API before). */
export function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = id;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
      } catch { return false; }
    };
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(id).then(done, () => { if (fallback()) done(); });
    } else if (fallback()) done();
  };
  return (
    <button type="button" onClick={copy} title="Click to copy ID"
      className="num"
      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
        font: 'inherit', fontSize: 11, textAlign: 'left', wordBreak: 'break-all',
        color: copied ? 'var(--accent)' : 'inherit',
        textDecoration: copied ? 'none' : 'underline dotted',
        textUnderlineOffset: 3 }}>
      {copied ? '✓ copied' : id}
    </button>
  );
}
