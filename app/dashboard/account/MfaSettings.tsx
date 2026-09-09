'use client';

import { useEffect, useState } from 'react';
import { supabaseBrowser } from '../../../lib/supabase-browser';

/**
 * Two-factor authentication (TOTP) — county-compliance gap #1, 2026-09-09.
 *
 * Enrollment: Supabase issues a QR + secret; the user scans it with any
 * authenticator app (Microsoft/Google Authenticator, Authy…) and confirms
 * with a 6-digit code. Verifying also elevates THIS session to AAL2, so BNL
 * access works immediately after setup with no re-login.
 *
 * The By-Name List requires an enrolled factor AND an AAL2 session for any
 * account holding the BNL grant (enforced server-side on the BNL page and
 * the roster export). Removing the factor therefore drops BNL access until
 * a new one is enrolled — the confirm says so.
 */

type Factor = { id: string; factor_type: string; status: 'verified' | 'unverified' };

export default function MfaSettings({ bnlGranted }: { bnlGranted: boolean }) {
  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [enrolling, setEnrolling] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const sb = () => supabaseBrowser();

  const load = async () => {
    const { data, error: e } = await sb().auth.mfa.listFactors();
    if (e) { setError(e.message); setFactors([]); return; }
    setFactors((data?.totp ?? []) as Factor[]);
  };
  useEffect(() => { load(); }, []);

  const verified = (factors ?? []).find((f) => f.status === 'verified') ?? null;

  const startEnroll = async () => {
    setBusy(true); setError(null); setDone(false);
    try {
      // A dangling unverified factor from an abandoned attempt blocks a fresh
      // enroll — clear those first.
      for (const f of (factors ?? []).filter((x) => x.status === 'unverified')) {
        await sb().auth.mfa.unenroll({ factorId: f.id });
      }
      const { data, error: e } = await sb().auth.mfa.enroll({ factorType: 'totp' });
      if (e) throw e;
      setEnrolling({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
      setCode('');
    } catch (e) {
      setError(String((e as Error).message));
    } finally { setBusy(false); }
  };

  const confirmEnroll = async () => {
    if (!enrolling || code.trim().length < 6) return;
    setBusy(true); setError(null);
    try {
      const { data: ch, error: e1 } = await sb().auth.mfa.challenge({ factorId: enrolling.id });
      if (e1) throw e1;
      const { error: e2 } = await sb().auth.mfa.verify({
        factorId: enrolling.id, challengeId: ch.id, code: code.trim(),
      });
      if (e2) throw e2;
      setEnrolling(null); setCode(''); setDone(true);
      await load();
    } catch {
      setError('That code didn’t match — check the app and try the current code.');
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!verified) return;
    const warn = bnlGranted
      ? 'Remove two-factor authentication?\n\nYour account holds By-Name List access, which REQUIRES two-factor — the BNL will be unavailable to you until you set it up again.'
      : 'Remove two-factor authentication from your account?';
    if (!confirm(warn)) return;
    setBusy(true); setError(null); setDone(false);
    try {
      const { error: e } = await sb().auth.mfa.unenroll({ factorId: verified.id });
      if (e) throw e;
      await load();
    } catch (e) {
      setError(String((e as Error).message));
    } finally { setBusy(false); }
  };

  return (
    <div className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-h">
        <div>
          <h3>Two-factor authentication</h3>
          <div className="meta">
            A 6-digit code from an authenticator app, asked at sign-in
            {bnlGranted ? ' · required for By-Name List access' : ''}
          </div>
        </div>
      </div>
      <div style={{ padding: '4px 18px 16px', maxWidth: 560 }}>
        {factors === null && <div className="bnl-sub">Checking…</div>}

        {factors !== null && verified && !enrolling && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="pill good">✓ Enabled</span>
            <span className="bnl-sub">Codes are required at every sign-in.</span>
            <button className="btn" style={{ marginLeft: 'auto' }} disabled={busy} onClick={remove}>
              Remove
            </button>
          </div>
        )}

        {factors !== null && !verified && !enrolling && (
          <div style={{ display: 'grid', gap: 10 }}>
            {done && (
              <div className="pill good" style={{ justifySelf: 'start' }}>✓ Two-factor enabled</div>
            )}
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>
              Protects your account even if the password leaks. You’ll need any authenticator app
              on your phone (Microsoft Authenticator, Google Authenticator, Authy…).
              {bnlGranted && <> <b style={{ color: 'var(--strong)' }}>Your account has By-Name List
              access, which requires this.</b></>}
            </p>
            <button className="btn primary" style={{ justifySelf: 'start' }} disabled={busy}
              onClick={startEnroll}>
              {busy ? 'Preparing…' : 'Set up two-factor'}
            </button>
          </div>
        )}

        {enrolling && (
          <div style={{ display: 'grid', gap: 10 }}>
            <p style={{ fontSize: 13 }}>
              <b>1.</b> Scan this with your authenticator app:
            </p>
            <img alt="Authenticator QR code" width={168} height={168}
              style={{ background: '#fff', borderRadius: 8, padding: 6, border: '1px solid var(--border)' }}
              // Supabase returns qr_code as a ready-made data URI in current
              // versions and as raw SVG markup in older ones — handle both
              // (double-wrapping a data URI renders a broken image).
              src={enrolling.qr.startsWith('data:')
                ? enrolling.qr
                : `data:image/svg+xml;utf8,${encodeURIComponent(enrolling.qr)}`} />
            <div className="bnl-sub">
              Can’t scan? Enter this key manually:{' '}
              <code style={{ userSelect: 'all' }}>{enrolling.secret}</code>
            </div>
            <p style={{ fontSize: 13 }}><b>2.</b> Enter the 6-digit code the app shows:</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="finput" inputMode="numeric" autoComplete="one-time-code"
                maxLength={6} style={{ width: 120, fontSize: 16, letterSpacing: 3 }}
                value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => e.key === 'Enter' && confirmEnroll()} autoFocus />
              <button className="btn primary" disabled={busy || code.length < 6} onClick={confirmEnroll}>
                {busy ? 'Checking…' : 'Confirm'}
              </button>
              <button className="btn" disabled={busy} onClick={() => { setEnrolling(null); setCode(''); }}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {error && <div className="lerror" role="alert" style={{ marginTop: 10 }}>{error}</div>}
      </div>
    </div>
  );
}
