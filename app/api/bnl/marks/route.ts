import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../../lib/supabase-server';
import { canWriteClient } from '../../../../lib/bnl-query';

/**
 * BNL cell marks — right-click color highlights on roster cells (shared team
 * state for case conferencing). One mark per (pid, col), last write wins;
 * color 1..4 = red/yellow/green/blue, unlabeled by design (user 2026-08-25).
 *
 * Every query runs through the caller's session client so RLS is the real
 * boundary (read = can_see_bnl(), write = can_write_bnl_note(pid) — the same
 * population-scoped grant as notes). Author identity comes from the SESSION,
 * never the request body.
 *
 * Degrades gracefully before supabase/bnl_cell_marks.sql has run: the table
 * missing (42P01) reads as "no marks", so the page never errors on a
 * deploy-to-SQL gap.
 */

export const dynamic = 'force-dynamic';

/** Same courtesy-layer check as /api/bnl/notes — the SQL policy re-checks. */
async function canWriteOn(pid: string, writePops: string[]): Promise<boolean> {
  if (!writePops.length) return false;
  if (writePops.includes('all')) return true;
  const { data } = await supabaseServer()
    .from('bnl_clients').select('age, veteran, family').eq('pid', pid).maybeSingle();
  return data ? canWriteClient(writePops, data) : false;
}

/** Markable columns — the COLS keys in BnlView.tsx. */
const MARK_COLS = new Set([
  'name', 'age', 'hh_n', 'status', 'flags', 'project', 'days_homeless',
  'sys_days3', 'ms_wait', 'risk_pts', 'income', 'ref_status', 'notes',
]);

const TABLE_MISSING = /relation .*bnl_cell_marks.* does not exist|42P01/i;

export async function GET() {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // The whole table rides down at once: marks are conferencing-scale (a few
  // hundred rows at most), and the roster is server-paged, so per-page joins
  // would re-fetch on every filter change for no win.
  const { data, error } = await supabaseServer()
    .from('bnl_cell_marks')
    .select('pid, col, color, author_name, updated_at');

  if (error) {
    if (TABLE_MISSING.test(error.message)) return NextResponse.json({ marks: [] });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ marks: data ?? [] });
}

export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let payload: { pid?: string; col?: string; color?: number };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const pid = (payload.pid ?? '').trim();
  const col = (payload.col ?? '').trim();
  const color = Number(payload.color ?? NaN);
  if (!pid) return NextResponse.json({ error: 'pid required' }, { status: 400 });
  if (!MARK_COLS.has(col)) return NextResponse.json({ error: 'unknown column' }, { status: 400 });
  if (!Number.isInteger(color) || color < 0 || color > 4) {
    return NextResponse.json({ error: 'color must be 0 (clear) or 1–4' }, { status: 400 });
  }
  if (!(await canWriteOn(pid, viewer.bnlWritePops))) {
    return NextResponse.json(
      { error: 'Marks are read-only for this client on your account — an administrator sets writing scopes in Users.' },
      { status: 403 },
    );
  }

  const sb = supabaseServer();
  if (color === 0) {
    const { error } = await sb.from('bnl_cell_marks').delete().eq('pid', pid).eq('col', col);
    if (error && !TABLE_MISSING.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ mark: null });
  }

  const { data, error } = await sb
    .from('bnl_cell_marks')
    // author_id must equal auth.uid() or the WITH CHECK rejects the write.
    .upsert({ pid, col, color, author_id: viewer.id, author_name: viewer.displayName ?? viewer.email })
    .select('pid, col, color, author_name, updated_at')
    .single();

  if (error) {
    if (TABLE_MISSING.test(error.message)) {
      return NextResponse.json(
        { error: 'Marks are not set up yet — run supabase/bnl_cell_marks.sql once in the SQL editor.' },
        { status: 503 },
      );
    }
    const denied = /row-level security/i.test(error.message);
    return NextResponse.json(
      { error: denied ? 'forbidden' : error.message },
      { status: denied ? 403 : 500 },
    );
  }
  return NextResponse.json({ mark: data }, { status: 201 });
}
