import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../../lib/supabase-server';
import { canWriteClient } from '../../../../lib/bnl-query';
import { FAMILY_STATUS_LABEL, isFamilyStatus } from '../../../../lib/family-status';

/**
 * BNL Family status (2026-10-01) — set / change / clear one family's
 * housing-search stage from the Family tab dropdown.
 *
 * Runs through the caller's session client, so RLS is the real boundary
 * (write = can_write_bnl_note(pid), the population-scoped note grant). The
 * check below is the same courtesy layer /api/bnl/marks uses, for a clean
 * 403 instead of an RLS error. Author identity comes from the SESSION.
 * Every change is history-logged by the bnl_family_status trigger.
 */

export const dynamic = 'force-dynamic';

async function canWriteOn(pid: string, writePops: string[]): Promise<boolean> {
  if (!writePops.length) return false;
  if (writePops.includes('all')) return true;
  const { data } = await supabaseServer()
    .from('bnl_clients').select('age, veteran, family').eq('pid', pid).maybeSingle();
  return data ? canWriteClient(writePops, data) : false;
}

const TABLE_MISSING = /relation .*bnl_family_status.* does not exist|42P01|PGRST205|schema cache/i;

export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.canSeeBnl) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  let payload: { pid?: string; status?: string | null };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const pid = (payload.pid ?? '').trim();
  const status = payload.status ? String(payload.status) : null;
  if (!pid) return NextResponse.json({ error: 'pid required' }, { status: 400 });
  if (status && !isFamilyStatus(status)) {
    return NextResponse.json({ error: 'unknown status' }, { status: 400 });
  }
  if (!(await canWriteOn(pid, viewer.bnlWritePops))) {
    return NextResponse.json({ error: 'You can view this family’s status but not change it.' }, { status: 403 });
  }

  const sb = supabaseServer();
  const author = viewer.displayName ?? viewer.email ?? null;
  const { error } = status
    ? await sb.from('bnl_family_status').upsert(
      { pid, status, author_id: viewer.id, author_name: author, updated_at: new Date().toISOString() },
      { onConflict: 'pid' })
    : await sb.from('bnl_family_status').delete().eq('pid', pid);

  if (error) {
    if (TABLE_MISSING.test(error.message)) {
      return NextResponse.json({ error: 'Family status isn’t set up yet — run supabase/bnl_family_status.sql once.' }, { status: 503 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    famStatus: status ? { key: status, label: FAMILY_STATUS_LABEL[status], by: author, at: new Date().toISOString() } : null,
  });
}
