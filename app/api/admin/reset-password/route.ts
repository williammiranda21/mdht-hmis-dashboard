import { randomBytes } from 'crypto';
import { NextResponse } from 'next/server';
import { getViewer } from '../../../../lib/supabase-server';
import { supabaseAdmin } from '../../../../lib/supabase';

export const dynamic = 'force-dynamic';

/** Readable temp password: no ambiguous chars (0/O, 1/l/I). */
function tempPassword(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/**
 * Admin-initiated password reset.
 *
 * Sets a new temporary password and returns it ONCE so the admin can hand it to
 * the user out-of-band — deliberately not emailed, since SMTP isn't configured
 * and a reset email that never arrives is worse than none.
 *
 * This route uses the service-role key, so the admin check is the entire
 * security boundary: we verify the CALLER's own session says is_admin (which
 * itself requires status='approved') before touching anything.
 */
export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isAdmin) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  let userId = '';
  try {
    userId = String((await req.json())?.userId ?? '');
  } catch {
    /* fall through */
  }
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

  const admin = supabaseAdmin();

  // Only reset accounts that actually have a profile in this app.
  const { data: target, error: lookupErr } = await admin
    .from('profiles')
    .select('id, email')
    .eq('id', userId)
    .maybeSingle();
  if (lookupErr) return NextResponse.json({ error: lookupErr.message }, { status: 500 });
  if (!target) return NextResponse.json({ error: 'no such user' }, { status: 404 });

  const password = tempPassword();
  const { error } = await admin.auth.admin.updateUserById(userId, { password });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, email: target.email, password });
}
