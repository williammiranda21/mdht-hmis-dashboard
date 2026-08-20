import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { IDLE_MS, IDLE_COOKIE } from './lib/idle';

/**
 * Refreshes the Supabase session cookie on every request and gates the app.
 *
 * The whole dashboard is private: any unauthenticated request to a non-public
 * path is redirected to /login (carrying ?next= so we can bounce back after
 * sign-in). This is defence in depth — RLS is the real boundary — but it keeps
 * unauthenticated users from ever rendering a page shell.
 */
// /yc is the Youth Connect self-entry portal: youth open it from a tokened
// invite link with no account. The token check happens server-side in the page
// and in /api/yc/submit — the middleware just lets the request through.
const PUBLIC_PATHS = ['/login', '/signup', '/auth/callback', '/forgot', '/yc', '/api/yc/submit'];

export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: { headers: req.headers } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return req.cookies.get(name)?.value;
        },
        set(name: string, value: string, options: Record<string, unknown>) {
          res.cookies.set({ name, value, ...options });
        },
        remove(name: string, options: Record<string, unknown>) {
          res.cookies.set({ name, value: '', ...options });
        },
      },
    },
  );

  // Touch the session so an expiring access token is refreshed into `res`.
  const { data } = await supabase.auth.getUser();
  const user = data.user;

  const { pathname, search } = req.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (!user && !isPublic) {
    // API routes answer fetch() calls — send JSON, not an HTML login page,
    // so the caller gets a parseable 401 instead of a redirect it can't read.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  // Idle sign-out (lib/idle.ts): a live session whose activity stamp is stale
  // or MISSING is over — fail closed, this is a PII system. The stamp is
  // server-written by /api/seen (client clocks are never trusted), which is
  // why /api/seen itself must be exempt: it's how new sessions get seeded.
  // Middleware deliberately never refreshes the stamp here — request traffic
  // isn't proof a human is present.
  if (user && !isPublic && pathname !== '/api/seen') {
    const stamp = Number(req.cookies.get(IDLE_COOKIE)?.value ?? NaN);
    if (!Number.isFinite(stamp) || Date.now() - stamp > IDLE_MS) {
      try { await supabase.auth.signOut(); } catch { /* cookie wipe below still ends it */ }
      const out = pathname.startsWith('/api/')
        ? NextResponse.json({ error: 'signed out after inactivity' }, { status: 401 })
        : (() => {
            const url = req.nextUrl.clone();
            url.pathname = '/login';
            url.search = `?reason=idle&next=${encodeURIComponent(pathname + search)}`;
            return NextResponse.redirect(url);
          })();
      for (const c of req.cookies.getAll()) {
        if (c.name.startsWith('sb-')) out.cookies.set({ name: c.name, value: '', path: '/', maxAge: 0 });
      }
      out.cookies.set({ name: IDLE_COOKIE, value: '', path: '/', maxAge: 0 });
      return out;
    }
  }

  // Already signed in and sitting on /login → send them to the dashboard.
  if (user && pathname === '/login') {
    const url = req.nextUrl.clone();
    url.pathname = '/dashboard';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return res;
}

export const config = {
  // Everything except Next internals and static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
