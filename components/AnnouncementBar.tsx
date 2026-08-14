'use client';

import { useRef, useState } from 'react';
import AnnDetails from './AnnDetails';

/**
 * Admin broadcast banner — shown on every dashboard page when an announcement
 * is active. Two kinds: 'notice' (general business — deadlines, meetings,
 * data issues) and 'update' (dashboard features). Optional details support
 * screenshots ("[img]<path>" lines via /api/announcements/upload) behind a
 * "read more" toggle; history lives at /dashboard/announcements. Admins
 * manage inline: post replaces (old one is retired to history), never stacks.
 */
export interface Announcement {
  id: number; body: string; details: string | null; kind: string;
  created_at: string; expires_on: string | null;
}

export default function AnnouncementBar({ initial, isAdmin }: {
  initial: Announcement | null; isAdmin: boolean;
}) {
  const [ann, setAnn] = useState<Announcement | null>(initial);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [val, setVal] = useState('');
  const [details, setDetails] = useState('');
  const [kind, setKind] = useState<'notice' | 'update'>('notice');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  if (!ann && !isAdmin) return null;

  const post = async () => {
    if (!val.trim()) return;
    setBusy(true);
    try {
      const r = await fetch('/api/announcements', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: val.trim(), details: details.trim() || null, kind }),
      });
      if (r.ok) {
        setAnn((await r.json()).announcement as Announcement);
        setEditing(false); setExpanded(false); setVal(''); setDetails('');
      }
    } finally { setBusy(false); }
  };
  const clear = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/announcements', { method: 'DELETE' });
      if (r.ok) { setAnn(null); setEditing(false); }
    } finally { setBusy(false); }
  };
  const attach = async (f: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const r = await fetch('/api/announcements/upload', { method: 'POST', body: fd });
      if (r.ok) {
        const { path } = await r.json();
        setDetails((d) => `${d}${d && !d.endsWith('\n') ? '\n' : ''}[img]${path}\n`);
      }
    } finally { setBusy(false); }
  };

  if (editing) {
    return (
      <div style={{
        display: 'grid', gap: 8, margin: '0 0 14px', padding: '10px 14px',
        borderRadius: 8, background: 'var(--card)', border: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select className="fselect" style={{ fontSize: 12.5 }} value={kind} disabled={busy}
            onChange={(e) => setKind(e.target.value as 'notice' | 'update')}>
            <option value="notice">📣 Notice</option>
            <option value="update">✨ Dashboard update</option>
          </select>
          <input className="finput" style={{ flex: 1, fontSize: 13 }} maxLength={300} autoFocus
            placeholder="One-line banner shown to every user…"
            value={val} onChange={(e) => setVal(e.target.value)} disabled={busy} />
        </div>
        <textarea className="finput" rows={4} maxLength={5000} disabled={busy}
          style={{ fontSize: 13, resize: 'vertical', fontFamily: 'inherit' }}
          placeholder={'Optional details shown behind “read more” — one thought per line.\nAttach screenshots with the button below; they appear as [img]… lines.'}
          value={details} onChange={(e) => setDetails(e.target.value)} />
        {details.trim() && (
          <div style={{ border: '1px dashed var(--border)', borderRadius: 8, padding: '6px 10px' }}>
            <div className="bnl-sub" style={{ marginBottom: 2 }}>preview</div>
            <AnnDetails text={details} />
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) attach(f); e.target.value = ''; }} />
          <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
            🖼 Attach screenshot
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={post} disabled={busy || !val.trim()}>Post</button>
          {ann && <button className="btn" onClick={clear} disabled={busy}>Retire banner</button>}
          <button className="btn" onClick={() => setEditing(false)} disabled={busy}>✕</button>
        </div>
      </div>
    );
  }

  if (!ann) {
    return (
      <div style={{ margin: '0 0 10px' }}>
        <button className="btn" style={{ fontSize: 11.5, padding: '2px 10px' }}
          onClick={() => { setVal(''); setDetails(''); setKind('notice'); setEditing(true); }}>
          📣 Post an announcement
        </button>
      </div>
    );
  }

  return (
    <div style={{
      margin: '0 0 14px', padding: '8px 14px', borderRadius: 8, fontSize: 13,
      background: 'var(--accent-light)', border: '1px solid var(--accent)',
      color: 'var(--strong)',
    }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <span aria-hidden="true">{ann.kind === 'update' ? '✨' : '📣'}</span>
        {ann.kind === 'update' && (
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--accent)',
            border: '1px solid var(--accent)', borderRadius: 999, padding: '0 7px',
            whiteSpace: 'nowrap' }}>
            DASHBOARD UPDATE
          </span>
        )}
        <span style={{ flex: 1 }}>{ann.body}</span>
        {ann.details && (
          <button className="btn" style={{ fontSize: 11, padding: '2px 8px' }}
            onClick={() => setExpanded((x) => !x)}>
            {expanded ? 'less ▴' : 'read more ▾'}
          </button>
        )}
        <a className="btn" href="/dashboard/announcements"
          title="Every notice and dashboard update, newest first"
          style={{ fontSize: 11, padding: '2px 8px', whiteSpace: 'nowrap', textDecoration: 'none' }}>
          🗂 All announcements
        </a>
        {isAdmin && (
          <button className="btn" style={{ fontSize: 11, padding: '2px 8px' }}
            onClick={() => {
              setVal(ann.body); setDetails(ann.details ?? '');
              setKind(ann.kind === 'update' ? 'update' : 'notice'); setEditing(true);
            }}>
            edit
          </button>
        )}
      </div>
      {expanded && ann.details && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--accent)' }}>
          <AnnDetails text={ann.details} />
        </div>
      )}
    </div>
  );
}
