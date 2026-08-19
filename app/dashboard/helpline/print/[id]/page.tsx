import { supabaseServer, getViewer } from '../../../../../lib/supabase-server';
import { priorityBand } from '../../../../../lib/helpline-options';
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
  const Z = 18, T = 256, W = 718, H = 360;
  const n = 2 ** Z;
  const rad = (lat * Math.PI) / 180;
  // global pixel position of the pin at zoom Z
  const px = ((lng + 180) / 360) * n * T;
  const py = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n * T;
  const left = px - W / 2, top = py - H / 2;
  const x0 = Math.floor(left / T), y0 = Math.floor(top / T);
  const tiles: { x: number; y: number; sx: number; sy: number }[] = [];
  for (let x = x0; x * T < left + W; x++) {
    for (let y = y0; y * T < top + H; y++) {
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      tiles.push({ x, y, sx: x * T - left, sy: y * T - top });
    }
  }
  return (
    <div className="map" style={{ width: W, height: H }}>
      {tiles.map((t) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={`${t.x}/${t.y}`} src={`/api/helpline/tile/${Z}/${t.x}/${t.y}`} alt=""
          width={T} height={T} style={{ left: t.sx, top: t.sy }} />
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
      .order('received_at', { ascending: true }).limit(10),
  ]);
  if (!c) return <div className="panel"><div className="empty">Case not found.</div></div>;
  const { data: team } = c.team_id != null
    ? await sb.from('outreach_teams').select('name').eq('id', c.team_id).maybeSingle()
    : { data: null };

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
          border-radius:8px;padding:28px 34px;font-size:13.5px;line-height:1.5}
        .ds *{box-sizing:border-box}
        .ds .hd{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;
          border-bottom:2px solid #1a202c;padding-bottom:10px;margin-bottom:14px}
        .ds h1{font-size:19px;margin:0}
        .ds .sub{color:#5c6a7d;font-size:12px}
        .ds .prio{font-weight:800;font-size:15px;padding:4px 14px;border:2px solid currentColor;border-radius:6px}
        .ds h2{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5c6a7d;
          margin:16px 0 5px;border-bottom:1px solid #e4e8ef;padding-bottom:3px}
        .ds .grid{display:grid;grid-template-columns:150px 1fr;gap:3px 16px}
        .ds .k{color:#5c6a7d;font-size:12px}
        .ds .v{font-weight:600}
        .ds .big{font-size:16px;font-weight:800}
        .ds .loc{background:#f4f6fa;border:1px solid #d8dee8;border-radius:8px;padding:12px 16px;margin-top:6px}
        .ds .map{position:relative;overflow:hidden;border:1px solid #d8dee8;border-radius:8px;
          margin-top:10px;max-width:100%;background:#eef1f5;
          -webkit-print-color-adjust:exact;print-color-adjust:exact}
        .ds .map img{position:absolute;display:block;max-width:none}
        .ds .pin{position:absolute;transform:translate(-50%,-92%);font-size:30px;
          text-shadow:0 1px 2px rgba(0,0,0,.35);z-index:2}
        .ds .attr{position:absolute;right:4px;bottom:2px;font-size:9px;color:#5c6a7d;z-index:2;
          background:rgba(255,255,255,.75);padding:0 4px;border-radius:3px}
        .ds .note{white-space:pre-wrap}
        .ds .foot{margin-top:18px;padding-top:8px;border-top:1px solid #e4e8ef;color:#5c6a7d;font-size:11px}
        .ds .btnrow{margin:0 auto 14px;max-width:820px;text-align:right}
        @media print{
          body{background:#fff !important;padding:0 !important}
          .ds{border:none;border-radius:0;max-width:none;padding:10mm 12mm}
          .noprint, .sidenav, .hdr, .tabnav, nav, header{display:none !important}
          @page{size:letter;margin:8mm}
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

      <div className="loc" style={{ marginTop: 0, display: 'flex', justifyContent: 'space-between',
        alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
        <span><span className="k">Assigned to </span>
          <span className="big">{team?.name ?? 'NOT YET ASSIGNED'}</span></span>
        {c.assigned_at && <span className="k">assigned {fmt(c.assigned_at)}</span>}
      </div>

      <h2>Find them</h2>
      <div className="loc">
        <div className="big">{c.address || c.landmark || c.area || 'Location not captured'}</div>
        <div className="grid" style={{ marginTop: 6 }}>
          {c.area && <><span className="k">Area</span><span className="v">{c.area}</span></>}
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

      <h2>Reach them</h2>
      <div className="grid">
        <span className="k">Callback number</span><span className="v big">{c.phone_callback || c.phone_line || '—'}</span>
        {c.phone_callback && c.phone_line && c.phone_callback !== c.phone_line && (
          <><span className="k">Called from</span><span className="v">{c.phone_line}</span></>
        )}
      </div>

      <h2>Who &amp; situation</h2>
      <div className="grid">
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
      </div>

      {(calls ?? []).some((k: any) => k.notes) && (
        <>
          <h2>Call notes</h2>
          {(calls ?? []).filter((k: any) => k.notes).map((k: any, i: number) => (
            <div key={i} style={{ marginBottom: 6 }}>
              <span className="k">{fmt(k.received_at)}{k.kind === 'followup' ? ' · call-back' : ''}</span>
              <div className="note">{k.notes}</div>
            </div>
          ))}
        </>
      )}

      <div className="foot">
        Verify homelessness in person → record the outcome in the Helpline board → enter/enroll the
        client in HMIS (WellSky). This sheet contains confidential information — do not leave it
        in the field; dispose per Homeless Trust policy.
      </div>
    </main>
  );
}
