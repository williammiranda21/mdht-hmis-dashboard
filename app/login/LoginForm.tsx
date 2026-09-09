'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabaseBrowser } from '../../lib/supabase-browser';

export default function LoginForm() {
  const params = useSearchParams();
  const next = params.get('next') || '/dashboard';
  const idledOut = params.get('reason') === 'idle';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // MFA step (county-compliance gap #1): a user with a verified authenticator
  // must supply a 6-digit code after the password to elevate the session to
  // AAL2. mfaFactor non-null = we're on the code screen.
  const [mfaFactor, setMfaFactor] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');

  // Seed the idle stamp, then hard-navigate (see comments below) — shared by
  // both the password-only and the post-MFA paths.
  async function finishSignIn() {
    // Seed the idle-timeout activity stamp BEFORE navigating — middleware
    // treats a session without one as idle-expired (lib/idle.ts). The stamp
    // is server-written (/api/seen), so a wrong client clock can't matter.
    await fetch('/api/seen', { method: 'POST' }).catch(() => { /* re-login recovers */ });
    // Hard navigation, not router.replace(): a client-side transition lazily
    // fetches the dashboard chunk, and in dev that URL goes stale on every
    // recompile (ChunkLoadError right before the page settles). A full document
    // load also guarantees middleware and Server Components see the new session
    // cookie rather than racing it.
    window.location.assign(next);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const sb = supabaseBrowser();
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      // Deliberately generic: don't reveal whether the address has an account.
      setError('That email and password combination didn’t work.');
      setBusy(false);
      return;
    }
    // Enrolled users must verify a code before the session counts (AAL2).
    try {
      const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
        const { data: fl } = await sb.auth.mfa.listFactors();
        const factor = (fl?.totp ?? []).find((f) => f.status === 'verified');
        if (factor) {
          setMfaFactor(factor.id);
          setBusy(false);
          return;                      // wait for the code
        }
      }
    } catch { /* no factors → proceed as password-only */ }
    await finishSignIn();
  }

  async function onMfaSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!mfaFactor || mfaCode.trim().length < 6) return;
    setBusy(true);
    setError(null);
    const sb = supabaseBrowser();
    const { data: ch, error: e1 } = await sb.auth.mfa.challenge({ factorId: mfaFactor });
    if (!e1) {
      const { error: e2 } = await sb.auth.mfa.verify({
        factorId: mfaFactor, challengeId: ch.id, code: mfaCode.trim(),
      });
      if (!e2) { await finishSignIn(); return; }
    }
    setError('That code didn’t match — enter the current code from your authenticator app.');
    setMfaCode('');
    setBusy(false);
  }

  if (mfaFactor) {
    return (
      <form onSubmit={onMfaSubmit} className="loginform">
        <p style={{ fontSize: 13.5, marginBottom: 12 }}>
          <b>Two-factor check</b> — enter the 6-digit code from your authenticator app.
        </p>
        <label className="lfield">
          <span>Code</span>
          <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} required autoFocus
            style={{ fontSize: 18, letterSpacing: 4 }}
            value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))} />
        </label>
        {error && <div className="lerror" role="alert">{error}</div>}
        <button type="submit" className="btn primary lbtn" disabled={busy || mfaCode.length < 6}>
          {busy ? 'Checking…' : 'Verify'}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={onSubmit} className="loginform">
      {idledOut && (
        <div role="status" style={{ background: 'var(--warn-light)', color: 'var(--warn)',
          border: '1px solid var(--warn)', borderRadius: 8, padding: '9px 13px',
          fontSize: 13, marginBottom: 12, fontWeight: 600 }}>
          You were signed out after 20 minutes of inactivity. Sign back in to continue.
        </div>
      )}
      <label className="lfield">
        <span>Email</span>
        <input
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@agency.org"
        />
      </label>
      <label className="lfield">
        <span>Password</span>
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && <div className="lerror" role="alert">{error}</div>}
      <button type="submit" className="btn primary lbtn" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p style={{ marginTop: 10, fontSize: 13, textAlign: 'right' }}>
        <a href="/forgot">Forgot password?</a>
      </p>
    </form>
  );
}
