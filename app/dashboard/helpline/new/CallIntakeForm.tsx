'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '../../../../lib/supabase-browser';
import {
  AREAS, DEFAULT_RULES, SLEEPING_OPTIONS, HOUSEHOLD_OPTIONS, FACTORS, muniArea, priorityOf,
  priorityBand, suggestTeam, type PriorityRules, type RoutableTeam,
} from '../../../../lib/helpline-options';
import { fetchPriorityRules } from '../../../../lib/priority-rules';
import { featuresAt, inFeature, type GeoFC } from '../../../../lib/slippy';
import { fetchCustomAreas } from '../../../../lib/custom-areas';
import ReferOut, { type ReferralResource } from '../../../../components/ReferOut';

// District boundary files, fetched once per session (same-origin static).
let _cityGeo: GeoFC | null | undefined;
let _countyGeo: GeoFC | null | undefined;
let _muniGeo: GeoFC | null | undefined;
async function loadGeo(file: string): Promise<GeoFC | null> {
  try {
    const r = await fetch(file);
    return r.ok ? ((await r.json()) as GeoFC) : null;
  } catch { return null; }
}

interface PriorCase {
  id: number; created_at: string; status: string; team_id: number | null;
  first_name: string | null; last_name: string | null; area: string | null;
  dob: string | null; phone_line: string | null; ssn4: string | null;
}
const PRIOR_COLS = 'id, created_at, status, team_id, first_name, last_name, area, dob, phone_line, ssn4';
/** 8xx toll-free / relay lines: many unrelated callers share them, so
 *  number-based repeat detection is noise — the name check carries it. */
const isTollFree = (digits: string) => /^1?8(00|88|77|66|55|44|33)\d{7}$/.test(digits);
/** statuses where a case is still being worked — a repeat call about one of
 *  these should ATTACH, not spawn a duplicate queue row */
const STILL_OPEN = ['new', 'assigned', 'attempted', 'contacted', 'confirmed'];
interface GeoHit { label: string; lat: number; lng: number }

/**
 * Call intake — built for an operator on the phone: one screen, tap-first,
 * everything optional except SOME way to find or reach the caller. The call
 * timestamp is the row's created_at (database clock, not this form).
 *
 * Repeat-caller check fires as the line number is typed (RLS-scoped browser
 * query — same session the page runs under). Address geocoding goes through
 * /api/helpline/geocode so county PCs never call external services; a failed
 * geocode still saves the typed address.
 */
export default function CallIntakeForm({ me }: { me: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState({
    first_name: '', last_name: '', dob: '', ssn4: '',
    phone_line: '', phone_callback: '',
    area: '', landmark: '', address: '',
    sleeping: '', household: '', notes: '',
  });
  const [factors, setFactors] = useState<string[]>([]);
  const [prior, setPrior] = useState<PriorCase[]>([]);
  const [geo, setGeo] = useState<GeoHit[] | 'loading' | null>(null);
  const [pin, setPin] = useState<GeoHit | null>(null);
  const [countyDist, setCountyDist] = useState<string | null>(null);
  const [distNote, setDistNote] = useState<string | null>(null);
  const [teams, setTeams] = useState<RoutableTeam[]>([]);
  const [openBy, setOpenBy] = useState<Map<number, number>>(new Map());
  const [assignNow, setAssignNow] = useState(false);
  const [referOpen, setReferOpen] = useState(false);
  const [rules, setRules] = useState<PriorityRules>(DEFAULT_RULES);
  useEffect(() => { fetchPriorityRules().then(setRules); }, []);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  // Teams + their open-case load, once per form — feeds the live suggestion
  // (same suggestTeam the triage queue uses, so the two always agree).
  useEffect(() => {
    (async () => {
      const db = supabaseBrowser();
      const [t, oc] = await Promise.all([
        db.from('outreach_teams').select('id, name, zones, factors, active').eq('active', true),
        db.from('helpline_cases').select('team_id')
          .in('status', ['assigned', 'attempted', 'contacted']).not('team_id', 'is', null),
      ]);
      setTeams((t.data ?? []) as RoutableTeam[]);
      const m = new Map<number, number>();
      for (const r of (oc.data ?? []) as { team_id: number }[]) {
        m.set(r.team_id, (m.get(r.team_id) ?? 0) + 1);
      }
      setOpenBy(m);
    })();
  }, []);

  // Repeat-caller check: same number, any prior case. Debounced on the digits.
  // Toll-free/relay numbers are skipped — shared by unrelated callers.
  const [tollFree, setTollFree] = useState(false);
  useEffect(() => {
    const digits = f.phone_line.replace(/\D/g, '');
    setTollFree(isTollFree(digits));
    if (digits.length < 7 || isTollFree(digits)) { setPrior([]); return; }
    const h = setTimeout(async () => {
      const { data } = await supabaseBrowser()
        .from('helpline_cases')
        .select(PRIOR_COLS)
        .or(`phone_line.ilike.%${digits.slice(-7)}%,phone_callback.ilike.%${digits.slice(-7)}%`)
        .order('created_at', { ascending: false })
        .limit(5);
      setPrior((data ?? []) as PriorCase[]);
    }, 350);
    return () => clearTimeout(h);
  }, [f.phone_line]);

  // Borrowed-phone coverage (user directive 2026-08-20: match on name, DOB,
  // SSN-4, and phone — whatever is available). Any single identifier can
  // surface an open case; the banner says WHICH fields matched so the
  // operator can verify identity on the call.
  const [priorName, setPriorName] = useState<PriorCase[]>([]);
  useEffect(() => {
    const fn = f.first_name.trim(), ln = f.last_name.trim();
    const hasName = fn.length >= 2 && ln.length >= 2;
    const hasDob = Boolean(f.dob);
    const hasSsn = /^\d{4}$/.test(f.ssn4);
    if (!hasName && !hasDob && !hasSsn) { setPriorName([]); return; }
    const h = setTimeout(async () => {
      const clean = (s: string) => s.replace(/[(),.]/g, ' ').trim();
      const ors: string[] = [];
      if (hasName) ors.push(`and(first_name.ilike.${clean(fn)},last_name.ilike.${clean(ln)})`);
      if (hasDob) ors.push(`dob.eq.${f.dob}`);
      if (hasSsn) ors.push(`ssn4.eq.${f.ssn4}`);
      const { data } = await supabaseBrowser()
        .from('helpline_cases')
        .select(PRIOR_COLS)
        .or(ors.join(','))
        .in('status', STILL_OPEN)
        .order('created_at', { ascending: false })
        .limit(4);
      setPriorName((data ?? []) as PriorCase[]);
    }, 400);
    return () => clearTimeout(h);
  }, [f.first_name, f.last_name, f.dob, f.ssn4]);

  async function geocode() {
    const q = [f.address, f.area, 'Miami-Dade FL'].filter(Boolean).join(', ');
    if (f.address.trim().length < 4) return;
    setGeo('loading'); setPin(null);
    try {
      const res = await fetch(`/api/helpline/geocode?q=${encodeURIComponent(q)}`);
      const j = await res.json();
      setGeo((j.results ?? []) as GeoHit[]);
    } catch {
      setGeo([]);
    }
  }

  /** Pin picked → detect districts (point-in-polygon on the same files the
   *  call map draws). Inside the city: area auto-sets to the Commission
   *  District, per the routing doc — no lookup-map trip. Outside: the
   *  operator's municipality pick stands. County district is stamped either
   *  way for reporting. Operator can always override the area afterward. */
  async function pickPin(g: GeoHit) {
    setPin(g);
    if (_cityGeo === undefined) _cityGeo = await loadGeo('/gis/districts.geojson');
    if (_countyGeo === undefined) _countyGeo = await loadGeo('/gis/county_districts.geojson');
    if (_muniGeo === undefined) _muniGeo = await loadGeo('/gis/municipalities.geojson');
    const notes: string[] = [];
    // Admin-drawn custom areas outrank everything — they exist precisely to
    // override the default geography (e.g. a drawn 'Government Center').
    const customs = await fetchCustomAreas();
    const custom = customs.find((a) => inFeature(g.lng, g.lat, a.polygon));
    const city = _cityGeo ? featuresAt(g.lng, g.lat, _cityGeo) : [];
    if (custom) {
      set('area')(custom.name);
      notes.push(`in ${custom.name} (custom area, set automatically)`);
    } else if (city.length) {
      const d = String(city[0].COMDISTID ?? '');
      const areaVal = d === '' ? '' : `Miami District ${d}`;
      if (areaVal && (AREAS as readonly string[]).includes(areaVal)) {
        set('area')(areaVal);
        notes.push(`inside City of Miami — District ${d} (area set automatically)`);
      }
    } else if (_cityGeo) {
      // Outside the city: the municipality polygon (county layer) stamps the
      // area so municipality-zoned teams route; unincorporated (or file
      // missing) leaves area null and the county-district fallback routes.
      // featuresAt can return several hits (inFeature ignores holes, so the
      // unincorporated outer ring may contain municipalities) — take the
      // first hit that names a real municipality.
      const muni = _muniGeo ? featuresAt(g.lng, g.lat, _muniGeo) : [];
      const mArea = muni.map((m) => muniArea(String(m.NAME ?? ''))).find(Boolean) ?? null;
      if (mArea) {
        set('area')(mArea);
        notes.push(`in ${mArea} (area set automatically)`);
      } else {
        notes.push('outside City of Miami — routes by County Commission District');
      }
    }
    const county = _countyGeo ? featuresAt(g.lng, g.lat, _countyGeo) : [];
    if (county.length) {
      const cd = `County District ${county[0].ID ?? '?'}`;
      setCountyDist(cd);
      notes.push(`${cd}${county[0].COMMNAME ? ` (${county[0].COMMNAME})` : ''}`);
    } else {
      setCountyDist(null);
    }
    setDistNote(notes.length ? notes.join(' · ') : null);
  }

  const pts = priorityOf(factors, f.household || null, f.sleeping || null, rules);
  const band = priorityBand(pts, rules);

  // In-page attach confirmation (user: no browser alert popups). Shows what
  // will attach, warns when the form is empty; the summary reads LIVE state,
  // so Go back → type notes → Confirm includes them.
  const [confirmAttach, setConfirmAttach] = useState<{ p: PriorCase; reopen: boolean } | null>(null);
  const [confirmNewCase, setConfirmNewCase] = useState(false);
  const [armCancel, setArmCancel] = useState(false);
  const attachPreview = (p: PriorCase): string[] => {
    const locBits = [f.address.trim(), f.landmark.trim(),
      pin ? `pin ${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}` : ''].filter(Boolean).join(' · ');
    const typedNum = (f.phone_callback || f.phone_line).trim();
    const newNumber = typedNum
      && typedNum.replace(/\D/g, '').slice(-7) !== (p.phone_line ?? '').replace(/\D/g, '').slice(-7)
      ? typedNum : '';
    return [
      f.notes.trim() ? `Notes: ${f.notes.trim().slice(0, 140)}${f.notes.trim().length > 140 ? '…' : ''}` : '',
      locBits ? `New location: ${locBits}` : '',
      newNumber ? `New callback number: ${newNumber}` : '',
    ].filter(Boolean);
  };

  // open-case matches from every channel, deduped — labeled by WHAT matched
  const idHits = (p: PriorCase): string[] => {
    const hits: string[] = [];
    const fn = f.first_name.trim().toLowerCase(), ln = f.last_name.trim().toLowerCase();
    if (fn && ln && (p.first_name ?? '').toLowerCase() === fn
      && (p.last_name ?? '').toLowerCase() === ln) hits.push('name');
    if (f.dob && p.dob === f.dob) hits.push('DOB');
    if (/^\d{4}$/.test(f.ssn4) && p.ssn4 === f.ssn4) hits.push('SSN-4');
    return hits;
  };
  const phoneOpen = prior.filter((p) => STILL_OPEN.includes(p.status));
  const openMatches = [
    ...phoneOpen.map((p) => ({ p, via: ['same number', ...idHits(p)].join(' + ') })),
    ...priorName.filter((p) => !phoneOpen.some((q) => q.id === p.id))
      .map((p) => ({ p, via: idHits(p).join(' + ') || 'possible match' })),
  ];
  // identifiers changed → any pending confirmations are stale
  const matchKey = openMatches.map((m) => m.p.id).join(',');
  useEffect(() => { setConfirmNewCase(false); setConfirmAttach(null); }, [matchKey]);

  /** Automated duplicate handling (user pick 2026-08-20): the system tells
   *  the operator this number has an OPEN case and one click logs the new
   *  call (and any fresher location) onto it — no duplicate queue row. */
  async function attachToCase(p: PriorCase, reopen = false) {
    if (busy) return;
    const locBits = [f.address.trim(), f.landmark.trim(),
      pin ? `pin ${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}` : ''].filter(Boolean).join(' · ');
    // borrowed phone? capture the number they're reachable at NOW
    const typedNum = (f.phone_callback || f.phone_line).trim();
    const newNumber = typedNum
      && typedNum.replace(/\D/g, '').slice(-7) !== (p.phone_line ?? '').replace(/\D/g, '').slice(-7)
      ? typedNum : '';
    setBusy(true); setErr(null);
    const db = supabaseBrowser();
    const ev = await db.from('helpline_calls').insert({
      case_id: p.id, operator: me,
      kind: 'repeat', // a real incoming CALL — counts toward call volume
      notes: (reopen
        ? 'Caller called again — case REOPENED, failed-attempt counter reset. '
        : `Repeat call${newNumber ? ` from a different number (${newNumber})` : ' (same number)'}. `)
        + (f.notes.trim() || 'No new information given.')
        + (locBits ? ` — location now: ${locBits}` : ''),
    });
    let e2 = ev.error;
    if (!e2) {
      const patch: Record<string, unknown> = {};
      if (f.address.trim()) patch.address = f.address.trim();
      if (f.landmark.trim()) patch.landmark = f.landmark.trim();
      if (f.area.trim()) patch.area = f.area.trim();
      if (pin) { patch.lat = pin.lat; patch.lng = pin.lng; }
      if (countyDist) patch.county_district = countyDist;
      if (newNumber) patch.phone_callback = newNumber; // reach them at the NEW number
      if (reopen) {
        // back to its team (or triage) with a FRESH 3-strike clock — the
        // dated ✗ history stays in the log; without the reset, one more
        // failed try would instantly re-close a reopened case
        patch.status = p.team_id != null ? 'assigned' : 'new';
        patch.attempts = 0;
      }
      if (Object.keys(patch).length) {
        const up = await db.from('helpline_cases').update(patch).eq('id', p.id);
        e2 = up.error;
      }
    }
    setBusy(false);
    if (e2) { setErr(e2.message); return; }
    router.push('/dashboard/helpline');
    router.refresh();
  }
  const sug = teams.length ? suggestTeam(
    { factors, household: f.household || null, area: f.area || null, county_district: countyDist },
    teams, openBy) : null;

  async function submit(refer?: { resource: ReferralResource; terminal: boolean }, force = false) {
    if (busy) return;
    if (!f.first_name.trim() && !f.phone_line.trim() && !f.phone_callback.trim() && !f.landmark.trim() && !f.address.trim()) {
      setErr('Capture at least a name, a number, or a location — something outreach can act on.');
      return;
    }
    // A matched OPEN case means Save would create a duplicate — stop and ask
    // in-page (user scenario 2026-08-20: updating info for a previous caller
    // and hitting Save by mistake). force = the operator confirmed new-person.
    if (!refer && !force && openMatches.length > 0) {
      setConfirmNewCase(true);
      return;
    }
    if (f.ssn4 && !/^\d{4}$/.test(f.ssn4)) { setErr('SSN-4 must be exactly 4 digits (or blank).'); return; }
    setBusy(true); setErr(null);
    const row: Record<string, unknown> = { created_by: me, priority: pts, factors };
    for (const [k, v] of Object.entries(f)) if (v.trim()) row[k] = v.trim();
    if (pin) { row.lat = pin.lat; row.lng = pin.lng; }
    if (countyDist) row.county_district = countyDist;
    if (refer?.terminal) {
      // SOP referral resolved the call — no outreach dispatch for this case.
      row.status = 'referred_out';
      row.referred_to = refer.resource.name;
    } else if (assignNow && sug) {
      row.team_id = sug.team.id;
      row.status = 'assigned';
      row.assigned_at = new Date().toISOString();
    }
    const db = supabaseBrowser();
    const { data, error } = await db.from('helpline_cases').insert(row).select('id').single();
    if (!error && data) {
      await db.from('helpline_calls').insert({ case_id: data.id, operator: me, kind: 'initial', notes: f.notes.trim() || null });
      if (refer) {
        // the SOP's "document that the referral information was provided"
        await db.from('helpline_calls').insert({
          case_id: data.id, operator: me, kind: 'followup',
          notes: refer.terminal
            ? `Referred out → ${refer.resource.name}. SOP referral information provided to the caller.`
            : `Referral info provided → ${refer.resource.name}; case remains active for outreach.`,
        });
      }
    }
    setBusy(false);
    if (error) { setErr(error.message); return; }
    router.push('/dashboard/helpline');
    router.refresh();
  }

  const L = ({ children }: { children: React.ReactNode }) => (
    <label style={{ display: 'block', fontSize: 11, color: 'var(--faint)', fontWeight: 700,
      letterSpacing: '.05em', textTransform: 'uppercase', margin: '13px 0 5px' }}>{children}</label>
  );
  const Chips = ({ options, value, onPick }: {
    options: readonly string[]; value: string; onPick: (v: string) => void;
  }) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
      {options.map((v) => {
        const on = value === v;
        return (
          <button key={v} type="button" aria-pressed={on} onClick={() => onPick(on ? '' : v)}
            style={{ border: `1px solid ${on ? 'var(--secondary)' : 'var(--border)'}`,
              background: on ? 'var(--primary-light)' : 'var(--card)',
              color: on ? 'var(--strong)' : 'var(--muted)',
              borderRadius: 20, padding: '7px 13px', fontSize: 12.5, fontWeight: 600,
              cursor: 'pointer', font: 'inherit' }}>{v}</button>
        );
      })}
    </div>
  );

  return (
    <div className="panel" style={{ maxWidth: 720 }}>
      <div className="panel-h">
        <div>
          <h3>New call</h3>
          <div className="meta">Call time is stamped automatically ·{' '}
            <Link href="/dashboard/helpline">Back to triage</Link></div>
        </div>
        <span className="bnl-chip" style={{
          background: band === 'HIGH' ? 'var(--danger-light)' : band === 'MED' ? 'var(--warn-light)' : 'var(--track)',
          color: band === 'HIGH' ? 'var(--danger)' : band === 'MED' ? 'var(--warn)' : 'var(--muted)' }}>
          priority {band} · {pts} pts</span>
      </div>
      <div style={{ padding: '0 12px 16px' }}>
        {err && <div className="lerror" role="alert" style={{ marginBottom: 10 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <L>Number they called from</L>
            <input className="tinput" style={{ width: '100%' }} value={f.phone_line} maxLength={25}
              placeholder="Caller ID" onChange={(e) => set('phone_line')(e.target.value)} />
            {tollFree && (
              <div className="bnl-sub" style={{ marginTop: 4 }}>
                Toll-free / relay line — repeat detection by number is off for this call;
                name, DOB, and SSN-4 checks still run.
              </div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <L>Callback number — if different</L>
            <input className="tinput" style={{ width: '100%' }} value={f.phone_callback} maxLength={25}
              placeholder="“But reach me at…”" onChange={(e) => set('phone_callback')(e.target.value)} />
          </div>
        </div>
        {openMatches.length > 0 && (
          <div style={{ background: 'var(--danger-light)', border: '1px solid var(--danger)',
            borderRadius: 8, padding: '10px 13px', fontSize: 12.5, margin: '10px 0 0' }}>
            <b style={{ color: 'var(--danger)' }}>⚠ This caller may already have an open case</b>
            {openMatches.map(({ p, via }) => (
              <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center',
                flexWrap: 'wrap', marginTop: 6 }}>
                <span>#{p.id} <b>{[p.first_name, p.last_name].filter(Boolean).join(' ') || 'anonymous'}</b>
                  {' '}· {p.status}
                  {p.team_id != null && teams.find((t) => t.id === p.team_id)
                    ? ` · ${teams.find((t) => t.id === p.team_id)!.name}` : ''}
                  {p.area ? ` · ${p.area}` : ''}
                  {p.dob ? ` · DOB ${p.dob}` : ''}
                  {' '}<span className="bnl-fp bnl-fp-sch">{via}</span></span>
                <button className="btn primary" type="button" style={{ padding: '4px 12px', fontSize: 12 }}
                  disabled={busy} onClick={() => setConfirmAttach({ p, reopen: false })}>
                  Log this call on case #{p.id}</button>
              </div>
            ))}
            <div className="bnl-sub" style={{ marginTop: 6 }}>
              Adds these notes, any new location, AND the new number to the open case — no
              duplicate is created. Verify identity on the call (DOB shown when known); a
              different person → save a new call below as usual.
            </div>
          </div>
        )}
        {prior.some((p) => !STILL_OPEN.includes(p.status)) && (
          <div style={{ background: 'var(--primary-soft)', border: '1px solid var(--primary-light)',
            borderRadius: 8, padding: '9px 13px', fontSize: 12.5, margin: '10px 0 0' }}>
            ☎ This number has called before:
            {prior.filter((p) => !STILL_OPEN.includes(p.status)).map((p) => (
              <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center',
                flexWrap: 'wrap', marginTop: 5 }}>
                <span>
                  <b>{[p.first_name, p.last_name].filter(Boolean).join(' ') || 'anonymous'}</b>
                  {' '}({new Date(p.created_at).toLocaleDateString()}, {p.status}
                  {p.area ? `, ${p.area}` : ''})
                </span>
                <button className="tbtn" type="button" style={{ padding: '3px 10px', fontSize: 12 }}
                  disabled={busy}
                  title="Same person calling again? Reopen the closed case — it returns to its team (or the queue) with a fresh attempt counter, and these notes attach to it"
                  onClick={() => setConfirmAttach({ p, reopen: true })}>
                  Reopen #{p.id} + log this call</button>
              </div>
            ))}
            <div className="bnl-sub" style={{ marginTop: 5 }}>
              A shared phone isn&rsquo;t proof of identity; confirm on the call. Different person →
              save a new call below as usual.
            </div>
          </div>
        )}

        {confirmAttach && (
          <div style={{ background: 'var(--info-light)', border: '1px solid var(--info)',
            borderRadius: 8, padding: '10px 13px', fontSize: 12.5, margin: '10px 0 0' }}>
            <b style={{ color: 'var(--strong)' }}>
              {confirmAttach.reopen
                ? `Reopen case #${confirmAttach.p.id} and log this call?`
                : `Log this call on open case #${confirmAttach.p.id}?`}</b>
            {attachPreview(confirmAttach.p).length > 0
              ? attachPreview(confirmAttach.p).map((s, i) => (
                  <div key={i} style={{ marginTop: 4 }}>{s}</div>))
              : <div style={{ color: 'var(--warn)', fontWeight: 600, marginTop: 4 }}>
                  Nothing new is filled in — it will be logged as &ldquo;No new information
                  given.&rdquo; Go back to add call notes or an updated location first.
                </div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="btn primary" type="button" disabled={busy}
                style={{ background: 'var(--accent)' }}
                onClick={() => {
                  const a = confirmAttach;
                  setConfirmAttach(null);
                  if (a) attachToCase(a.p, a.reopen);
                }}>
                {confirmAttach.reopen ? 'Confirm — reopen + log call' : 'Confirm — log call'}</button>
              <button className="tbtn" type="button" onClick={() => setConfirmAttach(null)}>← Go back</button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 160 }}>
            <L>First name</L>
            <input className="tinput" style={{ width: '100%' }} value={f.first_name} maxLength={80}
              onChange={(e) => set('first_name')(e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <L>Last name</L>
            <input className="tinput" style={{ width: '100%' }} value={f.last_name} maxLength={80}
              onChange={(e) => set('last_name')(e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <L>DOB — helps HMIS match</L>
            <input className="tinput" style={{ width: '100%' }} type="date" value={f.dob}
              onChange={(e) => set('dob')(e.target.value)} />
          </div>
          <div style={{ flex: 0.7, minWidth: 110 }}>
            <L>SSN-4 — optional</L>
            <input className="tinput" style={{ width: '100%' }} value={f.ssn4} maxLength={4} inputMode="numeric"
              onChange={(e) => set('ssn4')(e.target.value.replace(/\D/g, ''))} />
          </div>
        </div>

        <L>Address or intersection — as exact as they can give</L>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="tinput" style={{ flex: 1 }} value={f.address} maxLength={160}
            placeholder="e.g. 401 NW 2nd Ave · or NW 36th St & 17th Ave"
            onChange={(e) => { set('address')(e.target.value); setGeo(null); setPin(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); geocode(); } }} />
          <button className="tbtn" type="button" disabled={geo === 'loading'} onClick={geocode}
            title="Look up coordinates (server-side); the pin sets the district and drives the team suggestion">
            {geo === 'loading' ? 'Locating…' : '📍 Locate'}</button>
        </div>
        {/* No area question (user directive 2026-08-20): the PIN decides — city
            district becomes the area, county district is the countywide
            routing fallback. The operator just types what the caller says. */}
        {f.address.trim().length >= 4 && !pin && geo === null && (
          <div className="bnl-sub" style={{ marginTop: 4 }}>
            Press Enter or 📍 Locate — the pin sets the district and the team suggestion.
          </div>
        )}
        {Array.isArray(geo) && geo.length === 0 && (
          <div className="bnl-sub" style={{ marginTop: 4 }}>No match — the typed address still saves; refine or skip.</div>
        )}
        {distNote && (
          <div style={{ background: 'var(--accent-light)', border: '1px solid var(--accent)',
            borderRadius: 8, padding: '7px 12px', fontSize: 12.5, marginTop: 6,
            color: 'var(--strong)' }}>
            📍 {distNote}
          </div>
        )}
        {Array.isArray(geo) && geo.map((g) => (
          <button key={g.label} type="button" className="tbtn"
            style={{ display: 'block', marginTop: 6, textAlign: 'left', width: '100%',
              ...(pin?.label === g.label ? { borderColor: 'var(--secondary)', color: 'var(--strong)' } : {}) }}
            onClick={() => pickPin(g)}>
            {pin?.label === g.label ? '✓ ' : ''}{g.label}
            <span className="bnl-sub"> · {g.lat.toFixed(5)}, {g.lng.toFixed(5)}</span>
          </button>
        ))}

        <L>Landmark / how to find them</L>
        <input className="tinput" style={{ width: '100%' }} value={f.landmark} maxLength={200}
          placeholder="“Amelia Earhart Park, by the north lot — blue tent”"
          onChange={(e) => set('landmark')(e.target.value)} />

        <L>Where did they sleep last night?</L>
        <Chips options={SLEEPING_OPTIONS} value={f.sleeping} onPick={set('sleeping')} />
        <L>Household on the call</L>
        <Chips options={HOUSEHOLD_OPTIONS} value={f.household} onPick={set('household')} />
        <L>Factors — tap all that apply</L>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
          {FACTORS.map(({ key }) => {
            const on = factors.includes(key);
            return (
              <button key={key} type="button" aria-pressed={on}
                onClick={() => setFactors((p) => on ? p.filter((x) => x !== key) : [...p, key])}
                style={{ border: `1px solid ${on ? 'var(--secondary)' : 'var(--border)'}`,
                  background: on ? 'var(--primary-light)' : 'var(--card)',
                  color: on ? 'var(--strong)' : 'var(--muted)',
                  borderRadius: 20, padding: '7px 13px', fontSize: 12.5, fontWeight: 600,
                  cursor: 'pointer', font: 'inherit' }}>{key}</button>
            );
          })}
        </div>

        <L>Call notes</L>
        <textarea className="tinput" rows={3} style={{ width: '100%', resize: 'vertical' }}
          value={f.notes} maxLength={4000}
          placeholder="What they said, callback window, safety context…"
          onChange={(e) => set('notes')(e.target.value)} />

        {sug && (
          <div style={{ background: 'var(--primary-soft)', border: '1px solid var(--primary-light)',
            borderRadius: 8, padding: '10px 14px', fontSize: 12.5, marginTop: 14 }}>
            <b style={{ color: 'var(--strong)' }}>Suggested team: {sug.team.name}</b>
            <span className="bnl-sub"> · {sug.why} · {openBy.get(sug.team.id) ?? 0} open
              case{(openBy.get(sug.team.id) ?? 0) === 1 ? '' : 's'}</span>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 7,
              cursor: 'pointer', color: 'var(--text)' }}>
              <input type="checkbox" checked={assignNow}
                onChange={(e) => setAssignNow(e.target.checked)} />
              Assign to this team on save — unchecked, the call lands in the triage queue
            </label>
          </div>
        )}
        {!sug && teams.length > 0 && (f.area || countyDist) && (
          <div className="bnl-sub" style={{ marginTop: 14 }}>
            No team covers {f.area || countyDist} yet — the call goes to the triage queue for
            manual assignment. Admins set zones under Team coverage on the Helpline page.
          </div>
        )}

        {confirmNewCase && openMatches.length > 0 && (
          <div style={{ background: 'var(--warn-light)', border: '1px solid var(--warn)',
            borderRadius: 8, padding: '10px 13px', fontSize: 12.5, marginTop: 14 }}>
            <b style={{ color: 'var(--strong)' }}>⚠ An open case may already exist for this
              caller — save a NEW case anyway?</b>
            <div className="bnl-sub" style={{ marginTop: 4 }}>
              {openMatches.map(({ p, via }) =>
                `#${p.id} ${[p.first_name, p.last_name].filter(Boolean).join(' ') || 'anonymous'} (${via})`
              ).join(' · ')}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="btn primary" type="button" disabled={busy}
                style={{ background: 'var(--info)' }}
                onClick={() => { setConfirmNewCase(false); setConfirmAttach({ p: openMatches[0].p, reopen: false }); }}>
                Attach to #{openMatches[0].p.id} instead</button>
              <button className="btn primary" type="button" disabled={busy}
                style={{ background: 'var(--accent)' }}
                onClick={() => { setConfirmNewCase(false); submit(undefined, true); }}>
                Different person — save new case</button>
              <button className="tbtn" type="button" onClick={() => setConfirmNewCase(false)}>← Go back</button>
            </div>
          </div>
        )}

        {/* color-coded, equal-size actions (user directive 2026-08-20):
            green = save, blue = save + refer, red = cancel (two-step, no
            browser dialogs anywhere on this form) */}
        <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn primary" disabled={busy} onClick={() => submit()}
            style={{ background: 'var(--accent)', minWidth: 160 }}>
            {busy ? 'Saving…' : assignNow && sug ? `Save + assign → ${sug.team.name}` : 'Save call'}
          </button>
          <button className="btn primary" type="button" disabled={busy}
            style={{ background: 'var(--info)', minWidth: 160 }}
            title="SOP specialized referrals (prevention · veterans · DV · youth) and other-provider areas — shows the script to read to the caller, then saves the call"
            onClick={() => setReferOpen(true)}>
            ↗ Save + refer out
          </button>
          <button className="btn primary" type="button" disabled={busy}
            style={{ background: 'var(--danger)', minWidth: 160 }}
            title="Discard this call and return to triage — nothing is saved"
            onClick={() => {
              const touched = Object.values(f).some((v) => v.trim() !== '')
                || factors.length > 0 || pin !== null;
              if (!touched || armCancel) { router.push('/dashboard/helpline'); return; }
              setArmCancel(true);
              setTimeout(() => setArmCancel(false), 4000);
            }}>
            {armCancel ? 'Discard? Click again' : 'Cancel call'}
          </button>
        </div>
        {referOpen && (
          <ReferOut title="Refer the caller out"
            onPick={(resource, terminal) => { setReferOpen(false); submit({ resource, terminal }); }}
            onClose={() => setReferOpen(false)} />
        )}
      </div>
    </div>
  );
}
