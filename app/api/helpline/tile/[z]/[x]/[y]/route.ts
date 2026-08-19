import { getViewer } from '../../../../../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * OSM tile proxy for the dispatch-sheet map. The operator's browser only ever
 * talks to the dashboard (county proxy blocks third-party fetches); the server
 * fetches the tile and passes it through with long-lived caching.
 *
 * OSM tile usage policy: identifying User-Agent, light traffic. A dispatch
 * sheet loads ~12 tiles and repeat views hit the cache — comfortably within
 * policy. Attribution is rendered on the map block itself.
 */
export async function GET(
  _req: Request,
  { params }: { params: { z: string; x: string; y: string } },
) {
  const viewer = await getViewer();
  if (!viewer?.canSeeHelpline) return new Response('forbidden', { status: 403 });

  const z = Number(params.z); const x = Number(params.x); const y = Number(params.y);
  const max = 2 ** z;
  if (!Number.isInteger(z) || z < 3 || z > 19
    || !Number.isInteger(x) || x < 0 || x >= max
    || !Number.isInteger(y) || y < 0 || y >= max) {
    return new Response('bad tile', { status: 400 });
  }

  try {
    const res = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, {
      headers: { 'User-Agent': 'MDHT-HMIS-Dashboard helpline (miamidade.gov)' },
      // Next Data Cache: identical tiles are served without re-fetching OSM.
      next: { revalidate: 60 * 60 * 24 * 30 },
    });
    if (!res.ok) return new Response('tile unavailable', { status: 502 });
    return new Response(await res.arrayBuffer(), {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=2592000, immutable',
      },
    });
  } catch {
    return new Response('tile unavailable', { status: 502 });
  }
}
