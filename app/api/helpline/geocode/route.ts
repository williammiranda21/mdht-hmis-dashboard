import { NextResponse } from 'next/server';
import { getViewer } from '../../../../lib/supabase-server';
import { parseIntersection, buildOverpassQL, clusterNodes } from '../../../../lib/intersection';

export const dynamic = 'force-dynamic';

/**
 * Server-side geocoder for helpline dispatch locations.
 *
 * Proxies OSM Nominatim so the operator's browser only ever talks to the
 * dashboard — county PCs sit behind a TLS-inspecting proxy that breaks direct
 * third-party calls, and we don't want an API key in the client anyway.
 * Bounded to Miami-Dade so "Main St" can't resolve to Ohio.
 *
 * Nominatim usage policy: light traffic, identifying User-Agent, no bulk.
 * A helpline's few dozen lookups/day is comfortably within it. If this ever
 * grows past that, swap in a keyed provider here — one file to change.
 */

// Miami-Dade bounding box (lng,lat): west,south,east,north
const VIEWBOX = '-80.88,25.13,-80.05,26.00';

export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.canSeeHelpline) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  // Reverse mode (?lat=&lng=, user 2026-10-01): a dropped pin becomes words
  // outreach can use — nearest street address + nearest intersection — so
  // logs read "1161 NW 49th St · near NW 12th Ave & NW 50th St", not decimals.
  const lat = Number(sp.get('lat')), lng = Number(sp.get('lng'));
  if (sp.has('lat') && Number.isFinite(lat) && Number.isFinite(lng)) {
    const [address, cross] = await Promise.all([reverseAddress(lat, lng), nearestIntersection(lat, lng)]);
    const label = [address, cross ? `near ${cross}` : null].filter(Boolean).map((x) => short(x!)).join(' · ');
    return NextResponse.json({ label: label || null, address, intersection: cross });
  }

  const q = (sp.get('q') ?? '').trim().slice(0, 200);
  if (q.length < 4) return NextResponse.json({ results: [] });

  try {
    // Cross-street query ("A & B", "A and B", "A at B")? Nominatim has no
    // concept of intersections — it returns nothing for these (user report
    // 2026-08-20). Overpass CAN answer it: the shared node of the two named
    // ways is the actual crossing. Tolerant name matching (Sw/Southwest,
    // St/Street, 2/2nd) lives in lib/intersection.ts. Any failure falls
    // through to the normal Nominatim path.
    const ix = parseIntersection(q);
    if (ix) {
      try {
        const r = await fetch('https://overpass-api.de/api/interpreter', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded',
            'User-Agent': 'MDHT-HMIS-Dashboard helpline (miamidade.gov)' },
          body: 'data=' + encodeURIComponent(buildOverpassQL(ix.a, ix.b)),
          cache: 'no-store',
          signal: AbortSignal.timeout(9000),
        });
        if (r.ok) {
          const j = (await r.json()) as { elements?: { type: string; lat: number; lon: number }[] };
          const pts = clusterNodes((j.elements ?? [])
            .filter((e) => e.type === 'node')
            .map((e) => ({ lat: e.lat, lng: e.lon })));
          if (pts.length) {
            return NextResponse.json({
              results: pts.map((p, i) => ({
                // labels must stay unique — the intake form keys results by label
                label: `${ix.a} & ${ix.b} — intersection${i ? ` · option ${i + 1}` : ''}`,
                lat: p.lat,
                lng: p.lng,
              })),
            });
          }
        }
      } catch { /* fall through to Nominatim */ }
    }

    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=3'
      + `&viewbox=${VIEWBOX}&bounded=1&countrycodes=us&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'MDHT-HMIS-Dashboard helpline (miamidade.gov)' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`geocoder ${res.status}`);
    const hits = (await res.json()) as any[];
    return NextResponse.json({
      results: hits.map((h) => ({
        label: String(h.display_name ?? ''),
        lat: Number(h.lat),
        lng: Number(h.lon),
      })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng)),
    });
  } catch (e) {
    // Geocoding is a convenience, never a blocker — the form saves the typed
    // address regardless, so a proxy/network failure degrades gracefully.
    return NextResponse.json({ results: [], error: String((e as Error).message) });
  }
}

const UA = { 'User-Agent': 'MDHT-HMIS-Dashboard helpline (miamidade.gov)' };

/** Nominatim reverse → "1161 NW 49th St" (house number + road), else the road. */
async function reverseAddress(lat: number, lng: number): Promise<string | null> {
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1'
      + `&lat=${lat}&lon=${lng}`, { headers: UA, cache: 'no-store', signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { address?: Record<string, string>; name?: string };
    const a = j.address ?? {};
    const road = a.road ?? a.pedestrian ?? a.footway ?? a.path ?? null;
    const place = a.amenity ?? a.leisure ?? a.building ?? a.shop ?? null;
    const street = road ? [a.house_number, road].filter(Boolean).join(' ') : null;
    return [place && place !== street ? place : null, street].filter(Boolean).join(', ') || j.name || null;
  } catch { return null; }
}

/** Overpass: the closest node shared by two differently-named streets within
 *  ~150 m → "NW 12th Ave & NW 50th St". Null when nothing is close. */
async function nearestIntersection(lat: number, lng: number): Promise<string | null> {
  try {
    const ql = `[out:json][timeout:8];way(around:150,${lat},${lng})[highway][name]`
      + '[highway!~"footway|path|cycleway|service|steps|track"];(._;>;);out body;';
    const r = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...UA },
      body: 'data=' + encodeURIComponent(ql), cache: 'no-store', signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { elements?: { type: string; id: number; lat?: number; lon?: number;
      nodes?: number[]; tags?: Record<string, string> }[] };
    const els = j.elements ?? [];
    const pos = new Map<number, [number, number]>();
    for (const e of els) if (e.type === 'node' && e.lat != null && e.lon != null) pos.set(e.id, [e.lat, e.lon]);
    const names = new Map<number, Set<string>>();
    for (const w of els) {
      if (w.type !== 'way' || !w.tags?.name) continue;
      for (const n of w.nodes ?? []) (names.get(n) ?? names.set(n, new Set()).get(n)!).add(w.tags.name);
    }
    let best: { d: number; label: string } | null = null;
    names.forEach((set, id) => {
      const p = pos.get(id);
      if (!p || set.size < 2) return;
      const dy = (p[0] - lat) * 111_000, dx = (p[1] - lng) * 111_000 * Math.cos((lat * Math.PI) / 180);
      const d = Math.hypot(dx, dy);
      if (!best || d < best.d) best = { d, label: [...set].slice(0, 2).join(' & ') };
    });
    return best ? (best as { d: number; label: string }).label : null;
  } catch { return null; }
}

/** "1161 Northwest 49th Street" → "1161 NW 49th St" — dispatch-sheet style. */
function short(x: string): string {
  const dir: Record<string, string> = { Northwest: 'NW', Northeast: 'NE', Southwest: 'SW', Southeast: 'SE',
    North: 'N', South: 'S', East: 'E', West: 'W' };
  const sfx: Record<string, string> = { Street: 'St', Avenue: 'Ave', Road: 'Rd', Boulevard: 'Blvd', Drive: 'Dr',
    Court: 'Ct', Place: 'Pl', Terrace: 'Ter', Lane: 'Ln', Parkway: 'Pkwy', Highway: 'Hwy', Circle: 'Cir', Trail: 'Trl' };
  return x
    .replace(/\b(Northwest|Northeast|Southwest|Southeast|North|South|East|West)\b(?=\s+\w)/g, (m) => dir[m])
    .replace(/\b(Street|Avenue|Road|Boulevard|Drive|Court|Place|Terrace|Lane|Parkway|Highway|Circle|Trail)\b/g, (m) => sfx[m]);
}
