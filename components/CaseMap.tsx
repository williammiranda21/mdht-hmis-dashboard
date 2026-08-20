import { tilesFor, TILE } from '../lib/slippy';
import TileImg from './TileImg';

/**
 * Static OSM map with a center pin — inline-styled so it drops into client
 * components (the helpline team board) without touching page CSS. Tiles load
 * through /api/helpline/tile with the viewer's session; no external calls.
 * Pin is pixel-anchored (not 50%) so container clipping can't drift it.
 */
export default function CaseMap({ lat, lng, zoom = 17, width = 640, height = 300 }: {
  lat: number; lng: number; zoom?: number; width?: number; height?: number;
}) {
  const tiles = tilesFor(lat, lng, zoom, width, height);
  return (
    <div style={{ position: 'relative', overflow: 'hidden', width, height, maxWidth: '100%',
      border: '1px solid var(--border, #d8dee8)', borderRadius: 8, background: '#eef1f5' }}>
      {tiles.map((t) => (
        <TileImg key={`${t.x}/${t.y}`} src={`/api/helpline/tile/${t.z}/${t.x}/${t.y}`}
          size={TILE} left={t.sx} top={t.sy} />
      ))}
      <div aria-hidden="true" style={{ position: 'absolute', left: width / 2, top: height / 2,
        transform: 'translate(-50%,-92%)', fontSize: 30, zIndex: 2,
        textShadow: '0 1px 2px rgba(0,0,0,.35)' }}>📍</div>
      <div style={{ position: 'absolute', right: 4, bottom: 2, fontSize: 9, zIndex: 2,
        color: '#5c6a7d', background: 'rgba(255,255,255,.75)', padding: '0 4px', borderRadius: 3 }}>
        © OpenStreetMap contributors</div>
    </div>
  );
}
