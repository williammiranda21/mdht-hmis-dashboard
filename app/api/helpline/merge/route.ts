import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../../lib/supabase-server';

/**
 * Merge duplicate OPEN helpline cases for one person (2026-10-01).
 *
 * The survivor keeps its team and status; each other case is closed with
 * merged_into = survivor (supabase/helpline_merge.sql). Blank identity /
 * contact fields on the survivor are filled from the merged cases. Both sides
 * get a permanent log note. Nothing is deleted; call logs never move.
 *
 * Helpline admins only (full admins + helpline_admin grant) — a merge closes
 * other teams' cases. Writes run through the caller's SESSION client, so the
 * helpline RLS policies still apply.
 */

export const dynamic = 'force-dynamic';

const OPEN = ['new', 'assigned', 'attempted', 'contacted', 'confirmed'];
const FILL = ['first_name', 'last_name', 'dob', 'ssn4', 'phone_line', 'phone_callback',
  'address', 'landmark', 'area', 'lat', 'lng', 'county_district', 'matched_pid'] as const;
const COLUMN_MISSING = /merged_into|42703|PGRST204|schema cache/i;

export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.canSeeHelpline || !viewer.isHelplineAdmin) {
    return NextResponse.json({ error: 'Only helpline admins can merge cases — use “Flag for a helpline admin”.' }, { status: 403 });
  }

  let body: { survivor?: number; others?: number[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }
  const survivor = Number(body.survivor);
  const others = [...new Set((body.others ?? []).map(Number))].filter((n) => Number.isInteger(n) && n !== survivor);
  if (!Number.isInteger(survivor) || !others.length) {
    return NextResponse.json({ error: 'survivor and at least one other case are required' }, { status: 400 });
  }

  const sb = supabaseServer();
  const { data: rows, error: e1 } = await sb.from('helpline_cases').select('*').in('id', [survivor, ...others]);
  if (e1) return NextResponse.json({ error: e1.message }, { status: 500 });
  const byId = new Map((rows ?? []).map((r: Record<string, unknown>) => [Number(r.id), r]));
  const s = byId.get(survivor);
  if (!s) return NextResponse.json({ error: `case #${survivor} not found` }, { status: 404 });
  for (const id of others) {
    const r = byId.get(id);
    if (!r) return NextResponse.json({ error: `case #${id} not found` }, { status: 404 });
    if (!OPEN.includes(String(r.status))) {
      return NextResponse.json({ error: `case #${id} is already ${r.status} — only open cases merge` }, { status: 409 });
    }
  }

  // 1. close the duplicates (fails cleanly if helpline_merge.sql hasn't run)
  const { error: e2 } = await sb.from('helpline_cases')
    .update({ status: 'closed', merged_into: survivor }).in('id', others);
  if (e2) {
    if (COLUMN_MISSING.test(e2.message)) {
      return NextResponse.json({ error: 'Merging isn’t set up yet — run supabase/helpline_merge.sql once.' }, { status: 503 });
    }
    return NextResponse.json({ error: e2.message }, { status: 500 });
  }

  // 2. fill the survivor's blanks from the merged cases (newest first)
  const patch: Record<string, unknown> = {};
  const donors = others.map((id) => byId.get(id)!).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  for (const k of FILL) {
    if (s[k] == null || s[k] === '') {
      const d = donors.find((r) => r[k] != null && r[k] !== '');
      if (d) patch[k] = d[k];
    }
  }
  if (Object.keys(patch).length) await sb.from('helpline_cases').update(patch).eq('id', survivor);

  // 3. permanent log notes on both sides
  const who = viewer.displayName ?? viewer.email ?? 'a helpline admin';
  await sb.from('helpline_calls').insert([
    { case_id: survivor, operator: viewer.id, kind: 'followup',
      notes: `Merged duplicate case${others.length > 1 ? 's' : ''} ${others.map((i) => `#${i}`).join(', ')} into this case (same person) — by ${who}. Their calls and notes appear in this log.` },
    ...others.map((id) => ({ case_id: id, operator: viewer.id, kind: 'followup',
      notes: `Merged into #${survivor} (same person) — by ${who}. Closed here; work continues on #${survivor}.` })),
  ]);

  return NextResponse.json({ ok: true, survivor, merged: others, filled: Object.keys(patch) });
}
