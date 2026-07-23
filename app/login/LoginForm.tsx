'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabaseBrowser } from '../../lib/supabase-browser';

export default function LoginForm() {
  const params = useSearchParams();
  const next = params.get('next') || '/dashboard';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabaseBrowser().auth.signInWithPassword({ email, password });
    if (error) {
      // Deliberately generic: don't reveal whether the address has an account.
      setError('That email and password combination didn’t work.');
      setBusy(false);
      return;
    }
    // Hard navigation, not router.replace(): a client-side transition lazily
    // fetches the dashboard chunk, and in dev that URL goes stale on every
    // recompile (ChunkLoadError right before the page settles). A full document
    // load also guarantees middleware and Server Components see the new session
    // cookie rather than racing it.
    window.location.assign(next);
  }

  return (
    <form onSubmit={onSubmit} className="loginform">
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
    </form>
  );
}
