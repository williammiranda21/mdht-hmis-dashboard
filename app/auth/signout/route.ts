import { NextResponse } from 'next/server';
import { supabaseServer } from '../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * Server-side sign-out.
 *
 * Doing this in the browser doesn't work reliably: the session cookies are set
 * by the middleware (and are chunked for large tokens), so the browser client
 * can't be trusted to clear them — and the client-side redirect races the
 * middleware, which still sees a live session and bounces /login back to
 * /dashboard. A plain form POST to this handler avoids all of that: we clear
 * the session where the cookies are actually writable, then redirect.
 */
export async function POST(req: Request) {
  const supabase = supabaseServer();
  await supabase.auth.signOut();

  const res = NextResponse.redirect(new URL('/login', req.url), { status: 303 });

  // Belt and braces: drop every Supabase auth cookie (incl. chunked
  // `sb-<ref>-auth-token.0/.1`) so nothing can resurrect the session.
  const cookieHeader = req.headers.get('cookie') ?? '';
  for (const part of cookieHeader.split(';')) {
    const name = part.split('=')[0]?.trim();
    if (name && name.startsWith('sb-')) {
      res.cookies.set({ name, value: '', path: '/', maxAge: 0 });
    }
  }
  return res;
}
