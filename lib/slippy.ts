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

/** Inverse of project(): global pixels at zoom z → lat/lng. */
export function unproject(px: number, py: number, z: number): { lat: number; lng: number } {
  const n = 2 ** z;
  const lng = (px / (n * TILE)) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / (n * TILE)))) * 180) / Math.PI;
  return { lat, lng };
}

// ── point-in-polygon (ray cast) for the GIS boundary layers ─────────────────
export type Geometry = { type: string; coordinates: any };
export type GeoFC = { features: { properties?: Record<string, unknown>; geometry: Geometry }[] };

function inRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[i]; const [x2, y2] = ring[j];
    if ((y1 > lat) !== (y2 > lat) && lng < ((x2 - x1) * (lat - y1)) / (y2 - y1) + x1) {
      inside = !inside;
    }
  }
  return inside;
}

/** Does this feature's (outer-ring) polygon contain the point? */
export function inFeature(lng: number, lat: number, g: Geometry): boolean {
  return g.type === 'Polygon' ? inRing(lng, lat, g.coordinates[0])
    : g.type === 'MultiPolygon' ? g.coordinates.some((p: number[][][]) => inRing(lng, lat, p[0]))
    : false;
}

/** Properties of every feature whose (outer-ring) polygon contains the point. */
export function featuresAt(lng: number, lat: number, geo: GeoFC): Record<string, unknown>[] {
  return geo.features.filter((f) => inFeature(lng, lat, f.geometry)).map((f) => f.properties ?? {});
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
