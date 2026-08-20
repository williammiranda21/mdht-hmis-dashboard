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

  const q = (new URL(req.url).searchParams.get('q') ?? '').trim().slice(0, 200);
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
