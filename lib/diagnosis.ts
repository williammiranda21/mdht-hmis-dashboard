/**
 * Performance diagnosis — Pillar 2.
 *
 * NOT a second copy of the peer-benchmark chart. PeerBench already shows where a
 * project stands on each metric in isolation; this is the layer PeerBench cannot
 * be — it CROSSES metrics (and data-quality) to say what the standing means and
 * what to do about it. Every number is a stored value or a peer median computed
 * with the same percentile() PeerBench uses; nothing is invented.
 *
 * Output = a one-line headline (bottom line vs same-type peers) + a short list of
 * INSIGHTS. Each insight is a rule in the auditable library below that fires only
 * when a real, cross-metric data condition holds, and pairs the observation with
 * a standard HUD/HMIS practice pointer — never a fabricated figure.
 *
 * Two modes, each about THIS project's own operation:
 *   • snapshot — housing speed × PH rate × length of stay × data quality
 *   • returns  — do this project's own exits stick, and where do returns follow
 * The system-pathway bottleneck (e.g. "Emergency Shelter" for an RRH project's
 * clients) is deliberately NOT here — that is a system view, on the Deep Dive.
 */

// ── Numeric helpers (mirror ProjectPanel so ranks match exactly) ──────────────

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
const median = (vals: number[]): number | null => percentile([...vals].sort((a, b) => a - b), 50);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const rate = (band: number | null | undefined, denom: number | null | undefined): number | null =>
  band == null || !denom ? null : (band / denom) * 100;
const d1 = (v: number | null): string => v == null ? '—' : `${Number(v.toFixed(1))}`;
const p2 = (v: number | null): string => v == null ? '—' : `${Number(v.toFixed(2))}`;

const MIN_PEERS = 3;         // peers with data before a comparison is trustworthy
const MIN_PH_EXITS = 10;     // PH exits before a return rate is stable
const EVEN_BAND = 0.05;      // relative gap under which two values are "even"
const DQ_MOVEIN_HI = 15;     // % missing move-in dates that meaningfully skews housing speed
const DQ_DEST_HI = 15;       // % of exits missing a destination that undercuts the PH rate
const THIN_EXITS = 15;       // leaver count below which a rate is volatile
const DQ_LOW = 85;           // DQ score under which the whole benchmark needs a caveat

const PH_TYPES = new Set([3, 9, 10, 13]);            // move-in applies (PSH/PH/RRH)
const STAY_TYPES = new Set([0, 1, 2, 8]);            // ES / TH / Safe Haven — long stay can mean "stuck"
const PH_DEST: Record<string, string> = {
  '410': 'rental (no subsidy)', '411': 'owned (no subsidy)', '421': 'owned (with subsidy)',
  '422': 'staying with family (permanent)', '423': 'staying with friends (permanent)',
  '426': 'HOPWA permanent housing', '435': 'rental (with subsidy)',
};

// ── Types ─────────────────────────────────────────────────────────────────────

export type DiagMode = 'snapshot' | 'returns';
export type MetricStatus = 'ahead' | 'behind' | 'even' | 'na';
export type InsightKind = 'concern' | 'caveat' | 'strength';

export interface DiagInsight { kind: InsightKind; text: string; action?: string }

export interface Diagnosis {
  mode: DiagMode;
  peerType: string;
  peerN: number;
  headline: string;
  insights: DiagInsight[];
}

export interface DiagnosisInput {
  mode: DiagMode;
  typeName: string;
  projectType: number | null;
  selfProjectId: number;
  latest: Record<string, unknown> | null;   // current-period project_metrics OR returns_metrics row
  peers: Array<Record<string, unknown>>;    // same-type rows for the period (incl. self)
  survivalProject?: { median_days?: number | null; n?: number | null } | null;
  survivalType?: { median_days?: number | null } | null;
  dq?: Record<string, unknown> | null;      // dq_metrics.data (snapshot)
  dest?: Record<string, { exits?: number | null; returns?: number | null }> | null; // returns
}

// ── Small internal metric read (used to GATE insights, not to display a table) ─

interface Signal { value: number | null; peer: number | null; status: MetricStatus }

function statusOf(value: number | null, peer: number | null, higherBetter: boolean): MetricStatus {
  if (value == null || peer == null) return 'na';
  if (Math.abs(value - peer) / Math.max(Math.abs(peer), 1e-9) <= EVEN_BAND) return 'even';
  return (value > peer) === higherBetter ? 'ahead' : 'behind';
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function buildDiagnosis(input: DiagnosisInput): Diagnosis | null {
  const others = input.peers.filter((p) => Number(p['project_id']) !== input.selfProjectId);
  const peerN = new Set(others.map((p) => Number(p['project_id']))).size;
  const base = { peerType: input.typeName, peerN, mode: input.mode };
  return input.mode === 'returns'
    ? buildReturns(input, others, base)
    : buildSnapshot(input, others, base);
}

// ── Snapshot: housing speed × PH rate × LOS × data quality ────────────────────

function buildSnapshot(
  input: DiagnosisInput, others: Array<Record<string, unknown>>,
  base: { peerType: string; peerN: number; mode: DiagMode },
): Diagnosis | null {
  const { latest, survivalProject, survivalType, dq, projectType, typeName } = input;
  const peerMed = (key: string): number | null => {
    const vals = others.map((p) => num(p[key])).filter((v): v is number => v != null);
    return vals.length >= MIN_PEERS ? median(vals) : null;
  };

  const tth: Signal = {
    value: num(survivalProject?.median_days ?? null),
    peer: num(survivalType?.median_days ?? null),
    status: statusOf(num(survivalProject?.median_days ?? null), num(survivalType?.median_days ?? null), false),
  };
  const phVal = num(latest?.['ph_exit_rate'] ?? null), phPeer = peerMed('ph_exit_rate');
  const ph: Signal = { value: phVal, peer: phPeer, status: statusOf(phVal, phPeer, true) };
  const losVal = num(latest?.['avg_los'] ?? null), losPeer = peerMed('avg_los');
  const los: Signal = { value: losVal, peer: losPeer, status: 'na' }; // neutral: no good/bad direction

  // Nothing to say on a project with no computed outcome at all. (A survival
  // row with a null median still counts — that null is a real answer, rule 0.)
  if (tth.value == null && ph.value == null && survivalProject == null && los.value == null) return null;

  const leavers = num(latest?.['leavers'] ?? null);
  const dqScore = num(dq?.['DQ_Score'] ?? null);
  const dqMoveIn = num(dq?.['DQ_MoveIn_pct'] ?? null);
  const dqDest = num(dq?.['DQ_Dest_pct'] ?? null);
  const isPH = projectType != null && PH_TYPES.has(projectType);
  const isStay = projectType != null && STAY_TYPES.has(projectType);

  const insights: DiagInsight[] = [];

  // 0) The curve never crossed 50% — a REAL answer, not missing data. A
  //    survival row with n>=20 but null median means more than half the entry
  //    cohort had not reached housing within the two-year tracking window
  //    (see CLAUDE.md §11 — never collapse this into "n/a").
  if (survivalProject != null && survivalProject.median_days == null
      && num(survivalProject.n) != null && tth.peer != null) {
    insights.push({
      kind: 'concern',
      text: `More than half of the ${num(survivalProject.n)}-client entry cohort had not reached housing within the two-year tracking window — similar ${input.typeName} projects house half within ${d1(tth.peer)}d.`,
      action: 'The time-to-housing curve below shows how far the cohort got; the awaiting-move-in worklist on the Deep Dive lists who is still waiting.',
    });
  }

  // 1) Housing speed undermined by missing move-in dates (PH types) — the DQ
  //    caveat when it applies, otherwise a genuine-gap concern if behind.
  const moveInGap = isPH && dqMoveIn != null && dqMoveIn >= DQ_MOVEIN_HI;
  if (moveInGap && tth.value != null) {
    insights.push({
      kind: 'caveat',
      text: `Median time to housing reads ${d1(tth.value)}d${tth.status === 'behind' ? ` (slower than the ${d1(tth.peer)}d peer median)` : ''}, but ${p2(dqMoveIn)}% of move-in dates are missing — some of that gap is unrecorded move-ins, not real delay.`,
      action: 'Enter the missing move-in dates from the fix-list; the housing-speed number will sharpen as they land.',
    });
  } else if (tth.status === 'behind') {
    // The gap is real — move-in recording is clean (or not applicable).
    insights.push({
      kind: 'concern',
      text: `Clients wait longer to be housed than similar projects (${d1(tth.value)}d vs ${d1(tth.peer)}d)${isPH ? ', and move-in recording is clean, so the gap is real' : ''}.`,
      action: 'Projects that close this gap usually tighten the referral-to-move-in handoff.',
    });
  }
  // 2) PH rate resting on thin volume and/or incomplete destinations — the
  //    caveat when it applies, otherwise a genuine-gap concern if behind.
  const thin = leavers != null && leavers > 0 && leavers < THIN_EXITS;
  const destGap = dqDest != null && dqDest >= DQ_DEST_HI;
  if (ph.value != null && (thin || destGap)) {
    const parts: string[] = [];
    if (thin) parts.push(`on only ${leavers} leaver${leavers === 1 ? '' : 's'}, so a few cases move it a lot`);
    if (destGap) parts.push(`with ${p2(dqDest)}% of exits missing a destination`);
    insights.push({
      kind: 'caveat',
      text: `The ${p2(ph.value)}% permanent-housing exit rate rests ${parts.join(' and ')} — it is less certain than it looks.`,
      action: destGap ? 'Record the missing exit destinations first, then re-read the rate.' : undefined,
    });
  } else if (ph.status === 'behind') {
    insights.push({
      kind: 'concern',
      text: `Fewer clients exit to permanent housing than at similar projects (${p2(ph.value)}% vs ${p2(ph.peer)}%), and destination recording is clean, so the gap is real.`,
      action: 'Housing-focused case planning is the usual lever; the Deep Dive shows which clients are closest.',
    });
  }
  // 3) Long stay + low exit = clients may be stuck (ES/TH/SH only).
  if (isStay && los.value != null && losPeer != null && ph.status === 'behind'
      && los.value > losPeer * (1 + EVEN_BAND)) {
    insights.push({
      kind: 'concern',
      text: `Clients stay longer than similar projects (${d1(los.value)}d vs ${d1(losPeer)}d) yet fewer reach permanent housing (${p2(ph.value)}% vs ${p2(ph.peer)}%) — a sign they may be getting stuck rather than housed.`,
      action: 'The long-stay worklist on the Deep Dive lists the specific clients past the typical stay.',
    });
  }
  // 4) Data quality gates the whole benchmark.
  if (dqScore != null && dqScore < DQ_LOW) {
    insights.push({
      kind: 'caveat',
      text: `These comparisons rest on a data-quality score of ${d1(dqScore)}/100 for this project.`,
      action: 'Clear the data-quality fix-list first — the benchmark is only as good as the records behind it.',
    });
  }
  // 5) Strength — only if nothing above fired AND nothing is behind, so praise
  //    never masks a caveat or sits beside an open gap.
  if (insights.length === 0 && tth.status !== 'behind' && ph.status !== 'behind') {
    const wins: string[] = [];
    if (tth.status === 'ahead') wins.push(`housing clients faster than similar projects (${d1(tth.value)}d vs ${d1(tth.peer)}d)`);
    if (ph.status === 'ahead') wins.push(`at a higher permanent-housing exit rate (${p2(ph.value)}% vs ${p2(ph.peer)}%)`);
    if (wins.length) {
      insights.push({ kind: 'strength', text: `${cap(wins.join(', and '))} — a strong outcome profile.` });
    }
  }

  return { ...base, headline: snapshotHeadline(tth, ph, typeName, base.peerN), insights: insights.slice(0, 3) };
}

function snapshotHeadline(tth: Signal, ph: Signal, typeName: string, peerN: number): string {
  const judged = [tth, ph];
  const behind = judged.filter((s) => s.status === 'behind').length;
  const ahead = judged.filter((s) => s.status === 'ahead').length;
  if (behind === 0 && ahead > 0) return `Performing at or above similar ${typeName} projects on housing outcomes.`;
  if (behind === 1) return `Roughly on par with similar ${typeName} projects, with one outcome below peers.`;
  if (behind >= 2) return `Housing outcomes are below similar ${typeName} projects.`;
  return `Compared against ${peerN} similar ${typeName} project${peerN === 1 ? '' : 's'}.`;
}

// ── Returns: do THIS project's exits stick, and where do returns follow ───────

/** 2-year return rate at/above this is flagged red on the Returns tab
 *  (ret2Flagged in ProjectPanel) — reuse the app's own convention, don't invent one. */
const RET2_FLAG = 20;

function buildReturns(
  input: DiagnosisInput, others: Array<Record<string, unknown>>,
  base: { peerType: string; peerN: number; mode: DiagMode },
): Diagnosis | null {
  const { latest, dest, typeName } = input;
  const selfExits = num(latest?.['total_ph_exits'] ?? null) ?? 0;
  const value = selfExits >= MIN_PH_EXITS ? rate(num(latest?.['returns_2yr'] ?? null), selfExits) : null;
  const peerRates = others
    .filter((p) => (num(p['total_ph_exits']) ?? 0) >= MIN_PH_EXITS)
    .map((p) => rate(num(p['returns_2yr']), num(p['total_ph_exits'])))
    .filter((v): v is number => v != null);
  const peer = peerRates.length >= MIN_PEERS ? median(peerRates) : null;
  const status = statusOf(value, peer, false);

  if (value == null && peer == null && selfExits === 0) return null;

  // Which of THIS project's own exit destinations do the returns follow?
  let worst: { label: string; returns: number; exits: number } | null = null;
  for (const [code, dd] of Object.entries(dest ?? {})) {
    const r = dd.returns ?? 0;
    if (r > 0 && (!worst || r > worst.returns)) worst = { label: PH_DEST[code] ?? `destination ${code}`, returns: r, exits: dd.exits ?? 0 };
  }
  const destLine = worst ? ` Most returns followed exits to ${worst.label} (${worst.returns} of ${worst.exits}).` : '';
  const AFTERCARE = 'Returns track with less-stable destinations; strengthening aftercare follow-up and warm hand-offs to mainstream resources is the usual lever.';

  const insights: DiagInsight[] = [];
  let headline: string;

  if (value == null) {
    // THIS project has too few PH exits for a stable rate — say so precisely.
    headline = `Only ${selfExits} permanent-housing exit${selfExits === 1 ? '' : 's'} in this window — too few for a stable return rate.`;
  } else if (peer == null) {
    // The project's rate is solid; it's the PEER GROUP that is too small or
    // low-volume to form a fair median. Judge against the Returns tab's own
    // 20% flag threshold instead of pretending there is no reading at all.
    headline = value >= RET2_FLAG
      ? `${p2(value)}% of ${selfExits} exits returned within two years — above the ${RET2_FLAG}% level the Returns tab flags.`
      : `${p2(value)}% of ${selfExits} exits returned within two years — under the ${RET2_FLAG}% level the Returns tab flags.`;
    if (value >= RET2_FLAG) {
      insights.push({
        kind: 'concern',
        text: `Too few similar ${typeName} projects have enough exits for a fair peer median, but the rate is above the ${RET2_FLAG}% flag on its own.${destLine}`,
        action: AFTERCARE,
      });
    }
  } else if (status === 'behind') {
    headline = `A larger share of exits return to homelessness than at similar ${typeName} projects.`;
    insights.push({
      kind: 'concern',
      text: `${p2(value)}% of exits returned within two years, above the ${p2(peer)}% peer median.${destLine}`,
      action: AFTERCARE,
    });
  } else if (status === 'ahead') {
    headline = `Exits stick better than at similar ${typeName} projects — fewer clients return to homelessness.`;
    insights.push({ kind: 'strength', text: `${p2(value)}% returned within two years vs a ${p2(peer)}% peer median — exits are holding.` });
  } else {
    headline = `Returns are in line with similar ${typeName} projects.`;
  }

  return { ...base, headline, insights };
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
