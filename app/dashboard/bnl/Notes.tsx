'use client';

import { useEffect, useState } from 'react';

export interface BnlNote {
  id: number;
  body: string;
  /** Display name captured when the note was written. */
  author_name: string | null;
  /** Fallback when the author had no display name set. */
  author_email: string | null;
  created_at: string;
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

  useEffect(() => {
    let live = true;
    setNotes(null);
    setErr(null);
    fetch(`/api/bnl/notes?pid=${encodeURIComponent(pid)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { notes: BnlNote[] }) => { if (live) setNotes(j.notes); })
      .catch(() => { if (live) { setNotes([]); setErr('Could not load notes.'); } });
    return () => { live = false; };
  }, [pid]);

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

      <textarea
        className="nc-input"
        placeholder="Add a note — include what was observed or agreed, and any follow-up. Notes cannot be edited or deleted once saved."
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
      {err && <div className="nc-err">{err}</div>}

      {notes === null && <div className="hc-none">Loading notes…</div>}
      {notes?.length === 0 && <div className="hc-none">No notes yet.</div>}
      {notes?.map((n) => (
        <div className="nc-note" key={n.id}>
          <div className="nc-meta">
            <b title={n.author_email ?? undefined}>{authorOf(n)}</b>
            <span>{stamp(n.created_at)}</span>
          </div>
          <div className="nc-body">{n.body}</div>
        </div>
      ))}
    </div>
  );
}
