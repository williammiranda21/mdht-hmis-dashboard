import { getViewer, supabaseServer } from '../../../../lib/supabase-server';
import { parseRosterQuery, queryRoster, ROSTER_COLS } from '../../../../lib/bnl-query';
import { enrichRoster } from '../../../../lib/bnl-enrich';
import { MILESTONES } from '../../../dashboard/bnl/types';
import type { BnlClient } from '../../../dashboard/bnl/types';

export const dynamic = 'force-dynamic';

/**
 * CSV of the current BNL filter selection — the TABLE's columns, nothing more.
 *
 * User directive 2026-08-19: the export mirrors what the roster shows on
 * screen (a 40-column data dump was the old behavior). Composite cells are
 * split only where a spreadsheet needs them separable (referral, income date,
 * note author) — the values are still exactly the table's.
 *
 * The table itself only loads a page at a time, so this re-runs the same
 * filter server-side and streams chunks; notes ride in via the same
 * enrichRoster the page uses. Contains client names — can_see_bnl() RLS gates
 * every read, including the notes join.
 */

const MS_LABELS = Object.fromEntries(MILESTONES);

const HEADER = [
  'client', 'status_detail', 'age', 'hh_size', 'status', 'flags',
  'project_type', 'project', 'enrollment',
  'self_reported_days', 'in_hmis_3y_days', 'episodes_3y',
  'ce_leg_wait_days', 'ce_leg_stage',
  'risk_pts', 'risk_band',
  'income_mo', 'income_date',
  'ref_type', 'ref_status', 'ref_date', 'ref_provider',
  'last_note', 'last_note_at', 'last_note_author',
];

/** One CSV row = one table row, cell for cell (Flags logic mirrors <Flags/>). */
function toRow(r: BnlClient): unknown[] {
  const flags = [
    r.is_new && 'NEW', r.returned && 'RETURNED', r.chronic && 'CHRONIC',
    r.veteran && 'VET', r.family && 'FAMILY', r.parenting && 'PARENTING',
    r.unaccompanied && r.age != null && r.age < 25 && 'UNACC.',
    r.in_school && 'SCHOOL', r.dq_n > 0 && 'DQ',
  ].filter(Boolean).join(' · ');
  const note = r.notes2?.[0];
  return [
    r.name, r.detail, r.age, r.hh_n ?? 1, r.status, flags,
    r.ptype, r.project, r.project ? (r.enrolled ? 'current' : 'former') : '',
    r.days_homeless, r.sys_days3, r.episodes3,
    r.ms_wait, r.ms_stage ? (MS_LABELS[r.ms_stage] ?? r.ms_stage) : '',
    r.risk_pts, r.risk_pts == null ? '' : (r.risk_pts >= 8 ? 'High' : 'Low'),
    r.income, r.income_date,
    r.ref_type, r.ref_status, r.ref_date, r.ref_prov,
    note?.body, note?.at, note?.author,
  ];
}

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
      controller.enqueue(enc.encode(HEADER.join(',') + '\n'));
      let offset = 0;
      try {
        for (;;) {
          const { data, error } = await queryRoster(
            sb, { ...base, offset, limit: CHUNK }, ROSTER_COLS, false,
          );
          if (error) throw new Error(error.message);
          const rows = (data ?? []) as unknown as BnlClient[];
          if (!rows.length) break;
          // Same notes join the on-screen table uses (session client → RLS).
          await enrichRoster(sb, rows);
          controller.enqueue(enc.encode(
            rows.map((r) => toRow(r).map(esc).join(',')).join('\n') + '\n',
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
