'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { tilesFor, frameFor, toPx, unproject, project, inFeature, TILE, type GeoFC } from '../../../lib/slippy';
import { muniArea } from '../../../lib/helpline-options';
import type { HlCase, Team } from './HelplineView';

/**
 * Reporting map — every geocoded case as a dot, navigable (drag to pan,
 * +/- or double-click to zoom), with toggleable boundary overlays and a
 * date-range filter. CLICK A BOUNDARY to select it and get a live call
 * counter for that district/ZIP within the range; click a dot to open the
 * case drawer.
 *
 * Boundary layers are GeoJSON in hmis-web/public/gis/ (WGS84). A missing
 * file shows a hint on its toggle. Tiles come through the gated
 * /api/helpline/tile proxy.
 */

const H = 560;   // width is fluid — measured from the panel
const VIEWS = {
  county: { lat: 25.65, lng: -80.32, z: 10, label: 'County' },
  metro: { lat: 25.78, lng: -80.24, z: 12, label: 'Miami metro' },
  city: { lat: 25.78, lng: -80.22, z: 13, label: 'City core' },
} as const;
type ViewKey = keyof typeof VIEWS;

const LAYERS = [
  { key: 'districts', label: 'City of Miami districts', file: '/gis/districts.geojson', stroke: 'var(--secondary)', width: 2 },
  { key: 'county', label: 'County districts', file: '/gis/county_districts.geojson', stroke: 'var(--accent)', width: 1.6 },
  { key: 'muni', label: 'Municipalities', file: '/gis/municipalities.geojson', stroke: 'var(--danger)', width: 1.4 },
  { key: 'zipcodes', label: 'ZIP codes', file: '/gis/zipcodes.geojson', stroke: 'var(--warn)', width: 1.4 },
  { key: 'tracts', label: 'Census tracts', file: '/gis/census_tracts.geojson', stroke: 'var(--faint)', width: 0.8 },
] as const;
type LayerKey = (typeof LAYERS)[number]['key'];

const DOT: Record<string, { c: string; label: string }> = {
  new: { c: 'var(--warn)', label: 'awaiting triage' },
  open: { c: 'var(--secondary)', label: 'with outreach' },
  confirmed: { c: 'var(--accent)', label: 'confirmed homeless' },
  closed: { c: 'var(--faint)', label: 'closed / other' },
};
function dotGroup(c: HlCase): keyof typeof DOT {
  if (c.status === 'new') return 'new';
  if (['assigned', 'attempted', 'contacted'].includes(c.status)) return 'open';
  if (c.status === 'confirmed') return 'confirmed';
  return 'closed';
}

function featureName(props?: Record<string, unknown>): string {
  if (!props) return '';
  // City file: COMDISTID + COMNAME · County file: ID + COMMNAME · county ZIP file: ZIP
  const dist = props.COMDISTID ?? props.ID;
  const who = props.COMNAME ?? props.COMMNAME;
  if (dist != null && dist !== '' && who !== undefined) {
    return `District ${dist}${who ? ` · ${who}` : ''}`;
  }
  if (props.ZIP != null) return `ZIP ${props.ZIP}`;
  for (const k of ['NAME', 'name', 'DISTRICT', 'District', 'district', 'LABEL',
    'ZIPCODE', 'zip', 'GEOID', 'TRACT', 'COMMISSIONER']) {
    if (props[k] != null && props[k] !== '') return String(props[k]);
  }
  return dist != null ? `District ${dist}` : '';
}

/** The zone string a boundary corresponds to in outreach_teams.zones —
 *  city districts, county districts, and municipalities (ZIPs/tracts don't
 *  route). Municipality NAMEs normalize through muniArea (MIAMI and
 *  unincorporated return null — they route by district instead). */
function zoneOf(key: LayerKey, props?: Record<string, unknown>): string | null {
  if (!props) return null;
  if (key === 'districts' && props.COMDISTID != null && props.COMDISTID !== '') {
    return `Miami District ${props.COMDISTID}`;
  }
  if (key === 'county' && props.ID != null && props.ID !== '') {
    return `County District ${props.ID}`;
  }
  if (key === 'muni') return muniArea(String(props.NAME ?? ''));
  return null;
}

export default function ReportMap({ cases, teams = [], onOpen }: {
  cases: HlCase[]; teams?: Team[]; onOpen: (c: HlCase) => void;
}) {
  const [center, setCenter] = useState<{ lat: number; lng: number }>(
    { lat: VIEWS.metro.lat, lng: VIEWS.metro.lng });
  const [z, setZ] = useState<number>(VIEWS.metro.z);
  const [on, setOn] = useState<Record<LayerKey, boolean>>(
    { districts: false, county: false, muni: false, zipcodes: false, tracts: false });
  const [geo, setGeo] = useState<Record<LayerKey, GeoFC | 'missing' | 'loading' | undefined>>(
    { districts: undefined, county: undefined, muni: undefined, zipcodes: undefined, tracts: undefined });
  const [sel, setSel] = useState<{ key: LayerKey; idx: number } | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // Fluid width: the map meets the panel borders at any window size.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(960);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => {
      const w = Math.floor(es[0].contentRect.width);
      if (w > 300) setW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Wheel-to-zoom, anchored at the cursor. Native non-passive listener —
  // React's onWheel is passive, so preventDefault (stopping page scroll while
  // zooming) only works this way. State reads via ref so we bind once.
  const mapRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ z, center, W });
  stateRef.current = { z, center, W };
  const lastWheel = useRef(0);
  useEffect(() => {
    const el = mapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheel.current < 110) return;   // one step per notch-ish
      lastWheel.current = now;
      const { z: cz, center: cc, W: cw } = stateRef.current;
      const nz = Math.min(18, Math.max(9, cz + (e.deltaY < 0 ? 1 : -1)));
      if (nz === cz) return;
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      const f = frameFor(cc.lat, cc.lng, cz, cw, H);
      const under = unproject(f.left + cx, f.top + cy, cz);   // point under cursor
      const { px, py } = project(under.lat, under.lng, nz);
      setZ(nz);
      setCenter(unproject(px - cx + cw / 2, py - cy + H / 2, nz)); // keep it there
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Hover scroll-lock (user report 2026-08-20: wheel zoomed AND scrolled the
  // page, so the map slid under the cursor mid-gesture and the zoom anchor
  // drifted). preventDefault alone wasn't reliable in the field — locking the
  // page scroller while the cursor is over the map is mechanism-proof: wheel
  // can only mean zoom here. Scrollbar width is compensated so nothing shifts.
  const lockRef = useRef<{ ovf: string; pad: string } | null>(null);
  function lockScroll() {
    if (lockRef.current) return;
    const b = document.body;
    lockRef.current = { ovf: b.style.overflow, pad: b.style.paddingRight };
    const sw = window.innerWidth - document.documentElement.clientWidth;
    b.style.overflow = 'hidden';
    if (sw > 0) b.style.paddingRight = `${sw}px`;
  }
  function unlockScroll() {
    if (!lockRef.current) return;
    document.body.style.overflow = lockRef.current.ovf;
    document.body.style.paddingRight = lockRef.current.pad;
    lockRef.current = null;
  }
  useEffect(() => unlockScroll, []); // never leave the page locked on unmount

  // drag-to-pan (pointer events); a real drag suppresses the click behind it
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const draggedRef = useRef(false);
  function onPointerDown(e: React.PointerEvent) {
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    d.moved = true;
    draggedRef.current = true;
    d.x = e.clientX; d.y = e.clientY;
    setCenter((c) => {
      const { px, py } = project(c.lat, c.lng, z);
      return unproject(px - dx, py - dy, z);
    });
  }
  function onPointerUp() {
    drag.current = null;
    // let the click that follows a drag be ignored, then reset
    setTimeout(() => { draggedRef.current = false; }, 0);
  }
  function zoomTo(nz: number, at?: { lat: number; lng: number }) {
    setZ(Math.min(18, Math.max(9, nz)));
    if (at) setCenter(at);
  }
  function onDblClick(e: React.MouseEvent) {
    const rect = (e.currentTarget as Element).getBoundingClientRect();
    const { lat, lng } = unproject(
      frame.left + (e.clientX - rect.left), frame.top + (e.clientY - rect.top), z);
    zoomTo(z + 1, { lat, lng });
  }

  // lazy-load a layer's file the first time it's switched on
  useEffect(() => {
    for (const L of LAYERS) {
      if (on[L.key] && geo[L.key] === undefined) {
        setGeo((p) => ({ ...p, [L.key]: 'loading' }));
        fetch(L.file)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
          .then((j: GeoFC) => setGeo((p) => ({ ...p, [L.key]: j })))
          .catch(() => setGeo((p) => ({ ...p, [L.key]: 'missing' })));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);

  const frame = frameFor(center.lat, center.lng, z, W, H);
  const tiles = tilesFor(center.lat, center.lng, z, W, H);

  // date-range filter (created_at date, inclusive both ends)
  const shown = useMemo(() => cases.filter((c) => {
    const d = c.created_at.slice(0, 10);
    return (!from || d >= from) && (!to || d <= to);
  }), [cases, from, to]);
  const dots = shown.filter((c) => c.lat != null && c.lng != null);
  const noGeo = shown.length - dots.length;

  // selected-boundary counter
  const selFeature = sel && typeof geo[sel.key] === 'object'
    ? (geo[sel.key] as GeoFC).features[sel.idx] : null;
  const selCounts = useMemo(() => {
    if (!selFeature) return null;
    const inside = dots.filter((c) => inFeature(c.lng!, c.lat!, selFeature.geometry));
    const by: Record<string, number> = {};
    inside.forEach((c) => { by[dotGroup(c)] = (by[dotGroup(c)] ?? 0) + 1; });
    return { total: inside.length, by };
  }, [selFeature, dots]);

  function pathOf(geom: { type: string; coordinates: any }): string {
    const rings: number[][][] = geom.type === 'Polygon' ? geom.coordinates
      : geom.type === 'MultiPolygon' ? geom.coordinates.flat() : [];
    let d = '';
    for (const ring of rings) {
      ring.forEach(([lng, lat]: number[], i: number) => {
        const { x, y } = toPx(lat, lng, frame);
        d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      });
      d += 'Z';
    }
    return d;
  }

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="panel-h">
        <div>
          <h3>Call map</h3>
          <div className="meta">
            {dots.length} of {shown.length} cases in range have coordinates
            {noGeo > 0 && <> · {noGeo} without a pin</>}
            {' '}· drag to pan · scroll or double-click to zoom · click a boundary for its call count
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="tinput" type="date" value={from} style={{ width: 140 }}
            onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
          <span className="bnl-sub">→</span>
          <input className="tinput" type="date" value={to} style={{ width: 140 }}
            onChange={(e) => setTo(e.target.value)} aria-label="To date" />
          {(from || to) && (
            <button className="tbtn" onClick={() => { setFrom(''); setTo(''); }}>Clear dates</button>
          )}
          {(Object.keys(VIEWS) as ViewKey[]).map((k) => (
            <button key={k} className="tbtn"
              onClick={() => { setCenter({ lat: VIEWS[k].lat, lng: VIEWS[k].lng }); setZ(VIEWS[k].z); }}>
              {VIEWS[k].label}</button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', padding: '0 18px 10px' }}>
        <span className="flabel">Layers</span>
        {LAYERS.map((L) => (
          <label key={L.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
            fontSize: 12.5, color: 'var(--muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={on[L.key]}
              onChange={() => {
                setOn((p) => ({ ...p, [L.key]: !p[L.key] }));
                if (sel?.key === L.key) setSel(null);
              }} />
            <span style={{ borderBottom: `2px solid ${L.stroke}` }}>{L.label}</span>
            {on[L.key] && geo[L.key] === 'loading' && <span className="bnl-sub">loading…</span>}
            {on[L.key] && geo[L.key] === 'missing' && (
              <span className="bnl-sub" title={`Drop the file at hmis-web/public${L.file} (GeoJSON, WGS84 lon/lat)`}>
                — file not loaded yet</span>
            )}
          </label>
        ))}
        <span style={{ flex: 1 }} />
        {Object.entries(DOT).map(([k, d]) => (
          <span key={k} className="bnl-sub" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: d.c, display: 'inline-block' }} />
            {d.label}
          </span>
        ))}
      </div>

      <div ref={wrapRef} style={{ padding: '0 18px 16px' }}>
        <div ref={mapRef} style={{ position: 'relative', width: W, height: H, maxWidth: '100%',
          overflow: 'hidden', border: '1px solid var(--border)', borderRadius: 8,
          background: '#eef1f5', cursor: 'grab', touchAction: 'none', userSelect: 'none' }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerEnter={lockScroll}
          onPointerLeave={() => { onPointerUp(); unlockScroll(); }}
          onDoubleClick={onDblClick}>
          {tiles.map((t) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={`${t.z}/${t.x}/${t.y}`} src={`/api/helpline/tile/${t.z}/${t.x}/${t.y}`} alt=""
              width={TILE} height={TILE} draggable={false}
              style={{ position: 'absolute', left: t.sx, top: t.sy, display: 'block', maxWidth: 'none' }} />
          ))}
          <svg width={W} height={H} style={{ position: 'absolute', inset: 0, zIndex: 2 }}>
            {LAYERS.map((L) => {
              const g = geo[L.key];
              if (!on[L.key] || !g || g === 'missing' || g === 'loading') return null;
              return (
                <g key={L.key}>
                  {g.features.map((f, i) => {
                    const isSel = sel?.key === L.key && sel.idx === i;
                    return (
                      <path key={i} d={pathOf(f.geometry)}
                        fill={isSel ? L.stroke : 'transparent'} fillOpacity={isSel ? 0.14 : 0}
                        stroke={L.stroke} strokeWidth={isSel ? L.width + 1.2 : L.width}
                        opacity={0.9} style={{ cursor: 'pointer', pointerEvents: 'visible' }}
                        onClick={() => {
                          if (draggedRef.current) return;
                          setSel(isSel ? null : { key: L.key, idx: i });
                        }}>
                        <title>{featureName(f.properties)}</title>
                      </path>
                    );
                  })}
                </g>
              );
            })}
            {dots.map((c) => {
              const { x, y } = toPx(c.lat!, c.lng!, frame);
              if (x < -8 || y < -8 || x > W + 8 || y > H + 8) return null;
              const g = DOT[dotGroup(c)];
              return (
                <circle key={c.id} cx={x} cy={y} r={5.5} fill={g.c}
                  stroke="rgba(255,255,255,.85)" strokeWidth={1.5}
                  style={{ cursor: 'pointer' }}
                  onClick={() => { if (!draggedRef.current) onOpen(c); }}>
                  <title>{`#${c.id} · ${[c.first_name, c.last_name].filter(Boolean).join(' ') || 'anonymous'} · ${c.status}${c.area ? ` · ${c.area}` : ''}`}</title>
                </circle>
              );
            })}
          </svg>

          {/* zoom controls */}
          <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 4,
            display: 'flex', flexDirection: 'column', gap: 4 }}>
            <button className="tbtn" style={{ width: 34, fontSize: 16, fontWeight: 700, background: 'var(--card)' }}
              onClick={() => zoomTo(z + 1)} aria-label="Zoom in">+</button>
            <button className="tbtn" style={{ width: 34, fontSize: 16, fontWeight: 700, background: 'var(--card)' }}
              onClick={() => zoomTo(z - 1)} aria-label="Zoom out">−</button>
          </div>

          {/* selected-boundary counter */}
          {selFeature && selCounts && (
            <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 4,
              background: 'var(--card)', border: '1px solid var(--border-strong)',
              borderRadius: 8, padding: '10px 14px', boxShadow: 'var(--shadow)',
              minWidth: 200, fontSize: 12.5 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                <b style={{ color: 'var(--strong)' }}>{featureName(selFeature.properties)}</b>
                <button className="bnl-x" style={{ float: 'none' }} aria-label="Clear selection"
                  onClick={() => setSel(null)}>✕</button>
              </div>
              <div style={{ fontSize: 21, fontWeight: 800, color: 'var(--strong)', margin: '2px 0' }}>
                {selCounts.total} <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>
                  call{selCounts.total === 1 ? '' : 's'}{(from || to) ? ' in range' : ''}</span>
              </div>
              {Object.entries(DOT).map(([k, d]) => (selCounts.by[k] ?? 0) > 0 && (
                <div key={k} className="bnl-sub" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: d.c }} />
                  {d.label}: <b style={{ color: 'var(--text)' }}>{selCounts.by[k]}</b>
                </div>
              ))}
              {(() => {
                // which teams the suggestion would route this district to
                const zone = sel ? zoneOf(sel.key, selFeature.properties) : null;
                if (!zone || !teams.length) return null;
                const cover = teams.filter((t) => t.active && t.zones.includes(zone));
                return (
                  <div className="bnl-sub" style={{ marginTop: 6, paddingTop: 6,
                    borderTop: '1px solid var(--hair)', maxWidth: 230 }}>
                    {cover.length
                      ? <>Covered by <b style={{ color: 'var(--text)' }}>
                          {cover.map((t) => t.name).join(', ')}</b></>
                      : <span style={{ color: 'var(--warn)', fontWeight: 600 }}>
                          No team covers {zone} — set it in Team coverage below</span>}
                  </div>
                );
              })()}
            </div>
          )}

          <div style={{ position: 'absolute', right: 4, bottom: 2, fontSize: 9, zIndex: 3,
            color: '#5c6a7d', background: 'rgba(255,255,255,.75)', padding: '0 4px', borderRadius: 3 }}>
            © OpenStreetMap contributors</div>
        </div>
      </div>
    </div>
  );
}
