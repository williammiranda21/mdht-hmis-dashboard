'use client';

import { useState } from 'react';
import { supabaseBrowser } from '../../../lib/supabase-browser';

export default function ChangePassword() {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (pw.length < 10) return setError('Use at least 10 characters.');
    if (pw !== confirm) return setError('Those two passwords don’t match.');
    setBusy(true);
    // Updates the currently signed-in user — no old password needed because the
    // session itself is the proof of identity.
    const { error } = await supabaseBrowser().auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return setError(error.message);
    setPw(''); setConfirm(''); setDone(true);
  }

  return (
    <div className="panel">
      <div className="panel-h">
        <div>
          <h3>Change password</h3>
          <div className="meta">If an administrator issued you a temporary password, set your own here</div>
        </div>
      </div>
      <div style={{ padding: '16px 18px 20px', maxWidth: 420 }}>
        {done ? (
          <div className="lnotice" role="status">
            <strong>Password updated</strong>
            <p>Your new password is active. You’ll use it next time you sign in.</p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="loginform" style={{ marginTop: 0 }}>
            <label className="lfield">
              <span>New password</span>
              <input type="password" autoComplete="new-password" required minLength={10}
                value={pw} onChange={(e) => setPw(e.target.value)} />
              <span className="lhelp">At least 10 characters.</span>
            </label>
            <label className="lfield">
              <span>Confirm new password</span>
              <input type="password" autoComplete="new-password" required
                value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            {error && <div className="lerror" role="alert">{error}</div>}
            <button type="submit" className="btn primary lbtn" disabled={busy}>
              {busy ? 'Saving…' : 'Update password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
