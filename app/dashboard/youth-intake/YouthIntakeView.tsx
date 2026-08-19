'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '../../../lib/supabase-browser';
import { fmtInt } from '../../../lib/format';

export interface Intake {
  id: number;
  created_at: string;
  source: 'self' | 'staff';
  status: 'pending' | 'matched' | 'no_match' | 'rejected';
  first_name: string | null;
  last_name: string | null;
  dob: string | null;
  ssn4: string | null;
  contact: string | null;
  sleeping: string | null;
  school_work: string | null;
  unsafe: string | null;
  notes: string | null;
  matched_pid: string | null;
  matched_at: string | null;
}
export interface Invite {
  token: string;
  label: string | null;
  created_at: string;
  expires_at: string | null;
  max_uses: number;
  uses: number;
  disabled: boolean;
}
interface Candidate {
  pid: string; name: string; dob: string | null; score: number; why: string[];
  bnl: { status: string | null; project: string | null; last_contact: string | null } | null;
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function nameOf(r: Intake): string {
  return [r.first_name, r.last_name].filter(Boolean).join(' ') || '(no name given)';
}

const STATUS_PILL: Record<Intake['status'], JSX.Element> = {
  pending: <span className="pill warn">pending review</span>,
  matched: <span className="pill good">matched</span>,
  no_match: <span className="pill">awaiting HMIS entry</span>,
  rejected: <span className="pill bad">rejected</span>,
};

/**
 * Youth Connect internal portal. All writes go through the browser client
 * carrying the viewer's own session — the can_see_yc() RLS policies authorize
 * them; this UI is a convenience. Matching goes through /api/yc/match (the
 * only reader of client_index).
 */
export default function YouthIntakeView({ me, intakes, invites, sqlMissing }: {
  me: string; intakes: Intake[]; invites: Invite[]; sqlMissing: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [cands, setCands] = useState<Record<number, Candidate[] | 'loading'>>({});
  const [showInvites, setShowInvites] = useState(false);
  const [inviteLabel, setInviteLabel] = useState('');
  const [newLink, setNewLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const db = () => supabaseBrowser();

  async function run(fn: () => Promise<{ error: unknown }>) {
    setBusy(true); setError(null);
    const { error: e } = await fn();
    setBusy(false);
    if (e) { setError(String((e as any)?.message ?? e)); return false; }
    router.refresh();
    return true;
  }

  async function findMatches(id: number) {
    setOpenId(id);
    setCands((p) => ({ ...p, [id]: 'loading' }));
    try {
      const res = await fetch(`/api/yc/match?id=${id}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'match failed');
      setCands((p) => ({ ...p, [id]: j.candidates as Candidate[] }));
    } catch (e) {
      setError(String((e as Error).message));
      setCands((p) => ({ ...p, [id]: [] }));
    }
  }

  const confirm = (r: Intake, pid: string) =>
    run(async () => db().from('youth_intakes').update({
      matched_pid: pid, status: 'matched', matched_by: me,
      matched_at: new Date().toISOString(),
    }).eq('id', r.id));

  const setStatus = (r: Intake, status: Intake['status']) =>
    run(async () => db().from('youth_intakes').update({
      status,
      // leaving no_match/rejected clears a stale link; matched is set via confirm()
      ...(status !== 'matched' ? { matched_pid: null, matched_at: null } : {}),
    }).eq('id', r.id));

  async function createInvite() {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const ok = await run(async () => db().from('intake_invites').insert({
      token, label: inviteLabel.trim() || null, created_by: me,
    }));
    if (ok) {
      setNewLink(`${window.location.origin}/yc/${token}`);
      setInviteLabel('');
      setCopied(false);
    }
  }

  const toggleInvite = (v: Invite) =>
    run(async () => db().from('intake_invites').update({ disabled: !v.disabled }).eq('token', v.token));

  const pending = intakes.filter((r) => r.status === 'pending');
  const rest = intakes.filter((r) => r.status !== 'pending');

  function Details({ r }: { r: Intake }) {
    return (
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, lineHeight: 1.6 }}>
        {r.dob && <>DOB {r.dob} · </>}
        {r.contact && <>reach: <b style={{ color: 'var(--text, inherit)' }}>{r.contact}</b> · </>}
        {r.sleeping && <>sleeping: {r.sleeping} · </>}
        {r.unsafe && <>unsafe: {r.unsafe} · </>}
        {r.school_work && <>school/work: {r.school_work}</>}
        {r.notes && (
          <div style={{ marginTop: 3 }}>
            <span className="ty">notes</span> {r.notes}
          </div>
        )}
      </div>
    );
  }

  function MatchPanel({ r }: { r: Intake }) {
    const c = cands[r.id];
    return (
      <div style={{ padding: '4px 10px 14px' }}>
        {c === 'loading' && <div className="meta">Searching HMIS…</div>}
        {Array.isArray(c) && c.length === 0 && (
          <div className="meta" style={{ marginBottom: 8 }}>
            No HMIS candidates found — if they&rsquo;re genuinely new, flag them for HMIS entry.
          </div>
        )}
        {Array.isArray(c) && c.map((m) => (
          <div key={m.pid} style={{
            border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px', marginBottom: 8,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <span className="nm" style={{ textTransform: 'capitalize' }}>{m.name || '(no name)'}</span>
              <b>{m.score}%</b>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--faint)' }}>
              {m.why.join(' · ')}
              {m.bnl && <> · BNL: {m.bnl.status ?? '?'}{m.bnl.project ? ` @ ${m.bnl.project}` : ''}
                {m.bnl.last_contact ? ` · last contact ${m.bnl.last_contact}` : ''}</>}
              {!m.bnl && ' · not on the BNL'}
            </div>
            <div style={{ marginTop: 6 }}>
              <button className="tbtn" disabled={busy} onClick={() => confirm(r, m.pid)}>Confirm match</button>
              <button className="tbtn" style={{ marginLeft: 6 }}
                onClick={() => setCands((p) => ({
                  ...p, [r.id]: (p[r.id] as Candidate[]).filter((x) => x.pid !== m.pid),
                }))}>Not them</button>
            </div>
          </div>
        ))}
        {Array.isArray(c) && (
          <button className="tbtn" disabled={busy} onClick={() => setStatus(r, 'no_match')}>
            No match — flag for HMIS entry
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      {sqlMissing && (
        <div className="lerror" style={{ marginBottom: 14 }} role="alert">
          Youth Connect tables aren&rsquo;t set up yet — run supabase/youth_connect.sql in the
          Supabase SQL editor, then reload.
        </div>
      )}
      {error && <div className="lerror" style={{ marginBottom: 14 }} role="alert">{error}</div>}

      <div className="panel" style={{ marginBottom: 18 }}>
        <div className="panel-h">
          <div>
            <h3>Review queue</h3>
            <div className="meta">
              {pending.length
                ? `${fmtInt(pending.length)} waiting · match to HMIS, or flag for entry`
                : 'Nothing waiting — new submissions land here'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="tbtn" onClick={() => setShowInvites(!showInvites)}>
              {showInvites ? 'Close invite links' : `Invite links (${fmtInt(invites.filter((v) => !v.disabled).length)})`}
            </button>
            <Link className="btn primary" href="/dashboard/youth-intake/new">New intake</Link>
          </div>
        </div>

        {showInvites && (
          <div style={{ padding: '0 10px 14px' }}>
            <div className="meta" style={{ margin: '4px 0 8px' }}>
              A link (or its QR code) is how youth reach the self-entry portal — print it on
              outreach cards, posters, or send it directly. Disable a link to retire it.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              <input className="finput" placeholder="Label — e.g. Outreach cards Sept"
                value={inviteLabel} onChange={(e) => setInviteLabel(e.target.value)}
                style={{ minWidth: 240 }} />
              <button className="btn" disabled={busy} onClick={createInvite}>Create link</button>
            </div>
            {newLink && (
              <div className="pwpanel" role="status" style={{ marginBottom: 10 }}>
                <div className="pwrow">
                  <code className="pwcode" style={{ fontSize: 12 }}>{newLink}</code>
                  <button className="btn" onClick={async () => {
                    try { await navigator.clipboard.writeText(newLink); setCopied(true);
                      setTimeout(() => setCopied(false), 1500); } catch {}
                  }}>{copied ? 'Copied ✓' : 'Copy'}</button>
                </div>
              </div>
            )}
            {invites.length > 0 && (
              <div className="scroll"><table>
                <thead><tr><th>Label</th><th>Created</th><th className="num">Uses</th><th>Status</th><th className="num">Actions</th></tr></thead>
                <tbody>
                  {invites.map((v) => (
                    <tr key={v.token}>
                      <td>{v.label || <span style={{ color: 'var(--faint)' }}>—</span>}
                        <div style={{ fontSize: 11, color: 'var(--faint)' }}>/yc/{v.token.slice(0, 8)}…</div></td>
                      <td>{when(v.created_at)}</td>
                      <td className="num">{fmtInt(v.uses)} / {fmtInt(v.max_uses)}</td>
                      <td>{v.disabled ? <span className="pill bad">disabled</span> : <span className="pill good">active</span>}</td>
                      <td className="num">
                        <button className="tbtn" onClick={async () => {
                          try { await navigator.clipboard.writeText(`${window.location.origin}/yc/${v.token}`); } catch {}
                        }}>Copy link</button>
                        <button className="tbtn" style={{ marginLeft: 6 }} disabled={busy}
                          onClick={() => toggleInvite(v)}>{v.disabled ? 'Re-enable' : 'Disable'}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </div>
        )}

        {pending.length > 0 && (
          <div className="scroll"><table>
            <thead><tr><th>Received</th><th>Youth</th><th>Source</th><th className="num">Actions</th></tr></thead>
            <tbody>
              {pending.map((r) => (
                <FragmentRow key={r.id} r={r} openId={openId} busy={busy}
                  onFind={() => findMatches(r.id)} onReject={() => setStatus(r, 'rejected')}
                  Details={Details} MatchPanel={MatchPanel} />
              ))}
            </tbody>
          </table></div>
        )}
      </div>

      <div className="panel">
        <div className="panel-h">
          <div>
            <h3>Youth Intake List</h3>
            <div className="meta">
              {fmtInt(intakes.length)} total · matched youth carry their hashed HMIS id —
              find them on the <Link href="/dashboard/bnl">By-Name List</Link>
            </div>
          </div>
        </div>
        <div className="scroll"><table>
          <thead><tr><th>Youth</th><th>Intake</th><th>Status</th><th>HMIS id</th></tr></thead>
          <tbody>
            {rest.map((r) => (
              <tr key={r.id}>
                <td><span className="nm">{nameOf(r)}</span><Details r={r} /></td>
                <td style={{ whiteSpace: 'nowrap' }}>{when(r.created_at)}<div className="ty">{r.source}</div></td>
                <td>{STATUS_PILL[r.status]}</td>
                <td style={{ fontSize: 11.5, color: 'var(--faint)' }}>
                  {r.matched_pid ? `${r.matched_pid.slice(0, 10)}…` : '—'}
                </td>
              </tr>
            ))}
            {!rest.length && <tr><td colSpan={4} className="empty">Reviewed intakes will appear here.</td></tr>}
          </tbody>
        </table></div>
      </div>
    </>
  );
}

/** A pending-queue row plus (when open) its match panel underneath. */
function FragmentRow({ r, openId, busy, onFind, onReject, Details, MatchPanel }: {
  r: Intake; openId: number | null; busy: boolean;
  onFind: () => void; onReject: () => void;
  Details: (p: { r: Intake }) => JSX.Element;
  MatchPanel: (p: { r: Intake }) => JSX.Element;
}) {
  return (
    <>
      <tr>
        <td style={{ whiteSpace: 'nowrap' }}>{when(r.created_at)}</td>
        <td><span className="nm">{[r.first_name, r.last_name].filter(Boolean).join(' ') || '(no name given)'}</span>
          <Details r={r} /></td>
        <td>{r.source}</td>
        <td className="num" style={{ whiteSpace: 'nowrap' }}>
          <button className="tbtn" disabled={busy} onClick={onFind}>
            {openId === r.id ? 'Refresh matches' : 'Find HMIS matches'}
          </button>
          <button className="tbtn" style={{ marginLeft: 6 }} disabled={busy} onClick={onReject}>Reject</button>
        </td>
      </tr>
      {openId === r.id && (
        <tr><td colSpan={4} style={{ background: 'var(--rowhover)' }}><MatchPanel r={r} /></td></tr>
      )}
    </>
  );
}
