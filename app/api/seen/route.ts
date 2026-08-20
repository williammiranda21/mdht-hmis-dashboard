import { NextResponse } from 'next/server';
import { getSessionUser } from '../../../lib/supabase-server';
import { supabaseAdmin } from '../../../lib/supabase';
import { IDLE_COOKIE, IDLE_COOKIE_MAX_AGE } from '../../../lib/idle';

export const dynamic = 'force-dynamic';

/**
 * Activity ping — the ONLY writer of the idle-timeout stamp (server clock;
 * see lib/idle.ts) and of profiles.last_seen_at, the real-usage column the
 * admin console shows (sessions persist for weeks, so auth's last_sign_in_at
 * routinely reads "20d ago" for a daily user).
 *
 * Fired by components/IdleLogout.tsx while the user is active (throttled to
 * IDLE_PING_MS) and by the login/signup forms right after a session is
 * created. Exempt from the middleware idle check — this is the seeding
 * endpoint — but it still requires a live session.
 *
 * Service role because profiles deliberately has no self-update RLS policy
 * (users could otherwise write their own approval fields); the session user
 * scopes the write to their own row. Column missing (supabase/last_seen.sql
 * not run yet) still sets the cookie — the timeout works without the column.
 */
export async function POST() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Telemetry write may fail (column not added yet, service key mis-set) —
  // the cookie below must still be stamped or sessions could never seed.
  let ok = false;
  try {
    const { error } = await supabaseAdmin()
      .from('profiles')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', user.id);
    ok = !error;
  } catch { ok = false; }

  const res = NextResponse.json({ ok });
  res.cookies.set({ name: IDLE_COOKIE, value: String(Date.now()), path: '/',
    maxAge: IDLE_COOKIE_MAX_AGE, sameSite: 'lax', httpOnly: true });
  return res;
}
