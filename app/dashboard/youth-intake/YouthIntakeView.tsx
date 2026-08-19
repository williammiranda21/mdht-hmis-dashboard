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

/** BNL-style dot chip, colored by state. */
function StatusChip({ s }: { s: Intake['status'] }) {
  const m: Record<Intake['status'], [string, string, string]> = {
    pending: ['pending review', 'var(--warn-light)', 'var(--warn)'],
    matched: ['matched → BNL', 'var(--accent-light)', 'var(--accent)'],
    no_match: ['awaiting HMIS entry', 'var(--primary-light)', 'var(--secondary)'],
    rejected: ['rejected', 'var(--danger-light)', 'var(--danger)'],
  };
  const [label, bg, fg] = m[s];
  return <span className="bnl-chip" style={{ background: bg, color: fg }}>{label}</span>;
}

/** Source badge: which door the youth came through. */
function SourceChip({ s }: { s: Intake['source'] }) {
  return s === 'self'
    ? <span className="bnl-fp bnl-fp-sch">self-entry</span>
    : <span className="bnl-fp bnl-fp-una">staff intake</span>;
}

function Details({ r }: { r: Intake }) {
  return (
    <div className="bnl-sub" style={{ marginTop: 3, lineHeight: 1.7 }}>
      {r.dob && <>DOB {r.dob} · </>}
      {r.contact && <>reach: <b style={{ color: 'var(--strong)' }}>{r.contact}</b> · </>}
      {r.sleeping && <>sleeping: {r.sleeping} · </>}
      {r.unsafe && <>unsafe: {r.unsafe} · </>}
      {r.school_work && <>school/work: {r.school_work}</>}
      {r.notes && (
        <div style={{ marginTop: 2 }}>
          <span className="bnl-fp bnl-fp-dq">notes</span> {r.notes}
        </div>
      )}
    </div>
  );
}

/**
 * Youth Connect internal portal, in the BNL's visual language: KPI strip on
 * top, dot-chip statuses, bnl-table rows. All writes go through the browser
 * client carrying the viewer's own session — can_see_yc() RLS authorizes
 * them. Matching goes through /api/yc/match (the only reader of client_index).
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
  const [q, setQ] = useState('');

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
  const matched = intakes.filter((r) => r.status === 'matched');
  const noMatch = intakes.filter((r) => r.status === 'no_match');
  const rest = intakes.filter((r) => r.status !== 'pending');
  const activeLinks = invites.filter((v) => !v.disabled);

  const t = q.trim().toLowerCase();
  const shown = t
    ? rest.filter((r) =>
        nameOf(r).toLowerCase().includes(t)
        || (r.contact ?? '').toLowerCase().includes(t)
        || (r.notes ?? '').toLowerCase().includes(t))
    : rest;

  const kpi = (lbl: string, val: number, note: string, kc: string) => (
    <div className="bnl-kpi" style={{ ['--kc' as any]: kc }}>
      <div className="bnl-kpi-lbl">{lbl}</div>
      <div className="bnl-kpi-val">{fmtInt(val)}</div>
      <div className="bnl-kpi-note">{note}</div>
    </div>
  );

  function scoreColor(s: number): string {
    return s >= 80 ? 'var(--accent)' : s >= 60 ? 'var(--warn)' : 'var(--faint)';
  }

  function MatchPanel({ r }: { r: Intake }) {
    const c = cands[r.id];
    return (
      <div style={{ padding: '6px 12px 16px' }}>
        {c === 'loading' && <div className="meta">Searching 50k HMIS clients…</div>}
        {Array.isArray(c) && c.length === 0 && (
          <div className="meta" style={{ marginBottom: 8 }}>
            No HMIS candidates found — if they&rsquo;re genuinely new, flag them for HMIS entry.
          </div>
        )}
        {Array.isArray(c) && c.map((m) => (
          <div key={m.pid} style={{
            border: '1px solid var(--border)', borderLeft: `3px solid ${scoreColor(m.score)}`,
            borderRadius: 10, padding: '10px 14px', marginBottom: 8,
            background: 'var(--card)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="bnl-nm" style={{ textTransform: 'capitalize' }}>{m.name || '(no name)'}</span>
              <span className="bnl-dh" style={{ minWidth: 110 }}>
                <span className="bnl-dh-tr"><span className="bnl-dh-fl"
                  style={{ width: `${m.score}%`, background: scoreColor(m.score) }} /></span>
                <b style={{ color: scoreColor(m.score) }}>{m.score}%</b>
              </span>
            </div>
            <div className="bnl-sub" style={{ marginTop: 2 }}>
              {m.why.join(' · ')}
              {m.bnl && <> · BNL: <b>{m.bnl.status ?? '?'}</b>{m.bnl.project ? ` @ ${m.bnl.project}` : ''}
                {m.bnl.last_contact ? ` · last contact ${m.bnl.last_contact}` : ''}</>}
              {!m.bnl && ' · not on the BNL'}
            </div>
            <div style={{ marginTop: 8 }}>
              <button className="btn primary" style={{ padding: '5px 14px', fontSize: 12.5 }}
                disabled={busy} onClick={() => confirm(r, m.pid)}>Confirm match</button>
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

      {/* ── KPI strip — same anatomy as the BNL count cards ── */}
      <div className="bnl-kpis" style={{ marginBottom: 18 }}>
        {kpi('Pending review', pending.length,
          pending.length ? 'waiting on a match decision' : 'queue is clear', 'var(--warn)')}
        {kpi('Matched to HMIS', matched.length, 'on the By-Name List', 'var(--accent)')}
        {kpi('Awaiting HMIS entry', noMatch.length, 'new youth — enter in WellSky', 'var(--secondary)')}
        {kpi('Total intakes', intakes.length,
          `${fmtInt(intakes.filter((r) => r.source === 'self').length)} self · ${fmtInt(intakes.filter((r) => r.source === 'staff').length)} staff`,
          'var(--primary)')}
        {kpi('Active links', activeLinks.length,
          `${fmtInt(activeLinks.reduce((n, v) => n + v.uses, 0))} submissions through links`, 'var(--faint)')}
      </div>

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
              {showInvites ? 'Close invite links' : `Invite links (${fmtInt(activeLinks.length)})`}
            </button>
            <Link className="btn primary" href="/dashboard/youth-intake/new">New intake</Link>
          </div>
        </div>

        {showInvites && (
          <div style={{ padding: '0 12px 16px' }}>
            <div className="meta" style={{ margin: '4px 0 10px' }}>
              A link (or its QR code) is how youth reach the self-entry portal — print it on
              outreach cards, posters, or send it directly. Disable a link to retire it.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <input className="finput" placeholder="Label — e.g. Outreach cards Sept"
                value={inviteLabel} onChange={(e) => setInviteLabel(e.target.value)}
                style={{ minWidth: 240 }} />
              <button className="btn" disabled={busy} onClick={createInvite}>Create link</button>
            </div>
            {newLink && (
              <div className="pwpanel" role="status" style={{ marginBottom: 12 }}>
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
              <div className="scroll"><table className="bnl-table">
                <thead><tr><th>Label</th><th>Created</th><th>Uses</th><th>Status</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
                <tbody>
                  {invites.map((v) => (
                    <tr key={v.token} style={{ cursor: 'default' }}>
                      <td><span className="bnl-nm">{v.label || 'Unlabeled'}</span>
                        <div className="bnl-sub">/yc/{v.token.slice(0, 10)}…</div></td>
                      <td>{when(v.created_at)}</td>
                      <td>
                        <span className="bnl-dh">
                          <span className="bnl-dh-tr"><span className="bnl-dh-fl" style={{
                            width: `${Math.min(100, (v.uses / v.max_uses) * 100)}%`,
                            background: 'var(--secondary)' }} /></span>
                          {fmtInt(v.uses)} / {fmtInt(v.max_uses)}
                        </span>
                      </td>
                      <td>{v.disabled
                        ? <span className="bnl-chip bnl-inactive">disabled</span>
                        : <span className="bnl-chip bnl-housed">active</span>}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
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
          <div className="scroll"><table className="bnl-table">
            <thead><tr><th>Received</th><th>Youth</th><th>Source</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
            <tbody>
              {pending.map((r) => (
                <FragmentRow key={r.id} r={r} openId={openId} busy={busy}
                  onFind={() => findMatches(r.id)} onReject={() => setStatus(r, 'rejected')}
                  MatchPanel={MatchPanel} />
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
              {t ? `${fmtInt(shown.length)} of ${fmtInt(rest.length)} shown` : `${fmtInt(rest.length)} reviewed`}
              {' '}· matched youth are on the <Link href="/dashboard/bnl">By-Name List</Link>
            </div>
          </div>
          <input className="finput" placeholder="Search name, contact, or notes…"
            value={q} onChange={(e) => setQ(e.target.value)}
            style={{ minWidth: 240 }} aria-label="Search intakes" />
        </div>
        <div className="scroll"><table className="bnl-table">
          <thead><tr><th>Youth</th><th>Intake</th><th>Status</th><th>HMIS id</th></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} style={{ cursor: 'default' }}>
                <td><span className="bnl-nm">{nameOf(r)}</span><Details r={r} /></td>
                <td style={{ whiteSpace: 'nowrap' }}>{when(r.created_at)}
                  <div style={{ marginTop: 3 }}><SourceChip s={r.source} /></div></td>
                <td><StatusChip s={r.status} /></td>
                <td className="bnl-sub">{r.matched_pid ? `${r.matched_pid.slice(0, 10)}…` : '—'}</td>
              </tr>
            ))}
            {!rest.length && <tr><td colSpan={4} className="empty" style={{ cursor: 'default' }}>
              Reviewed intakes will appear here.</td></tr>}
            {rest.length > 0 && !shown.length && (
              <tr><td colSpan={4} className="empty" style={{ cursor: 'default' }}>
                No intakes match “{q.trim()}”.</td></tr>
            )}
          </tbody>
        </table></div>
      </div>
    </>
  );
}

/** A pending-queue row plus (when open) its match panel underneath. */
function FragmentRow({ r, openId, busy, onFind, onReject, MatchPanel }: {
  r: Intake; openId: number | null; busy: boolean;
  onFind: () => void; onReject: () => void;
  MatchPanel: (p: { r: Intake }) => JSX.Element;
}) {
  return (
    <>
      <tr style={{ cursor: 'default' }}>
        <td style={{ whiteSpace: 'nowrap' }}>{when(r.created_at)}</td>
        <td><span className="bnl-nm">{nameOf(r)}</span><Details r={r} /></td>
        <td><SourceChip s={r.source} /></td>
        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
          <button className="btn primary" style={{ padding: '5px 14px', fontSize: 12.5 }}
            disabled={busy} onClick={onFind}>
            {openId === r.id ? 'Refresh matches' : 'Find HMIS matches'}
          </button>
          <button className="tbtn" style={{ marginLeft: 6 }} disabled={busy} onClick={onReject}>Reject</button>
        </td>
      </tr>
      {openId === r.id && (
        <tr style={{ cursor: 'default' }}>
          <td colSpan={4} style={{ background: 'var(--rowhover)' }}><MatchPanel r={r} /></td>
        </tr>
      )}
    </>
  );
}
