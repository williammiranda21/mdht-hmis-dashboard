import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

const MAX_BODY = 4000;

/**
 * Append-only notes on a BNL client.
 *
 * Every query runs through the caller's own session client, so the `can_see_bnl()`
 * RLS policy is the real boundary — a user without BNL access gets nothing back
 * and cannot insert, even hitting this route directly.
 *
 * Author identity and timestamp are taken from the SESSION and the database
 * default, never from the request body. A client cannot post a note as someone
 * else or backdate one.
 */

function assertPid(req: Request): string | null {
  return new URL(req.url).searchParams.get('pid');
}

export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const pid = assertPid(req);
  if (!pid) return NextResponse.json({ error: 'pid required' }, { status: 400 });

  const { data, error } = await supabaseServer()
    .from('bnl_notes')
    .select('id, body, author_name, author_email, created_at')
    .eq('pid', pid)
    .order('created_at', { ascending: false });

  // RLS returns an empty set (not an error) for users without BNL access.
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ notes: data ?? [] });
}

export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let payload: { pid?: string; body?: string };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const pid = (payload.pid ?? '').trim();
  const body = (payload.body ?? '').trim();
  if (!pid) return NextResponse.json({ error: 'pid required' }, { status: 400 });
  if (!body) return NextResponse.json({ error: 'note cannot be empty' }, { status: 400 });
  if (body.length > MAX_BODY) {
    return NextResponse.json({ error: `note too long (max ${MAX_BODY} characters)` }, { status: 400 });
  }

  const { data, error } = await supabaseServer()
    .from('bnl_notes')
    // author_id must equal auth.uid() or the RLS WITH CHECK rejects the insert.
    // Name and email are snapshotted here rather than joined at read time — see
    // supabase/bnl_notes.sql for why a join cannot work for non-admin readers.
    .insert({
      pid,
      body,
      author_id: viewer.id,
      author_name: viewer.displayName,
      author_email: viewer.email,
    })
    .select('id, body, author_name, author_email, created_at')
    .single();

  if (error) {
    // A user without BNL access trips the policy rather than a validation rule.
    const denied = /row-level security/i.test(error.message);
    return NextResponse.json(
      { error: denied ? 'forbidden' : error.message },
      { status: denied ? 403 : 500 },
    );
  }
  return NextResponse.json({ note: data }, { status: 201 });
}
