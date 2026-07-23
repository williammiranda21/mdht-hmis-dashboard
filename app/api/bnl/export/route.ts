import { getViewer, supabaseServer } from '../../../../lib/supabase-server';
import { parseRosterQuery, queryRoster } from '../../../../lib/bnl-query';

export const dynamic = 'force-dynamic';

/**
 * CSV of the current BNL filter selection.
 *
 * The table itself only loads a page at a time, so the browser no longer holds
 * the rows an export needs. This re-runs the same filter server-side with the
 * FULL column set and streams the result, which keeps a 20k-row export off the
 * heap. Export is an occasional action, so taking a few seconds is fine.
 *
 * Contains client names — the `can_see_bnl()` RLS policy gates every read.
 */

const COLS = [
  'name', 'age', 'status', 'detail', 'project', 'ptype', 'days_homeless',
  'ep_start', 'sys_days3', 'episodes3', 'times3_sr', 'months3_sr', 'dob', 'sex', 'race',
  'income', 'income_date', 'dv_fleeing', 'dv_survivor', 'foster', 'jj',
  'ref_type', 'ref_status', 'ref_date', 'ref_prov', 'risk_pts', 'risk_max',
  'last_contact', 'assessed', 'is_new', 'returned', 'chronic', 'veteran', 'family',
  'parenting', 'unaccompanied', 'in_school',
];

const CHUNK = 1000;   // Supabase caps a response at 1000 rows

const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return new Response('unauthorized', { status: 401 });
  if (!viewer.canSeeBnl) return new Response('forbidden', { status: 403 });

  const base = parseRosterQuery(new URL(req.url).searchParams);
  const sb = supabaseServer();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(COLS.join(',') + '\n'));
      let offset = 0;
      try {
        for (;;) {
          const { data, error } = await queryRoster(
            sb, { ...base, offset, limit: CHUNK }, COLS.join(', '), false,
          );
          if (error) throw new Error(error.message);
          const rows = data ?? [];
          if (!rows.length) break;
          controller.enqueue(enc.encode(
            rows.map((r: any) => COLS.map((c) => esc(r[c])).join(',')).join('\n') + '\n',
          ));
          // advance by rows RECEIVED — asking for more than the cap silently
          // returns the cap, and advancing by the request size would skip rows
          if (rows.length < CHUNK) break;
          offset += rows.length;
        }
      } catch (e) {
        controller.enqueue(enc.encode(`\n"export failed: ${String(e).replace(/"/g, "'")}"\n`));
      }
      controller.close();
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="bnl_${base.pop}_${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
