import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp',
};

/**
 * Streams an announcement screenshot from the PRIVATE bucket under the
 * caller's session — any approved user may view (storage RLS), nothing is
 * ever publicly reachable. <img src="/api/ann-image?p=..."> just works.
 */
export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer?.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const p = new URL(req.url).searchParams.get('p') ?? '';
  if (!/^[\w.-]+$/.test(p)) return NextResponse.json({ error: 'bad path' }, { status: 400 });

  const { data, error } = await supabaseServer().storage.from('announcements').download(p);
  if (error || !data) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  return new NextResponse(await data.arrayBuffer(), {
    headers: {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
