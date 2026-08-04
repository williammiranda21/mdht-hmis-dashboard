'use client';

import { useState } from 'react';
import { supabaseBrowser } from '../../lib/supabase-browser';

/**
 * Sets a new password. Reached from the recovery email via /auth/callback,
 * which has already exchanged the code for a session — so this page is behind
 * the normal auth gate and auth.updateUser just works. Also reachable signed-in
 * (works as a change-password form).
 */
export default function ResetPasswordPage() {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (pw.length < 8) { setErr('Use at least 8 characters.'); return; }
    if (pw !== pw2) { setErr('The passwords don’t match.'); return; }
    setBusy(true);
    const { error } = await supabaseBrowser().auth.updateUser({ password: pw });
    if (error) {
      setErr(error.message.includes('should be different')
        ? 'The new password must be different from the old one.'
        : 'Could not set the password — the reset link may have expired. Request a new one.');
      setBusy(false);
      return;
    }
    window.location.assign('/dashboard');
  }

  return (
    <main className="portal" style={{ maxWidth: 460, margin: '0 auto', padding: '48px 20px' }}>
      <div className="kick">Miami-Dade County Homeless Trust</div>
      <h1 style={{ fontSize: 28, marginTop: 10 }}>Choose a new password</h1>
      <form onSubmit={onSubmit} className="loginform" style={{ marginTop: 18 }}>
        <label className="lfield">
          <span>New password</span>
          <input type="password" autoComplete="new-password" required value={pw}
            onChange={(e) => setPw(e.target.value)} />
        </label>
        <label className="lfield">
          <span>Repeat it</span>
          <input type="password" autoComplete="new-password" required value={pw2}
            onChange={(e) => setPw2(e.target.value)} />
        </label>
        {err && <div className="lerror" role="alert">{err}</div>}
        <button type="submit" className="btn primary lbtn" disabled={busy}>
          {busy ? 'Saving…' : 'Set password and sign in'}
        </button>
      </form>
    </main>
  );
}
