'use client';

import { useState } from 'react';

/**
 * Annual HMIS Policies & Procedures acknowledgment gate (compliance gap #6).
 *
 * The in-app version of the Homeless Trust's paper "User's Acknowledgement
 * Form" — same language, checkbox in place of the signature line, stamped
 * server-side on the caller's own profile and renewed every 365 days. Blocks
 * the dashboard (full-screen overlay, no dismiss) until acknowledged; the
 * only other way out is signing out.
 */
export default function PolicyAttestation({ renewal, email }: {
  renewal: boolean; email: string | null;
}) {
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (done) return null;

  const submit = async () => {
    if (!agree || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/attest', { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || 'Could not record the acknowledgment.');
      setDone(true);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="HMIS User's Acknowledgement"
      style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(10,14,25,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="panel" style={{ maxWidth: 640, width: '100%', maxHeight: '92vh',
        overflowY: 'auto', padding: '22px 26px' }}>
        <h2 style={{ fontSize: 18, marginBottom: 2 }}>HMIS User’s Acknowledgement</h2>
        <div className="bnl-sub" style={{ marginBottom: 14 }}>
          Miami-Dade County Homeless Trust · Homeless Management Information System
          {renewal ? ' · annual renewal' : ''}
        </div>

        <div style={{ display: 'grid', gap: 10, fontSize: 13.5, lineHeight: 1.55 }}>
          <p>
            HMIS is a web-based management information system utilized to record and share
            information electronically on services provided to individuals and families who are
            homeless, or at risk of homelessness.
          </p>
          <p>
            This acknowledgment serves to confirm the HMIS User’s understanding of and compliance
            with the{' '}
            <a href="/hmis-policies-and-procedures-manual.pdf" target="_blank" rel="noreferrer"
              style={{ fontWeight: 600 }}>
              HMIS Policies and Procedures ↗
            </a>. Should the Policies and Procedures be modified by the Miami-Dade County Homeless
            Trust, the updated version will be distributed to all providers and staff members.
          </p>
          <p>
            The user agrees to comply with any and all applicable Federal, State, and local laws
            and regulations — including, but not limited to, the Health Insurance Portability and
            Accountability Act — pertaining to client confidentiality and the transmission of
            confidential client information.
          </p>
        </div>

        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 16,
          padding: '10px 12px', border: '1px solid var(--border-strong)', borderRadius: 8,
          cursor: 'pointer', fontSize: 13.5 }}>
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)}
            style={{ marginTop: 3 }} />
          <span>
            I have read and agree to comply with the Miami-Dade County Homeless Trust HMIS
            Policies and Procedures.
          </span>
        </label>

        {error && <div className="lerror" role="alert" style={{ marginTop: 10 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14 }}>
          <span className="bnl-sub">
            Recorded with your account{email ? ` (${email})` : ''} and today’s date
            {renewal ? '' : ' · renewed annually'}.
          </span>
          <span style={{ flex: 1 }} />
          <form action="/auth/signout" method="post">
            <button className="btn" type="submit" disabled={busy}>Sign out</button>
          </form>
          <button className="btn primary" onClick={submit} disabled={!agree || busy}>
            {busy ? 'Recording…' : 'I agree — continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
