import { supabaseServer, getViewer } from '../../../../../lib/supabase-server';
import { priorityBand } from '../../../../../lib/helpline-options';
import { tilesFor, TILE } from '../../../../../lib/slippy';
import PrintButton from './PrintButton';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dispatch Sheet' };

/**
 * Static map block — OSM tiles through our own proxy (/api/helpline/tile) so
 * county PCs never call out, composed with plain slippy-map math and printed
 * as ordinary positioned <img>s. No map library, nothing interactive.
 */
function MapBlock({ lat, lng }: { lat: number; lng: number }) {
  // z18 ≈ 0.6 m/px — individual buildings and lot corners (user pushed the
  // zoom twice; the map's job is the last 50 meters, the address line above
  // carries the wider context). OSM's max useful detail is z19.
  // W spans the location box edge-to-edge (sheet 820 − sheet padding 68 −
  // box padding 32 − borders ≈ 718). The pin is pinned at exact pixels, not
  // 50%, so a clipped right edge on narrow paper can't drift it off target.
  const Z = 18, T = TILE, W = 718, H = 360;
  const tiles = tilesFor(lat, lng, Z, W, H);
  return (
    <div className="map" style={{ width: W, height: H }}>
      {tiles.map((t) => (
        <TileImg key={`${t.x}/${t.y}`} src={`/api/helpline/tile/${Z}/${t.x}/${t.y}`}
          size={T} left={t.sx} top={t.sy} />
      ))}
      <div className="pin" aria-hidden="true" style={{ left: W / 2, top: H / 2 }}>📍</div>
      <div className="attr">© OpenStreetMap contributors</div>
    </div>
  );
}

/**
 * One-page dispatch sheet for the outreach team — print it or save as PDF
 * (user directive 2026-08-19). Deliberately dependency-free: print CSS +
 * the browser's own Print-to-PDF, which works on county PCs where nothing
 * external loads. Always light — this is paper.
 *
 * The location block is the point: area, exact address, landmark, and
 * coordinates both as text and as a Google Maps link the field team can
 * open on a phone (county desktop may block it; the phone won't).
 */
export default async function DispatchSheet({ params }: { params: { id: string } }) {
  const viewer = await getViewer();
  if (!viewer) return null;
  if (!viewer.canSeeHelpline) {
    return <div className="panel"><div className="empty"><strong>Restricted</strong></div></div>;
  }

  const sb = supabaseServer();
  const id = Number(params.id);
  const [{ data: c }, { data: calls }] = await Promise.all([
    sb.from('helpline_cases').select('*').eq('id', id).maybeSingle(),
    sb.from('helpline_calls').select('received_at, kind, notes').eq('case_id', id)
      .order('received_at', { ascending: true }).limit(40),
  ]);
  if (!c) return <div className="panel"><div className="empty">Case not found.</div></div>;
  const { data: team } = c.team_id != null
    ? await sb.from('outreach_teams').select('*').eq('id', c.team_id).maybeSingle()
    : { data: null };
  // Assigned accounts + free-text field workers on one staff line ('*' select
  // so a pre-team_mgmt.sql database, without member_accounts, still renders).
  const staff = [
    ...(((team?.member_accounts ?? []) as { name: string }[]).map((a) => a.name)),
    team?.members ?? '',
  ].filter(Boolean).join(', ');

  const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Anonymous caller';
  const band = priorityBand(c.priority ?? 0);
  const maps = c.lat != null && c.lng != null
    ? `https://maps.google.com/?q=${c.lat},${c.lng}`
    : c.address ? `https://maps.google.com/?q=${encodeURIComponent(`${c.address}, ${c.area ?? ''} FL`)}` : null;
  const fmt = (iso: string) => new Date(iso).toLocaleString(undefined,
    { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  return (
    <main className="ds">
      <style dangerouslySetInnerHTML={{ __html: `
        .ds{max-width:820px;margin:0 auto;background:#fff;color:#1a202c;border:1px solid #d8dee8;
          border-radius:8px;padding:16px 34px 22px;font-size:13.5px;line-height:1.45}
        .ds *{box-sizing:border-box}
        .ds .hd{display:flex;justify-content:space-between;align-items:center;gap:14px;
          border-bottom:2px solid #1a202c;padding-bottom:6px;margin-bottom:6px}
        .ds h1{font-size:17px;margin:0;line-height:1.25}
        .ds .sub{color:#5c6a7d;font-size:11.5px}
        .ds .prio{font-weight:800;font-size:14px;padding:3px 12px;border:2px solid currentColor;border-radius:6px}
        .ds .assign{display:flex;justify-content:space-between;align-items:baseline;gap:12px;
          flex-wrap:wrap;font-size:13px;padding:5px 0 7px;border-bottom:1px solid #e4e8ef}
        .ds h2{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:#5c6a7d;
          margin:10px 0 4px;border-bottom:1px solid #e4e8ef;padding-bottom:2px}
        .ds .grid{display:grid;grid-template-columns:150px 1fr;gap:3px 16px}
        .ds .k{color:#5c6a7d;font-size:12px}
        .ds .v{font-weight:600}
        .ds .big{font-size:16px;font-weight:800}
        .ds .loc{background:#f4f6fa;border:1px solid #d8dee8;border-radius:8px;padding:9px 14px;margin-top:4px}
        .ds .map{position:relative;overflow:hidden;border:1px solid #d8dee8;border-radius:8px;
          margin-top:10px;max-width:100%;background:#eef1f5;
          -webkit-print-color-adjust:exact;print-color-adjust:exact}
        .ds .map img{position:absolute;display:block;max-width:none}
        .ds .pin{position:absolute;transform:translate(-50%,-92%);font-size:30px;
          text-shadow:0 1px 2px rgba(0,0,0,.35);z-index:2}
        .ds .attr{position:absolute;right:4px;bottom:2px;font-size:9px;color:#5c6a7d;z-index:2;
          background:rgba(255,255,255,.75);padding:0 4px;border-radius:3px}
        .ds .note{white-space:pre-wrap}
        .ds .foot{margin-top:12px;padding-top:6px;border-top:1px solid #e4e8ef;color:#5c6a7d;font-size:10.5px}
        .ds .btnrow{margin:0 auto 10px;max-width:820px;text-align:right}
        @media print{
          body{background:#fff !important;padding:0 !important}
          /* ONE PAGE is the contract: shrink type a step, cap the map, and
             keep blocks unsplit. The notes section is already capped to the
             latest 4 calls, so total height stays inside a letter page. */
          .ds{border:none;border-radius:0;max-width:none;padding:2mm 6mm;font-size:12px;line-height:1.38}
          .ds .map{height:300px !important}
          .ds .loc,.ds .grid,.ds .assign{break-inside:avoid}
          .noprint, .sidenav, .hdr, .tabnav, nav, header{display:none !important}
          @page{size:letter;margin:7mm}
        }
      ` }} />
      <div className="btnrow noprint">
        <PrintButton />
      </div>

      <div className="hd">
        <div>
          <h1>Outreach Dispatch — {name}</h1>
          <div className="sub">Miami-Dade Homeless Trust Helpline · case #{c.id} ·
            first call {fmt(c.created_at)} · CONFIDENTIAL</div>
        </div>
        <span className="prio" style={{ color: band === 'HIGH' ? '#c22' : band === 'MED' ? '#a06a10' : '#5c6a7d' }}>
          {band}</span>
      </div>

      <div className="assign">
        <span><span className="k">Assigned to </span>
          <b style={{ fontSize: 14 }}>{team?.name ?? 'NOT YET ASSIGNED'}</b>
          {staff && <span className="k"> — {staff}</span>}
          {team?.dispatch && <span className="k"> · dispatch: {team.dispatch}</span>}</span>
        {c.assigned_at && <span className="k">assigned {fmt(c.assigned_at)}</span>}
      </div>

      <h2>Find them</h2>
      <div className="loc">
        <div className="big">{c.address || c.landmark || c.area || 'Location not captured'}</div>
        <div className="grid" style={{ marginTop: 6 }}>
          {c.area && <><span className="k">Area</span><span className="v">{c.area}
            {c.county_district ? ` · ${c.county_district}` : ''}</span></>}
          {c.address && c.landmark && <><span className="k">Landmark</span><span className="v">{c.landmark}</span></>}
          {c.lat != null && c.lng != null && (
            <><span className="k">Coordinates</span>
              <span className="v">{c.lat.toFixed(5)}, {c.lng.toFixed(5)}</span></>
          )}
          {maps && <><span className="k">Map</span><span className="v" style={{ fontWeight: 400 }}>
            <a href={maps} style={{ color: '#1a56db' }}>{maps}</a></span></>}
        </div>
        {c.lat != null && c.lng != null && <MapBlock lat={c.lat} lng={c.lng} />}
        {(c.lat == null || c.lng == null) && (c.address || c.landmark) && (
          <div style={{ marginTop: 8, fontSize: 11.5, color: '#5c6a7d' }}>
            No map pin — the call was saved without coordinates. Use 📍 Locate on the
            intake next time to put the map on this sheet.
          </div>
        )}
      </div>

      <h2>Who · situation · contact</h2>
      <div className="grid">
        <span className="k">Callback ☎</span>
        <span className="v" style={{ fontSize: 15, fontWeight: 800 }}>
          {c.phone_callback || c.phone_line || '—'}
          {c.phone_callback && c.phone_line && c.phone_callback !== c.phone_line && (
            <span className="k" style={{ fontWeight: 400 }}> · called from {c.phone_line}</span>
          )}
        </span>
        <span className="k">Name</span><span className="v">{name}</span>
        {c.dob && <><span className="k">Date of birth</span><span className="v">{c.dob}</span></>}
        {c.sleeping && <><span className="k">Sleeping</span><span className="v">{c.sleeping}</span></>}
        {c.household && <><span className="k">Household</span><span className="v">{c.household}</span></>}
        {(c.factors ?? []).length > 0 && (
          <><span className="k">Factors</span><span className="v">{(c.factors as string[]).join(' · ')}</span></>
        )}
        <span className="k">HMIS</span>
        <span className="v">{c.matched_pid
          ? `Known client — record ${String(c.matched_pid).slice(0, 12)}… (history on the BNL)`
          : 'No confirmed HMIS match — may be new to the system'}</span>
        {(() => {
          const trail = (calls ?? []).filter((k: any) => k.kind === 'attempt' || k.kind === 'contact');
          if (!trail.length) return null;
          const d = (iso: string) => { const x = new Date(iso); return `${x.getMonth() + 1}/${x.getDate()}`; };
          return (
            <><span className="k">Outreach so far</span>
              <span className="v" style={{ fontWeight: 600 }}>
                {trail.map((k: any, i: number) => (
                  <span key={i} style={{ marginRight: 8, whiteSpace: 'nowrap',
                    color: k.kind === 'contact' ? '#0b8a5c' : '#c2333f' }}>
                    {k.kind === 'contact' ? '✓' : '✗'} {d(k.received_at)}
                  </span>
                ))}
              </span></>
          );
        })()}
      </div>

      {(() => {
        // Latest 4 note-bearing calls, newest first — the one-page budget.
        const noted = (calls ?? []).filter((k: any) => k.notes).reverse();
        const shown = noted.slice(0, 4);
        if (!shown.length) return null;
        return (
          <>
            <h2>Call notes{noted.length > shown.length
              ? ` — latest ${shown.length} of ${noted.length} (rest in the system)` : ''}</h2>
            {shown.map((k: any, i: number) => (
              <div key={i} style={{ marginBottom: 5 }}>
                <span className="k">{fmt(k.received_at)}{k.kind === 'followup' ? ' · call-back' : ''}</span>
                <div className="note">{k.notes}</div>
              </div>
            ))}
          </>
        );
      })()}

      <div className="foot">
        Verify homelessness in person → record the outcome in the Helpline board → enter/enroll the
        client in HMIS (WellSky). This sheet contains confidential information — do not leave it
        in the field; dispose per Homeless Trust policy.
      </div>
    </main>
  );
}
