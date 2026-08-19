'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '../../../../lib/supabase-browser';

/**
 * Staff-entered intake. Inserts through the viewer's own session — the
 * can_see_yc() RLS insert policy authorizes it. SSN-4 is collected only here
 * (not on the youth's own phone); case notes are internal-only and travel to
 * the review queue, the intake list, and the BNL drawer's Youth Connect
 * section.
 */
export default function StaffIntakeForm({ me }: { me: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState({
    first_name: '', last_name: '', dob: '', ssn4: '', contact: '',
    sleeping: '', school_work: '', unsafe: '', notes: '',
  });
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  async function submit() {
    if (busy) return;
    if (!f.first_name.trim() && !f.contact.trim()) {
      setErr('At least a name or a way to reach them is needed.');
      return;
    }
    if (f.ssn4 && !/^\d{4}$/.test(f.ssn4)) {
      setErr('SSN-4 must be exactly 4 digits (or leave it blank).');
      return;
    }
    setBusy(true); setErr(null);
    const row: Record<string, unknown> = { source: 'staff', created_by: me };
    for (const [k, v] of Object.entries(f)) if (v.trim()) row[k] = v.trim();
    const { error } = await supabaseBrowser().from('youth_intakes').insert(row);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    router.push('/dashboard/youth-intake');
    router.refresh();
  }

  const L = ({ children }: { children: React.ReactNode }) => (
    <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', fontWeight: 600, margin: '12px 0 4px' }}>
      {children}
    </label>
  );

  return (
    <div className="panel" style={{ maxWidth: 640 }}>
      <div className="panel-h">
        <div>
          <h3>New intake</h3>
          <div className="meta">
            Lands in the review queue like a self-entry — match it to HMIS from there.
            {' '}<Link href="/dashboard/youth-intake">Back to the queue</Link>
          </div>
        </div>
      </div>
      <div style={{ padding: '0 10px 14px' }}>
        {err && <div className="lerror" role="alert" style={{ marginBottom: 10 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <L>First name</L>
            <input className="finput" style={{ width: '100%' }} value={f.first_name} maxLength={80}
              onChange={(e) => set('first_name')(e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <L>Last name</L>
            <input className="finput" style={{ width: '100%' }} value={f.last_name} maxLength={80}
              onChange={(e) => set('last_name')(e.target.value)} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <L>Date of birth</L>
            <input className="finput" style={{ width: '100%' }} type="date" value={f.dob}
              onChange={(e) => set('dob')(e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <L>SSN — last 4 (optional, sharpens HMIS matching)</L>
            <input className="finput" style={{ width: '100%' }} value={f.ssn4} maxLength={4}
              inputMode="numeric" onChange={(e) => set('ssn4')(e.target.value.replace(/\D/g, ''))} />
          </div>
        </div>
        <L>Contact — phone / email / social</L>
        <input className="finput" style={{ width: '100%' }} value={f.contact} maxLength={200}
          placeholder="Anything the youth says works" onChange={(e) => set('contact')(e.target.value)} />
        <L>Where are they staying tonight?</L>
        <input className="finput" style={{ width: '100%' }} value={f.sleeping} maxLength={60}
          placeholder="Street / car / doubled up / shelter / unknown"
          onChange={(e) => set('sleeping')(e.target.value)} />
        <L>School / work</L>
        <input className="finput" style={{ width: '100%' }} value={f.school_work} maxLength={200}
          onChange={(e) => set('school_work')(e.target.value)} />
        <L>Feels unsafe?</L>
        <input className="finput" style={{ width: '100%' }} value={f.unsafe} maxLength={30}
          placeholder="Yes / no / rather not say" onChange={(e) => set('unsafe')(e.target.value)} />
        <L>Case notes — internal-only, never shown to the youth</L>
        <textarea className="finput" rows={4} style={{ width: '100%', resize: 'vertical' }}
          value={f.notes} maxLength={4000}
          placeholder="How they presented, immediate needs, who referred them, follow-up plan…"
          onChange={(e) => set('notes')(e.target.value)} />
        <div style={{ marginTop: 14 }}>
          <button className="btn primary" disabled={busy} onClick={submit}>
            {busy ? 'Saving…' : 'Add to intake list'}
          </button>
        </div>
      </div>
    </div>
  );
}
