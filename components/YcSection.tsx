'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface YcIntake {
  id: number;
  created_at: string;
  source: 'self' | 'staff';
  contact: string | null;
  sleeping: string | null;
  school_work: string | null;
  unsafe: string | null;
  notes: string | null;
}

/**
 * "Youth Connect" section for the BNL client drawer — the matched intake's
 * self-reported contact info and situation, surfaced where case conferencing
 * happens. Fetches through /api/yc/by-pid, which runs under the viewer's own
 * session: no access (or no intake) → null → the section simply isn't there.
 */
export default function YcSection({ pid }: { pid: string }) {
  const [intake, setIntake] = useState<YcIntake | null>(null);

  useEffect(() => {
    let live = true;
    setIntake(null);
    fetch(`/api/yc/by-pid?pid=${encodeURIComponent(pid)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j?.intake) setIntake(j.intake as YcIntake); })
      .catch(() => {});
    return () => { live = false; };
  }, [pid]);

  if (!intake) return null;

  const d = new Date(intake.created_at);
  const stamp = Number.isNaN(d.getTime()) ? intake.created_at
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div style={{
      border: '1px solid var(--accent)', borderRadius: 10, padding: '11px 14px',
      margin: '12px 0', fontSize: 12.5,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <b>Youth Connect · {intake.source === 'self' ? 'self-entry' : 'staff intake'} {stamp}</b>
        <Link href="/dashboard/youth-intake" style={{ fontSize: 12 }}>Open intake list →</Link>
      </div>
      <div style={{
        marginTop: 7, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 14px',
      }}>
        {intake.contact && <><span className="bnl-sub">Reach them</span><b>{intake.contact}</b></>}
        {intake.sleeping && <><span className="bnl-sub">Sleeping</span><span>{intake.sleeping}</span></>}
        {intake.school_work && <><span className="bnl-sub">School / work</span><span>{intake.school_work}</span></>}
        {intake.unsafe && <><span className="bnl-sub">Feels unsafe</span><span>{intake.unsafe}</span></>}
        {intake.notes && <><span className="bnl-sub">Staff notes</span><span>{intake.notes}</span></>}
      </div>
    </div>
  );
}
