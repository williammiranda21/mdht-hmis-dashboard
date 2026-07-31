'use client';

import { useEffect, useState } from 'react';

/**
 * Action notes on a worklist client (Pillar 3-4).
 *
 * Deliberately the SAME thread as the BNL drawer notes — one conversation per
 * client, not per list — so a note typed at Monday's worklist review is what a
 * case manager sees when they open the client in the By-Name List, and vice
 * versa. Reads/writes /api/bnl/notes (append-only bnl_notes; author + timestamp
 * come from the session server-side; can_see_bnl RLS is the boundary, which
 * matches the Deep Dive page gate).
 */

interface Note { id: number; body: string; author_name: string | null; author_email: string | null; created_at: string }

export default function WorklistNotes({ pid, name, onClose, onPosted }: {
  pid: string; name: string; onClose: () => void; onPosted: () => void;
}) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    fetch(`/api/bnl/notes?pid=${encodeURIComponent(pid)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => setNotes(j.notes ?? []))
      .catch(() => setErr('Could not load notes.'));
  };
  useEffect(load, [pid]);

  const post = () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true); setErr(null);
    fetch('/api/bnl/notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid, body: text }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(() => { setBody(''); load(); onPosted(); })
      .catch(() => setErr('Could not save the note.'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="bnl-ov" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bnl-modal" style={{ maxWidth: 560 }}>
        <button className="bnl-x" onClick={onClose}>✕</button>
        <h3>Action notes</h3>
        <div className="bnl-sub" style={{ marginTop: 2 }}>
          {name} — shared with the By-Name List drawer (one thread per client)
        </div>

        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <textarea className="finput" rows={2} style={{ flex: 1, resize: 'vertical' }}
            placeholder="What was decided / who is following up…"
            value={body} onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) post(); }} />
          <button className="btn" disabled={!body.trim() || busy} onClick={post}>
            {busy ? 'Saving…' : 'Add note'}
          </button>
        </div>
        {err && <div className="bnl-dq" style={{ marginTop: 8 }}>{err}</div>}

        <div style={{ marginTop: 14, display: 'grid', gap: 10, maxHeight: 320, overflowY: 'auto' }}>
          {notes == null && !err && <div className="hc-none">Loading notes…</div>}
          {notes != null && notes.length === 0 && (
            <div className="hc-none">No notes yet — the first one starts the thread.</div>
          )}
          {(notes ?? []).map((n) => (
            <div key={n.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px' }}>
              <div className="bnl-sub">
                {n.author_name || n.author_email || 'Unknown'} · {new Date(n.created_at).toLocaleString()}
              </div>
              <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{n.body}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
