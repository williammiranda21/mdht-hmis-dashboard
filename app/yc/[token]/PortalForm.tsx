'use client';

import { useState } from 'react';
import { SLEEPING_OPTIONS, UNSAFE_OPTIONS } from '../../../lib/yc-options';

/**
 * The youth-facing form: three short steps, plain language, everything except
 * "some way to know or reach you" skippable. Inputs are 16px so iOS Safari
 * doesn't zoom on focus. A hidden "website" honeypot field filters naive bots
 * (see /api/yc/submit).
 */
export default function PortalForm({ token }: { token: string }) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState({
    first_name: '', last_name: '', dob: '', contact: '',
    sleeping: '', unsafe: '', school_work: '', website: '',
  });
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  async function submit() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/yc/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, ...f }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'Something went wrong');
      setStep(3);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  const Chip = ({ group, value }: { group: 'sleeping' | 'unsafe'; value: string }) => (
    <button type="button" className="ycopt" aria-pressed={f[group] === value}
      onClick={() => set(group)(f[group] === value ? '' : value)}>{value}</button>
  );

  return (
    <div className="yccard">
      <div className="ycbrand"><span className="yclogo">Y</span>Youth Connect</div>
      <div className="ycprog"><i style={{ width: `${step === 0 ? 6 : step * 33}%` }} /></div>

      {step === 0 && (
        <div>
          <h1 className="ych">Hey — let&rsquo;s get you connected.</h1>
          <p className="ycsub">A few questions so the right people can reach you. About 3 minutes,
            and you can skip anything you&rsquo;re not comfortable with.</p>
          <label className="yclabel" htmlFor="fn">First name (or what you go by)</label>
          <input className="ycinp" id="fn" value={f.first_name} maxLength={80}
            onChange={(e) => set('first_name')(e.target.value)} />
          <label className="yclabel" htmlFor="ln">Last name — okay to skip</label>
          <input className="ycinp" id="ln" value={f.last_name} maxLength={80}
            onChange={(e) => set('last_name')(e.target.value)} />
          <label className="yclabel" htmlFor="dob">Date of birth — helps us find your file, okay to skip</label>
          <input className="ycinp" id="dob" type="date" value={f.dob}
            onChange={(e) => set('dob')(e.target.value)} />
          {/* honeypot — invisible to people, tempting to bots */}
          <div className="ychoney" aria-hidden="true">
            <label>Website<input tabIndex={-1} autoComplete="off" value={f.website}
              onChange={(e) => set('website')(e.target.value)} /></label>
          </div>
          <button className="yccta" type="button" onClick={() => setStep(1)}>Continue &rarr;</button>
        </div>
      )}

      {step === 1 && (
        <div>
          <h1 className="ych">Where are you at right now?</h1>
          <p className="ycsub">This helps us know how urgent things are.</p>
          <label className="yclabel">Where did you sleep last night?</label>
          <div className="ycopts">
            {SLEEPING_OPTIONS.map((v) => <Chip key={v} group="sleeping" value={v} />)}
          </div>
          <label className="yclabel" htmlFor="ct">Best way to reach you</label>
          <input className="ycinp" id="ct" value={f.contact} maxLength={200}
            placeholder="Phone, email, Instagram — anything works"
            onChange={(e) => set('contact')(e.target.value)} />
          <label className="yclabel" htmlFor="sw">In school or working? — okay to skip</label>
          <input className="ycinp" id="sw" value={f.school_work} maxLength={200}
            onChange={(e) => set('school_work')(e.target.value)} />
          <label className="yclabel">Anything feel unsafe right now?</label>
          <div className="ycopts">
            {UNSAFE_OPTIONS.map((v) => <Chip key={v} group="unsafe" value={v} />)}
          </div>
          <button className="yccta" type="button" onClick={() => setStep(2)}>Continue &rarr;</button>
          <button className="ycghost" type="button" onClick={() => setStep(0)}>&larr; Back</button>
        </div>
      )}

      {step === 2 && (
        <div>
          <h1 className="ych">One last thing.</h1>
          <p className="ycsub">Your info only goes to people whose job is getting you housed.</p>
          <div className="ycconsent">
            <input type="checkbox" id="ok" defaultChecked />
            <label htmlFor="ok">I agree that Educate Tomorrow and the Miami-Dade Homeless Trust
              can use what I shared to connect me with housing and services.</label>
          </div>
          {err && <div className="ycerr">{err} — try again, or find any outreach worker.</div>}
          <button className="yccta" type="button" disabled={busy} onClick={submit}>
            {busy ? 'Sending…' : 'Send it ✓'}
          </button>
          <button className="ycghost" type="button" onClick={() => setStep(1)}>&larr; Back</button>
        </div>
      )}

      {step === 3 && (
        <div className="ycdone">
          <div className="big">✓</div>
          <h1 className="ych">You&rsquo;re on the list.</h1>
          <p className="ycsub">Someone from Educate Tomorrow will reach out within 2 business days.
            If anything changes, come back with the same link.</p>
        </div>
      )}
    </div>
  );
}
