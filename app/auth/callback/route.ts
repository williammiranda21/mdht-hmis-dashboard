import { NextResponse, type NextRequest } from 'next/server';
import { supabaseServer } from '../../../lib/supabase-server';

/**
 * PKCE code exchange — the landing point for Supabase auth emails (password
 * recovery today; magic links if ever enabled). The emailed link carries
 * ?code=…; exchanging it here writes the session cookies, then we bounce to
 * ?next= (the reset form). Already whitelisted in middleware PUBLIC_PATHS.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') ?? '/dashboard';
  // Only ever redirect within this origin.
  const dest = new URL(next.startsWith('/') ? next : '/dashboard', url.origin);

  if (code) {
    // Route Handlers may write cookies, so the shared request-scoped client
    // (lib/supabase-server) persists the exchanged session here.
    const { error } = await supabaseServer().auth.exchangeCodeForSession(code);
    if (error) {
      const fail = new URL('/login', url.origin);
      fail.searchParams.set('err', 'expired');
      return NextResponse.redirect(fail);
    }
  }
  return NextResponse.redirect(dest);
}
