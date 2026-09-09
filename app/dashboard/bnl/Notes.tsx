'use client';

import { useEffect, useState } from 'react';

export interface BnlNote {
  id: number;
  body: string;
  /** Author's auth id — lets the thread offer edit ONLY on own notes. */
  author_id?: string | null;
  /** Display name captured when the note was written. */
  author_name: string | null;
  /** Fallback when the author had no display name set. */
  author_email: string | null;
  created_at: string;
  /** Stamped by the edit trigger; null/absent = never edited. */
  edited_at?: string | null;
}

/** Prefer the person's name; fall back to their email, then to a neutral label.
 *  Both are snapshots from write time, so an old note keeps naming whoever
 *  actually wrote it even if their profile is later changed. */
function authorOf(n: BnlNote): string {
  return n.author_name?.trim() || n.author_email?.trim() || 'Unknown user';
}

/** '2026-07-23T14:05:12Z' → 'Jul 23, 2026 · 2:05 PM' */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

/**
 * Append-only case notes for one BNL client.
 *
 * Notes are never edited or deleted — the database has no UPDATE/DELETE policy,
 * so corrections are added as a new note. Author and timestamp come from the
 * session server-side; nothing here is trusted to set them.
 */
export default function Notes({ pid }: { pid: string }) {
  const [notes, setNotes] = useState<BnlNote[] | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Account-level write grant (bnl_write.sql) — the API says whether this
  // account may write; true until told otherwise so the composer doesn't
  // flash away from grandfathered writers while loading.
  const [canWrite, setCanWrite] = useState(true);
  // Note-EDIT grant (bnl_note_edit.sql, default off): pencil appears only on
  // the caller's OWN notes; the UPDATE policy is the real boundary.
  const [canEdit, setCanEdit] = useState(false);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [editBody, setEditBody] = useState('');

  useEffect(() => {
    let live = true;
    setNotes(null);
    setErr(null);
    setEditing(null);
    fetch(`/api/bnl/notes?pid=${encodeURIComponent(pid)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { notes: BnlNote[]; canWrite?: boolean; canEdit?: boolean; viewerId?: string }) => {
        if (live) {
          setNotes(j.notes);
          setCanWrite(j.canWrite !== false);
          setCanEdit(j.canEdit === true);
          setViewerId(j.viewerId ?? null);
        }
      })
      .catch(() => { if (live) { setNotes([]); setErr('Could not load notes.'); } });
    return () => { live = false; };
  }, [pid]);

  async function saveEdit(id: number) {
    const text = editBody.trim();
    if (!text || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/bnl/notes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, body: text }),
      });
      const j = await res.json();
      if (!res.ok) {
        setErr(j.error ?? 'Could not save the edit.');
      } else {
        setNotes((prev) => (prev ?? []).map((n) => (n.id === id ? (j.note as BnlNote) : n)));
        setEditing(null);
      }
    } catch {
      setErr('Could not save. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/bnl/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid, body: text }),
      });
      const j = await res.json();
      if (!res.ok) {
        setErr(j.error === 'forbidden' ? 'You do not have permission to add notes.' : (j.error ?? 'Could not save.'));
      } else {
        setNotes((prev) => [j.note as BnlNote, ...(prev ?? [])]);
        setBody('');
      }
    } catch {
      setErr('Could not save. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  const over = body.length > 4000;

  return (
    <div className="ncard">
      <div className="hc-h">
        <b>Notes</b>
        <span className="bnl-sub">
          {notes === null ? '' : `${notes.length} note${notes.length === 1 ? '' : 's'} · permanent record`}
        </span>
      </div>

      {canWrite ? (
        <>
          <textarea
            className="nc-input"
            placeholder={canEdit
              ? 'Add a note — include what was observed or agreed, and any follow-up. You can fix your own notes later; every change keeps its history.'
              : 'Add a note — include what was observed or agreed, and any follow-up. Notes cannot be edited or deleted once saved.'}
            value={body}
            rows={3}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
          />
          <div className="nc-actions">
            <span className={`bnl-sub${over ? ' nc-over' : ''}`}>
              {over ? `${body.length.toLocaleString()} / 4,000 — too long` : 'Ctrl+Enter to save · saved with your name and the date'}
            </span>
            <button className="nc-btn" onClick={submit} disabled={busy || !body.trim() || over}>
              {busy ? 'Saving…' : 'Add note'}
            </button>
          </div>
        </>
      ) : (
        <div className="bnl-sub" style={{ padding: '4px 0 8px' }}>
          Notes are read-only for your account — an administrator can grant note-writing in Users.
        </div>
      )}
      {err && <div className="nc-err">{err}</div>}

      {notes === null && <div className="hc-none">Loading notes…</div>}
      {notes?.length === 0 && <div className="hc-none">No notes yet.</div>}
      {notes?.map((n) => (
        <div className="nc-note" key={n.id}>
          <div className="nc-meta">
            <b title={n.author_email ?? undefined}>{authorOf(n)}</b>
            <span>
              {stamp(n.created_at)}
              {n.edited_at && (
                <span className="bnl-sub" title={`Edited ${stamp(n.edited_at)} — the previous text is kept in the audit history`}>
                  {' '}· edited
                </span>
              )}
              {canEdit && viewerId && n.author_id === viewerId && editing !== n.id && (
                <button className="tbtn" style={{ marginLeft: 8, padding: '0 7px', fontSize: 11 }}
                  title="Fix this note — your change is saved with an audit history"
                  onClick={() => { setEditing(n.id); setEditBody(n.body); setErr(null); }}>
                  ✎ edit
                </button>
              )}
            </span>
          </div>
          {editing === n.id ? (
            <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
              <textarea className="nc-input" rows={3} value={editBody} autoFocus
                onChange={(e) => setEditBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit(n.id);
                  if (e.key === 'Escape') setEditing(null);
                }} />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="bnl-sub">the previous text stays in the audit history</span>
                <span style={{ flex: 1 }} />
                <button className="nc-btn" disabled={busy || !editBody.trim() || editBody.length > 4000}
                  onClick={() => saveEdit(n.id)}>
                  {busy ? 'Saving…' : 'Save'}
                </button>
                <button className="tbtn" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="nc-body">{n.body}</div>
          )}
        </div>
      ))}
    </div>
  );
}
