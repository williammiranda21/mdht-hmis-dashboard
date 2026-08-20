'use client';

import { useEffect, useRef, useState } from 'react';
import { IDLE_MS, IDLE_WARN_MS, IDLE_LOCAL_KEY, IDLE_PING_MS } from '../lib/idle';

/**
 * Idle sign-out tracker — mounted once in the dashboard layout (see
 * lib/idle.ts for the whole design). Measures idleness with the CLIENT clock
 * only (localStorage stamp, shared so activity in ANY tab keeps every tab
 * alive), shows a "still there?" card 5 minutes before the deadline, and at
 * the hour signs out via the server-side signout route — the only reliable
 * way to clear the middleware-set session cookies (CLAUDE.md §4).
 *
 * While the user is active it pings /api/seen (throttled), which refreshes
 * the server-clock enforcement stamp AND profiles.last_seen_at — the admin
 * console's real-usage column.
 */

function readLocal(): number {
  try { return Number(localStorage.getItem(IDLE_LOCAL_KEY)) || 0; } catch { return 0; }
}
function writeLocal(t: number) {
  try { localStorage.setItem(IDLE_LOCAL_KEY, String(t)); } catch { /* private mode */ }
}

const WRITE_EVERY_MS = 30_000;  // localStorage refresh throttle while active
const CHECK_EVERY_MS = 30_000;

export default function IdleLogout() {
  const [warnLeft, setWarnLeft] = useState<number | null>(null);
  const lastWrite = useRef(0);
  const lastPing = useRef(0);
  const signingOut = useRef(false);

  useEffect(() => {
    const write = () => { const t = Date.now(); writeLocal(t); lastWrite.current = t; };
    const ping = () => {
      const now = Date.now();
      if (now - lastPing.current < IDLE_PING_MS) return;
      lastPing.current = now;
      fetch('/api/seen', { method: 'POST' }).catch(() => { /* next ping retries */ });
    };
    // Fresh mount = fresh activity (a page load IS the user doing something).
    write();
    ping();

    const activity = () => {
      if (signingOut.current) return;
      if (Date.now() - lastWrite.current >= WRITE_EVERY_MS) write();
      setWarnLeft((w) => (w === null ? w : null)); // real movement clears the warning
      ping();
    };

    const check = () => {
      if (signingOut.current) return;
      // Cross-tab truth is localStorage; the ref covers a blocked write.
      const stamp = Math.max(readLocal(), lastWrite.current);
      const left = IDLE_MS - (Date.now() - stamp);
      if (left <= 0) {
        signingOut.current = true;
        // Server-side sign-out (plain form POST — client signOut can't clear
        // the chunked middleware cookies). Carries where they were, so the
        // re-login lands them back on the same page.
        const fm = document.createElement('form');
        fm.method = 'POST';
        fm.action = `/auth/signout?reason=idle&next=${encodeURIComponent(
          window.location.pathname + window.location.search)}`;
        document.body.appendChild(fm);
        fm.submit();
      } else {
        setWarnLeft(left <= IDLE_WARN_MS ? left : null);
      }
    };

    const evs = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
    evs.forEach((e) => window.addEventListener(e, activity, { passive: true }));
    // Background tabs throttle timers — re-check the moment the tab is back.
    const vis = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', vis);
    const iv = window.setInterval(check, CHECK_EVERY_MS);
    return () => {
      evs.forEach((e) => window.removeEventListener(e, activity));
      document.removeEventListener('visibilitychange', vis);
      window.clearInterval(iv);
    };
  }, []);

  if (warnLeft === null) return null;
  const min = Math.max(1, Math.ceil(warnLeft / 60_000));
  return (
    <div role="alertdialog" aria-label="Inactivity sign-out warning"
      style={{ position: 'fixed', right: 18, bottom: 18, zIndex: 1200,
        background: 'var(--card)', border: '1px solid var(--warn)', borderRadius: 10,
        boxShadow: 'var(--shadow)', padding: '14px 18px', maxWidth: 330, fontSize: 13 }}>
      <b style={{ color: 'var(--strong)' }}>Still there?</b>
      <div style={{ color: 'var(--muted)', margin: '4px 0 10px' }}>
        You&rsquo;ll be signed out in about {min} minute{min === 1 ? '' : 's'} of
        inactivity. Unsaved work doesn&rsquo;t survive a sign-out.
      </div>
      <button className="btn primary" style={{ padding: '6px 14px', fontSize: 12.5 }}
        onClick={() => {
          const t = Date.now(); writeLocal(t); lastWrite.current = t;
          lastPing.current = 0; // force a server refresh too
          fetch('/api/seen', { method: 'POST' }).catch(() => {});
          setWarnLeft(null);
        }}>
        Stay signed in
      </button>
    </div>
  );
}
