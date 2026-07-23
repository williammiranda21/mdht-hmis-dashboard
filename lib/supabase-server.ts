import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Request-scoped Supabase client for Server Components / Route Handlers.
 *
 * This is the one every data query must use: it carries the logged-in user's
 * session cookie, so `auth.uid()` is populated and RLS can scope rows to that
 * user's agency (see can_see_project() in supabase/auth_setup.sql). The old
 * module-level anon client had no session and will return nothing once the
 * policies are flipped to `to authenticated`.
 */
export function supabaseServer() {
  const cookieStore = cookies();
  return createServerClient(url, anon, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: Record<string, unknown>) {
        // Server Components can't set cookies; middleware refreshes the session.
        try {
          cookieStore.set({ name, value, ...options });
        } catch {}
      },
      remove(name: string, options: Record<string, unknown>) {
        try {
          cookieStore.set({ name, value: '', ...options });
        } catch {}
      },
    },
  });
}

/** The signed-in user, or null. */
export async function getSessionUser() {
  const { data } = await supabaseServer().auth.getUser();
  return data.user ?? null;
}

export type ViewerStatus = 'pending' | 'approved' | 'disabled';

export interface Viewer {
  id: string;
  email: string | null;
  displayName: string | null;
  agency: string | null;
  isAdmin: boolean;
  status: ViewerStatus;
  /** Approved (and admin implies approved). Anything else sees no data. */
  isApproved: boolean;
  /**
   * May open the By-Name List and its notes. Admins always qualify; a non-admin
   * qualifies only via the `bnl_access` grant. Mirrors the `can_see_bnl()` SQL
   * helper — RLS is the real boundary, this just avoids rendering a page whose
   * queries would come back empty.
   */
  canSeeBnl: boolean;
}

/**
 * Profile of the signed-in user, or null if not signed in.
 *
 * `status` is the gate: a brand-new signup is 'pending' and every data policy
 * refuses it, so callers should render the awaiting-approval screen rather than
 * an empty dashboard. If the row is missing (trigger not yet run) we fail
 * closed by treating them as pending.
 */
export async function getViewer(): Promise<Viewer | null> {
  const supabase = supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  const user = auth.user;
  if (!user) return null;
  const { data } = await supabase
    .from('profiles')
    .select('display_name, agency, is_admin, bnl_access, status, email')
    .eq('id', user.id)
    .maybeSingle();
  const status = (data?.status as ViewerStatus) ?? 'pending';
  const isApproved = status === 'approved';
  const isAdmin = Boolean(data?.is_admin) && isApproved;
  return {
    id: user.id,
    email: data?.email ?? user.email ?? null,
    displayName: data?.display_name ?? null,
    agency: data?.agency ?? null,
    isAdmin,
    status,
    isApproved,
    canSeeBnl: isAdmin || (isApproved && Boolean(data?.bnl_access)),
  };
}
