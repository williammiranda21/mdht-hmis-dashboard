/**
 * Metric glossary — "how every number is computed", pulled from the
 * definitions the pipeline actually enforces (apr_monthly_report.py,
 * bnl_core.py, and the conventions in hmis-web/CLAUDE.md). STATIC on
 * purpose: this page documents code, not data, so it changes only when the
 * logic changes — keep it in the same commit as any definition change.
 *
 * Written for providers: plain-language first, the precise rule underneath.
 */

export const dynamic = 'force-static';

function Term({ name, children, rule }: {
  name: string; children: React.ReactNode; rule?: React.ReactNode;
}) {
  return (
    <div style={{ padding: '10px 0', borderTop: '1px solid rgba(148,163,184,0.15)' }}>
      <div style={{ fontWeight: 700, fontSize: '.92rem', marginBottom: 2 }}>{name}</div>
      <div style={{ fontSize: '.86rem', lineHeight: 1.55 }}>{children}</div>
      {rule && <div className="bnl-sub" style={{ marginTop: 4, lineHeight: 1.5 }}>Rule: {rule}</div>}
    </div>
  );
}

function Section({ id, title, children }: {
  id: string; title: string; children: React.ReactNode;
}) {
  return (
    <div className="panel" style={{ marginTop: 16, padding: '14px 18px' }} id={id}>
      <h3 style={{ margin: '0 0 4px' }}>{title}</h3>
      {children}
    </div>
  );
}

const SECTIONS: [string, string][] = [
  ['basics', 'Reading this dashboard'],
  ['populations', 'Populations & statuses'],
  ['housing', 'Housing & destinations'],
  ['returns', 'Returns to homelessness'],
  ['journey', 'CE journey milestones'],
  ['dq', 'Data quality'],
  ['util', 'Unit utilization'],
  ['tth', 'Time to housing'],
  ['cohorts', 'Cohorts'],
  ['targets', 'Targets'],
];

export default function GlossaryPage() {
  return (
    <>
      <div className="panel" style={{ padding: '14px 18px' }}>
        <h3 style={{ margin: 0 }}>Metric glossary</h3>
        <p className="bnl-sub" style={{ margin: '6px 0 10px', textTransform: 'none', letterSpacing: 0, lineHeight: 1.5 }}>
          How every number on this dashboard is computed. These are the definitions the data
          pipeline enforces — if your count differs from a report elsewhere, the difference is
          almost always one of the rules below.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="btn" style={{ fontSize: 12 }}>{label}</a>
          ))}
        </div>
      </div>

      <Section id="basics" title="Reading this dashboard">
        <Term name="Data source" rule="HUD CSV export (hashed IDs) + side-car reports (PSH referrals, SPDAT) keyed on the same hashed Personal ID.">
          Everything comes from the HMIS (WellSky Community Services) HUD CSV export, refreshed
          when a new export is loaded — this is a reporting mirror, not live HMIS.
        </Term>
        <Term name="Data as of" rule="Export.csv ExportEndDate, shown in the page header.">
          The export&apos;s own end date: no number on the dashboard reflects anything that happened
          after it, even if the export was pulled later.
        </Term>
        <Term name="Fiscal year" rule="FY2026 = Oct 1, 2025 – Sep 30, 2026.">
          October 1 through September 30, matching HUD reporting.
        </Term>
        <Term name="Partial month" rule="DQ, System Performance, Returns, and Utilization stop at the last complete month; Project Performance shows the partial month flagged.">
          The current month is incomplete until it ends. Tabs that need complete data simply do not
          include it — a &quot;missing&quot; current month on those tabs is correct, not a bug.
        </Term>
      </Section>

      <Section id="populations" title="Populations & statuses (By-Name List)">
        <Term name="Who is on the list" rule="Any HMIS activity in the trailing 24 months in ES, Safe Haven, TH, SO, PSH, RRH, PH, or CE. Services-Only and Prevention are excluded.">
          Everyone the system touched in the last two years — adults, children, heads of household
          and members alike. People counts, not household counts (except the Families tab).
        </Term>
        <Term name="Actively homeless" rule="Open ES/SH/TH/SO enrollment · OR matched to PH with no move-in · OR a literal-homeless outreach sighting within 90 days.">
          The system has current evidence they are homeless right now.
        </Term>
        <Term name="Housed" rule="PH enrollment with a HUD move-in date · OR most recent exit went to a permanent destination AND no HUD-qualifying return since.">
          In a unit, or exited to permanent housing that has held.
        </Term>
        <Term name="Inactive" rule="No open enrollment, no outreach sighting, no PH exit — for 90+ days.">
          The system lost track of them. An exit record alone is a departure, not evidence of
          active homelessness.
        </Term>
        <Term name="Families tab = households" rule="One row per household: the head of household, or the oldest member when no HoH is recorded (so no-HoH households stay visible). Header shows both counts.">
          Families are case-conferenced as households, so the Families tab shows one row per
          family; the drawer&apos;s Household card lists every member with ages. All other tabs count
          people.
        </Term>
        <Term name="Chronically homeless (approx.)" rule="Disabling condition AND (12+ continuous months homeless OR 4+ occasions totaling 12+ months in 3 years, from the 3.917 self-report).">
          An approximation of the HMIS Reporting Glossary chronic-homelessness logic — confirm in
          case conferencing before treating it as determinative.
        </Term>
        <Term name="Self-reported days homeless (3.917)" rule="Approximate start date from intake; floors at age 13; episodes over 25 years are treated as data errors (DQ-flagged). PSH/RRH residency never counts as homeless time.">
          What the client reported at intake about when this episode began.
        </Term>
        <Term name="Observed in HMIS (3y)" rule="Union of ES/SH/TH/SO enrollment nights plus outreach contact days in the last 3 years; a break of 7+ consecutive nights separates occasions (HUD CH Final Rule).">
          What the system actually saw, as distinct from what was self-reported.
        </Term>
      </Section>

      <Section id="housing" title="Housing & destinations">
        <Term name="Permanent-housing destinations" rule="Codes 410, 411, 421, 422, 423, 426, 435.">
          Exits to: Rental no subsidy (410) · Owned no subsidy (411) · Owned with subsidy (421) ·
          Staying with family, permanent (422) · Staying with friends, permanent (423) · HOPWA PH
          (426) · Rental with subsidy (435). &quot;Unsubsidized&quot; means 410 and 411 only.
        </Term>
        <Term name="PH exit rate" rule="PH-destination exits ÷ all leavers, per project per period.">
          Of everyone who left the project, the share who left to permanent housing.
        </Term>
        <Term name="Housing placement (history card)" rule="A PH move-in, or an exit to a permanent destination. Intervals overlapping the 3-year window count, clamped to the window edge. An exit-to-PH placement runs until the first HUD-qualifying return, else to today.">
          The green segments on a client&apos;s history bar. HMIS records a destination, never a
          move-out — so an exit placement&apos;s end is the return that disproved it, or today.
        </Term>
      </Section>

      <Section id="returns" title="Returns to homelessness">
        <Term name="The HUD return test (SPM Measure 2)" rule="After a permanent-destination exit: a NEW enrollment in SO/ES/SH/TH on or after the exit day counts (same-day included). A PH entry counts only if more than 14 days after the exit and not covered by another PH stay (transfers are not returns). The exited enrollment itself never counts.">
          One test, used everywhere a &quot;return&quot; is counted, so every surface agrees with the
          number leadership reports to HUD.
        </Term>
        <Term name="Returns tab bands" rule="Exit cohorts get a full 730-day observation window, so a period's M2 universe is exits from ~2 years prior. Bands: <6 months, 6–12, 13–24.">
          Recent exits are not in the official M2 numbers yet — HUD waits until every exit has had
          two full years to fail before grading the cohort.
        </Term>
        <Term name="RETURNED flag vs. card returns" rule="Flag: homeless evidence since the client's MOST RECENT permanent exit (current state — clears on re-housing). Card: count of HUD-qualifying returns after housing events in the 3-year window (history — re-housing does not erase it).">
          A client re-housed after a failed placement shows returns on the card but no flag —
          both are correct; they answer &quot;now?&quot; versus &quot;ever?&quot;.
        </Term>
      </Section>

      <Section id="journey" title="CE journey milestones">
        <Term name="Identified" rule="Earliest Street Outreach or Coordinated Entry enrollment entry within 24 months before the journey's anchor (or before today if un-anchored).">
          When the system first found this person for the current journey. The 24-month cap keeps
          old episodes from inflating it; it measures when the data saw them, not when homelessness
          began.
        </Term>
        <Term name="Assessed" rule="Most recent SPDAT completion date (VI/F/TAY, side-car reports).">
          The CE assessment on file.
        </Term>
        <Term name="Referred" rule="Date of the client's current LIVE referral to HOUSING (TH / RRH / PSH / other PH / vouchers — shelter-bed referrals never count). Canceled, declined, or rejected referrals never advance the journey — the drawer lists them in referral history, but the client is back to waiting for a new referral.">
          A referral that died is not progress, and a shelter-bed referral is not a housing
          referral.
        </Term>
        <Term name="Accepted" rule="Entry date at the housing provider — but only an OPEN stay, or a closed stay that reached a move-in with no HUD-qualifying return after its exit, anchors the journey. A closed never-housed stay is a dead acceptance; a returned-after client is on a new journey.">
          The receiving program creating the enrollment is the acceptance.
        </Term>
        <Term name="Moved in" rule="HUD move-in date; or, when a client exits any non-PH program directly to a permanent destination with no program move-in, that exit is the terminal (shown as 'Housed (exit)'). An RRH/PSH graduation keeps its move-in as the housing event.">
          The journey&apos;s finish line.
        </Term>
        <Term name="Waiting at a leg / worklists" rule="Active clients not yet moved in, bucketed by their furthest milestone; wait = days since it. The bar's waiting numbers and the clicked worklist are the same computation — they can never disagree. Journey card follows the population selector.">
          Click any &quot;N waiting&quot; number under the journey bar for the list, longest-waiting first.
        </Term>
        <Term name="Median vs. average" rule="Median = the typical client (headline). Average shown muted — pulled up by long-tail outliers.">
          Both appear on the journey bars; the median is the honest headline.
        </Term>
      </Section>

      <Section id="dq" title="Data quality">
        <Term name="What counts as an error" rule="Blank/missing values count, not just the HUD refusal codes (8/9/99). Income questions are scored only for adults and heads of household (the APR universe).">
          A blank field fails reporting exactly like a &quot;client refused&quot; — the masks count both.
        </Term>
        <Term name="Data quality checks" rule="Registry of checks aligned with HUD's open-source Eva tool (household integrity, impossible dates, duplicates, income consistency…), snapshotted at the latest complete month. Methodology credit: HUD Eva.">
          Each check carries fix guidance written for how WellSky Community Services actually
          records the data (dated income records are end-dated, never unchecked).
        </Term>
        <Term name="SSN quality" rule="Last-4-only SSN marked 'partial' is correct entry, never flagged. Last-4 with quality 'full' is a mismatch and is flagged. APR Q6a stays HUD-faithful either way.">
          The fix-list flags real mismatches, not the county&apos;s legitimate partial-SSN practice.
        </Term>
        <Term name="Error rates by user" rule="Records attributed to their CREATOR (UserID), unique-record math over the trailing window — a record failing all year counts once. Rates can exceed 100% when a backlog predates the window.">
          Coaching data, not performance review — the creator is not always the last editor.
        </Term>
      </Section>

      <Section id="util" title="Unit utilization">
        <Term name="PSH / PH capacity" rule="Static HIC UnitInventory.">
          Fixed units, from the housing inventory count.
        </Term>
        <Term name="RRH & hotel/motel capacity" rule="Dynamic: capacity = households with an active move-in (point in time); utilization pegged at 100% by definition. The real signal is households enrolled and AWAITING move-in, shown on the project row.">
          Tenant-based programs lease per household — a static bed count would be fiction (one
          program showed 650 phantom beds at 30%).
        </Term>
        <Term name="DV beds" rule="Victim Service Provider projects are excluded from utilization entirely.">
          They report inventory but enter no client data into HMIS, so their beds would read as
          permanently empty.
        </Term>
      </Section>

      <Section id="tth" title="Time to housing">
        <Term name="The event depends on program type" rule="PSH/PH/RRH: recorded move-in. ES/TH/SO/Safe Haven: exit to a permanent destination. ES night-by-night: excluded (bed-nights, not destinations).">
          &quot;Housed&quot; means something different in a shelter than a housing program, and the metric
          respects that.
        </Term>
        <Term name="Cohort & minimums" rule="Rolling 24 months of program entries; Kaplan-Meier survival; projects need 20+ enrollments for their own curve; medians can legitimately be 0 days (enrollment created at move-in) or 'not reached' (most still waiting) — different answers, both real.">
          Small programs show the type baseline instead of a noise curve.
        </Term>
      </Section>

      <Section id="cohorts" title="Cohorts">
        <Term name="Membership" rule="Static — housed members stay. That is the point: watch a fixed group's outcomes accumulate.">
          A cohort is a fixed list of people you choose to track.
        </Term>
        <Term name="Housed % over time" rule="Reconstructed from actual event dates (placements and HUD returns), weekly; refresh snapshots overlay as dots. A dot off the line means the data was edited after that capture.">
          The line is when things happened; the dots are what we measured on each refresh.
        </Term>
        <Term name="Returns after first housing" rule="From each member's FIRST placement, N of M returned within 6/12/24 months — denominators only include placements old enough to grade ('too soon' otherwise). Re-housing later does not erase a return (SPM M2 convention); 'housed today' is shown alongside.">
          Placement durability, deliberately framed as events — never as a &quot;retention %&quot; that
          could be misread as current status.
        </Term>
        <Term name="System benchmark" rule="The 'sys Nd' ghost figures are the all-population journey medians; green/amber tint when the cohort beats/trails the system by 25%+.">
          Are we faster than the system, leg by leg.
        </Term>
      </Section>

      <Section id="targets" title="Targets">
        <Term name="Where targets come from" rule="Admins set them per project TYPE (inherited by all projects of that type) or per specific project (overrides the type default). Panel shows only metrics with an effective target.">
          Seven metrics: PH exit rate, unsubsidized rate, DQ score, returns (6-month and 2-year),
          average length of stay, median days to housing.
        </Term>
        <Term name="Off-target flags" rule="Evaluated server-side on the All/All view; the ⚑ chip lists which targets a project misses.">
          Direction-aware: &quot;at least&quot; for rates you want high, &quot;at most&quot; for returns and days.
        </Term>
      </Section>

      <p className="bnl-sub" style={{ margin: '16px 4px', textTransform: 'none', letterSpacing: 0, lineHeight: 1.5 }}>
        Definitions follow HUD specifications (APR, System Performance Measures, HMIS Reporting
        Glossary) wherever one exists; local conventions are noted as such. This page changes only
        when the pipeline&apos;s logic changes.
      </p>
    </>
  );
}
