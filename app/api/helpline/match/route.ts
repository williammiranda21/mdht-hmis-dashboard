import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../../lib/supabase-server';
import { supabaseAdmin } from '../../../../lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * Propose HMIS candidates for one helpline case — suggest-only, a person
 * confirms. Same scorer as Youth Connect's /api/yc/match (DOB 55 · SSN-4 30 ·
 * name-Dice 35), same boundary: client_index is service-role-only, so the
 * viewer gate here (admins + helpline_access) is what protects it; the case
 * itself is fetched through the CALLER's session so RLS decides visibility.
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

  const url = new URL(req.url);
  const id = Number(url.searchParams.get('id'));

  // Two modes, same scorer + gate: ?id= for a SAVED case (identity read via
  // the caller's session so RLS decides), or direct identity params for the
  // LIVE intake glance (2026-09-22) — nothing saved yet, so the viewer gate
  // is the whole boundary and runs before anything is looked up.
  let c: { first_name: string | null; last_name: string | null;
    dob: string | null; ssn4: string | null };
  if (id) {
    const { data, error: cErr } = await supabaseServer()
      .from('helpline_cases')
      .select('id, first_name, last_name, dob, ssn4')
      .eq('id', id)
      .maybeSingle();
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: 'not found' }, { status: 404 });
    // RLS already refused viewers without helpline access (data would be
    // null), so reaching here implies access; keep the explicit belt anyway.
    if (!viewer.isAdmin && !(viewer as any).canSeeHelpline) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    c = data;
  } else {
    if (!viewer.isAdmin && !(viewer as any).canSeeHelpline) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    c = {
      first_name: url.searchParams.get('first'),
      last_name: url.searchParams.get('last'),
      dob: url.searchParams.get('dob'),
      ssn4: url.searchParams.get('ssn4'),
    };
    if (!c.dob && !c.ssn4 && !c.last_name) {
      return NextResponse.json({ candidates: [] });
    }
  }

  const first = (c.first_name ?? '').trim().toLowerCase();
  const last = (c.last_name ?? '').trim().toLowerCase();
  const admin = supabaseAdmin();

  const pulls = [];
  if (c.dob) pulls.push(admin.from('client_index').select('*').eq('dob', c.dob).limit(200));
  if (c.ssn4) pulls.push(admin.from('client_index').select('*').eq('ssn4', c.ssn4).limit(200));
  if (last) pulls.push(admin.from('client_index').select('*').eq('last_n', last).limit(200));
  if (!pulls.length) return NextResponse.json({ candidates: [] });

  const results = await Promise.all(pulls);
  for (const r of results) {
    if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });
  }
  const pool = new Map<string, any>();
  results.forEach((r) => (r.data ?? []).forEach((x: any) => pool.set(x.pid, x)));

  const scored = [...pool.values()].map((x) => {
    let score = 0;
    const why: string[] = [];
    if (c.dob && x.dob === c.dob) { score += 55; why.push('DOB exact'); }
    else if (c.dob && x.dob) why.push(`DOB ${x.dob}`);
    if (c.ssn4 && x.ssn4 === c.ssn4) { score += 30; why.push('SSN-4 match'); }
    const sim = dice(`${first} ${last}`, `${x.first_n ?? ''} ${x.last_n ?? ''}`);
    score += Math.round(35 * sim);
    if (sim >= 0.999) why.push('name exact');
    else if (sim >= 0.5) why.push('name similar');
    return { ...x, score: Math.min(99, score), why };
  }).filter((x) => x.score >= 40)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  let bnl: Record<string, any> = {};
  if (scored.length) {
    const { data } = await admin
      .from('bnl_clients')
      .select('pid, status, project, last_contact, chronic, veteran, timeline')
      .in('pid', scored.map((x) => x.pid));
    // Distill the timeline into one enrollment fact — newest OPEN enrollment
    // (entry, no exit) or, failing that, the most recent exited one with its
    // destination. The full history never leaves the server.
    (data ?? []).forEach((b: any) => {
      const tl: any[] = Array.isArray(b.timeline) ? b.timeline : [];
      const opens = tl.filter((t) => t && t.project && !t.exit)
        .sort((a, x) => String(x.entry ?? '').localeCompare(String(a.entry ?? '')));
      const closed = tl.filter((t) => t && t.project && t.exit)
        .sort((a, x) => String(x.exit).localeCompare(String(a.exit)));
      const enroll = opens.length
        ? { open: true, project: String(opens[0].project),
            entry: opens[0].entry ?? null, more: opens.length - 1 }
        : closed.length
        ? { open: false, project: String(closed[0].project),
            entry: closed[0].entry ?? null, exit: closed[0].exit,
            dest: closed[0].dest ?? null }
        : null;
      bnl[b.pid] = { status: b.status, project: b.project,
        last_contact: b.last_contact, chronic: b.chronic, veteran: b.veteran,
        enroll };
    });
  }

  // Equal scores: surface the record that carries BNL data first — with
  // duplicate client records (same human, two PersonalIDs) the roster-backed
  // one is the record to link.
  scored.sort((a, b) => b.score - a.score
    || (bnl[b.pid] ? 1 : 0) - (bnl[a.pid] ? 1 : 0));

  return NextResponse.json({
    candidates: scored.map((x) => ({
      pid: x.pid,
      name: [x.first_n, x.last_n].filter(Boolean).join(' '),
      dob: x.dob,
      score: x.score,
      why: x.why,
      bnl: bnl[x.pid] ?? null,
    })),
  });
}
