'use client';

import { useEffect, useState } from 'react';
import { tilesFor, frameFor, toPx, TILE } from '../../../lib/slippy';
import type { HlCase } from './HelplineView';

/**
 * Reporting map — every geocoded case as a dot, with toggleable boundary
 * overlays (commission districts / ZIP codes / census tracts) for "where are
 * the calls coming from" analysis.
 *
 * Boundary layers are GeoJSON files served same-origin from
 * hmis-web/public/gis/ (districts.geojson, zipcodes.geojson,
 * census_tracts.geojson — WGS84 lon/lat, EPSG:4326). A missing file just
 * shows a hint next to its toggle; drop the file in and the layer works with
 * no code change. Tiles come through the gated /api/helpline/tile proxy.
 */

const W = 960, H = 560;
const VIEWS = {
  county: { lat: 25.65, lng: -80.32, z: 10, label: 'County' },
  metro: { lat: 25.78, lng: -80.24, z: 12, label: 'Miami metro' },
  city: { lat: 25.78, lng: -80.22, z: 13, label: 'City core' },
} as const;
type ViewKey = keyof typeof VIEWS;

const LAYERS = [
  { key: 'districts', label: 'Commission districts', file: '/gis/districts.geojson', stroke: 'var(--secondary)', width: 2 },
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

type Geo = { features: { properties?: Record<string, unknown>; geometry: { type: string; coordinates: any } }[] };

function ringsOf(geom: { type: string; coordinates: any }): number[][][] {
  // → list of rings, each ring a list of [lng, lat]
  if (geom.type === 'Polygon') return geom.coordinates;
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat();
  return [];
}
function featureName(props?: Record<string, unknown>): string {
  if (!props) return '';
  for (const k of ['NAME', 'name', 'DISTRICT', 'District', 'district', 'LABEL',
    'ZIPCODE', 'ZIP', 'zip', 'GEOID', 'TRACT', 'COMMNAME', 'COMMISSIONER']) {
    if (props[k] != null && props[k] !== '') return String(props[k]);
  }
  return '';
}

export default function ReportMap({ cases, onOpen }: {
  cases: HlCase[]; onOpen: (c: HlCase) => void;
}) {
  const [view, setView] = useState<ViewKey>('metro');
  const [on, setOn] = useState<Record<LayerKey, boolean>>({ districts: false, zipcodes: false, tracts: false });
  const [geo, setGeo] = useState<Record<LayerKey, Geo | 'missing' | 'loading' | undefined>>(
    { districts: undefined, zipcodes: undefined, tracts: undefined });

  // lazy-load a layer's file the first time it's switched on
  useEffect(() => {
    for (const L of LAYERS) {
      if (on[L.key] && geo[L.key] === undefined) {
        setGeo((p) => ({ ...p, [L.key]: 'loading' }));
        fetch(L.file)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
          .then((j: Geo) => setGeo((p) => ({ ...p, [L.key]: j })))
          .catch(() => setGeo((p) => ({ ...p, [L.key]: 'missing' })));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);

  const v = VIEWS[view];
  const frame = frameFor(v.lat, v.lng, v.z, W, H);
  const tiles = tilesFor(v.lat, v.lng, v.z, W, H);
  const dots = cases.filter((c) => c.lat != null && c.lng != null);
  const noGeo = cases.length - dots.length;

  function pathOf(geom: { type: string; coordinates: any }): string {
    let d = '';
    for (const ring of ringsOf(geom)) {
      ring.forEach(([lng, lat], i) => {
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
            {dots.length} of {cases.length} cases have coordinates
            {noGeo > 0 && <> · {noGeo} without a pin (use 📍 Locate on intake)</>}
            {' '}· click a dot to open the case
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(Object.keys(VIEWS) as ViewKey[]).map((k) => (
            <button key={k} className="tbtn" aria-pressed={view === k}
              style={view === k ? { color: 'var(--primary)', fontWeight: 700, borderColor: 'var(--primary)' } : undefined}
              onClick={() => setView(k)}>{VIEWS[k].label}</button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', padding: '0 18px 10px' }}>
        <span className="flabel">Layers</span>
        {LAYERS.map((L) => (
          <label key={L.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
            fontSize: 12.5, color: 'var(--muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={on[L.key]}
              onChange={() => setOn((p) => ({ ...p, [L.key]: !p[L.key] }))} />
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

      <div className="scroll" style={{ padding: '0 18px 16px' }}>
        <div style={{ position: 'relative', width: W, height: H, maxWidth: 'none',
          overflow: 'hidden', border: '1px solid var(--border)', borderRadius: 8, background: '#eef1f5' }}>
          {tiles.map((t) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={`${t.x}/${t.y}`} src={`/api/helpline/tile/${t.z}/${t.x}/${t.y}`} alt=""
              width={TILE} height={TILE}
              style={{ position: 'absolute', left: t.sx, top: t.sy, display: 'block', maxWidth: 'none' }} />
          ))}
          <svg width={W} height={H} style={{ position: 'absolute', inset: 0, zIndex: 2 }}>
            {LAYERS.map((L) => {
              const g = geo[L.key];
              if (!on[L.key] || !g || g === 'missing' || g === 'loading') return null;
              return (
                <g key={L.key}>
                  {g.features.map((f, i) => (
                    <path key={i} d={pathOf(f.geometry)} fill="none"
                      stroke={L.stroke} strokeWidth={L.width} opacity={0.85}>
                      <title>{featureName(f.properties)}</title>
                    </path>
                  ))}
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
                  style={{ cursor: 'pointer' }} onClick={() => onOpen(c)}>
                  <title>{`#${c.id} · ${[c.first_name, c.last_name].filter(Boolean).join(' ') || 'anonymous'} · ${c.status}${c.area ? ` · ${c.area}` : ''}`}</title>
                </circle>
              );
            })}
          </svg>
          <div style={{ position: 'absolute', right: 4, bottom: 2, fontSize: 9, zIndex: 3,
            color: '#5c6a7d', background: 'rgba(255,255,255,.75)', padding: '0 4px', borderRadius: 3 }}>
            © OpenStreetMap contributors</div>
        </div>
      </div>
    </div>
  );
}
