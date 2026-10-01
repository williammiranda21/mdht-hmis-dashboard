import { NextResponse } from 'next/server';
import { getViewer } from '../../../../lib/supabase-server';
import { supabaseAdmin } from '../../../../lib/supabase';
import { audit } from '../../../../lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Admin-initiated two-factor reset (2026-10-01).
 *
 * Deletes every MFA factor on the target account so the user can enroll a new
 * authenticator (lost/changed phone). Their next sign-in is password-only;
 * BNL / client names stay locked until they re-enroll (getViewer's aal2
 * gate), so a reset never widens person-level access.
 *
 * Same boundary as reset-password: service-role route, so the CALLER's own
 * is_admin (which requires status='approved') is the entire security check.
 * Every reset is written to access_log.
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

  const { data: target, error: lookupErr } = await admin
    .from('profiles')
    .select('id, email')
    .eq('id', userId)
    .maybeSingle();
  if (lookupErr) return NextResponse.json({ error: lookupErr.message }, { status: 500 });
  if (!target) return NextResponse.json({ error: 'no such user' }, { status: 404 });

  const { data: fl, error: listErr } = await admin.auth.admin.mfa.listFactors({ userId });
  if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });
  const factors = fl?.factors ?? [];
  for (const f of factors) {
    const { error } = await admin.auth.admin.mfa.deleteFactor({ userId, id: f.id });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await audit('mfa_reset', viewer, {
    target_id: target.id, target_email: target.email, removed: factors.length,
  });
  return NextResponse.json({ ok: true, removed: factors.length });
}
