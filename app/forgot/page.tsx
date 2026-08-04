'use client';

import { useState } from 'react';
import { supabaseBrowser } from '../../lib/supabase-browser';

/**
 * Forgot-password self-service. Sends the Supabase recovery email; the link
 * lands on /auth/callback which exchanges the code and forwards to
 * /reset-password. Copy stays deliberately generic — never reveal whether an
 * address has an account.
 */
export default function ForgotPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    await supabaseBrowser().auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    });
    // Always report success — same anti-enumeration stance as the login form.
    setSent(true);
    setBusy(false);
  }

  return (
    <main className="portal" style={{ maxWidth: 460, margin: '0 auto', padding: '48px 20px' }}>
      <div className="kick">Miami-Dade County Homeless Trust</div>
      <h1 style={{ fontSize: 28, marginTop: 10 }}>Reset your password</h1>
      {sent ? (
        <p style={{ marginTop: 18, color: 'var(--muted)' }}>
          If that address has an account, a reset link is on its way. Check your
          inbox (and spam) — the link is valid for a limited time. If nothing
          arrives, contact your administrator, who can issue a temporary password.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="loginform" style={{ marginTop: 18 }}>
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>
            Enter your account email and we’ll send a password-reset link.
          </p>
          <label className="lfield">
            <span>Email</span>
            <input type="email" autoComplete="username" required value={email}
              onChange={(e) => setEmail(e.target.value)} placeholder="name@agency.org" />
          </label>
          <button type="submit" className="btn primary lbtn" disabled={busy}>
            {busy ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}
      <p style={{ marginTop: 22, fontSize: 14 }}>
        <a href="/login">← Back to sign in</a>
      </p>
    </main>
  );
}
