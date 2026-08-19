import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../../lib/supabase-server';
import { supabaseAdmin } from '../../../../lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * Propose HMIS candidates for one intake — suggest-only, a person confirms.
 *
 * client_index (all ~53k clients, RLS with no select policy) is readable only
 * through the service role, so the viewer gate here is the boundary for it:
 * admins + yc_access. The intake itself is fetched through the CALLER's session
 * client first — if their RLS can't see it, there is nothing to match.
 *
 * Scoring: DOB exact 55 · SSN-4 30 · name similarity up to 35 (Dice bigrams
 * over "first last") · sex agreement 5. Candidates below 40 are noise and
 * dropped; top 5 returned with BNL context when the pid is on the roster.
 */

function bigrams(s: string): Set<string> {
  const t = s.replace(/[^a-z]/g, '');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function dice(a: string, b: string): number {
  const A = bigrams(a); const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  A.forEach((g) => { if (B.has(g)) hit++; });
  return (2 * hit) / (A.size + B.size);
}

export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.canSeeYc) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { data: intake, error: iErr } = await supabaseServer()
    .from('youth_intakes')
    .select('id, first_name, last_name, dob, ssn4')
    .eq('id', id)
    .maybeSingle();
  if (iErr) return NextResponse.json({ error: iErr.message }, { status: 500 });
  if (!intake) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const first = (intake.first_name ?? '').trim().toLowerCase();
  const last = (intake.last_name ?? '').trim().toLowerCase();
  const admin = supabaseAdmin();

  // Three cheap indexed pulls, unioned in JS: exact DOB, exact SSN-4, exact
  // last name. Fuzzy scoring then ranks the union — no table scan involved.
  const pulls = [];
  if (intake.dob) pulls.push(admin.from('client_index').select('*').eq('dob', intake.dob).limit(200));
  if (intake.ssn4) pulls.push(admin.from('client_index').select('*').eq('ssn4', intake.ssn4).limit(200));
  if (last) pulls.push(admin.from('client_index').select('*').eq('last_n', last).limit(200));
  if (!pulls.length) return NextResponse.json({ candidates: [] });

  const results = await Promise.all(pulls);
  for (const r of results) {
    if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });
  }
  const pool = new Map<string, any>();
  results.forEach((r) => (r.data ?? []).forEach((c: any) => pool.set(c.pid, c)));

  const scored = [...pool.values()].map((c) => {
    let score = 0;
    const why: string[] = [];
    if (intake.dob && c.dob === intake.dob) { score += 55; why.push('DOB exact'); }
    else if (intake.dob && c.dob) why.push(`DOB ${c.dob}`);
    if (intake.ssn4 && c.ssn4 === intake.ssn4) { score += 30; why.push('SSN-4 match'); }
    const nameSim = dice(`${first} ${last}`, `${c.first_n ?? ''} ${c.last_n ?? ''}`);
    score += Math.round(35 * nameSim);
    if (nameSim >= 0.999) why.push('name exact');
    else if (nameSim >= 0.5) why.push('name similar');
    return { ...c, score: Math.min(99, score), why };
  }).filter((c) => c.score >= 40)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // BNL context for candidates currently on the roster.
  let bnl: Record<string, any> = {};
  if (scored.length) {
    const { data } = await admin
      .from('bnl_clients')
      .select('pid, status, project, last_contact')
      .in('pid', scored.map((c) => c.pid));
    (data ?? []).forEach((b: any) => { bnl[b.pid] = b; });
  }

  return NextResponse.json({
    candidates: scored.map((c) => ({
      pid: c.pid,
      name: [c.first_n, c.last_n].filter(Boolean).join(' '),
      dob: c.dob,
      score: c.score,
      why: c.why,
      bnl: bnl[c.pid] ?? null,
    })),
  });
}
