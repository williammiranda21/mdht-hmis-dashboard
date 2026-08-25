'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '../../../lib/supabase-browser';
import { fmtInt } from '../../../lib/format';

export interface AdminProfile {
  id: string;
  email: string | null;
  displayName: string | null;
  agency: string | null;
  isAdmin: boolean;
  /** Grants By-Name List + notes access WITHOUT making the user an admin.
   *  Admins always have it (can_see_bnl() ORs the two), so this only matters
   *  for non-admins. The BNL contains real names — grant sparingly. */
  bnlAccess: boolean;
  /** May WRITE BNL notes (bnl_write.sql) — meaningful only with bnlAccess;
   *  admins always write. Reading notes rides bnlAccess. */
  bnlWrite: boolean;
  /** Youth Connect (intake list + review + invites). Admins always have it. */
  ycAccess: boolean;
  /** Helpline Triage (call intake + assignment). Admins always have it. */
  hlAccess: boolean;
  status: 'pending' | 'approved' | 'disabled';
  createdAt: string;
  /** auth.users.last_sign_in_at — stamped on fresh sign-ins only (a session
   *  kept alive by token refresh does NOT update it). Floor, not "last seen". */
  lastSignInAt: string | null;
  /** profiles.last_seen_at — real usage, stamped by /api/seen while the user
   *  is active in the dashboard. Null until supabase/last_seen.sql runs (or
   *  the user's first visit after this shipped). */
  lastSeenAt: string | null;
  projectIds: number[];
}
export interface ProjectOption { id: number; name: string; type: string }

/**
 * All writes go through the browser client carrying the admin's own session,
 * so the "admins update profiles" / "admins manage grants" RLS policies are
 * what actually authorises them — the UI is just a convenience.
 */
export default function AdminUsers({
  me, rows, projects,
}: { me: string; rows: AdminProfile[]; projects: ProjectOption[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // Search over the All-accounts list (name / email / agency, case-insensitive).
  const [q, setQ] = useState('');

  async function resetPassword(r: AdminProfile) {
    if (!confirm(`Reset the password for ${r.email}?\n\nTheir current password stops working immediately. You'll get a temporary one to pass along.`)) return;
    setBusy(r.id); setError(null); setIssued(null); setCopied(false);
    try {
      const res = await fetch('/api/admin/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: r.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Reset failed');
      setIssued({ email: json.email, password: json.password });
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(null);
    }
  }

  const pending = rows.filter((r) => r.status === 'pending');
  const others = rows.filter((r) => r.status !== 'pending');
  const t = q.trim().toLowerCase();
  const shown = t
    ? others.filter((r) =>
        (r.displayName ?? '').toLowerCase().includes(t)
        || (r.email ?? '').toLowerCase().includes(t)
        || (r.agency ?? '').toLowerCase().includes(t))
    : others;

  async function run(id: string, fn: () => Promise<{ error: unknown }>) {
    setBusy(id); setError(null);
    const { error } = await fn();
    setBusy(null);
    if (error) { setError(String((error as any)?.message ?? error)); return; }
    router.refresh();
  }

  const db = () => supabaseBrowser();

  const setStatus = (r: AdminProfile, status: AdminProfile['status']) =>
    run(r.id, async () => db().from('profiles').update({
      status,
      approved_at: status === 'approved' ? new Date().toISOString() : null,
      approved_by: status === 'approved' ? me : null,
    }).eq('id', r.id));

  const setAdmin = (r: AdminProfile, isAdmin: boolean) =>
    run(r.id, async () => db().from('profiles').update({ is_admin: isAdmin }).eq('id', r.id));

  const setBnlAccess = (r: AdminProfile, bnl: boolean) =>
    run(r.id, async () => db().from('profiles').update({ bnl_access: bnl }).eq('id', r.id));

  const setBnlWrite = (r: AdminProfile, w: boolean) =>
    run(r.id, async () => db().from('profiles').update({ bnl_write: w }).eq('id', r.id));

  const setYcAccess = (r: AdminProfile, yc: boolean) =>
    run(r.id, async () => db().from('profiles').update({ yc_access: yc }).eq('id', r.id));

  const setHlAccess = (r: AdminProfile, hl: boolean) =>
    run(r.id, async () => db().from('profiles').update({ helpline_access: hl }).eq('id', r.id));

  async function saveProjects(r: AdminProfile, ids: number[]) {
    await run(r.id, async () => {
      const del = await db().from('user_projects').delete().eq('user_id', r.id);
      if (del.error) return { error: del.error };
      if (!ids.length) return { error: null };
      return db().from('user_projects')
        .upsert(ids.map((project_id) => ({ user_id: r.id, project_id })),
          { onConflict: 'user_id,project_id' });
    });
    setOpenFor(null);
  }

  const statusPill = (s: AdminProfile['status']) =>
    s === 'approved' ? <span className="pill good">approved</span>
      : s === 'pending' ? <span className="pill warn">pending</span>
      : <span className="pill bad">disabled</span>;

  // Idle accounts jump out (the user reviews this list to reclaim seats):
  // recent = plain text · 14d+ idle = warn pill · never signed in = bad pill.
  function lastSignInCell(r: AdminProfile) {
    if (!r.lastSignInAt) {
      return <span className="pill bad" title="Has never signed in">never</span>;
    }
    const d = new Date(r.lastSignInAt);
    const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
    const label = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`;
    const title = `Last sign-in ${d.toLocaleString()} — sessions kept alive by token refresh don't update this`;
    return days >= 14
      ? <span className="pill warn" title={title}>{label}</span>
      : <span title={title}>{label}</span>;
  }

  // Real usage (profiles.last_seen_at) — the answer to "sign-in says 20d ago
  // but I know they were in here yesterday": persistent sessions don't stamp
  // a sign-in, the /api/seen heartbeat stamps this.
  function lastSeenSub(r: AdminProfile) {
    if (!r.lastSeenAt) return null;
    const d = new Date(r.lastSeenAt);
    const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
    const label = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`;
    return (
      <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}
        title={`Last activity in the dashboard ${d.toLocaleString()} — stamped while they actually use it, sign-in or not`}>
        seen {label}
      </div>
    );
  }

  function Row({ r }: { r: AdminProfile }) {
    const isMe = r.id === me;
    return (
      <>
        <tr>
          <td>
            <span className="nm">{r.displayName || '—'}</span>
            {isMe && <span className="ty">you</span>}
            <div style={{ fontSize: 11.5, color: 'var(--faint)' }}>{r.email}</div>
          </td>
          <td>{r.agency || <span style={{ color: 'var(--faint)' }}>—</span>}</td>
          <td>{statusPill(r.status)}</td>
          <td style={{ whiteSpace: 'nowrap' }}>{lastSignInCell(r)}{lastSeenSub(r)}</td>
          <td className="num">
            {r.isAdmin ? (
              <span className="pill good" title="Admins see every project — grants aren't used">
                all projects
              </span>
            ) : (
              <button className="tbtn" onClick={() => setOpenFor(openFor === r.id ? null : r.id)}>
                {openFor === r.id ? 'Close' : `Edit projects (${fmtInt(r.projectIds.length)})`}
              </button>
            )}
          </td>
          {/* Actions wrap within the cell (no horizontal scroll). Access toggles
              turn GREEN when granted, so an admin sees at a glance what each user
              can reach — the green ones are their active accesses. */}
          <td className="num">
            <div className="au-actions">
              {r.status !== 'approved' && (
                <button className="tbtn" disabled={busy === r.id}
                  onClick={() => setStatus(r, 'approved')}>Approve</button>
              )}
              {r.status === 'approved' && !isMe && (
                <button className="tbtn" disabled={busy === r.id}
                  onClick={() => setStatus(r, 'disabled')}>Disable</button>
              )}
              {!isMe && (
                <button className={`tbtn${r.isAdmin ? ' tbtn-on' : ''}`} disabled={busy === r.id}
                  onClick={() => setAdmin(r, !r.isAdmin)}>
                  {r.isAdmin ? 'Revoke admin' : 'Make admin'}
                </button>
              )}
              {/* Admins already have BNL access via can_see_bnl(), so this toggle
                  would be a no-op for them — only show it for non-admins. */}
              {!r.isAdmin && r.status === 'approved' && (
                <button className={`tbtn${r.bnlAccess ? ' tbtn-on' : ''}`} disabled={busy === r.id}
                  title="By-Name List contains real client names. Grant only to staff who need it."
                  onClick={() => setBnlAccess(r, !r.bnlAccess)}>
                  {r.bnlAccess ? 'Revoke BNL access' : 'Grant BNL access'}
                </button>
              )}
              {/* Note-WRITING is a separate account-level grant (bnl_write.sql,
                  user directive 2026-08-25) — only meaningful with BNL access. */}
              {!r.isAdmin && r.status === 'approved' && r.bnlAccess && (
                <button className={`tbtn${r.bnlWrite ? ' tbtn-on' : ''}`} disabled={busy === r.id}
                  title="Whether this account may WRITE case notes on the By-Name List (all populations). Reading notes rides BNL access; writing is this switch."
                  onClick={() => setBnlWrite(r, !r.bnlWrite)}>
                  {r.bnlWrite ? 'Revoke notes' : 'Grant notes'}
                </button>
              )}
              {!r.isAdmin && r.status === 'approved' && (
                <button className={`tbtn${r.ycAccess ? ' tbtn-on' : ''}`} disabled={busy === r.id}
                  title="Youth Connect: intake list, review queue, invite links. Intended for Educate Tomorrow."
                  onClick={() => setYcAccess(r, !r.ycAccess)}>
                  {r.ycAccess ? 'Revoke Youth Intake' : 'Grant Youth Intake'}
                </button>
              )}
              {!r.isAdmin && r.status === 'approved' && (
                <button className={`tbtn${r.hlAccess ? ' tbtn-on' : ''}`} disabled={busy === r.id}
                  title="Helpline Triage: call intake, triage queue, team assignment. For helpline operators and Trust staff."
                  onClick={() => setHlAccess(r, !r.hlAccess)}>
                  {r.hlAccess ? 'Revoke Helpline' : 'Grant Helpline'}
                </button>
              )}
              <button className="tbtn" disabled={busy === r.id}
                onClick={() => resetPassword(r)}>Reset password</button>
            </div>
          </td>
        </tr>
        {openFor === r.id && (
          <tr>
            <td colSpan={6} style={{ background: 'var(--rowhover)' }}>
              <ProjectPicker
                projects={projects}
                initial={r.projectIds}
                onCancel={() => setOpenFor(null)}
                onSave={(ids) => saveProjects(r, ids)}
              />
            </td>
          </tr>
        )}
      </>
    );
  }

  return (
    <>
      {error && <div className="lerror" style={{ marginBottom: 14 }} role="alert">{error}</div>}

      {issued && (
        <div className="pwpanel" role="status">
          <div className="pwhead">
            <strong>Temporary password for {issued.email}</strong>
            <button className="tbtn" onClick={() => setIssued(null)}>Dismiss</button>
          </div>
          <div className="pwrow">
            <code className="pwcode">{issued.password}</code>
            <button
              className="btn"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(issued.password);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch { /* clipboard blocked — user can select the text */ }
              }}
            >
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          </div>
          <p className="pwnote">
            Shown once — it isn’t stored anywhere and can’t be retrieved again. Send it to the
            user over a channel you trust (not email if you can avoid it), and tell them to change
            it from <strong>My account</strong> after signing in. Their old password already stopped
            working.
          </p>
        </div>
      )}

      <div className="panel" style={{ marginBottom: 18 }}>
        <div className="panel-h">
          <div>
            <h3>Pending requests</h3>
            <div className="meta">
              {pending.length
                ? `${fmtInt(pending.length)} awaiting approval · assign projects after approving`
                : 'Nothing waiting'}
            </div>
          </div>
        </div>
        {pending.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr><th>User</th><th>Agency</th><th>Status</th><th title="Top: last credential sign-in (Supabase Auth). Below: last real activity in the dashboard (/api/seen heartbeat) — persistent sessions make sign-in alone misleading.">Last sign-in · seen</th><th className="num">Scope</th><th className="num">Actions</th></tr>
              </thead>
              <tbody>{pending.map((r) => <Row key={r.id} r={r} />)}</tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-h">
          <div>
            <h3>All accounts</h3>
            <div className="meta">
              {t ? `${fmtInt(shown.length)} of ${fmtInt(others.length)} shown` : `${fmtInt(rows.length)} total`}
              {' '}· admins see every project
            </div>
          </div>
          <input className="finput" placeholder="Search name, email, or agency…"
            value={q} onChange={(e) => setQ(e.target.value)}
            style={{ minWidth: 240 }} aria-label="Search accounts" />
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr><th>User</th><th>Agency</th><th>Status</th><th title="Top: last credential sign-in (Supabase Auth). Below: last real activity in the dashboard (/api/seen heartbeat) — persistent sessions make sign-in alone misleading.">Last sign-in · seen</th><th className="num">Scope</th><th className="num">Actions</th></tr>
            </thead>
            <tbody>
              {shown.map((r) => <Row key={r.id} r={r} />)}
              {!others.length && <tr><td colSpan={6} className="empty">No approved accounts yet.</td></tr>}
              {others.length > 0 && !shown.length && (
                <tr><td colSpan={6} className="empty">No accounts match “{q.trim()}”.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function ProjectPicker({
  projects, initial, onSave, onCancel,
}: { projects: ProjectOption[]; initial: number[]; onSave: (ids: number[]) => void; onCancel: () => void }) {
  const [sel, setSel] = useState<Set<number>>(new Set(initial));
  const [q, setQ] = useState('');

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? projects.filter((p) => p.name.toLowerCase().includes(t)) : projects;
  }, [projects, q]);

  const toggle = (id: number) =>
    setSel((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  return (
    <div style={{ padding: '12px 4px' }}>
      <div className="uctl" style={{ margin: '0 0 10px' }}>
        <input className="finput" placeholder="Filter projects…" value={q}
          onChange={(e) => setQ(e.target.value)} />
        <span className="seglbl">{fmtInt(sel.size)} selected</span>
        <span className="fspacer" />
        <button className="tbtn" onClick={() => setSel(new Set(shown.map((p) => p.id)))}>
          Select shown
        </button>
        <button className="tbtn" onClick={() => setSel(new Set())}>Clear</button>
      </div>
      <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
        {shown.map((p) => (
          <label key={p.id} className="colmenu-row">
            <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} />
            <span style={{ flex: 1 }}>{p.name}</span>
            <span className="ty">{p.type}</span>
          </label>
        ))}
        {!shown.length && <div className="empty" style={{ padding: 20 }}>No projects match.</div>}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn primary" onClick={() => onSave([...sel])}>Save projects</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
