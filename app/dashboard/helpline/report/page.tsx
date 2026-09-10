import Link from 'next/link';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { supabaseServer, getViewer } from '../../../../lib/supabase-server';
import { EMERGENCY_SLEEPING, FACTORS } from '../../../../lib/helpline-options';
import { inFeature, type GeoFC } from '../../../../lib/slippy';
import PrintButton from '../print/[id]/PrintButton';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Helpline Monthly Report' };

/**
 * Board-ready MONTHLY helpline report — one printable page (browser
 * Print / Save-as-PDF, same dependency-free pattern as the dispatch sheet;
 * always light, this is paper).
 *
 * Cohorts: CASES opened in the month (Miami time) drive the funnel, district,
 * and factor cuts; CALLS received in the month (on any case, old or new)
 * drive the volume numbers — the phone ringing and a person's episode are
 * different facts. Verified outcomes come from verify_helpline.py's
 * enrollment cross-check — proven by HMIS data, never self-reported.
 */

const MIAMI_TZ = 'America/New_York';
const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Miami-local {ymd, dow, hour} for a UTC timestamp. */
function miami(iso: string): { ymd: string; dow: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MIAMI_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
    dow: Math.max(0, DOWS.indexOf(get('weekday'))),
    hour: Number(get('hour')) % 24,
  };
}
function monthShift(m: string, by: number): string {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 15)).toLocaleDateString('en-US',
    { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
const fmtHour = (h: number) =>
  h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
const pctOf = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');

export default async function HelplineMonthlyReport({ searchParams }: {
  searchParams: { m?: string };
}) {
  const viewer = await getViewer();
  if (!viewer) return null;
  if (!viewer.canSeeHelpline) {
    return <div className="panel"><div className="empty"><strong>Restricted</strong></div></div>;
  }

  const thisMonth = miami(new Date().toISOString()).ymd.slice(0, 7);
  const m = /^\d{4}-\d{2}$/.test(searchParams.m ?? '') ? searchParams.m! : thisMonth;

  // Generous UTC bounds (month ± 1 day), filtered precisely by Miami-local
  // date below — timezone edges never drop a New Year's Eve call.
  const [y, mo] = m.split('-').map(Number);
  const lo = new Date(Date.UTC(y, mo - 1, 1) - 86_400_000).toISOString();
  const hi = new Date(Date.UTC(y, mo, 1) + 86_400_000).toISOString();

  const sb = supabaseServer();
  const [{ data: caseRows, error }, { data: callRows }, { data: teamRows }] = await Promise.all([
    sb.from('helpline_cases').select('*').gte('created_at', lo).lt('created_at', hi).limit(2000),
    sb.from('helpline_calls').select('received_at, kind')
      .in('kind', ['initial', 'repeat']).gte('received_at', lo).lt('received_at', hi).limit(5000),
    sb.from('outreach_teams').select('id, name'),
  ]);
  if (error) {
    return <div className="panel"><div className="empty">Helpline tables not found — run
      supabase/helpline.sql first.</div></div>;
  }

  const cases = (caseRows ?? []).filter((c: any) => miami(c.created_at).ymd.startsWith(m));
  const calls = (callRows ?? []).filter((c: any) => miami(c.received_at).ymd.startsWith(m));
  const teamName = new Map((teamRows ?? []).map((t: any) => [t.id as number, t.name as string]));

  // ── Aggregates ──────────────────────────────────────────────────────────────
  const n = cases.length;
  const stages: [string, number][] = [
    ['Cases opened', n],
    ['Assigned to an outreach team', cases.filter((c: any) => c.assigned_at).length],
    ['Contacted by outreach', cases.filter((c: any) => (c.contacts ?? 0) > 0 || c.confirmed_at
      || c.verified_entry || ['contacted', 'confirmed'].includes(c.status)).length],
    ['Confirmed homeless in the field', cases.filter((c: any) => c.confirmed_at
      || c.status === 'confirmed' || c.verified_entry).length],
    ['Verified HMIS enrollment', cases.filter((c: any) => c.verified_entry).length],
  ];
  const referred = cases.filter((c: any) => c.status === 'referred_out');
  const refBy = new Map<string, number>();
  for (const c of referred) {
    const k = (c as any).referred_to ?? '(unspecified)';
    refBy.set(k, (refBy.get(k) ?? 0) + 1);
  }

  const byDist = new Map<string, number>();
  for (const c of cases) {
    const k = (c as any).county_district || '(no pin)';
    byDist.set(k, (byDist.get(k) ?? 0) + 1);
  }
  const distRows = [...byDist.entries()].sort((a, b) =>
    (parseInt(a[0].replace(/\D/g, ''), 10) || 99) - (parseInt(b[0].replace(/\D/g, ''), 10) || 99));

  const dayTotals = Array(7).fill(0); const hourTotals = Array(24).fill(0);
  for (const c of calls) {
    const { dow, hour } = miami((c as any).received_at);
    dayTotals[dow] += 1; hourTotals[hour] += 1;
  }
  const busyDay = dayTotals.indexOf(Math.max(...dayTotals));
  const busyHour = hourTotals.indexOf(Math.max(...hourTotals));
  const initial = calls.filter((c: any) => c.kind === 'initial').length;

  const factorRows = FACTORS
    .map((f) => [f.key, cases.filter((c: any) => (c.factors ?? []).includes(f.key)).length] as [string, number])
    .filter(([, x]) => x > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const emergency = cases.filter((c: any) =>
    (EMERGENCY_SLEEPING as readonly string[]).includes(c.sleeping ?? '')).length;

  const byTeam = new Map<string, number>();
  for (const c of cases) {
    if ((c as any).team_id == null) continue;
    const k = teamName.get((c as any).team_id) ?? `Team ${(c as any).team_id}`;
    byTeam.set(k, (byTeam.get(k) ?? 0) + 1);
  }
  const teamRowsOut = [...byTeam.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  // Zip cut — county zip boundaries (public/gis/zipcodes.geojson), resolved
  // from each case's pin server-side; degrades to nothing if the file's gone.
  let zipRows: [string, number][] = [];
  try {
    const geo = JSON.parse(await readFile(
      join(process.cwd(), 'public', 'gis', 'zipcodes.geojson'), 'utf-8')) as GeoFC;
    const byZip = new Map<string, number>();
    for (const c of cases) {
      if ((c as any).lat == null || (c as any).lng == null) continue;
      const hit = geo.features.find((f) => inFeature((c as any).lng, (c as any).lat, f.geometry));
      const zip = hit?.properties?.ZIPCODE != null ? String(hit.properties.ZIPCODE) : null;
      if (zip) byZip.set(zip, (byZip.get(zip) ?? 0) + 1);
    }
    zipRows = [...byZip.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  } catch { /* boundary file missing — section self-hides */ }

  const kpi = (label: string, v: number | string, strong = false) => (
    <div className="kpi" style={strong ? { borderColor: '#5b46d9' } : undefined}>
      <div className="kv" style={strong ? { color: '#5b46d9' } : undefined}>{v}</div>
      <div className="kl">{label}</div>
    </div>
  );

  return (
    <main className="hr">
      <style dangerouslySetInnerHTML={{ __html: `
        .hr{max-width:820px;margin:0 auto;background:#fff;color:#1a202c;border:1px solid #d8dee8;
          border-radius:8px;padding:18px 34px 22px;font-size:13px;line-height:1.45}
        .hr *{box-sizing:border-box}
        .hr .hd{border-bottom:2px solid #1a202c;padding-bottom:8px;margin-bottom:10px;
          display:flex;justify-content:space-between;align-items:flex-end;gap:14px}
        .hr h1{font-size:19px;margin:0;line-height:1.2}
        .hr .sub{color:#5c6a7d;font-size:11.5px}
        .hr h2{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:#5c6a7d;
          margin:14px 0 6px;border-bottom:1px solid #e4e8ef;padding-bottom:2px}
        .hr .kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-top:10px}
        .hr .kpi{border:1px solid #d8dee8;border-radius:6px;padding:7px 4px;text-align:center}
        .hr .kv{font-size:19px;font-weight:800}
        .hr .kl{font-size:9.5px;color:#5c6a7d;margin-top:1px;line-height:1.25}
        .hr table{border-collapse:collapse;width:100%;font-size:12px}
        .hr th{color:#5c6a7d;font-size:10px;text-transform:uppercase;letter-spacing:.05em;
          text-align:left;padding:3px 8px 3px 0;border-bottom:1px solid #e4e8ef}
        .hr td{padding:3px 8px 3px 0;border-bottom:1px solid #f0f2f6}
        .hr td.n,.hr th.n{text-align:right}
        .hr .bar{display:inline-block;height:9px;background:#5b46d9;border-radius:3px;
          vertical-align:middle;-webkit-print-color-adjust:exact;print-color-adjust:exact}
        .hr .cols{display:grid;grid-template-columns:1fr 1fr;gap:0 26px}
        .hr .foot{margin-top:14px;padding-top:6px;border-top:1px solid #e4e8ef;color:#5c6a7d;font-size:10px}
        .hr .nav{display:flex;gap:8px;align-items:center}
        .hr .nav a{color:#1a56db;text-decoration:none;font-size:12px}
        .btnrow{margin:0 auto 10px;max-width:820px;display:flex;justify-content:space-between;align-items:center}
        @media print{
          body{background:#fff !important;padding:0 !important}
          .hr{border:none;border-radius:0;max-width:none;padding:2mm 6mm;font-size:11.5px}
          .hr h2,.hr .kpis,.hr table{break-inside:avoid}
          .noprint, .sidenav, .hdr, .tabnav, nav, header{display:none !important}
          @page{size:letter;margin:9mm}
        }
      ` }} />

      <div className="btnrow noprint">
        <span className="nav" style={{ display: 'flex', gap: 10 }}>
          <Link href={`/dashboard/helpline/report?m=${monthShift(m, -1)}`} className="tbtn">
            ← {monthLabel(monthShift(m, -1))}</Link>
          {m < thisMonth && (
            <Link href={`/dashboard/helpline/report?m=${monthShift(m, 1)}`} className="tbtn">
              {monthLabel(monthShift(m, 1))} →</Link>
          )}
          <Link href="/dashboard/helpline?tab=map" className="tbtn">↩ Back to Helpline</Link>
        </span>
        <PrintButton />
      </div>

      <div className="hd">
        <div>
          <h1>Helpline Monthly Report — {monthLabel(m)}</h1>
          <div className="sub">Miami-Dade County Homeless Trust · Homeless Helpline
            {m === thisMonth ? ' · month in progress' : ''} · CONFIDENTIAL</div>
        </div>
      </div>

      <div className="kpis">
        {kpi('Calls received', calls.length)}
        {kpi('Cases opened', n)}
        {kpi('Assigned to outreach', stages[1][1])}
        {kpi('Confirmed homeless', stages[3][1])}
        {kpi('Verified HMIS enrollment', stages[4][1], true)}
        {kpi('Referred to right door', referred.length)}
      </div>

      <h2>Outcome funnel — phone call to proven enrollment</h2>
      <table>
        <thead><tr><th>Stage</th><th className="n">Clients</th><th className="n">% of cases</th><th style={{ width: '38%' }} /></tr></thead>
        <tbody>
          {stages.map(([label, v]) => (
            <tr key={label}>
              <td>{label}</td><td className="n"><b>{v}</b></td>
              <td className="n">{pctOf(v, n)}</td>
              <td><span className="bar" style={{ width: `${n ? Math.max(2, (v / n) * 100) : 0}%` }} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="sub" style={{ marginTop: 4 }}>
        Verified enrollment = the client appears in an HMIS enrollment dated on/after field
        confirmation — read from the HMIS export by the verification pipeline, never self-reported.
      </div>

      <div className="cols">
        <div>
          <h2>Cases by County Commission District</h2>
          <table>
            <thead><tr><th>District</th><th className="n">Cases</th><th className="n">Share</th></tr></thead>
            <tbody>
              {distRows.length ? distRows.map(([k, v]) => (
                <tr key={k}><td>{k}</td><td className="n">{v}</td><td className="n">{pctOf(v, n)}</td></tr>
              )) : <tr><td colSpan={3} className="sub">No cases this month.</td></tr>}
            </tbody>
          </table>

          {zipRows.length > 0 && (
            <>
              <h2>Top zip codes</h2>
              <table>
                <thead><tr><th>Zip</th><th className="n">Cases</th><th className="n">Share</th></tr></thead>
                <tbody>
                  {zipRows.map(([k, v]) => (
                    <tr key={k}><td>{k}</td><td className="n">{v}</td>
                      <td className="n">{pctOf(v, n)}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <h2>Demand pattern</h2>
          <table>
            <tbody>
              <tr><td>Busiest day</td><td className="n"><b>{calls.length ? `${DOWS[busyDay]} (${dayTotals[busyDay]} calls)` : '—'}</b></td></tr>
              <tr><td>Busiest hour</td><td className="n"><b>{calls.length ? `${fmtHour(busyHour)} (${hourTotals[busyHour]} calls)` : '—'}</b></td></tr>
              <tr><td>First-time calls</td><td className="n">{initial}</td></tr>
              <tr><td>Repeat calls (joined an existing case)</td><td className="n">{calls.length - initial}</td></tr>
              <tr><td>Callers sleeping outside / in a car</td><td className="n">{emergency} · {pctOf(emergency, n)}</td></tr>
            </tbody>
          </table>
        </div>

        <div>
          <h2>Top situations reported (factors)</h2>
          <table>
            <thead><tr><th>Factor</th><th className="n">Cases</th><th className="n">Share</th></tr></thead>
            <tbody>
              {factorRows.length ? factorRows.map(([k, v]) => (
                <tr key={k}><td>{k}</td><td className="n">{v}</td><td className="n">{pctOf(v, n)}</td></tr>
              )) : <tr><td colSpan={3} className="sub">None recorded this month.</td></tr>}
            </tbody>
          </table>

          <h2>External referrals — right-door diversions</h2>
          <table>
            <thead><tr><th>Destination</th><th className="n">Referrals</th></tr></thead>
            <tbody>
              {refBy.size ? [...refBy.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                <tr key={k}><td>{k}</td><td className="n">{v}</td></tr>
              )) : <tr><td colSpan={2} className="sub">None this month.</td></tr>}
            </tbody>
          </table>

          {teamRowsOut.length > 0 && (
            <>
              <h2>Cases by outreach team</h2>
              <table>
                <thead><tr><th>Team</th><th className="n">Assigned</th></tr></thead>
                <tbody>
                  {teamRowsOut.map(([k, v]) => (
                    <tr key={k}><td>{k}</td><td className="n">{v}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>

      <div className="foot">
        Cases counted by the month they were opened (Miami time); calls by the month received.
        Outcome verification reads HMIS enrollment records — figures for recent months rise as
        outreach and data entry catch up. Generated {new Date().toLocaleDateString('en-US',
          { month: 'short', day: 'numeric', year: 'numeric', timeZone: MIAMI_TZ })} ·
        Miami-Dade County Homeless Trust · Confidential — handle per Trust policy.
      </div>
    </main>
  );
}
