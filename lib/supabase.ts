import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Anonymous client — safe on server and browser.
 * Reads are protected by Row-Level Security (aggregate tables are public-read;
 * drill_clients is locked down). Used by Server Components for live queries.
 */
export const supabase = createClient(url, anon, {
  auth: { persistSession: false },
  // The dashboard must reflect live DB data. Next.js App Router caches fetch() GETs
  // (incl. supabase-js reads) in its Data Cache by default, which persists to disk and
  // survives restarts — so a pipeline upsert wouldn't show up. Force every read no-store.
  global: {
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input, { ...init, cache: 'no-store' }),
  },
});

/**
 * Service-role client — server only (pipeline / privileged routes). Bypasses RLS.
 * Never import this into a Client Component.
 */
export function supabaseAdmin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return createClient(url, key, { auth: { persistSession: false } });
}
