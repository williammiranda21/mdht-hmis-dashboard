'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '../../../lib/supabase-browser';
import {
  AREAS, DEFAULT_RULES, SLEEPING_OPTIONS, HOUSEHOLD_OPTIONS, FACTORS, muniArea, priorityOf,
  priorityBand, suggestTeam, type PriorityRules, type RoutableTeam,
} from '../../../lib/helpline-options';
import { fetchPriorityRules } from '../../../lib/priority-rules';
import { featuresAt, inFeature, type GeoFC } from '../../../lib/slippy';
import { fetchCustomAreas } from '../../../lib/custom-areas';
import ReferOut, { type ReferralResource } from '../../../components/ReferOut';
import { CopyId } from '../../dashboard/analytics/shared';
import { IconSearch, IconLink, IconMapPin, IconMap } from '../../../components/icons';
import PinMap from '../../../components/PinMap';
import DobInput from '../../../components/DobInput';

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
  address?: string | null; landmark?: string | null;
}
const PRIOR_COLS = 'id, created_at, status, team_id, first_name, last_name, area, dob, phone_line, ssn4, address, landmark';
/** why a known caller is calling again — required on a follow-up so the log
 *  never reads "no new information" by accident (user 2026-10-01) */
const FU_REASONS = ['Checking on status', 'New location', 'Situation changed',
  'Found housing / wants to cancel', 'Same info, calling again'] as const;
/** most advanced first — the merge keeps the highest */
const STATUS_RANK = ['new', 'assigned', 'attempted', 'contacted', 'confirmed'];
/** 8xx toll-free / relay lines: many unrelated callers share them, so
 *  number-based repeat detection is noise — the name check carries it. */
const isTollFree = (digits: string) => /^1?8(00|88|77|66|55|44|33)\d{7}$/.test(digits);
/** statuses where a case is still being worked — a repeat call about one of
 *  these should ATTACH, not spawn a duplicate queue row */
const STILL_OPEN = ['new', 'assigned', 'attempted', 'contacted', 'confirmed'];
interface GeoHit { label: string; lat: number; lng: number }
interface HmisCand {
  pid: string; name: string; dob: string | null; score: number; why: string[];
  bnl: { status: string | null; project: string | null; last_contact: string | null;
    chronic?: boolean; veteran?: boolean;
    enroll?: { open: boolean; project: string; entry: string | null;
      exit?: string | null; dest?: string | null; more?: number } | null } | null;
}

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
export default function CallIntakeForm({ me, canMerge = false }: {
  me: string;
  /** full admins + helpline admins may merge duplicate open cases */
  canMerge?: boolean;
}) {
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
  // household-size follow-up — asked only when household = With children
  const [hhSize, setHhSize] = useState('');
  // live HMIS glance (2026-09-22): as identity fields land, propose HMIS
  // candidates (same scorer/gate as the queue's Find HMIS match) so the
  // operator sees who this is BEFORE saving / referring / assigning.
  // Suggest-only: linking is an explicit click, saved as matched_pid.
  const [hmisCands, setHmisCands] = useState<HmisCand[] | null>(null);
  const [linked, setLinked] = useState<HmisCand | null>(null);
  // "None of these" hides the panel; any change to an identity field looks
  // again — new info (a DOB, a corrected spelling) can surface the real match.
  const [hmisDismissed, setHmisDismissed] = useState(false);
  useEffect(() => {
    setHmisDismissed(false);
    const first = f.first_name.trim(), last = f.last_name.trim();
    const dob = f.dob.trim(), ssn4 = /^\d{4}$/.test(f.ssn4) ? f.ssn4 : '';
    if (!dob && !ssn4 && !(first && last)) { setHmisCands(null); return; }
    const t = setTimeout(async () => {
      try {
        const qs = new URLSearchParams();
        if (first) qs.set('first', first);
        if (last) qs.set('last', last);
        if (dob) qs.set('dob', dob);
        if (ssn4) qs.set('ssn4', ssn4);
        const r = await fetch(`/api/helpline/match?${qs.toString()}`);
        if (r.ok) setHmisCands(((await r.json()).candidates ?? []) as HmisCand[]);
      } catch { /* glance is best-effort — intake never blocks on it */ }
    }, 600);
    return () => clearTimeout(t);
  }, [f.first_name, f.last_name, f.dob, f.ssn4]);
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

  /** Point-in-polygon detection + area stamping for ANY coordinates — shared
   *  by geocode picks and manual pin nudges, so moving the pin re-routes.
   *  Custom areas outrank everything; inside the city the area auto-sets to
   *  the Commission District; the county district is stamped either way. */
  async function detectArea(latN: number, lngN: number) {
    if (_cityGeo === undefined) _cityGeo = await loadGeo('/gis/districts.geojson');
    if (_countyGeo === undefined) _countyGeo = await loadGeo('/gis/county_districts.geojson');
    if (_muniGeo === undefined) _muniGeo = await loadGeo('/gis/municipalities.geojson');
    const notes: string[] = [];
    // Admin-drawn custom areas outrank everything — they exist precisely to
    // override the default geography (e.g. a drawn 'Government Center').
    const customs = await fetchCustomAreas();
    const custom = customs.find((a) => inFeature(lngN, latN, a.polygon));
    const city = _cityGeo ? featuresAt(lngN, latN, _cityGeo) : [];
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
      const muni = _muniGeo ? featuresAt(lngN, latN, _muniGeo) : [];
      const mArea = muni.map((m) => muniArea(String(m.NAME ?? ''))).find(Boolean) ?? null;
      if (mArea) {
        set('area')(mArea);
        notes.push(`in ${mArea} (area set automatically)`);
      } else {
        notes.push('outside City of Miami — routes by County Commission District');
      }
    }
    const county = _countyGeo ? featuresAt(lngN, latN, _countyGeo) : [];
    if (county.length) {
      const cd = `County District ${county[0].ID ?? '?'}`;
      setCountyDist(cd);
      notes.push(`${cd}${county[0].COMMNAME ? ` (${county[0].COMMNAME})` : ''}`);
    } else {
      setCountyDist(null);
    }
    setDistNote(notes.length ? notes.join(' · ') : null);
  }

  const [focusKey, setFocusKey] = useState(0);
  const [manualMap, setManualMap] = useState(false);
  async function pickPin(g: GeoHit) {
    setPin(g);
    setFocusKey((k) => k + 1); // recenter the adjust-map on the new result
    await detectArea(g.lat, g.lng);
  }
  /** Staff fine-tune (user ask: "Bayfront Park, south side") — clicking the
   *  map moves the pin and re-runs detection + the team suggestion. */
  function movePin(latN: number, lngN: number) {
    setPin((p) => ({
      label: `${(p?.label ?? 'manual pin').replace(/ \(adjusted\)$/, '')} (adjusted)`,
      lat: latN, lng: lngN,
    }));
    void detectArea(latN, lngN);
    void describePin(latN, lngN);
  }

  // A clicked/dropped pin → nearest address + intersection in words (user
  // 2026-10-01: logs showed "pin 25.82041, -80.21537"). Fills an EMPTY
  // address box (the operator can still edit it); never overwrites typing.
  const [pinPlace, setPinPlace] = useState<string | null>(null);
  const pinSeq = useRef(0);
  const autoAddr = useRef<string | null>(null);
  async function describePin(latN: number, lngN: number) {
    const seq = ++pinSeq.current;
    setPinPlace(null);
    try {
      const j = await (await fetch(`/api/helpline/geocode?lat=${latN}&lng=${lngN}`)).json();
      if (seq !== pinSeq.current || !j?.label) return;
      setPinPlace(j.label);
      setF((prev) => {
        const cur = prev.address.trim();
        if (cur && cur !== autoAddr.current) return prev;      // operator typed something — keep it
        autoAddr.current = j.label;
        return { ...prev, address: j.label };
      });
    } catch { /* lookup is a convenience — coordinates still save */ }
  }

  const pts = priorityOf(factors, f.household || null, f.sleeping || null, rules);
  const band = priorityBand(pts, rules);

  // Follow-up mode (user 2026-10-01): "This is them" switches the form to a
  // follow-up on that case — nothing is written until the operator saves it
  // with a reason. attach = open case · reopen = closed case back to its team.
  const [followUp, setFollowUp] = useState<{ p: PriorCase; mode: 'attach' | 'reopen' } | null>(null);
  const [reason, setReason] = useState('');
  const [sendBack, setSendBack] = useState(false);
  const [fuLog, setFuLog] = useState<{ received_at: string; kind: string; notes: string | null }[] | null>(null);
  useEffect(() => {
    setSendBack(false);
    if (!followUp) { setFuLog(null); return; }
    setFuLog(null);
    supabaseBrowser().from('helpline_calls').select('received_at, kind, notes')
      .eq('case_id', followUp.p.id).order('received_at', { ascending: false }).limit(3)
      .then(({ data }) => setFuLog((data ?? []) as { received_at: string; kind: string; notes: string | null }[]));
  }, [followUp]);
  const [mergeArm, setMergeArm] = useState(false);
  const [mergeMsg, setMergeMsg] = useState<string | null>(null);
  const [confirmNewCase, setConfirmNewCase] = useState(false);
  const [armCancel, setArmCancel] = useState(false);
  // open-case matches from every channel, deduped — labeled by WHAT matched
  // Collapsed by default — a call is in progress; the summary line whispers
  // and the full match list is opt-in (user: the banner was too intrusive).
  const [dupOpen, setDupOpen] = useState(false);
  // Match channels ranked by IDENTIFIER STRENGTH (user directive 2026-08-25):
  // SSN-4 › name › DOB › phone. idHits pushes in that order so hits[0] is the
  // strongest; the strongest match leads the summary line and is the one the
  // save-guard's attach shortcut targets.
  const idHits = (p: PriorCase): string[] => {
    const hits: string[] = [];
    const fn = f.first_name.trim().toLowerCase(), ln = f.last_name.trim().toLowerCase();
    if (/^\d{4}$/.test(f.ssn4) && p.ssn4 === f.ssn4) hits.push('SSN-4');
    if (fn && ln && (p.first_name ?? '').toLowerCase() === fn
      && (p.last_name ?? '').toLowerCase() === ln) hits.push('name');
    if (f.dob && p.dob === f.dob) hits.push('DOB');
    return hits;
  };
  const MATCH_RANK = ['SSN-4', 'name', 'DOB'];
  const openMatches = (() => {
    const phoneOpenIds = new Set(prior.filter((p) => STILL_OPEN.includes(p.status)).map((p) => p.id));
    const seen = new Map<number, PriorCase>();
    for (const p of prior) if (STILL_OPEN.includes(p.status)) seen.set(p.id, p);
    for (const p of priorName) if (!seen.has(p.id)) seen.set(p.id, p);
    return [...seen.values()]
      .map((p) => {
        const hits = idHits(p);
        if (phoneOpenIds.has(p.id)) hits.push('same number');
        const rank = hits.length && MATCH_RANK.includes(hits[0]) ? MATCH_RANK.indexOf(hits[0]) : 3;
        return { p, via: hits.join(' + ') || 'possible match', rank };
      })
      // A phone number ALONE is too weak to suggest a match — shared and
      // recycled phones invite wrong-case attaches (user directive
      // 2026-08-25). Phone only ever corroborates a real identifier; the
      // phone-only open cases still show as neutral context under Review.
      .filter((m) => m.via !== 'same number')
      .sort((a, b) => a.rank - b.rank || b.p.created_at.localeCompare(a.p.created_at));
  })();
  /** open cases sharing the number but with NO identity agreement — context
   *  only, never a suggestion */
  const phoneOnlyOpen = prior.filter((p) =>
    STILL_OPEN.includes(p.status) && idHits(p).length === 0);
  // identifiers changed → any pending confirmations are stale
  const matchKey = openMatches.map((m) => m.p.id).join(',');
  useEffect(() => { setConfirmNewCase(false); setMergeArm(false); setMergeMsg(null); }, [matchKey]);

  // calls received + last call per matched case (initial + repeat = the phone rang)
  const [callStats, setCallStats] = useState<Record<number, { n: number; last: string }>>({});
  const statsKey = [...new Set([...prior, ...priorName].map((x) => x.id))].sort().join(',');
  useEffect(() => {
    const ids = statsKey ? statsKey.split(',').map(Number) : [];
    if (!ids.length) { setCallStats({}); return; }
    supabaseBrowser().from('helpline_calls').select('case_id, received_at')
      .in('case_id', ids).in('kind', ['initial', 'repeat']).limit(1000)
      .then(({ data }) => {
        const m: Record<number, { n: number; last: string }> = {};
        for (const e of (data ?? []) as { case_id: number; received_at: string }[]) {
          const cur = m[e.case_id] ?? { n: 0, last: e.received_at };
          m[e.case_id] = { n: cur.n + 1, last: e.received_at > cur.last ? e.received_at : cur.last };
        }
        setCallStats(m);
      });
  }, [statsKey]);

  const nm = (p: PriorCase) => [p.first_name, p.last_name].filter(Boolean).join(' ') || 'anonymous';
  /** open cases that look like the SAME person as the strongest match:
   *  same SSN-4, or same full name + same DOB */
  const samePersonGroup = (): PriorCase[] => {
    const top = openMatches[0]?.p;
    if (!top) return [];
    const key = (x: PriorCase) => `${(x.first_name ?? '').trim().toLowerCase()}|${(x.last_name ?? '').trim().toLowerCase()}|${x.dob ?? ''}`;
    const same = (x: PriorCase) => (top.ssn4 && x.ssn4 === top.ssn4)
      || (Boolean(top.dob) && Boolean(top.last_name) && key(x) === key(top));
    return openMatches.map((m) => m.p).filter(same);
  };
  const pickSurvivor = (g: PriorCase[]): PriorCase => [...g].sort((x, y) =>
    STATUS_RANK.indexOf(y.status) - STATUS_RANK.indexOf(x.status) || x.created_at.localeCompare(y.created_at))[0];

  async function mergeInto(survivor: PriorCase, group: PriorCase[]) {
    if (busy) return;
    setBusy(true); setErr(null);
    const res = await fetch('/api/helpline/merge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ survivor: survivor.id, others: group.filter((g) => g.id !== survivor.id).map((g) => g.id) }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false); setMergeArm(false);
    if (!res.ok) { setErr(j?.error || `Merge failed (HTTP ${res.status})`); return; }
    const gone = new Set(group.filter((g) => g.id !== survivor.id).map((g) => g.id));
    setPrior((l) => l.filter((x) => !gone.has(x.id)));
    setPriorName((l) => l.filter((x) => !gone.has(x.id)));
    setMergeMsg(`Merged into #${survivor.id} ✓`);
  }
  async function flagDup(survivor: PriorCase, group: PriorCase[]) {
    if (busy) return;
    setBusy(true); setErr(null);
    const { error } = await supabaseBrowser().from('helpline_calls').insert({
      case_id: survivor.id, operator: me, kind: 'followup',
      notes: `⚠ Possible duplicate open cases for the same person: ${group.map((g) => `#${g.id}`).join(', ')} — flagged by the call operator for a helpline admin to merge.`,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setMergeMsg('Flagged for a helpline admin ✓');
  }

  /** Automated duplicate handling (user pick 2026-08-20): the system tells
   *  the operator this number has an OPEN case and one click logs the new
   *  call (and any fresher location) onto it — no duplicate queue row. */
  async function attachToCase(p: PriorCase, mode: 'attach' | 'reopen' | 'outreach' = 'attach') {
    if (busy) return;
    const placeText = f.address.trim() || pinPlace || '';
    if (!reason && !f.notes.trim()) {
      setErr('Pick why they’re calling (or add notes) before saving the follow-up.');
      return;
    }
    const locBits = [placeText, f.landmark.trim(),
      pin && !placeText ? `pin ${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}` : ''].filter(Boolean).join(' · ');
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
      notes: (mode === 'reopen'
        ? 'Called again — case REOPENED, failed-attempt counter reset. '
        : mode === 'outreach'
        ? 'Called again — sent BACK TO OUTREACH from confirmed (confirmed-date history stays in this log); failed-attempt counter reset. '
        : `Follow-up call${newNumber ? ` from a different number (${newNumber})` : ''}. `)
        + [reason, f.notes.trim()].filter(Boolean).join(' — ')
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
      if (mode === 'reopen' || mode === 'outreach') {
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
    router.push('/helpline');
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
    if (hhSize.trim() && (!/^\d{1,2}$/.test(hhSize.trim()) || Number(hhSize) < 1)) {
      setErr('Household size must be a whole number (or blank).'); return;
    }
    setBusy(true); setErr(null);
    const row: Record<string, unknown> = { created_by: me, priority: pts, factors };
    for (const [k, v] of Object.entries(f)) if (v.trim()) row[k] = v.trim();
    if (pin) { row.lat = pin.lat; row.lng = pin.lng; }
    if (countyDist) row.county_district = countyDist;
    if (f.household === 'With children' && hhSize.trim()) row.household_size = Number(hhSize);
    if (linked) row.matched_pid = linked.pid;   // operator-confirmed HMIS link
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
    let { data, error } = await db.from('helpline_cases').insert(row).select('id').single();
    if (error && row.household_size != null && error.message.includes('household_size')) {
      // run-once supabase/helpline_household.sql hasn't run yet — keep the
      // answer in the case notes so nothing the operator collected is lost
      delete row.household_size;
      row.notes = [`Household size: ${hhSize.trim()}`, row.notes].filter(Boolean).join(' — ');
      ({ data, error } = await db.from('helpline_cases').insert(row).select('id').single());
    }
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
    router.push('/helpline');
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
    <div className="panel" style={{ maxWidth: 720, margin: '0 auto' }}>
      <div className="panel-h">
        <div>
          <h3>{followUp ? `Follow-up call — #${followUp.p.id}` : 'New call'}</h3>
          <div className="meta">Call time is stamped automatically ·{' '}
            <Link href="/helpline">Back to triage</Link></div>
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
        {/* Repeat-caller rework (user 2026-10-01, approved mockup): a match is
            a CARD with a field-by-field identity check and one "This is them"
            button that switches the form into FOLLOW-UP mode — nothing is
            logged until the operator saves a follow-up with a reason. Same
            person open more than once → merge (helpline admins) or flag. */}
        {followUp ? (() => {
          const p = followUp.p;
          const team = p.team_id != null ? teams.find((t) => t.id === p.team_id)?.name : null;
          const st = callStats[p.id];
          return (
            <div style={{ margin: '12px 0 0', border: '1px solid var(--primary)', borderRadius: 10,
              padding: '10px 13px', background: 'var(--primary-soft)', fontSize: 12.5 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <b style={{ color: 'var(--strong)', fontSize: 14 }}>
                  {followUp.mode === 'reopen' ? 'Reopen + follow-up' : 'Follow-up call'} on #{p.id} {nm(p)}</b>
                <span className="bnl-fp">{p.status}</span>
                {team && <span className="bnl-fp bnl-fp-par">{team}</span>}
                {st && <span className="bnl-sub">called {st.n}× · last {new Date(st.last).toLocaleDateString()}</span>}
                <span style={{ flex: 1 }} />
                <button type="button" className="tbtn" onClick={() => { setFollowUp(null); setReason(''); }}>
                  Not the same person — start a new case</button>
              </div>
              {(p.address || p.landmark || p.area) && (
                <div style={{ marginTop: 6 }}><span className="bnl-sub">Location on file: </span>
                  {[p.address, p.landmark, p.area].filter(Boolean).join(' · ')}</div>
              )}
              <div className="bnl-sub" style={{ marginTop: 8, fontWeight: 700 }}>Last on this case</div>
              {fuLog === null ? <div className="bnl-sub">Loading…</div> : fuLog.length === 0
                ? <div className="bnl-sub">No log entries yet.</div>
                : fuLog.map((e, i) => (
                  <div key={i} style={{ marginTop: 3 }}>
                    <span className="bnl-sub">{new Date(e.received_at).toLocaleDateString()} · {e.kind}</span>
                    {e.notes && <> — {e.notes.length > 140 ? `${e.notes.slice(0, 140)}…` : e.notes}</>}
                  </div>
                ))}
              <div style={{ marginTop: 10, fontSize: 11, color: 'var(--faint)', fontWeight: 700,
                letterSpacing: '.05em', textTransform: 'uppercase' }}>
                Why are they calling? <span style={{ color: 'var(--danger)' }}>required</span></div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 6 }}>
                {FU_REASONS.map((r) => {
                  const on = reason === r;
                  return (
                    <button key={r} type="button" aria-pressed={on} onClick={() => setReason(on ? '' : r)}
                      style={{ border: `1px solid ${on ? 'var(--secondary)' : 'var(--border)'}`,
                        background: on ? 'var(--primary-light)' : 'var(--card)',
                        color: on ? 'var(--strong)' : 'var(--muted)',
                        borderRadius: 20, padding: '6px 12px', fontSize: 12.5, fontWeight: 600,
                        cursor: 'pointer', font: 'inherit' }}>{r}</button>
                  );
                })}
              </div>
              <div className="bnl-sub" style={{ marginTop: 6 }}>
                Add a new address, landmark, pin, or callback number below if they gave one — it updates the case.
              </div>
            </div>
          );
        })() : (openMatches.length > 0 || phoneOnlyOpen.length > 0
          || prior.some((p) => !STILL_OPEN.includes(p.status))) && (() => {
          const closed = prior.filter((p) => !STILL_OPEN.includes(p.status));
          const top = openMatches[0];
          const rest = openMatches.slice(1);
          const dup = samePersonGroup();
          const survivor = dup.length >= 2 ? pickSurvivor(dup) : null;
          const idRow = (label: string, theirs: string | null, ours: string, cmp: 'eq' | 'phone' = 'eq') => {
            const norm = (s: string) => (cmp === 'phone' ? s.replace(/\D/g, '').slice(-7) : s.trim().toLowerCase());
            const state = !ours.trim() ? 'none' : !theirs ? 'blank' : norm(theirs) === norm(ours) ? 'same' : 'diff';
            return (
              <tr key={label}>
                <td className="bnl-sub" style={{ padding: '2px 8px 2px 0' }}>{label}</td>
                <td style={{ padding: '2px 8px' }}>{theirs || '—'}</td>
                <td style={{ padding: '2px 0' }}>
                  {state === 'same' && <span className="bnl-fp" style={{ color: 'var(--accent)' }}>✓ same</span>}
                  {state === 'diff' && <span className="bnl-fp" style={{ color: 'var(--danger)' }}>✗ different</span>}
                  {state === 'none' && <span className="bnl-sub">not given on this call</span>}
                  {state === 'blank' && <span className="bnl-sub">not on the case</span>}
                </td>
              </tr>
            );
          };
          return (
            <div style={{ margin: '10px 0 0', display: 'grid', gap: 8 }}>
              {survivor && (
                <div style={{ background: 'var(--warn-light)', border: '1px solid var(--warn)', borderRadius: 8,
                  padding: '8px 12px', fontSize: 12.5 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ flex: 1, color: 'var(--text)' }}>
                      ⚠ <b>{dup.length} open cases look like the same person</b>{' '}
                      ({dup.map((d) => `#${d.id}`).join(', ')}) — {new Set(dup.map((d) => d.team_id ?? 0)).size > 1
                        ? 'different teams may be working them' : 'only one should stay open'}</span>
                    {mergeMsg ? <b style={{ color: 'var(--accent)' }}>{mergeMsg}</b>
                      : canMerge ? (
                        mergeArm
                          ? <>
                              <button type="button" className="btn primary" disabled={busy}
                                style={{ background: 'var(--warn)' }} onClick={() => mergeInto(survivor, dup)}>
                                Confirm — merge into #{survivor.id}</button>
                              <button type="button" className="tbtn" onClick={() => setMergeArm(false)}>Cancel</button>
                            </>
                          : <button type="button" className="tbtn" onClick={() => setMergeArm(true)}
                              title="Keeps the most-advanced case (oldest on a tie) with its team; the others close as merged and their calls show in its log">
                              Merge into #{survivor.id} →</button>
                      ) : (
                        <button type="button" className="tbtn" disabled={busy} onClick={() => flagDup(survivor, dup)}
                          title="Adds a note to the case asking a helpline admin to merge the duplicates">
                          Flag for a helpline admin</button>
                      )}
                  </div>
                  {mergeArm && !mergeMsg && (
                    <div className="bnl-sub" style={{ marginTop: 4 }}>
                      Keeps #{survivor.id} ({survivor.status}) with its team. Closes{' '}
                      {dup.filter((d) => d.id !== survivor.id).map((d) => `#${d.id}`).join(', ')} as
                      &ldquo;merged into #{survivor.id}&rdquo; — nothing is deleted; their calls show in #{survivor.id}&rsquo;s log.
                    </div>
                  )}
                </div>
              )}
              {top && (
                <div style={{ border: '1px solid var(--info)', background: 'var(--info-light)', borderRadius: 10,
                  padding: '9px 12px', fontSize: 12.5 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <IconSearch size={12} />
                    <b style={{ color: 'var(--strong)' }}>Possible existing case #{top.p.id} {nm(top.p)}</b>
                    <span className="bnl-fp">{top.p.status}</span>
                    {top.p.team_id != null && teams.find((t) => t.id === top.p.team_id) && (
                      <span className="bnl-fp bnl-fp-par">{teams.find((t) => t.id === top.p.team_id)!.name}</span>)}
                    <span style={{ flex: 1 }} />
                    {callStats[top.p.id] && <span className="bnl-sub">called {callStats[top.p.id].n}× · last{' '}
                      {new Date(callStats[top.p.id].last).toLocaleDateString()}</span>}
                  </div>
                  <table style={{ marginTop: 6, fontSize: 12.5, borderCollapse: 'collapse' }}><tbody>
                    {idRow('Name', [top.p.first_name, top.p.last_name].filter(Boolean).join(' ') || null,
                      [f.first_name, f.last_name].filter((s) => s.trim()).join(' '))}
                    {idRow('DOB', top.p.dob, f.dob)}
                    {idRow('SSN-4', top.p.ssn4, f.ssn4)}
                    {idRow('Phone', top.p.phone_line, f.phone_line, 'phone')}
                  </tbody></table>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                    <button type="button" className="btn primary" disabled={busy}
                      onClick={() => { setFollowUp({ p: top.p, mode: 'attach' }); setReason(''); }}>
                      This is them — follow-up call →</button>
                    <span className="bnl-sub">Nothing is logged until you save the follow-up.</span>
                  </div>
                </div>
              )}
              {(rest.length > 0 || closed.length > 0 || phoneOnlyOpen.length > 0) && (
                <div style={{ fontSize: 12.5 }}>
                  <button type="button" className="tbtn" onClick={() => setDupOpen(!dupOpen)}>
                    {dupOpen ? 'Hide' : 'Show'} {rest.length ? `${rest.length} more match${rest.length === 1 ? '' : 'es'}` : ''}
                    {rest.length && (closed.length + phoneOnlyOpen.length) ? ' · ' : ''}
                    {closed.length + phoneOnlyOpen.length
                      ? `${closed.length + phoneOnlyOpen.length} earlier call${closed.length + phoneOnlyOpen.length === 1 ? '' : 's'} from this number` : ''}
                  </button>
                  {dupOpen && (
                    <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
                      {rest.map(({ p, via }) => (
                        <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span>#{p.id} <b>{nm(p)}</b> · {p.status}{p.dob ? ` · DOB ${p.dob}` : ''}
                            {' '}<span className="bnl-fp bnl-fp-sch">{via}</span></span>
                          <button type="button" className="tbtn" disabled={busy}
                            onClick={() => { setFollowUp({ p, mode: 'attach' }); setReason(''); }}>This is them →</button>
                        </div>
                      ))}
                      {phoneOnlyOpen.map((p) => (
                        <div key={p.id} className="bnl-sub">#{p.id} <b style={{ color: 'var(--text)' }}>{nm(p)}</b>
                          {' '}· {p.status} · same number only — not treated as a match</div>
                      ))}
                      {closed.map((p) => (
                        <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span className="bnl-sub">#{p.id} <b style={{ color: 'var(--text)' }}>{nm(p)}</b>
                            {' '}· {new Date(p.created_at).toLocaleDateString()} · {p.status}</span>
                          <button type="button" className="tbtn" disabled={busy}
                            title="Same person calling again? Reopens the case with its team (fresh attempt counter) and logs this call on it"
                            onClick={() => { setFollowUp({ p, mode: 'reopen' }); setReason(''); }}>
                            This is them — reopen →</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {!followUp && (<>
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
            <DobInput value={f.dob} onChange={set('dob')} style={{ width: '100%' }} />
          </div>
          <div style={{ flex: 0.7, minWidth: 110 }}>
            <L>SSN-4 — optional</L>
            <input className="tinput" style={{ width: '100%' }} value={f.ssn4} maxLength={4} inputMode="numeric"
              onChange={(e) => set('ssn4')(e.target.value.replace(/\D/g, ''))} />
          </div>
        </div>

        {linked ? (
          <div style={{ background: 'var(--accent-light)', border: '1px solid var(--accent)',
            borderRadius: 8, padding: '10px 14px', marginTop: 10, fontSize: 12.5 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <b style={{ color: 'var(--strong)' }}><IconLink size={12} /> About this client — {linked.name || 'HMIS record'}</b>
              <button type="button" className="tbtn" onClick={() => setLinked(null)}>✕ Unlink</button>
            </div>
            <div style={{ marginTop: 4, color: 'var(--text)' }}>
              {linked.dob && <>DOB {linked.dob} · </>}
              HMIS: <b>{linked.bnl?.status ?? 'known record'}</b>
              {linked.bnl?.last_contact && <> · last contact {linked.bnl.last_contact}</>}
            </div>
            <div style={{ marginTop: 3, display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <span className="bnl-sub">ID</span>
              <CopyId id={linked.pid} />
            </div>
            {linked.bnl?.enroll ? (
              <div style={{ marginTop: 3, color: 'var(--text)' }}>
                {linked.bnl.enroll.open ? (
                  <>Open enrollment: <b style={{ color: 'var(--strong)' }}>{linked.bnl.enroll.project}</b>
                    {linked.bnl.enroll.entry && <> · since {linked.bnl.enroll.entry}</>}
                    {(linked.bnl.enroll.more ?? 0) > 0 && <> · +{linked.bnl.enroll.more} more open</>}</>
                ) : (
                  <>Last enrollment: <b style={{ color: 'var(--strong)' }}>{linked.bnl.enroll.project}</b>
                    {linked.bnl.enroll.entry && <> · {linked.bnl.enroll.entry}</>}
                    {linked.bnl.enroll.exit && <> → exited {linked.bnl.enroll.exit}</>}
                    {linked.bnl.enroll.dest && <> → {linked.bnl.enroll.dest}</>}</>
                )}
              </div>
            ) : linked.bnl ? null : (
              <div style={{ marginTop: 3, color: 'var(--strong)', fontWeight: 700 }}>
                In HMIS: no recent homeless episode on record.
              </div>
            )}
            {(linked.bnl?.chronic || linked.bnl?.veteran) && (
              <div style={{ marginTop: 5, display: 'flex', gap: 6 }}>
                {linked.bnl?.chronic && <span className="bnl-chip"
                  style={{ background: 'var(--danger-light)', color: 'var(--danger)' }}>chronic</span>}
                {linked.bnl?.veteran && <span className="bnl-chip"
                  style={{ background: 'var(--info-light)', color: 'var(--info)' }}>veteran</span>}
              </div>
            )}
            <div className="bnl-sub" style={{ marginTop: 4 }}>
              Saves with the case as the confirmed HMIS link — the queue, verification,
              and the BNL drawer all use it.
            </div>
          </div>
        ) : hmisCands && hmisCands.length > 0 && !hmisDismissed ? (
          <div style={{ border: '1px solid var(--border-strong)', borderRadius: 10,
            padding: '10px 14px', marginTop: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em',
              textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4 }}>
              Possible HMIS matches — link only if it&rsquo;s the same person</div>
            {hmisCands.map((m) => (
              <div key={m.pid} style={{ display: 'flex', gap: 10, alignItems: 'center',
                flexWrap: 'wrap', padding: '6px 0', borderTop: '1px solid var(--hair)', fontSize: 12.5 }}>
                <b style={{ color: 'var(--strong)' }}>{m.name || '(no name)'}</b>
                {m.dob && <span className="bnl-sub">DOB {m.dob}</span>}
                <span className="bnl-sub">{m.score}% · {m.why.join(' · ')}</span>
                {m.bnl && (
                  <span className="bnl-sub">
                    BNL: {m.bnl.status}{m.bnl.project ? ` · ${m.bnl.project}` : ''}
                    {m.bnl.last_contact ? ` · seen ${m.bnl.last_contact}` : ''}</span>
                )}
                <span style={{ flex: 1 }} />
                <button type="button" className="tbtn" onClick={() => setLinked(m)}><IconLink size={11} /> Link</button>
              </div>
            ))}
            {new Set(hmisCands.map((m) => `${(m.name || '').toLowerCase()}|${m.dob ?? ''}`)).size
              < hmisCands.length && (
              <div className="bnl-sub" style={{ marginTop: 6, color: 'var(--warn)', fontWeight: 600 }}>
                ⚠ Two records share the same name + DOB — likely duplicate HMIS records.
                Link the one showing BNL info; the duplicate should be merged in WellSky.
              </div>
            )}
            <button type="button" className="tbtn" style={{ marginTop: 8 }}
              title="Hide these suggestions — the case saves unlinked; changing a name, DOB, or SSN-4 looks again"
              onClick={() => setHmisDismissed(true)}>
              ✕ None of these — close</button>
          </div>
        ) : hmisCands && (f.dob || /^\d{4}$/.test(f.ssn4)) ? (
          <div className="bnl-sub" style={{ marginTop: 8 }}>
            No HMIS match on these identifiers — likely new to the system.
          </div>
        ) : null}

        </>)}

        <L>Address or intersection — as exact as they can give</L>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="tinput" style={{ flex: 1 }} value={f.address} maxLength={160}
            placeholder="e.g. 401 NW 2nd Ave · or NW 36th St & 17th Ave"
            onChange={(e) => { set('address')(e.target.value); setGeo(null); setPin(null); setPinPlace(null); autoAddr.current = null; }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); geocode(); } }} />
          <button className="tbtn" type="button" disabled={geo === 'loading'} onClick={geocode}
            title="Look up coordinates (server-side); the pin sets the district and drives the team suggestion">
            {geo === 'loading' ? 'Locating…' : <><IconMapPin size={11} /> Locate</>}</button>
          {!pin && !manualMap && (
            <button className="tbtn" type="button"
              title="No usable address? Open the map and click where the caller is"
              onClick={() => setManualMap(true)}><IconMap size={11} /> Drop pin</button>
          )}
        </div>
        {/* No area question (user directive 2026-08-20): the PIN decides — city
            district becomes the area, county district is the countywide
            routing fallback. The operator just types what the caller says. */}
        {f.address.trim().length >= 4 && !pin && geo === null && (
          <div className="bnl-sub" style={{ marginTop: 4 }}>
            Press Enter or Locate — the pin sets the district and the team suggestion.
          </div>
        )}
        {Array.isArray(geo) && geo.length === 0 && (
          <div className="bnl-sub" style={{ marginTop: 4 }}>No match — the typed address still saves; refine or skip.</div>
        )}
        {distNote && (
          <div style={{ background: 'var(--accent-light)', border: '1px solid var(--accent)',
            borderRadius: 8, padding: '7px 12px', fontSize: 12.5, marginTop: 6,
            color: 'var(--strong)' }}>
            <IconMapPin size={11} /> {distNote}
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

        {(pin || manualMap) && (
          <div style={{ marginTop: 8 }}>
            <div className="bnl-sub" style={{ marginBottom: 4 }}>
              {pin
                ? 'Fine-tune: drag to pan · scroll to zoom · CLICK to move the pin ("south side of the park") — districts and the team suggestion update live.'
                : 'Click the map where the caller is — the pin sets the districts and routing.'}
            </div>
            <PinMap lat={pin?.lat ?? null} lng={pin?.lng ?? null} focusKey={focusKey}
              onPick={movePin} />
          </div>
        )}

        <L>Landmark / how to find them</L>
        <input className="tinput" style={{ width: '100%' }} value={f.landmark} maxLength={200}
          placeholder="“Amelia Earhart Park, by the north lot — blue tent”"
          onChange={(e) => set('landmark')(e.target.value)} />

        {!followUp && (<>
        <L>Where did they sleep last night?</L>
        <Chips options={SLEEPING_OPTIONS} value={f.sleeping} onPick={set('sleeping')} />
        <L>Household on the call</L>
        <Chips options={HOUSEHOLD_OPTIONS} value={f.household}
          onPick={(v) => { set('household')(v); if (v !== 'With children') setHhSize(''); }} />
        {f.household === 'With children' && (
          <>
            <L>How many people in the household — including the caller?</L>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center' }}>
              {['2', '3', '4', '5', '6'].map((n) => {
                const on = hhSize === n;
                return (
                  <button key={n} type="button" aria-pressed={on}
                    onClick={() => setHhSize(on ? '' : n)}
                    style={{ border: `1px solid ${on ? 'var(--secondary)' : 'var(--border)'}`,
                      background: on ? 'var(--primary-light)' : 'var(--card)',
                      color: on ? 'var(--strong)' : 'var(--muted)',
                      borderRadius: 20, padding: '7px 14px', fontSize: 12.5, fontWeight: 600,
                      cursor: 'pointer', font: 'inherit' }}>{n}</button>
                );
              })}
              <input className="tinput" type="number" min={1} max={99} value={hhSize}
                placeholder="Other…" aria-label="Household size" style={{ width: 90 }}
                onChange={(e) => setHhSize(e.target.value)} />
            </div>
          </>
        )}
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

        </>)}

        <L>{followUp ? 'Notes from this call' : 'Call notes'}</L>
        <textarea className="tinput" rows={3} style={{ width: '100%', resize: 'vertical' }}
          value={f.notes} maxLength={4000}
          placeholder="What they said, callback window, safety context…"
          onChange={(e) => set('notes')(e.target.value)} />

        {!followUp && (<>
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
                onClick={() => { setConfirmNewCase(false); setFollowUp({ p: openMatches[0].p, mode: 'attach' }); setReason(''); }}>
                It&rsquo;s them — follow-up on #{openMatches[0].p.id}</button>
              <button className="btn primary" type="button" disabled={busy}
                style={{ background: 'var(--accent)' }}
                onClick={() => { setConfirmNewCase(false); submit(undefined, true); }}>
                Different person — save new case</button>
              <button className="tbtn" type="button" onClick={() => setConfirmNewCase(false)}>← Go back</button>
            </div>
          </div>
        )}

        </>)}

        {/* color-coded, equal-size actions (user directives 2026-08-20 colors,
            2026-09-22 soft tint + ALL CAPS): green = save, blue = save +
            refer, red = cancel (two-step, no browser dialogs on this form) */}
        {followUp ? (
          <div style={{ marginTop: 14 }}>
            {followUp.mode === 'attach' && followUp.p.status === 'confirmed' && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, marginBottom: 8, cursor: 'pointer' }}
                title="They're confirmed but outreach needs to come back — moved, situation changed, enrollment stalled. Returns the case to its team with a fresh attempt counter; the confirmed history stays in the log.">
                <input type="checkbox" checked={sendBack} onChange={(e) => setSendBack(e.target.checked)} />
                Send back to outreach (they need a team visit again)
              </label>
            )}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button className="abtn" type="button" disabled={busy || (!reason && !f.notes.trim())}
                onClick={() => attachToCase(followUp.p, followUp.mode === 'reopen' ? 'reopen' : sendBack ? 'outreach' : 'attach')}
                style={{ color: 'var(--accent)', borderColor: 'var(--accent)', background: 'var(--accent-light)', minWidth: 200 }}
                title={!reason && !f.notes.trim() ? 'Pick why they’re calling (or add notes) first' : undefined}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                {busy ? 'Saving…' : followUp.mode === 'reopen' ? `Reopen #${followUp.p.id} + save follow-up` : `Save follow-up to #${followUp.p.id}`}
              </button>
              <button className="abtn" type="button" disabled={busy}
                style={{ color: 'var(--muted)', borderColor: 'var(--border-strong)', background: 'var(--card)', minWidth: 160 }}
                onClick={() => { setFollowUp(null); setReason(''); }}>
                ← Back to new call</button>
            </div>
          </div>
        ) : (<>
        <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="abtn" disabled={busy} onClick={() => submit()}
            style={{ color: 'var(--accent)', borderColor: 'var(--accent)',
              background: 'var(--accent-light)', minWidth: 160 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            {busy ? 'Saving…' : assignNow && sug ? `Save + assign → ${sug.team.name}` : 'Save call'}
          </button>
          <button className="abtn" type="button" disabled={busy}
            style={{ color: 'var(--info)', borderColor: 'var(--info)',
              background: 'var(--info-light)', minWidth: 160 }}
            title="SOP specialized referrals (prevention · veterans · DV · youth) and other-provider areas — shows the script to read to the caller, then saves the call"
            onClick={() => setReferOpen(true)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>
            Save + refer out
          </button>
          <button className="abtn" type="button" disabled={busy}
            style={{ color: 'var(--danger)', borderColor: 'var(--danger)',
              background: 'var(--danger-light)', minWidth: 160 }}
            title="Discard this call and return to triage — nothing is saved"
            onClick={() => {
              const touched = Object.values(f).some((v) => v.trim() !== '')
                || factors.length > 0 || pin !== null;
              if (!touched || armCancel) { router.push('/helpline'); return; }
              setArmCancel(true);
              setTimeout(() => setArmCancel(false), 4000);
            }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            {armCancel ? 'Discard? Click again' : 'Cancel call'}
          </button>
        </div>
        </>)}
        {referOpen && (
          <ReferOut title="Refer the caller out"
            onPick={(resource, terminal) => { setReferOpen(false); submit({ resource, terminal }); }}
            onClose={() => setReferOpen(false)} />
        )}
      </div>
    </div>
  );
}
