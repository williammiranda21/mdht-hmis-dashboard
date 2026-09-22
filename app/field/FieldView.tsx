'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '../../lib/supabase-browser';
import { MAX_FAILED_ATTEMPTS, priorityBand } from '../../lib/helpline-options';
import type { HlCase } from '../dashboard/helpline/HelplineView';
import QrShare from '../../components/QrShare';

/**
 * The field app screen (mock approved 2026-09-10). One-thumb design rules:
 * three screens max, 60px touch targets, actions pinned to the bottom.
 *
 * Writes mirror the dispatch board EXACTLY — same helpline_calls events,
 * same counters, same forward-only status moves, same 3-strike no-locate —
 * plus an optional note and a GPS stamp appended to the event note.
 *
 * OFFLINE QUEUE: a tap that fails to send (dead spot) is stored in
 * localStorage and retried automatically (online event + 20s timer). The
 * sync pill shows "↑ N to send" until everything lands — a worker under an
 * overpass never loses a logged contact.
 */

type Ev = { at: string; kind: string; notes: string | null };
type Outcome = 'attempt' | 'contact' | 'confirm';
type QItem = { caseId: number; kind: Outcome; note: string; when: string };

const QKEY = 'hl-field-queue';
function readQ(): QItem[] {
  try { return JSON.parse(localStorage.getItem(QKEY) || '[]'); } catch { return []; }
}
function writeQ(q: QItem[]) {
  try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch { /* private mode */ }
}

function nameOf(c: HlCase): string {
  return [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Anonymous caller';
}
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function daysSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

/** Best-effort GPS with a short timeout — never blocks the save. */
function getGps(): Promise<string | null> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    const t = setTimeout(() => resolve(null), 4000);
    navigator.geolocation.getCurrentPosition(
      (p) => { clearTimeout(t); resolve(`📍 ${p.coords.latitude.toFixed(5)}, ${p.coords.longitude.toFixed(5)} (±${Math.round(p.coords.accuracy)}m)`); },
      () => { clearTimeout(t); resolve(null); },
      { enableHighAccuracy: true, timeout: 3500, maximumAge: 60_000 },
    );
  });
}

const SHEET_COPY: Record<Outcome, { t: string; s: string; btn: string; cls: string }> = {
  attempt: { t: '✗ Couldn’t locate', s: 'Logs a failed attempt with today’s date — dispatch sees it immediately.', btn: 'Log attempt', cls: 'red' },
  contact: { t: '✓ Made contact', s: 'Logs a successful contact on the outreach trail.', btn: 'Log contact', cls: '' },
  confirm: { t: '🏠 Confirmed homeless', s: 'Marks the case confirmed in the field. The system then watches HMIS for the enrollment to verify it.', btn: 'Confirm', cls: 'green' },
};

export default function FieldView({ me, myName, teamLabel, scoped, cases: initial, events }: {
  me: string; myName: string; teamLabel: string; scoped: boolean;
  cases: HlCase[]; events: Record<number, Ev[]>;
}) {
  const router = useRouter();
  const [cases, setCases] = useState<HlCase[]>(initial);
  useEffect(() => { setCases(initial); }, [initial]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [sheet, setSheet] = useState<Outcome | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(0);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [trailPatch, setTrailPatch] = useState<Record<number, Ev[]>>({});

  const db = () => supabaseBrowser();
  const seen = () => fetch('/api/seen', { method: 'POST' }).catch(() => { /* retried on action */ });
  useEffect(() => { seen(); setQueued(readQ().length); }, []);

  // Home-screen bookmark reality (user report 2026-09-22): reopening restored
  // the CACHED page and the list never refetched — a case assigned from the
  // desktop "never came in". Refetch whenever the app comes back into view
  // (focus / visibility / bfcache pageshow) and every 60s while visible; each
  // refresh also pings /api/seen so field use counts as activity for the
  // idle gate.
  useEffect(() => {
    const fresh = () => {
      if (document.visibilityState !== 'visible') return;
      seen();
      router.refresh();
    };
    window.addEventListener('focus', fresh);
    window.addEventListener('pageshow', fresh);
    document.addEventListener('visibilitychange', fresh);
    const t = setInterval(fresh, 60_000);
    return () => {
      window.removeEventListener('focus', fresh);
      window.removeEventListener('pageshow', fresh);
      document.removeEventListener('visibilitychange', fresh);
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toast(msg: string) {
    setToastMsg(msg);
    if (toastT.current) clearTimeout(toastT.current);
    toastT.current = setTimeout(() => setToastMsg(null), 2400);
  }

  const current = cases.find((c) => c.id === openId) ?? null;
  const trailOf = (id: number) => [...(events[id] ?? []), ...(trailPatch[id] ?? [])];

  // Optimistic trail entries are stand-ins until the SERVER's copy arrives —
  // once a refresh delivers new events, drop them (else the entry renders
  // twice: the optimistic paint plus the refetched real one, user catch
  // 2026-09-11). Patches for cases with a write still QUEUED offline stay,
  // since the server doesn't have those yet.
  useEffect(() => {
    setTrailPatch((p) => {
      const q = readQ();
      const keep: Record<number, Ev[]> = {};
      for (const [cid, evs] of Object.entries(p)) {
        if (q.some((item) => item.caseId === Number(cid))) keep[Number(cid)] = evs;
      }
      return keep;
    });
  }, [events]);

  /** The board's exact write set for one outcome. Throws on failure so the
   *  caller can queue it. */
  async function send(c: HlCase, kind: Outcome, noteText: string, when: string) {
    const gps = await getGps();
    const evNote = [noteText, gps].filter(Boolean).join(' · ') || null;
    const day = when.slice(0, 10);
    if (kind === 'attempt') {
      const attempts = c.attempts + 1;
      const strikeOut = attempts >= MAX_FAILED_ATTEMPTS && (c.contacts ?? 0) === 0
        && ['assigned', 'attempted'].includes(c.status);
      const ev = await db().from('helpline_calls').insert({ case_id: c.id, operator: me, kind: 'attempt', notes: evNote });
      if (ev.error) throw ev.error;
      if (strikeOut) {
        await db().from('helpline_calls').insert({
          case_id: c.id, operator: me, kind: 'followup',
          notes: `Case closed — could not locate. ${MAX_FAILED_ATTEMPTS} failed contact attempts `
            + 'with no successful contact (3-strike rule). Reopen from All cases if they are '
            + 'sighted or call again.',
        });
      }
      const up = await db().from('helpline_cases').update({
        status: strikeOut ? 'no_locate' : c.status === 'assigned' ? 'attempted' : c.status,
        attempts, last_attempt: day,
      }).eq('id', c.id);
      if (up.error) throw up.error;
      return strikeOut;
    }
    if (kind === 'contact') {
      const ev = await db().from('helpline_calls').insert({ case_id: c.id, operator: me, kind: 'contact', notes: evNote });
      if (ev.error) throw ev.error;
      const up = await db().from('helpline_cases').update({
        status: ['assigned', 'attempted'].includes(c.status) ? 'contacted' : c.status,
        contacts: (c.contacts ?? 0) + 1, last_contact: day,
      }).eq('id', c.id);
      if (up.error) throw up.error;
      return false;
    }
    // confirm — the board's update, plus a trail event so the drawer shows
    // WHO confirmed in the field and where.
    await db().from('helpline_calls').insert({
      case_id: c.id, operator: me, kind: 'followup',
      notes: ['CONFIRMED homeless in the field.', evNote].filter(Boolean).join(' '),
    });
    const up = await db().from('helpline_cases').update({
      status: 'confirmed', confirmed_at: day,
    }).eq('id', c.id);
    if (up.error) throw up.error;
    return false;
  }

  /** Optimistic local apply so the UI moves even before (or without) signal. */
  function applyLocal(c: HlCase, kind: Outcome, noteText: string, when: string): HlCase {
    // attempt/contact store the bare note — the trail renderer adds the
    // "Attempted — not located" / "Made contact" label for those kinds, so
    // the optimistic row matches the server row exactly (no double label).
    setTrailPatch((p) => ({
      ...p,
      [c.id]: [...(p[c.id] ?? []), { at: when, kind: kind === 'attempt' ? 'attempt' : kind === 'contact' ? 'contact' : 'followup',
        notes: kind === 'confirm'
          ? ['CONFIRMED homeless in the field.', noteText].filter(Boolean).join(' ')
          : (noteText || null) }],
    }));
    const day = when.slice(0, 10);
    if (kind === 'attempt') {
      const attempts = c.attempts + 1;
      const strikeOut = attempts >= MAX_FAILED_ATTEMPTS && (c.contacts ?? 0) === 0
        && ['assigned', 'attempted'].includes(c.status);
      return { ...c, attempts, last_attempt: day,
        status: strikeOut ? 'no_locate' : c.status === 'assigned' ? 'attempted' : c.status };
    }
    if (kind === 'contact') {
      return { ...c, contacts: (c.contacts ?? 0) + 1, last_contact: day,
        status: ['assigned', 'attempted'].includes(c.status) ? 'contacted' : c.status };
    }
    return { ...c, status: 'confirmed', confirmed_at: day };
  }

  async function saveOutcome() {
    if (!current || !sheet || busy) return;
    setBusy(true);
    const kind = sheet, noteText = note.trim(), when = new Date().toISOString();
    const updated = applyLocal(current, kind, noteText, when);
    const gone = !['assigned', 'attempted', 'contacted'].includes(updated.status);
    setCases((cs) => cs.map((x) => (x.id === current.id ? updated : x)));
    setSheet(null); setNote('');
    try {
      await send(current, kind, noteText, when);
      seen();
      toast(kind === 'confirm' ? 'Confirmed — dispatch notified'
        : updated.status === 'no_locate' ? `Logged — case closed (${MAX_FAILED_ATTEMPTS} failed tries)` : 'Saved');
      router.refresh();
    } catch {
      const q = readQ(); q.push({ caseId: current.id, kind, note: noteText, when });
      writeQ(q); setQueued(q.length);
      toast('No signal — saved on this phone, will send automatically');
    } finally {
      setBusy(false);
      if (gone) setOpenId(null);
    }
  }

  // Drain the offline queue: on regaining connectivity and every 20s.
  useEffect(() => {
    let draining = false;
    const drain = async () => {
      if (draining) return;
      const q = readQ();
      if (!q.length) return;
      draining = true;
      const rest: QItem[] = [];
      for (const item of q) {
        const c = cases.find((x) => x.id === item.caseId);
        try {
          if (c) {
            // Local state already applied the outcome optimistically — hand
            // send() the pre-image so counters don't double-bump on retry.
            const pre = item.kind === 'attempt' ? { ...c, attempts: Math.max(0, c.attempts - 1) }
              : item.kind === 'contact' ? { ...c, contacts: Math.max(0, (c.contacts ?? 0) - 1) } : c;
            await send(pre as HlCase, item.kind, item.note, item.when);
          }
        } catch { rest.push(item); }
      }
      writeQ(rest); setQueued(rest.length);
      if (rest.length < q.length) { toast('Queued updates sent'); router.refresh(); }
      draining = false;
    };
    const iv = setInterval(drain, 20_000);
    window.addEventListener('online', drain);
    return () => { clearInterval(iv); window.removeEventListener('online', drain); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cases]);

  const open = useMemo(() => cases.filter((c) => ['assigned', 'attempted', 'contacted'].includes(c.status)), [cases]);

  const sh = sheet ? SHEET_COPY[sheet] : null;
  return (
    <div className="fApp">
      <style>{FIELD_CSS}</style>

      <div className="ftop">
        {current ? (
          <button className="fback" onClick={() => setOpenId(null)}>‹ Back</button>
        ) : (
          <span className="fmark">HT</span>
        )}
        <div style={{ minWidth: 0 }}>
          <h1>{current ? nameOf(current) : 'MY ASSIGNMENTS'}</h1>
          <div className="fsub">{current
            ? `Case #${current.id} · ${priorityBand(current.priority ?? 0)} priority`
            : `${teamLabel} · ${myName}`}</div>
        </div>
        <span className={queued ? 'fsync q' : 'fsync'}>{queued ? `↑ ${queued} to send` : '● Synced'}</span>
        {!current && <QrShare path="/field" label="QR" />}
      </div>

      {!current && (
        <div className="fwrap">
          <div className="fhint">
            {open.length ? `${open.length} open case${open.length === 1 ? '' : 's'} — sorted by priority.` : ''}
            {!scoped && ' Showing all teams (this account isn’t assigned to a team).'}
          </div>
          {open.map((c) => {
            const band = priorityBand(c.priority ?? 0);
            const wait = (c.contacts ?? 0) === 0 ? daysSince(c.created_at) : 0;
            return (
              <button key={c.id} className="fcase" onClick={() => { setOpenId(c.id); window.scrollTo(0, 0); }}>
                <div className="fr1">
                  <span className="fnm">{nameOf(c)}</span>
                  <span className={`fband fb-${band.toLowerCase()}`}>{band}</span>
                </div>
                <div className="fwhere"><b>{c.address || c.landmark || c.area || 'No location captured'}</b>
                  {c.area ? <span> · {c.area}</span> : null}</div>
                <div className="fr2">
                  {wait >= 3 && <span className="fchip fc-wait">⏳ waiting {wait}d</span>}
                  {(c.factors ?? []).slice(0, 3).map((f) => <span key={f} className="fchip fc-fact">{f}</span>)}
                  {c.attempts > 0 && <span className="fchip fc-try">✗ ×{c.attempts} so far</span>}
                </div>
              </button>
            );
          })}
          {!open.length && (
            <div className="fdone">No open assignments right now.<br />New cases appear here when dispatch assigns them{scoped ? ' to your team' : ''}.</div>
          )}
          {open.length > 0 && <div className="fdone">That’s every open case{scoped ? ' for your team' : ''}.</div>}
        </div>
      )}

      {current && (
        <div className="fwrap" style={{ paddingBottom: 130 }}>
          <div className="fcard">
            <h2>Find them</h2>
            <div className="faddr">{current.address || current.landmark || current.area || 'No location captured'}</div>
            {current.landmark && current.address && <div className="fsub2">{current.landmark}</div>}
            {current.area && <div className="fsub2">{current.area}{current.county_district ? ` · ${current.county_district}` : ''}</div>}
            {current.lat != null && current.lng != null ? (
              <a className="fnav" target="_blank" rel="noreferrer"
                href={`https://maps.google.com/?q=${current.lat},${current.lng}`}>🧭 Navigate there</a>
            ) : current.address ? (
              <a className="fnav" target="_blank" rel="noreferrer"
                href={`https://maps.google.com/?q=${encodeURIComponent(`${current.address}, ${current.area ?? ''} FL`)}`}>🧭 Navigate there</a>
            ) : null}
          </div>

          {(current.phone_callback || current.phone_line) && (
            <div className="fcard">
              <h2>Reach them</h2>
              <a className="fcall" href={`tel:${(current.phone_callback || current.phone_line || '').replace(/[^\d+]/g, '')}`}>
                <span style={{ fontSize: 24 }}>📞</span>
                <span><span className="fnum">{current.phone_callback || current.phone_line}</span><br />
                  <span className="flbl">tap to call · callback number</span></span>
              </a>
            </div>
          )}

          <div className="fcard">
            <h2>Who &amp; situation</h2>
            <div className="fkv">
              <span className="k">Name</span><span className="v">{nameOf(current)}</span>
              {current.sleeping && <><span className="k">Sleeping</span><span className="v">{current.sleeping}</span></>}
              {current.household && <><span className="k">Household</span><span className="v">{current.household}</span></>}
              {(current.factors ?? []).length > 0 && (
                <><span className="k">Factors</span><span className="v">{current.factors.join(' · ')}</span></>
              )}
              {current.notes && <><span className="k">Intake note</span><span className="v" style={{ fontWeight: 400 }}>{current.notes}</span></>}
            </div>
          </div>

          <div className="fcard">
            <h2>Outreach so far</h2>
            <div className="ftrail">
              {trailOf(current.id).map((e, i) => (
                <div key={i} className="ftr">
                  <span className="ic" style={{ color: e.kind === 'contact' ? 'var(--fblue)' : e.kind === 'attempt' ? 'var(--fred)' : 'var(--fmut)' }}>
                    {e.kind === 'contact' ? '✓' : e.kind === 'attempt' ? '✗' : e.kind === 'initial' || e.kind === 'repeat' ? '☎' : '·'}</span>
                  <span style={{ minWidth: 0 }}>{e.kind === 'initial' ? 'Call received — helpline'
                    : e.kind === 'repeat' ? 'Repeat call received'
                    : e.kind === 'attempt' ? `Attempted — not located${e.notes ? ` · ${e.notes}` : ''}`
                    : e.kind === 'contact' ? `Made contact${e.notes ? ` · ${e.notes}` : ''}`
                    : (e.notes || 'Note')}</span>
                  <span className="when">{fmtWhen(e.at)}</span>
                </div>
              ))}
              {!trailOf(current.id).length && <div className="fsub2">No outreach logged yet — you’re first.</div>}
            </div>
          </div>
        </div>
      )}

      {current && (
        <div className="factions">
          <button className="fabtn fa-miss" disabled={busy} onClick={() => { setSheet('attempt'); setNote(''); }}>
            ✗ Couldn’t<br />locate</button>
          <button className="fabtn fa-contact" disabled={busy} onClick={() => { setSheet('contact'); setNote(''); }}>
            ✓ Made<br />contact</button>
          <button className="fabtn fa-confirm" disabled={busy} onClick={() => { setSheet('confirm'); setNote(''); }}>
            🏠 Confirmed<br />homeless<small>starts HMIS verification</small></button>
        </div>
      )}

      {sh && current && (
        <>
          <div className="fscrim" onClick={() => setSheet(null)} />
          <div className="fsheet" role="dialog" aria-modal="true" aria-label={sh.t}>
            <h3>{sh.t}</h3>
            <div className="fsub2" style={{ marginBottom: 12 }}>{sh.s}</div>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} autoFocus
              placeholder="Optional note — where you looked, what you saw…" />
            <div className="fgps"><span className="dot" />Your location is stamped with this entry when available.</div>
            <div className="fsrow">
              <button className="fsbtn fs-cancel" onClick={() => setSheet(null)}>Cancel</button>
              <button className={`fsbtn fs-go ${sh.cls}`} disabled={busy} onClick={saveOutcome}>
                {busy ? 'Saving…' : sh.btn}</button>
            </div>
          </div>
        </>
      )}

      <div className={toastMsg ? 'ftoast on' : 'ftoast'}>{toastMsg}</div>
    </div>
  );
}

const FIELD_CSS = `
  .fApp{--fbg:var(--bg); --fcardc:var(--card); --fink:var(--text); --fmut:var(--muted);
    --fline:var(--border); --fbrand:var(--accent); --fred:var(--danger); --fgreen:#0b8a5c;
    --fblue:#3b82f6; --famber:var(--warn);
    max-width:520px; margin:0 auto; min-height:100vh; font-size:16px; position:relative}
  .fApp button{font-family:inherit}
  .ftop{position:sticky; top:0; z-index:20; background:var(--fcardc); border-bottom:1px solid var(--fline);
    padding:12px 16px; display:flex; align-items:center; gap:10px}
  .fmark{width:34px; height:34px; border-radius:9px; background:var(--fbrand); color:#fff;
    display:flex; align-items:center; justify-content:center; font-weight:800; font-size:14px; flex:none}
  .ftop h1{font-size:16px; margin:0; line-height:1.2; color:var(--fink)}
  .fsub{font-size:12px; color:var(--fmut)}
  .fsync{margin-left:auto; font-size:11.5px; font-weight:700; padding:5px 10px; border-radius:999px;
    background:rgba(11,138,92,.14); color:#27b47f; white-space:nowrap}
  .fsync.q{background:rgba(200,150,20,.16); color:var(--famber)}
  .fback{background:none; border:none; color:var(--fbrand); font-size:16px; font-weight:700;
    padding:6px 10px 6px 0; cursor:pointer}
  .fwrap{padding:14px 14px 40px}
  .fhint{font-size:12.5px; color:var(--fmut); margin:2px 2px 10px}
  .fcase{background:var(--fcardc); border:1px solid var(--fline); border-radius:14px;
    padding:14px 16px; margin-bottom:12px; cursor:pointer; display:block; width:100%;
    text-align:left; color:var(--fink); font-size:16px}
  .fcase:active{transform:scale(.985)}
  .fr1{display:flex; align-items:center; gap:8px}
  .fnm{font-weight:800; font-size:17px; flex:1; min-width:0}
  .fband{font-size:11px; font-weight:800; letter-spacing:.05em; padding:3px 9px; border-radius:6px; flex:none}
  .fb-high{background:rgba(194,51,63,.15); color:var(--fred)}
  .fb-med{background:rgba(200,150,20,.15); color:var(--famber)}
  .fb-low{background:var(--fline); color:var(--fmut)}
  .fwhere{color:var(--fmut); font-size:14.5px; margin-top:3px}
  .fwhere b{color:var(--fink)}
  .fr2{display:flex; gap:8px; margin-top:9px; flex-wrap:wrap}
  .fchip{font-size:12px; font-weight:700; padding:4px 10px; border-radius:999px}
  .fc-wait{background:rgba(194,51,63,.15); color:var(--fred)}
  .fc-fact{background:var(--accent-light, rgba(126,103,254,.15)); color:var(--fbrand)}
  .fc-try{background:var(--fline); color:var(--fmut)}
  .fdone{text-align:center; color:var(--fmut); font-size:13px; padding:18px 0 6px}
  .fcard{background:var(--fcardc); border:1px solid var(--fline); border-radius:14px; padding:16px; margin-bottom:12px}
  .fcard h2{font-size:12px; letter-spacing:.07em; text-transform:uppercase; color:var(--fmut); margin:0 0 8px}
  .faddr{font-size:19px; font-weight:800; line-height:1.3; color:var(--fink)}
  .fsub2{color:var(--fmut); font-size:14px; margin-top:2px}
  .fnav{display:block; width:100%; margin-top:12px; padding:13px; border-radius:11px;
    border:1.5px solid var(--fbrand); background:none; color:var(--fbrand); font-size:16px;
    font-weight:800; cursor:pointer; text-align:center; text-decoration:none}
  .fcall{display:flex; align-items:center; gap:12px; background:rgba(59,130,246,.12); border-radius:11px;
    padding:13px 16px; text-decoration:none}
  .fnum{font-size:20px; font-weight:800; color:var(--fblue); letter-spacing:.5px}
  .flbl{font-size:12px; color:var(--fmut)}
  .fkv{display:grid; grid-template-columns:110px 1fr; gap:6px 12px; font-size:15px; color:var(--fink)}
  .fkv .k{color:var(--fmut); font-size:13.5px; padding-top:1px}
  .fkv .v{font-weight:600; overflow-wrap:anywhere}
  .ftrail{display:flex; flex-direction:column; gap:8px}
  .ftr{display:flex; gap:10px; align-items:baseline; font-size:14.5px; color:var(--fink)}
  .ftr .ic{font-weight:800; flex:none; width:20px; text-align:center}
  .ftr .when{color:var(--fmut); font-size:12px; margin-left:auto; flex:none}
  .factions{position:fixed; bottom:0; left:0; right:0; z-index:30; max-width:520px; margin:0 auto;
    background:var(--fcardc); border-top:1px solid var(--fline);
    padding:10px 12px calc(12px + env(safe-area-inset-bottom));
    display:grid; grid-template-columns:1fr 1fr 1.3fr; gap:8px}
  .fabtn{border:none; border-radius:13px; padding:15px 6px; font-size:15px; font-weight:800;
    cursor:pointer; line-height:1.25; min-height:62px}
  .fabtn small{display:block; font-weight:600; font-size:11px; opacity:.85}
  .fa-miss{background:rgba(194,51,63,.15); color:var(--fred)}
  .fa-contact{background:rgba(59,130,246,.14); color:var(--fblue)}
  .fa-confirm{background:var(--fgreen); color:#fff}
  .fabtn:active{transform:scale(.97)}
  .fabtn:disabled{opacity:.6}
  .fscrim{position:fixed; inset:0; background:rgba(10,12,22,.45); z-index:40}
  .fsheet{position:fixed; bottom:0; left:0; right:0; z-index:50; max-width:520px; margin:0 auto;
    background:var(--fcardc); border-radius:18px 18px 0 0; box-shadow:0 -8px 30px rgba(0,0,0,.35);
    padding:18px 18px calc(20px + env(safe-area-inset-bottom))}
  .fsheet h3{margin:0 0 4px; font-size:19px; color:var(--fink)}
  .fsheet textarea{width:100%; border:1.5px solid var(--fline); border-radius:11px; background:var(--fbg);
    color:var(--fink); font-family:inherit; font-size:16px; padding:12px; min-height:74px; resize:none; box-sizing:border-box}
  .fsheet textarea:focus{outline:2px solid var(--fbrand); border-color:transparent}
  .fgps{display:flex; gap:9px; align-items:center; font-size:13px; color:var(--fmut); margin:10px 2px}
  .fgps .dot{width:9px; height:9px; border-radius:50%; background:#27b47f; flex:none}
  .fsrow{display:flex; gap:10px; margin-top:12px}
  .fsbtn{flex:1; border:none; border-radius:12px; padding:16px; font-size:17px; font-weight:800; cursor:pointer}
  .fs-cancel{background:var(--fline); color:var(--fmut)}
  .fs-go{background:var(--fbrand); color:#fff}
  .fs-go.green{background:var(--fgreen)}
  .fs-go.red{background:var(--fred)}
  .ftoast{position:fixed; left:50%; transform:translateX(-50%); bottom:110px; z-index:60;
    background:var(--text); color:var(--bg); font-size:14.5px; font-weight:700;
    padding:11px 20px; border-radius:999px; box-shadow:0 6px 24px rgba(0,0,0,.3);
    opacity:0; transition:opacity .25s; pointer-events:none; white-space:nowrap}
  .ftoast.on{opacity:1}
`;
