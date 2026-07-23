'use client';

import { useState } from 'react';
import { supabaseBrowser } from '../../lib/supabase-browser';

export default function SignupForm() {
  const [displayName, setDisplayName] = useState('');
  const [agency, setAgency] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 10) {
      setError('Use at least 10 characters for your password.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await supabaseBrowser().auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName.trim(), agency: agency.trim() } },
    });
    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    setDone(true);
    setBusy(false);
  }

  if (done) {
    return (
      <div className="lnotice" role="status">
        <strong>Request submitted</strong>
        <p>
          Your account has been created and is waiting for a Homeless Trust administrator to
          approve it and assign your projects. You’ll be able to sign in once that’s done.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="loginform">
      <label className="lfield">
        <span>Your name</span>
        <input required value={displayName} onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Jane Doe" autoComplete="name" />
      </label>
      <label className="lfield">
        <span>Agency</span>
        <input required value={agency} onChange={(e) => setAgency(e.target.value)}
          placeholder="Chapman Partnership" autoComplete="organization" />
      </label>
      <label className="lfield">
        <span>Work email</span>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="name@agency.org" autoComplete="username" />
      </label>
      <label className="lfield">
        <span>Password</span>
        <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password" minLength={10} />
        <span className="lhelp">At least 10 characters.</span>
      </label>
      {error && <div className="lerror" role="alert">{error}</div>}
      <button type="submit" className="btn primary lbtn" disabled={busy}>
        {busy ? 'Submitting…' : 'Request access'}
      </button>
    </form>
  );
}
