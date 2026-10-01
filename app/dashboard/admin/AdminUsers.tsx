'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabaseBrowser } from '../../../lib/supabase-browser';
import { fmtInt, typeAbbr } from '../../../lib/format';

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
  /** Note-WRITING population scopes (bnl_write_pops.sql): which BNL
   *  populations this account may write notes on — 'all' or any of
   *  youth/vet/family/single/senior; empty = read-only. Meaningful only with
   *  bnlAccess; admins always write everywhere. */
  bnlWritePops: string[];
  /** May edit their OWN notes (bnl_note_edit.sql) — default off; every edit
   *  is history-archived by trigger. Admins always may. */
  bnlNoteEdit: boolean;
  /** Last HMIS P&P acknowledgment (policies_attestation.sql) — null = never;
   *  the dashboard gate renews it annually. Shown for compliance review. */
  policiesAttestedAt: string | null;
  /** Youth Connect (intake list + review + invites). Admins always have it. */
  ycAccess: boolean;
  /** Helpline Triage (call intake + assignment). Admins always have it. */
  hlAccess: boolean;
  /** Helpline SETTINGS management (teams, priority rules, resources, custom
   *  areas) without full dashboard admin — helpline_admin.sql. */
  hlAdmin: boolean;
  status: 'pending' | 'approved' | 'disabled';
  createdAt: string;
  /** auth.users.last_sign_in_at — stamped on fresh sign-ins only (a session
   *  kept alive by token refresh does NOT update it). Floor, not "last seen". */
  lastSignInAt: string | null;
  /** Two-factor state from Supabase Auth: 'on' = verified authenticator,
   *  'started' = unfinished setup only, null = none (or auth unreachable). */
  mfa: 'on' | 'started' | null;
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
  // The account list lives in CLIENT state and mutations patch one row in
  // place. The earlier router.refresh() re-rendered the whole page on every
  // grant/revoke and threw the admin back to the top of a long list (user
  // 2026-08-27). Props re-sync it whenever the server actually re-renders.
  const [list, setList] = useState(rows);
  useEffect(() => setList(rows), [rows]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);
  // Profile panel: which account is open (null = list only).
  const [selId, setSelId] = useState<string | null>(null);
  useEffect(() => {
    if (!selId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setSelId(null); setOpenFor(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selId]);
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

  // Admin 2FA reset (2026-10-01): deletes the user's authenticator factors so
  // they can enroll again (lost/changed phone). Server route checks is_admin
  // and writes an access_log 'mfa_reset' row.
  async function resetMfa(r: AdminProfile) {
    if (!confirm(`Reset two-factor sign-in for ${r.email}?

Their authenticator app stops working for this dashboard. They sign in with just their password, then set up two-factor again under Account. Until then they can't open the By-Name List or client names.`)) return;
    setBusy(r.id); setError(null);
    try {
      const res = await fetch('/api/admin/reset-mfa', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: r.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Reset failed');
      setList((prev) => prev.map((x) => (x.id === r.id ? { ...x, mfa: null } : x)));
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(null);
    }
  }

  const pending = list.filter((r) => r.status === 'pending');
  const others = list.filter((r) => r.status !== 'pending');
  const t = q.trim().toLowerCase();
  const shown = t
    ? others.filter((r) =>
        (r.displayName ?? '').toLowerCase().includes(t)
        || (r.email ?? '').toLowerCase().includes(t)
        || (r.agency ?? '').toLowerCase().includes(t))
    : others;

  async function run(id: string, fn: () => Promise<{ error: unknown }>, patch?: Partial<AdminProfile>) {
    setBusy(id); setError(null);
    const { error } = await fn();
    setBusy(null);
    if (error) { setError(String((error as any)?.message ?? error)); return; }
    if (patch) setList((l) => l.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  const db = () => supabaseBrowser();

  const setStatus = (r: AdminProfile, status: AdminProfile['status']) =>
    run(r.id, async () => db().from('profiles').update({
      status,
      approved_at: status === 'approved' ? new Date().toISOString() : null,
      approved_by: status === 'approved' ? me : null,
    }).eq('id', r.id), { status });

  const setAdmin = (r: AdminProfile, isAdmin: boolean) =>
    run(r.id, async () => db().from('profiles').update({ is_admin: isAdmin }).eq('id', r.id), { isAdmin });

  const setBnlAccess = (r: AdminProfile, bnl: boolean) =>
    run(r.id, async () => db().from('profiles').update({ bnl_access: bnl }).eq('id', r.id), { bnlAccess: bnl });

  // 'all' supersedes the specific scopes: turning it on clears them, and
  // picking a specific scope turns 'all' off.
  const toggleWritePop = (r: AdminProfile, k: string) => {
    let next: string[];
    if (k === 'all') next = r.bnlWritePops.includes('all') ? [] : ['all'];
    else {
      const base = r.bnlWritePops.filter((x) => x !== 'all');
      next = base.includes(k) ? base.filter((x) => x !== k) : [...base, k];
    }
    return run(r.id, async () => db().from('profiles').update({ bnl_write_pops: next }).eq('id', r.id), { bnlWritePops: next });
  };

  const setNoteEdit = (r: AdminProfile, on: boolean) =>
    run(r.id, async () => db().from('profiles').update({ bnl_note_edit: on }).eq('id', r.id), { bnlNoteEdit: on });

  const setYcAccess = (r: AdminProfile, yc: boolean) =>
    run(r.id, async () => db().from('profiles').update({ yc_access: yc }).eq('id', r.id), { ycAccess: yc });

  const setHlAccess = (r: AdminProfile, hl: boolean) =>
    run(r.id, async () => db().from('profiles').update({ helpline_access: hl }).eq('id', r.id), { hlAccess: hl });

  const setHlAdmin = (r: AdminProfile, on: boolean) =>
    run(r.id, async () => db().from('profiles').update({ helpline_admin: on }).eq('id', r.id), { hlAdmin: on });

  async function saveProjects(r: AdminProfile, ids: number[]) {
    await run(r.id, async () => {
      const del = await db().from('user_projects').delete().eq('user_id', r.id);
      if (del.error) return { error: del.error };
      if (!ids.length) return { error: null };
      return db().from('user_projects')
        .upsert(ids.map((project_id) => ({ user_id: r.id, project_id })),
          { onConflict: 'user_id,project_id' });
    }, { projectIds: ids });
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

  // A plain render FUNCTION, deliberately not a <Row> component: defined
  // inside AdminUsers, a component here gets a NEW identity every render, so
  // React unmounted and rebuilt every row on each state change — the page
  // height collapsed for a frame and the browser clamped scroll to the top
  // (the "list jumps to the top when I grant access" bug). A function call
  // renders inline in AdminUsers's own tree — no boundary, nothing remounts.
  //
  // Layout (user 2026-10-01): the list is a compact one-line-per-person index
  // with green access tags; clicking a row opens the profile panel where
  // every setting lives, grouped Account / Access / Projects / Security /
  // Activity.
  function row(r: AdminProfile) {
    const isMe = r.id === me;
    const open = () => { setSelId(r.id); setOpenFor(null); setError(null); };
    return (
      <tr key={r.id} className={`au-row${selId === r.id ? ' au-row-sel' : ''}`} tabIndex={0}
        onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open(); }}
        title="Open this user's profile">
        <td>
          <span className="nm">{r.displayName || '—'}</span>
          {isMe && <span className="ty">you</span>}
          <div style={{ fontSize: 11.5, color: 'var(--faint)' }}>{r.email}</div>
        </td>
        <td>{r.agency || <span style={{ color: 'var(--faint)' }}>—</span>}</td>
        <td>{statusPill(r.status)}</td>
        <td style={{ whiteSpace: 'nowrap' }}>{lastSignInCell(r)}{lastSeenSub(r)}</td>
        <td>{accessTags(r)}</td>
        <td className="num" style={{ color: 'var(--faint)', fontSize: 16 }} aria-hidden="true">›</td>
      </tr>
    );
  }

  // What this account can reach, at a glance (green = granted).
  function accessTags(r: AdminProfile) {
    const tags: [string, string][] = [];
    if (r.isAdmin) tags.push(['Admin', 'Full dashboard admin — every project and module']);
    else if (r.status === 'approved') {
      if (r.bnlAccess) tags.push(['BNL', 'By-Name List access']);
      if (r.hlAccess) tags.push([r.hlAdmin ? 'Helpline admin' : 'Helpline', 'Helpline Triage access']);
      if (r.ycAccess) tags.push(['Youth', 'Youth Intake access']);
    }
    return (
      <div className="au-tags">
        {tags.map(([t, title]) => <span key={t} className="pill good" title={title}>{t}</span>)}
        {r.mfa === 'on' && <span className="pill good" title="Two-factor sign-in is set up">2FA</span>}
        {!r.isAdmin && r.status === 'approved' && (
          <span className="au-sub">{fmtInt(r.projectIds.length)} project{r.projectIds.length === 1 ? '' : 's'}</span>
        )}
      </div>
    );
  }

  const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined,
    { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

  function profile(r: AdminProfile) {
    const isMe = r.id === me;
    const dis = busy === r.id;
    const approved = r.status === 'approved';
    const projName = new Map(projects.map((p) => [p.id, p.name]));
    const close = () => { setSelId(null); setOpenFor(null); };
    return (
      <div className="au-ov" onClick={(e) => e.target === e.currentTarget && close()}>
        <aside className="au-panel" role="dialog" aria-label={`Profile: ${r.displayName || r.email}`}>
          <div className="au-phead">
            <div className="au-avatar" aria-hidden="true">
              {(r.displayName || r.email || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2)
                .map((w) => w[0]?.toUpperCase()).join('')}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h3 style={{ margin: 0 }}>{r.displayName || '—'} {isMe && <span className="ty">you</span>}</h3>
              <div className="au-sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {r.email}{r.agency ? ` · ${r.agency}` : ''}
              </div>
            </div>
            {statusPill(r.status)}
            <button className="bnl-x" onClick={close} aria-label="Close">✕</button>
          </div>
          {error && <div className="lerror" style={{ margin: '10px 0 0' }} role="alert">{error}</div>}

          <section className="au-sec">
            <h4>Account</h4>
            <div className="au-btns">
              {r.status !== 'approved' && (
                <button className="tbtn" disabled={dis} onClick={() => setStatus(r, 'approved')}>Approve</button>
              )}
              {approved && !isMe && (
                <button className="tbtn" disabled={dis} onClick={() => setStatus(r, 'disabled')}>Disable account</button>
              )}
              {!isMe && (
                <button className={`tbtn${r.isAdmin ? ' tbtn-on' : ''}`} disabled={dis}
                  onClick={() => setAdmin(r, !r.isAdmin)}>
                  {r.isAdmin ? 'Revoke admin' : 'Make admin'}
                </button>
              )}
              {isMe && <span className="au-sub">You can&rsquo;t disable or demote your own account.</span>}
            </div>
            {r.status === 'pending' && (
              <p className="au-sub" style={{ marginTop: 6 }}>Approve first — access and projects can be set after.</p>
            )}
          </section>

          {approved && (
            <section className="au-sec">
              <h4>Access</h4>
              {r.isAdmin ? (
                <p className="au-sub">Admins have every module and every project — nothing to grant.</p>
              ) : (
                <>
                  <div className="au-btns">
                    <button className={`tbtn${r.bnlAccess ? ' tbtn-on' : ''}`} disabled={dis}
                      title="By-Name List contains real client names. Grant only to staff who need it."
                      onClick={() => setBnlAccess(r, !r.bnlAccess)}>
                      {r.bnlAccess ? '✓ ' : ''}By-Name List
                    </button>
                    <button className={`tbtn${r.hlAccess ? ' tbtn-on' : ''}`} disabled={dis}
                      title="Helpline Triage: call intake, triage queue, team assignment. For helpline operators and Trust staff."
                      onClick={() => setHlAccess(r, !r.hlAccess)}>
                      {r.hlAccess ? '✓ ' : ''}Helpline
                    </button>
                    {r.hlAccess && (
                      <button className={`tbtn${r.hlAdmin ? ' tbtn-on' : ''}`} disabled={dis}
                        title="Helpline SETTINGS: manage teams, priority rules, referral resources, custom routing areas, and queue pins — without full dashboard admin."
                        onClick={() => setHlAdmin(r, !r.hlAdmin)}>
                        {r.hlAdmin ? '✓ ' : ''}Helpline admin
                      </button>
                    )}
                    <button className={`tbtn${r.ycAccess ? ' tbtn-on' : ''}`} disabled={dis}
                      title="Youth Connect: intake list, review queue, invite links. Intended for Educate Tomorrow."
                      onClick={() => setYcAccess(r, !r.ycAccess)}>
                      {r.ycAccess ? '✓ ' : ''}Youth Intake
                    </button>
                  </div>
                  <p className="au-sub" style={{ marginTop: 6 }}>Green = granted. Click to grant or revoke.</p>
                  {/* Note-WRITING scopes (bnl_write_pops.sql, 2026-08-25):
                      per BNL population. Only meaningful with BNL access. */}
                  {r.bnlAccess && (
                    <div style={{ marginTop: 12 }}
                      title="Which BNL populations this account may WRITE notes on. A client in two populations is writable by either scope. None selected = read-only.">
                      <div className="au-k">BNL notes — may write on</div>
                      <div className="au-btns">
                        {([['all', 'All'], ['youth', 'Youth'], ['vet', 'Vet'], ['family', 'Family'],
                           ['single', 'Single'], ['senior', 'Senior']] as const).map(([k, lbl]) => (
                          <button key={k} disabled={dis}
                            className={`tbtn${r.bnlWritePops.includes(k) ? ' tbtn-on' : ''}`}
                            style={k !== 'all' && r.bnlWritePops.includes('all') ? { opacity: 0.45 } : undefined}
                            onClick={() => toggleWritePop(r, k)}>
                            {lbl}
                          </button>
                        ))}
                        <button disabled={dis} className={`tbtn${r.bnlNoteEdit ? ' tbtn-on' : ''}`}
                          title="May EDIT their own notes (typo fixes). Default off; every edit keeps the previous text in an audit history. Deleting is never possible."
                          onClick={() => setNoteEdit(r, !r.bnlNoteEdit)}>
                          ✎ Edit own
                        </button>
                      </div>
                      {!r.bnlWritePops.length && <p className="au-sub" style={{ marginTop: 4 }}>None selected — read-only on the BNL.</p>}
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {approved && !r.isAdmin && (
            <section className="au-sec">
              <h4>Projects · {fmtInt(r.projectIds.length)}</h4>
              {openFor === r.id ? (
                <ProjectPicker
                  projects={projects}
                  initial={r.projectIds}
                  onCancel={() => setOpenFor(null)}
                  onSave={(ids) => saveProjects(r, ids)}
                />
              ) : (
                <>
                  <div className="au-projlist">
                    {r.projectIds.length
                      ? r.projectIds.map((id) => projName.get(id) ?? `Project ${id}`)
                          .sort((x, y) => x.localeCompare(y))
                          .map((n, i) => <div key={`${n}-${i}`}>{n}</div>)
                      : <span className="au-sub">No projects assigned — they&rsquo;ll see no project data.</span>}
                  </div>
                  <button className="tbtn" style={{ marginTop: 8 }} onClick={() => setOpenFor(r.id)}>Edit projects</button>
                </>
              )}
            </section>
          )}

          <section className="au-sec">
            <h4>Security</h4>
            <div className="au-kv"><span>Two-factor sign-in</span>
              <span style={{ color: r.mfa === 'on' ? 'var(--accent)' : 'var(--muted)', fontWeight: 600 }}>
                {r.mfa === 'on' ? 'On' : r.mfa === 'started' ? 'Setup started, not finished' : 'Not set up'}
              </span>
            </div>
            <div className="au-btns" style={{ marginTop: 8 }}>
              <button className="tbtn" disabled={dis} onClick={() => resetPassword(r)}>Reset password</button>
            </div>
            {r.mfa && !isMe && (
              <div className="au-danger">
                <button className="tbtn au-tbtn-danger" disabled={dis}
                  title={r.mfa === 'on'
                    ? 'Removes their authenticator — use when they lost or changed phones.'
                    : 'Clears an unfinished two-factor setup so they can start over.'}
                  onClick={() => resetMfa(r)}>
                  {r.mfa === 'on' ? 'Reset 2FA (authenticator)' : 'Clear 2FA setup'}
                </button>
                <span className="au-sub">
                  Doesn&rsquo;t change their password. They sign in with their password, then set up two-factor again under My account.
                </span>
              </div>
            )}
            {isMe && r.mfa && <p className="au-sub" style={{ marginTop: 6 }}>Manage your own two-factor under My account.</p>}
          </section>

          <section className="au-sec">
            <h4>Activity</h4>
            <div className="au-kv"><span>Last seen</span><span>{r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : '—'}</span></div>
            <div className="au-kv"><span>Last sign-in</span><span>{r.lastSignInAt ? new Date(r.lastSignInAt).toLocaleString() : 'never'}</span></div>
            {approved && (
              <div className="au-kv"><span>Policies &amp; Procedures</span>
                <span>{r.policiesAttestedAt ? `acknowledged ${fmtDate(r.policiesAttestedAt)}` : <span style={{ color: 'var(--danger)' }}>not acknowledged</span>}</span>
              </div>
            )}
            <div className="au-kv"><span>Account created</span><span>{fmtDate(r.createdAt)}</span></div>
          </section>
        </aside>
      </div>
    );
  }

  const sel = selId ? list.find((r) => r.id === selId) ?? null : null;

  const thead = (
    <thead>
      <tr><th>User</th><th>Agency</th><th>Status</th>
        <th title="Top: last credential sign-in (Supabase Auth). Below: last real activity in the dashboard — persistent sessions make sign-in alone misleading.">Last sign-in · seen</th>
        <th>Access</th><th className="num" aria-label="Open" /></tr>
    </thead>
  );

  return (
    <>
      {error && !sel && <div className="lerror" style={{ marginBottom: 14 }} role="alert">{error}</div>}

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
            Shown once — it isn&rsquo;t stored anywhere and can&rsquo;t be retrieved again. Send it to the
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
                ? `${fmtInt(pending.length)} awaiting approval · click a request to review it`
                : 'Nothing waiting'}
            </div>
          </div>
        </div>
        {pending.length > 0 && (
          <div className="scroll">
            <table>{thead}<tbody>{pending.map(row)}</tbody></table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-h">
          <div>
            <h3>All accounts</h3>
            <div className="meta">
              {t ? `${fmtInt(shown.length)} of ${fmtInt(others.length)} shown` : `${fmtInt(list.length)} total`}
              {' '}· click a user to open their profile
            </div>
          </div>
          <input className="finput" placeholder="Search name, email, or agency…"
            value={q} onChange={(e) => setQ(e.target.value)}
            style={{ minWidth: 240 }} aria-label="Search accounts" />
        </div>
        <div className="scroll">
          <table>
            {thead}
            <tbody>
              {shown.map(row)}
              {!others.length && <tr><td colSpan={6} className="empty">No approved accounts yet.</td></tr>}
              {others.length > 0 && !shown.length && (
                <tr><td colSpan={6} className="empty">No accounts match “{q.trim()}”.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {sel && profile(sel)}
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
            <span className="ty">{typeAbbr(p.type)}</span>
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
