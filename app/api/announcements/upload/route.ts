import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

const TYPES: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
};
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Screenshot upload for announcements (admin only). Stores into the PRIVATE
 * 'announcements' bucket under the admin's session (storage RLS is the real
 * gate) and returns the path — the editor appends it to the details as an
 * "[img]<path>" line, rendered via /api/ann-image for approved users.
 */
export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isAdmin) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'file required' }, { status: 400 });
  const ext = TYPES[file.type];
  if (!ext) return NextResponse.json({ error: 'png, jpg, gif, or webp only' }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'max 4 MB' }, { status: 400 });

  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabaseServer().storage
    .from('announcements')
    .upload(path, Buffer.from(await file.arrayBuffer()), { contentType: file.type });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ path });
}
