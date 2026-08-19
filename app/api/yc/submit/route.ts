import { NextResponse } from 'next/server';
import { supabaseAdmin } from '../../../../lib/supabase';
import { SLEEPING_OPTIONS, UNSAFE_OPTIONS } from '../../../../lib/yc-options';

export const dynamic = 'force-dynamic';

/**
 * Youth Connect public submission — the ONLY unauthenticated write in the app.
 *
 * Youth have no accounts, so the browser posts here with an invite token and
 * this route writes with the service role AFTER validating the token against
 * intake_invites (exists, not disabled, not expired, under its use cap). The
 * anon key itself can write nothing: youth_intakes' RLS has no anon policy.
 *
 * Field lengths are capped hard — this endpoint is reachable by anyone who
 * holds a link, and links get photographed off posters.
 */

const CAP: Record<string, number> = {
  first_name: 80, last_name: 80, contact: 200, sleeping: 60,
  school_work: 200, unsafe: 30,
};

export async function POST(req: Request) {
  let p: Record<string, unknown>;
  try {
    p = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const token = String(p.token ?? '').trim();
  if (!token || token.length > 64) {
    return NextResponse.json({ error: 'invalid link' }, { status: 400 });
  }
  // Honeypot: the form renders an invisible "website" field. Humans leave it
  // empty; naive bots fill it. Pretend success so the bot moves on.
  if (String(p.website ?? '').trim()) return NextResponse.json({ ok: true });

  const admin = supabaseAdmin();
  const { data: inv, error: invErr } = await admin
    .from('intake_invites')
    .select('token, expires_at, max_uses, uses, disabled')
    .eq('token', token)
    .maybeSingle();
  if (invErr) return NextResponse.json({ error: invErr.message }, { status: 500 });
  const expired = inv?.expires_at && new Date(inv.expires_at).getTime() < Date.now();
  if (!inv || inv.disabled || expired || inv.uses >= inv.max_uses) {
    return NextResponse.json({ error: 'link no longer active' }, { status: 403 });
  }

  const row: Record<string, unknown> = { source: 'self', invite_token: token };
  for (const [k, max] of Object.entries(CAP)) {
    const v = String(p[k] ?? '').trim();
    if (v) row[k] = v.slice(0, max);
  }
  // Categorical fields hold ONE closed answer domain (lib/yc-options.ts) so
  // reporting can group them. The form only offers these values; a crafted
  // POST that sends anything else gets the field dropped, not the submission.
  if (row.sleeping && !(SLEEPING_OPTIONS as readonly string[]).includes(String(row.sleeping))) delete row.sleeping;
  if (row.unsafe && !(UNSAFE_OPTIONS as readonly string[]).includes(String(row.unsafe))) delete row.unsafe;
  // DOB arrives as YYYY-MM-DD from <input type="date">; anything else is dropped
  // rather than rejected — a youth who skips DOB should still get through.
  const dob = String(p.dob ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dob)) row.dob = dob;
  if (!row.first_name && !row.contact) {
    return NextResponse.json(
      { error: 'a name or a way to reach you is needed' }, { status: 400 });
  }

  const { error } = await admin.from('youth_intakes').insert(row);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // Use count is best-effort (read-then-write): a racing pair may count once.
  // The cap is an abuse brake, not an exact meter.
  await admin.from('intake_invites').update({ uses: inv.uses + 1 }).eq('token', token);

  return NextResponse.json({ ok: true });
}
