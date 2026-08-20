'use client';

import { useEffect, useState } from 'react';
import { supabaseBrowser } from '../lib/supabase-browser';

export interface ReferralResource {
  id: number;
  name: string;
  phone: string | null;
  instructions: string;
  active: boolean;
  sort: number;
}

/**
 * Refer-out picker + operator script card (SOP: Call Handling, Referral, and
 * Outreach Dispatch Procedures 08.2026). Lists the referral resources
 * (helpline_resources — admin-editable, seeded from the SOP) and, once one is
 * picked, shows the exact information the call taker reads to the caller.
 *
 * Two outcomes, per the SOP nuance: CLOSE the case as referred out (housed
 * at-risk callers, other-provider areas), or only LOG that the info was given
 * and keep the case active — someone unsheltered in coverage still gets
 * outreach even when they also qualify for a specialized referral.
 */
export default function ReferOut({ title, onPick, onClose }: {
  title: string;
  onPick: (r: ReferralResource, terminal: boolean) => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<ReferralResource[] | 'missing' | null>(null);
  const [selId, setSelId] = useState<number | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabaseBrowser().from('helpline_resources')
          .select('id, name, phone, instructions, active, sort')
          .eq('active', true).order('sort').order('name');
        setList(error ? 'missing' : ((data ?? []) as ReferralResource[]));
      } catch { setList('missing'); }
    })();
  }, []);
  const sel = Array.isArray(list) ? (list.find((r) => r.id === selId) ?? null) : null;

  return (
    <div className="bnl-ov" onClick={onClose}>
      <div className="bnl-modal" onClick={(e) => e.stopPropagation()} role="dialog"
        aria-label="Refer to an external resource" style={{ maxWidth: 560 }}>
        <button className="bnl-x" onClick={onClose} aria-label="Close">✕</button>
        <h3>↗ {title}</h3>
        {list === null && <div className="bnl-sub">Loading referral resources…</div>}
        {list === 'missing' && (
          <div className="lerror" role="alert" style={{ marginTop: 8 }}>
            Referral resources aren&rsquo;t set up yet — run
            <code> supabase/helpline_referrals.sql</code> in the Supabase SQL editor, then reload.
          </div>
        )}
        {Array.isArray(list) && !sel && (
          <>
            <div className="bnl-sub" style={{ margin: '4px 0 10px' }}>
              Pick where this caller should be referred — the script to read to them comes next.
            </div>
            {list.map((r) => (
              <button key={r.id} className="tbtn"
                style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 6 }}
                onClick={() => setSelId(r.id)}>
                {r.name}{r.phone ? <span className="bnl-sub"> · ☎ {r.phone}</span> : null}
              </button>
            ))}
            {list.length === 0 && (
              <div className="bnl-sub">No active referral resources — an admin can add them
                (helpline_referrals.sql seeds the SOP set).</div>
            )}
          </>
        )}
        {sel && (
          <>
            <div style={{ border: '1px solid var(--border-strong)', borderRadius: 10,
              padding: '12px 16px', margin: '8px 0 12px', background: 'var(--card)' }}>
              <b style={{ color: 'var(--strong)' }}>{sel.name}</b>
              {sel.phone && (
                <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--strong)', margin: '6px 0' }}>
                  ☎ {sel.phone}</div>
              )}
              <div style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{sel.instructions}</div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn primary" onClick={() => onPick(sel, true)}>
                Save — referred to {sel.name.split(' (')[0]}</button>
              <button className="tbtn"
                title="SOP: someone unsheltered in coverage still gets outreach — this only documents that the referral information was provided"
                onClick={() => onPick(sel, false)}>Log info given · keep case active</button>
              <button className="tbtn" onClick={() => setSelId(null)}>← Back</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
