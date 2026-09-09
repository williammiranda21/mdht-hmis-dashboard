import { NextResponse } from 'next/server';
import { getViewer } from '../../../lib/supabase-server';
import { audit, type AuditAction } from '../../../lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Client-side audit beacon — for read events that happen without a server
 * round-trip (the BNL drawer opens from rows already on the page). Identity
 * comes from the SESSION, never the body; the action must be allowlisted and
 * the detail is clamped, so this cannot be used to write arbitrary rows.
 */
const CLIENT_ACTIONS: ReadonlySet<string> = new Set(['bnl_drawer']);

export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let payload: { action?: string; pid?: string };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const action = String(payload.action ?? '');
  if (!CLIENT_ACTIONS.has(action)) {
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  }
  const pid = String(payload.pid ?? '').slice(0, 64);
  await audit(action as AuditAction, viewer, pid ? { pid } : undefined);
  return NextResponse.json({ ok: true });
}
