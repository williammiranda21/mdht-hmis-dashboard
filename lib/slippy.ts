/**
 * Slippy-map tile math shared by the dispatch sheet and the team-board map.
 * Given a center + zoom + frame size, returns the OSM tiles to draw and where
 * to place them so the center lands mid-frame. Tiles are served through
 * /api/helpline/tile (session-gated proxy) — nothing here talks to OSM.
 */
export interface TilePlacement { x: number; y: number; z: number; sx: number; sy: number }

export const TILE = 256;

/** Global pixel position of a lat/lng at zoom z. */
export function project(lat: number, lng: number, z: number): { px: number; py: number } {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return {
    px: ((lng + 180) / 360) * n * TILE,
    py: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n * TILE,
  };
}

/** Frame (left/top in global pixels) of a w×h viewport centered on lat/lng. */
export function frameFor(lat: number, lng: number, z: number, w: number, h: number) {
  const { px, py } = project(lat, lng, z);
  return { left: px - w / 2, top: py - h / 2, z, w, h };
}

/** Viewport-relative pixel position of a lat/lng within a frame. */
export function toPx(lat: number, lng: number, f: { left: number; top: number; z: number }) {
  const { px, py } = project(lat, lng, f.z);
  return { x: px - f.left, y: py - f.top };
}

export function tilesFor(lat: number, lng: number, z: number, w: number, h: number): TilePlacement[] {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  const px = ((lng + 180) / 360) * n * TILE;
  const py = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n * TILE;
  const left = px - w / 2, top = py - h / 2;
  const x0 = Math.floor(left / TILE), y0 = Math.floor(top / TILE);
  const out: TilePlacement[] = [];
  for (let x = x0; x * TILE < left + w; x++) {
    for (let y = y0; y * TILE < top + h; y++) {
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      out.push({ x, y, z, sx: x * TILE - left, sy: y * TILE - top });
    }
  }
  return out;
}
