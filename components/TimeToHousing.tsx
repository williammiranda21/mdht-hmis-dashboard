'use client';

/**
 * Time to housing — Kaplan-Meier, rendered from `survival_metrics`.
 *
 * Nothing here computes survival. `generate_analytics.py` §3b does that over a
 * rolling 24-month entry cohort and writes the curve to Postgres; this file maps
 * fields. Survival analysis handles censoring — the clients still enrolled and
 * still waiting — which a plain average over completed cases silently drops,
 * flattering every project. Do not "simplify" this into an average.
 *
 * Two rules the display has to respect, because both look like missing data and
 * neither is:
 *
 *   median = null  the curve never crossed 50% inside the two-year window, i.e.
 *                  most of the cohort was still unhoused. Render "not reached",
 *                  never 0 and never the window length.
 *   median = 0     genuinely zero days. PH projects that create the enrollment
 *                  on the day the client moves in produce this legitimately, and
 *                  `median || 'n/a'` would hide it. Render "same day".
 */

export interface SurvivalRow {
  scope: 'project' | 'type';
  ref_id: number;
  /** 'movein' = PH types (the event is a recorded MoveInDate — HUD's move-in
   *  concept). 'ph_exit' = ES/TH/SO/Safe Haven, where there is no move-in and
   *  the housing event is an exit to a permanent destination. */
  event: 'movein' | 'ph_exit';
  project_type: number | null;
  label: string | null;
  n: number;
  n_housed: number;
  median_days: number | null;
  q1_days: number | null;
  q3_days: number | null;
  rate_90: number | null;
  rate_180: number | null;
  rate_365: number | null;
  type_median: number | null;
  type_rate_180: number | null;
  type_n: number | null;
  curve: { x: number; y: number; n: number }[];
  window_start: string | null;
  window_end: string | null;
}

/** Days → a phrase. Handles the two "looks empty but isn't" cases above. */
export function fmtDays(d: number | null | undefined): string {
  if (d == null) return 'not reached';
  if (d === 0) return 'same day';
  if (d === 1) return '1 day';
  return `${d.toLocaleString()} days`;
}

export const EVENT_NOUN: Record<SurvivalRow['event'], string> = {
  movein: 'moved into housing',
  ph_exit: 'exited to permanent housing',
};

export const EVENT_BLURB: Record<SurvivalRow['event'], string> = {
  movein:
    'This is a housing program, so the event is the recorded move-in date — how long ' +
    'from enrolment until the client is actually in a unit. Programs that create the ' +
    'enrolment on move-in day will show a median of “same day”; that reflects how the ' +
    'enrolment is entered, not a delay of zero.',
  ph_exit:
    'There is no move-in date in a shelter or outreach programme, so the event is an ' +
    'exit to a permanent destination — how long from entry until the client leaves for ' +
    'permanent housing.',
};

const nearestBelow = (curve: SurvivalRow['curve'], day: number) => {
  let last = curve[0];
  for (const p of curve) { if (p.x > day) break; last = p; }
  return last;
};

/** Share housed by `day`, as a percentage — the complement of survival. */
export const housedBy = (curve: SurvivalRow['curve'], day: number): number | null => {
  const p = curve?.length ? nearestBelow(curve, day) : null;
  return p ? (1 - p.y) * 100 : null;
};

/**
 * Cumulative "share housed" chart — the KM curve inverted, so it rises.
 *
 * Plotting survival (a falling line) is the convention in the literature but
 * reads backwards to a program manager: a line that sinks toward zero looks like
 * failure when it means everyone got housed. Rising = housed.
 */
export function KmChart({
  self, peer, peerLabel,
}: { self: SurvivalRow; peer?: SurvivalRow | null; peerLabel?: string }) {
  const W = 1000, H = 240, L = 40, R = 12, T = 12, B = 34;
  const MAXD = 730;
  const px = (d: number) => L + (d / MAXD) * (W - L - R);
  const py = (pct: number) => T + (H - T - B) * (1 - pct / 100);

  const path = (row: SurvivalRow) =>
    row.curve
      .map((p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)},${py((1 - p.y) * 100).toFixed(1)}`)
      .join(' ');

  const marks = [90, 180, 365, 545];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="tth-chart" preserveAspectRatio="none"
      role="img"
      aria-label={`Share ${EVENT_NOUN[self.event]} over time since entry`}>
      {[0, 25, 50, 75, 100].map((g) => (
        <g key={g}>
          <line x1={L} x2={W - R} y1={py(g)} y2={py(g)} stroke="var(--hair)" strokeWidth={1} />
          <text x={L - 6} y={py(g) + 3} textAnchor="end" fontSize={9} fill="var(--muted)">{g}%</text>
        </g>
      ))}
      {marks.map((d) => (
        <line key={d} x1={px(d)} x2={px(d)} y1={T} y2={H - B}
          stroke="var(--hair)" strokeWidth={1} strokeDasharray="3 3" />
      ))}

      {peer && peer.curve?.length > 0 && (
        <path d={path(peer)} fill="none" stroke="var(--muted)" strokeWidth={1.6}
          strokeDasharray="5 4" />
      )}
      {self.curve?.length > 0 && (
        <path d={path(self)} fill="none" stroke="var(--primary)" strokeWidth={2.4} />
      )}

      {/* Median guide — only when the curve actually crosses 50%. */}
      {self.median_days != null && (
        <>
          <line x1={px(self.median_days)} x2={px(self.median_days)} y1={py(50)} y2={H - B}
            stroke="var(--primary)" strokeWidth={1.4} strokeDasharray="4 3" />
          <circle cx={px(self.median_days)} cy={py(50)} r={4} fill="var(--primary)" />
        </>
      )}

      {[0, ...marks, MAXD].map((d) => (
        <text key={`x${d}`} x={px(d)} y={H - 12} textAnchor="middle" fontSize={9} fill="var(--muted)">
          {d}d
        </text>
      ))}
      <text x={L} y={H - 1} fontSize={9} fill="var(--faint)">days since entry</text>

      <g>
        <line x1={W - 250} x2={W - 226} y1={T + 8} y2={T + 8} stroke="var(--primary)" strokeWidth={2.4} />
        <text x={W - 220} y={T + 11} fontSize={10} fill="var(--text)">this project</text>
        {peer && (
          <>
            <line x1={W - 250} x2={W - 226} y1={T + 24} y2={T + 24} stroke="var(--muted)"
              strokeWidth={1.6} strokeDasharray="5 4" />
            <text x={W - 220} y={T + 27} fontSize={10} fill="var(--muted)">
              {peerLabel ?? 'all peers'}
            </text>
          </>
        )}
      </g>
    </svg>
  );
}

/**
 * The full panel section: headline comparison, the curve, and the method note.
 * Used by the Project Panel; the Deep Dive grid renders the compact figures only.
 */
export function TimeToHousing({ self, peer }: { self: SurvivalRow | null; peer: SurvivalRow | null }) {
  if (!self) {
    return (
      <div className="hc-none">
        {peer
          ? `Fewer than 20 enrolments at this project in the two years to ${peer.window_end ?? 'the cohort end'} — too few for a reliable time-to-housing curve.`
          : 'Time to housing is not measured for this project type.'}
      </div>
    );
  }

  const better = self.median_days != null && self.type_median != null
    ? self.median_days < self.type_median
    : null;
  // A null median is not "worse than" a number — it means over half the cohort
  // was still waiting at two years, which IS worse than any real median. Say so
  // explicitly rather than letting a null quietly compare as neither.
  const stalled = self.median_days == null && self.type_median != null;

  return (
    <>
      <div className="hc-tiles">
        <div className="hc-t">
          <div className="k">Median time to housing</div>
          <div className="v" style={
            stalled ? { color: 'var(--danger)' }
            : better === true ? { color: 'var(--accent)' }
            : better === false ? { color: 'var(--warn)' } : undefined
          }>
            {fmtDays(self.median_days)}
          </div>
          <div className="s">
            {self.type_median != null
              ? `${fmtDays(self.type_median)} for ${self.label && peer?.label ? peer.label : 'peers'}`
              : 'no peer baseline'}
          </div>
        </div>
        <div className="hc-t">
          <div className="k">Housed within 180 days</div>
          <div className="v">{self.rate_180 != null ? `${self.rate_180}%` : '—'}</div>
          <div className="s">
            {self.type_rate_180 != null ? `${self.type_rate_180}% for peers` : '—'}
          </div>
        </div>
        <div className="hc-t">
          <div className="k">Middle half</div>
          <div className="v" style={{ fontSize: 15 }}>
            {self.q1_days != null ? fmtDays(self.q1_days) : 'not reached'}
            {' – '}
            {self.q3_days != null ? fmtDays(self.q3_days) : 'not reached'}
          </div>
          <div className="s">25th–75th percentile</div>
        </div>
        <div className="hc-t">
          <div className="k">Cohort</div>
          <div className="v">{self.n.toLocaleString()}</div>
          <div className="s">{self.n_housed.toLocaleString()} {EVENT_NOUN[self.event]}</div>
        </div>
      </div>

      <div className="tth-wrap">
        <KmChart self={self} peer={peer} peerLabel={peer?.label ? `${peer.label} average` : undefined} />
      </div>

      <p className="bnl-method tth-note">
        <b>How to read this.</b> The line is the share of clients housed by each day
        after entry, estimated with Kaplan-Meier so that clients still enrolled and
        still waiting are counted as far as they have got rather than dropped — a
        plain average over finished cases only would leave out exactly the people
        who are taking longest.{' '}
        {EVENT_BLURB[self.event]}{' '}
        Cohort: the {self.n.toLocaleString()} enrolments starting between{' '}
        {self.window_start ?? '—'} and {self.window_end ?? '—'}.
        {self.median_days == null && (
          <> <b>“Not reached”</b> means fewer than half this cohort were housed within
          two years — it is a result, not missing data.</>
        )}
      </p>
    </>
  );
}
