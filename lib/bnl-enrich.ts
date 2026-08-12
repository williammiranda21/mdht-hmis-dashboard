import type { SupabaseClient } from '@supabase/supabase-js';
import type { BnlClient } from '../app/dashboard/bnl/types';

/**
 * Page-scoped roster enrichment — the last 2 notes and the focus mark live in
 * side tables that deliberately have NO foreign key to the rebuilt roster
 * (they must outlive it), so PostgREST can't embed them; we join here, one
 * query each per 200-row page. Runs through the SESSION client: can_see_bnl
 * RLS on both tables is the boundary.
 */
export async function enrichRoster(sb: SupabaseClient, rows: BnlClient[]): Promise<void> {
  if (!rows.length) return;
  const pids = rows.map((r) => r.pid);
  const [notesRes, focusRes] = await Promise.all([
    // Newest-first across the page, kept to 2 per client below. The flat cap
    // guards the payload; a single client with a very long thread can starve
    // later pids of their 2 — acceptable for a 200-row page today.
    sb.from('bnl_notes')
      .select('pid, body, author_name, author_email, created_at')
      .in('pid', pids)
      .order('created_at', { ascending: false })
      .limit(1000),
    sb.from('bnl_focus').select('pid').in('pid', pids),
  ]);

  const byPid = new Map<string, NonNullable<BnlClient['notes2']>>();
  type NoteRow = { pid: string; body: string; author_name: string | null; author_email: string | null; created_at: string };
  for (const n of (notesRes.data ?? []) as NoteRow[]) {
    const l = byPid.get(n.pid) ?? [];
    if (l.length < 5) {
      l.push({
        body: n.body,
        author: n.author_name ?? n.author_email ?? null,
        at: String(n.created_at).slice(0, 10),
      });
      byPid.set(n.pid, l);
    }
  }
  const focused = new Set(((focusRes.data ?? []) as { pid: string }[]).map((f) => f.pid));
  for (const r of rows) {
    r.notes2 = byPid.get(r.pid) ?? null;
    r.focused = focused.has(r.pid);
  }
}

/** Every focused pid (the meeting list is small by nature — capped defensively). */
export async function focusPids(sb: SupabaseClient): Promise<string[]> {
  const { data } = await sb.from('bnl_focus').select('pid').limit(1000);
  return ((data ?? []) as { pid: string }[]).map((f) => f.pid);
}
