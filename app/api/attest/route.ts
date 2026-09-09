import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * Annual HMIS Policies & Procedures acknowledgment (compliance gap #6).
 * The attest_policies() SQL function stamps the CALLER's own profile row —
 * identity comes from the session, and nobody can attest for anyone else.
 */
export async function POST() {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const { data, error } = await supabaseServer().rpc('attest_policies');
  if (error) {
    // Table/function missing = policies_attestation.sql not run yet.
    return NextResponse.json(
      { error: 'Attestation is not set up yet — run supabase/policies_attestation.sql once.' },
      { status: 503 },
    );
  }
  return NextResponse.json({ attested_at: data });
}
