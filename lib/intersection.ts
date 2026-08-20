/**
 * Street-intersection geocoding support (user report 2026-08-20: "SW 2nd St
 * and SW 12th Ave Miami" → no match). Nominatim has no concept of
 * intersections and OSM splits streets into many pieces, so name-pair
 * queries return nothing. Instead, /api/helpline/geocode asks the Overpass
 * API for the SHARED NODE of the two named ways — the actual crossing.
 *
 * Pure helpers here (parse, name→regex, query build, node clustering) so
 * they unit-test standalone; the route owns the network calls.
 *
 * Overpass regexes are POSIX ERE: plain (a|b) groups, no \s, no (?:…).
 */

/** Street-type tokens a caller might use — a street phrase ends at the first
 *  one, which is how "Sw 12th Ave Miami" sheds the trailing city word. */
const TYPE_TOKEN =
  'st|street|ave|avenue|blvd|boulevard|rd|road|ct|court|dr|drive|ter|terr|terrace|'
  + 'pl|place|ln|lane|pkwy|parkway|hwy|highway|cir|circle|way|trl|trail';

/** "A & B", "A and B", "A at B", "A @ B", "A / B" → the two street phrases,
 *  each truncated at its street-type token. Null = not an intersection query. */
export function parseIntersection(q: string): { a: string; b: string } | null {
  const head = (q.split(',')[0] ?? '').trim(); // drop ", Miami-Dade FL" etc.
  const parts = head.split(/\s+(?:and|at)\s+|\s*[&@/]\s*/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  const clean = parts.map((p) => {
    const m = p.match(new RegExp(`^(.*?\\b(?:${TYPE_TOKEN}))\\b`, 'i'));
    return (m ? m[1] : p).trim();
  });
  if (clean.some((c) => c.length < 3) || clean[0].toLowerCase() === clean[1].toLowerCase()) return null;
  return { a: clean[0], b: clean[1] };
}

const DIRS: Record<string, string> = {
  sw: '(sw|south ?west)', southwest: '(sw|south ?west)',
  se: '(se|south ?east)', southeast: '(se|south ?east)',
  nw: '(nw|north ?west)', northwest: '(nw|north ?west)',
  ne: '(ne|north ?east)', northeast: '(ne|north ?east)',
  n: '(n|north)', north: '(n|north)',
  s: '(s|south)', south: '(s|south)',
  e: '(e|east)', east: '(e|east)',
  w: '(w|west)', west: '(w|west)',
};
const TYPES: Record<string, string> = {
  st: '(st|street)', street: '(st|street)',
  ave: '(ave|avenue)', avenue: '(ave|avenue)',
  blvd: '(blvd|boulevard)', boulevard: '(blvd|boulevard)',
  rd: '(rd|road)', road: '(rd|road)',
  ct: '(ct|court)', court: '(ct|court)',
  dr: '(dr|drive)', drive: '(dr|drive)',
  ter: '(ter|terr|terrace)', terr: '(ter|terr|terrace)', terrace: '(ter|terr|terrace)',
  pl: '(pl|place)', place: '(pl|place)',
  ln: '(ln|lane)', lane: '(ln|lane)',
  pkwy: '(pkwy|parkway)', parkway: '(pkwy|parkway)',
  hwy: '(hwy|highway)', highway: '(hwy|highway)',
  cir: '(cir|circle)', circle: '(cir|circle)',
  trl: '(trl|trail)', trail: '(trl|trail)',
  way: 'way',
};

function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10 <= 3 ? n % 10 : 0]}`;
}

/** "Sw 2nd St" → POSIX ERE matching OSM's "Southwest 2nd Street" (and every
 *  abbreviation/ordinal variant a caller or a mapper might have used). */
export function streetRegex(street: string): string {
  return street.trim().split(/\s+/).map((tokRaw) => {
    const tok = tokRaw.toLowerCase();
    if (DIRS[tok]) return DIRS[tok];
    if (TYPES[tok]) return TYPES[tok];
    const bare = tok.match(/^(\d+)$/);
    if (bare) return `(${bare[1]}|${ordinal(Number(bare[1]))})`;
    const ord = tok.match(/^(\d+)(st|nd|rd|th)$/);
    if (ord) return `(${ord[1]}|${ord[1]}${ord[2]})`;
    return tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join(' ');
}

/** Miami-Dade bbox, Overpass order (south, west, north, east). */
const OP_BBOX = '25.13,-80.88,26.00,-80.05';

/** Overpass QL: the nodes shared by the two named highway sets = crossings. */
export function buildOverpassQL(a: string, b: string): string {
  return `[out:json][timeout:10];
way["highway"]["name"~"^${streetRegex(a)}$",i](${OP_BBOX})->.wa;
way["highway"]["name"~"^${streetRegex(b)}$",i](${OP_BBOX})->.wb;
node(w.wa)->.na;
node(w.wb)->.nb;
node.na.nb;
out 20;`;
}

/** Divided roads yield 2–4 nodes per physical crossing — cluster within
 *  ~200 m and return each cluster's centroid, biggest cluster first, max 3
 *  (same-named pairs CAN cross more than once across the county grid). */
export function clusterNodes(pts: { lat: number; lng: number }[]): { lat: number; lng: number }[] {
  const kx = Math.cos((25.77 * Math.PI) / 180) * 111_320; // m per deg lng
  const ky = 110_570;                                      // m per deg lat
  const groups: { lat: number; lng: number }[][] = [];
  for (const p of pts) {
    const g = groups.find((xs) => xs.some((x) =>
      Math.hypot((x.lng - p.lng) * kx, (x.lat - p.lat) * ky) < 200));
    if (g) g.push(p); else groups.push([p]);
  }
  return groups
    .sort((x, y) => y.length - x.length)
    .slice(0, 3)
    .map((g) => ({
      lat: g.reduce((s, p) => s + p.lat, 0) / g.length,
      lng: g.reduce((s, p) => s + p.lng, 0) / g.length,
    }));
}
