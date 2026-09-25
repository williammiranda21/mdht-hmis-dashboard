// Every query uses the request-scoped, session-carrying client so that RLS sees
// auth.uid() and scopes rows to the signed-in user's agency. Do NOT swap this
// back to the module-level anon client — it has no session and returns nothing
// once the policies are `to authenticated`.
import { supabaseServer } from './supabase-server';
import type { Granularity, ProjectMetric } from './types';

const META_PERIOD_KEY: Record<Granularity, string> = {
  monthly: 'periods',
  quarterly: 'qtr_periods',
  fiscal: 'fy_periods',
};

/**
 * Distinct periods for a granularity, newest first (drives the period picker).
 * Reads the authoritative list the pipeline stored in `meta` (stored oldest→newest).
 * NOTE: do NOT derive this from `select('period')` on project_metrics — PostgREST
 * caps responses at 1000 rows, so over 214k rows that yields an arbitrary slice.
 */
export async function getPeriods(granularity: Granularity): Promise<string[]> {
  const { data, error } = await supabaseServer()
    .from('meta')
    .select('value')
    .eq('key', META_PERIOD_KEY[granularity])
    .maybeSingle();
  if (error) throw error;
  const list = (data?.value as string[] | null) ?? [];
  return [...list].reverse();
}

export interface ProjectInfo {
  project_id: number;
  name: string | null;
  type_name: string | null;
  project_type: number | null;
}

/** All projects keyed by id (name/type lookup for tabs that store only project_id). */
export async function getProjectsMap(): Promise<Record<number, ProjectInfo>> {
  const { data, error } = await supabaseServer()
    .from('projects')
    .select('project_id, name, type_name, project_type');
  if (error) throw error;
  const out: Record<number, ProjectInfo> = {};
  (data ?? []).forEach((p: any) => { out[p.project_id as number] = p as ProjectInfo; });
  return out;
}

/** System inflow + capacity forecast (Deep Dive Phase 3). Two keyed rows from
 *  `system_forecast`; the payloads are computed in generate_analytics.py and are
 *  system-level (not agency-scoped). Returns nulls when the table is unpopulated
 *  so the page can show an empty state rather than throwing. */
export interface SystemForecast {
  generated: string | null;
  inflow: Record<string, unknown> | null;
  capacity: unknown[] | null;
}
export async function getSystemForecast(): Promise<SystemForecast> {
  const { data, error } = await supabaseServer()
    .from('system_forecast')
    .select('key, value, generated');
  if (error) throw error;
  const byKey = new Map((data ?? []).map((r: any) => [r.key as string, r]));
  const inflowRow = byKey.get('inflow');
  const capacityRow = byKey.get('capacity');
  return {
    generated: (inflowRow?.generated ?? capacityRow?.generated ?? null) as string | null,
    inflow: (inflowRow?.value as Record<string, unknown> | undefined) ?? null,
    capacity: (capacityRow?.value as unknown[] | undefined) ?? null,
  };
}

/** Analytics tab payload (meta.analytics_insights — user 2026-09-18 port of
 *  the static analytics page, v2 = full 5-section parity). AGGREGATE-ONLY:
 *  the loader strips per-client risk scores (parked Housing Predictor), and
 *  long-stay outlier clients live in drill_clients (`an:outlier`, agency-
 *  scoped) — meta carries only their aggregate. Null until the meta key loads. */
export interface TrendSeries {
  values: (number | null)[];
  label?: string;
  color?: string;
  slope_pm?: number;
  direction?: 'up' | 'down';
  // Linear fit over the last 18 months + 6-month projection with 95% CI —
  // the projection chart's dashed line and shaded band.
  fit?: (number | null)[];
  proj_labels?: string[];
  proj?: number[];
  proj_lower?: number[];
  proj_upper?: number[];
}
export interface SurvivalTypeCurves {
  label: string; color: string;
  n: number; n_exited: number; n_ph_exit: number;
  median_los: number | null; median_ph_los: number | null;
  // KM step curves, x = days since enrollment (0–730), y = P(still enrolled).
  curve_any: { x: number; y: number }[];
  curve_ph: { x: number; y: number }[];
}
export interface AnalyticsInsights {
  generated: string | null;
  risk: {
    model: {
      auc: number; accuracy: number; train_n: number; train_pos_rate: number;
      score_n: number; features: string[]; importances: number[];
      // Signed normalized coefficients (z-scored feature space): positive
      // raises return risk, negative protective. Absent on payloads built
      // before 2026-09-18 — `importances` alone are |w|, direction-less.
      importances_signed?: number[];
      model_source?: string;
      // Per-horizon head quality (6mo/12mo/24mo) — absent pre-2026-09-18.
      horizons_meta?: Record<string, { auc: number; n_trained: number; pos_rate: number }> | null;
      // Model scoring parameters — the return-risk dossier computes personal
      // factor contributions and exit-package what-ifs from these + a
      // client's feature vector. Aggregate model params, no PII.
      scoring?: {
        feat_cols: string[]; weights: number[]; bias: number;
        feat_mean: number[]; feat_std: number[];
        horizons: Record<string, { weights: number[]; bias: number; feat_mean: number[]; feat_std: number[] }>;
      } | null;
    } | null;
    histogram: { labels: string[]; counts: number[] } | null;
    by_type: { type: number; label: string; color: string; avg_risk: number; n: number }[] | null;
    buckets: Record<string, number> | null;
    // Exit-package scenarios: the same "average leaver" scored through
    // different landings, recomputed from the live model each refresh.
    scenarios?: { baseline: number; rows: { group: string; label: string; pct: number }[] } | null;
    computed: boolean;
  };
  trend: {
    periods: string[];
    system: Record<string, TrendSeries | null>;
    by_type: Record<string, {
      label: string; color: string;
      ph_rate: TrendSeries | null; avg_los: TrendSeries | null;
    }>;
  };
  // Absent on payloads loaded before the v2 pipeline change.
  survival?: {
    types: Record<string, SurvivalTypeCurves>;
    table: {
      type: number; label: string; color: string; n: number;
      median: number | null; median_ph: number | null;
      exit_rate: number; ph_rate: number;
    }[];
    outliers_agg: { total: number; by_type: Record<string, number> };
  };
}
export async function getAnalyticsInsights(): Promise<AnalyticsInsights | null> {
  const { data, error } = await supabaseServer()
    .from('meta').select('value').eq('key', 'analytics_insights').maybeSingle();
  if (error) throw error;
  return (data?.value as AnalyticsInsights | undefined) ?? null;
}

/** Pathway Intelligence (meta.pathway_intel — user 2026-09-18 port of the
 *  static pathways page's four system tabs). AGGREGATE-ONLY: the scored
 *  active-client list lives in drill_clients `an:predict` (agency-scoped),
 *  served by /api/analytics/predictor — predictor_ml here carries the model
 *  and profile buckets only. Null until the meta key loads. */
export interface SankeyNode { id: string; label: string; color: string; n: number; ph_pct: number | null }
export interface SankeyLink { source: string; target: string; value: number }
export interface PathRow { path: string; n: number; median_days: number | null; avg_days: number | null }
export interface SankeyData {
  nodes: SankeyNode[];
  links: SankeyLink[];
  top_paths: { all: PathRow[]; housed: PathRow[]; churned: PathRow[] };
  source_rates: Record<string, { total: number; ph: number; ph_pct: number }>;
}
export interface BottleneckState {
  label: string; color: string; n: number; n_ph: number; n_active: number; n_churned: number;
  ph_rate: number; ph_rate_exits: number; ph_12mo: number; ph_delta: number | null;
  ph_trend: (number | null)[]; active_rate: number; churn_rate: number;
  median_los: number; cycling_pct: number;
  cycling_dist: { once: number; few: number; many: number };
  next_steps: { to: string; n: number; pct: number }[];
  incoming_steps: { from: string; n: number; pct: number }[];
  exit_tiers: {
    homeless: { n: number; pct: number }; inst: { n: number; pct: number };
    temp: { n: number; pct: number }; unknown: { n: number; pct: number };
    n_total: number;
  } | null;
  opportunity: { opp_5pp: number; opp_10pp: number; annual_exits: number };
}
export interface PathwayIntel {
  generated: string | null;
  sankey: SankeyData;
  sankey_filters: Record<string, SankeyData>;
  period_defs: { key: string; label: string }[];
  hh_defs: { key: string; label: string }[];
  bottleneck: Record<string, BottleneckState>;
  predictor: Record<string, {
    label: string; color: string;
    buckets: { label: string; n: number; too_few?: boolean; ph_rate?: number; n_ph?: number; n_churn?: number }[];
  }>;
  predictor_ml: {
    weights: number[]; feature_names: string[]; n_features: number;
    accuracy: number; n_trained: number; model_label: string;
    profile_buckets: Record<string, { n: number; ph_rate: number; median_los_housed: number }>;
    n_active: number;
    /** v2 all-factors model (2026-09-25): labels/tips for inputs past the original 14 */
    version?: number; feature_labels?: Record<string, string>; feature_tips?: Record<string, string>;
    holdout?: { split: string; n_test: number; auc_original: number; auc_original_newton: number; auc_all_factors: number } | null;
  } | null;
  markov: {
    states: string[]; colors: string[]; labels: string[];
    P: number[][];
    P_display: { state: string; label: string; color: string; probs: number[] }[];
    active_dist: number[]; active_counts: number[];
    baseline_sim: { housed: number; churned: number }[];
    sliders: {
      from_state: string; to_state: string; label: string; color: string;
      row: number; col: number; baseline: number;
    }[];
  } | null;
}
export async function getPathwayIntel(): Promise<PathwayIntel | null> {
  const { data, error } = await supabaseServer()
    .from('meta').select('value').eq('key', 'pathway_intel').maybeSingle();
  if (error) throw error;
  return (data?.value as PathwayIntel | undefined) ?? null;
}

/** Intervention Guide (meta.intervention_intel, 2026-09-25) — AGGREGATE-ONLY:
 *  model card, backtest, equity audit, pathway table. Per-client estimates are
 *  drill_clients `an:ivx` (agency-scoped) served by /api/analytics/intervention. */
export interface IvxDriver { feat: string; label: string; w: number }
export interface IvxPathway {
  path: string; n: number; steps: number; success: number; expected: number; adjusted: number;
  adj_ci: [number, number]; housed: number; returned_of_housed: number | null;
  median_days_to_housed: number | null; family_share: number; ends_in: string;
}
export interface InterventionIntel {
  generated: string; as_of: string;
  summary: { n_active: number; verdicts: Record<string, number>; best_mix: Record<string, number>; mean_p: number | null };
  model: {
    version: number; generated: string; data_through: string; train_from: string; train_to: string; n_train: number;
    arms: string[]; programs: string[]; arm_labels: Record<string, string>;
    features: string[]; feature_labels: Record<string, string>; overlap: number;
    definitions: Record<string, number>;
    arm_stats: Record<string, { n: number; success: number; housed: number; returned_of_housed: number; median_days_to_housed: number | null }>;
    effects: { a: string; b: string; effect: number; ci: [number, number]; n_overlap: number }[];
    backtest: {
      split: string; n_train: number; n_test: number; n_test_programs: number;
      auc: Record<string, { success: number; housed: number; stable: number; n: number }>;
      propensity_auc: Record<string, number>;
      calibration: Record<string, { pred: number; obs: number; n: number }[]>;
      observed_success: number; policy_value: number; lift: number; lift_ci: [number, number];
      reassigned_share: number; mix: Record<string, number>;
      rrh_psh_only?: { n: number; observed: number; policy_value: number; lift: number; lift_ci: [number, number]; reassigned_share: number };
      spdat_eval?: {
        n_train_with_spdat: number; n_test_with_spdat: number; share_all_with_spdat: number;
        auc_with: number | null; auc_without: number | null; auc_all_with: number; auc_all_without: number;
        cv?: { era_from: string; n_era: number; n_with_spdat: number; success_auc_with: number; success_auc_without: number;
          psh_assign_auc_with: number; psh_assign_auc_without: number; n_program_with_spdat: number };
      };
    };
    equity: { group: string; n: number; observed: number; predicted: number; auc: number; n_programs: number;
      psh_share_actual: number | null; psh_share_model: number | null; lift: number | null }[];
    drivers: Record<string, IvxDriver[]>;
    modifiers: Record<string, IvxDriver[]>;
    pathways: IvxPathway[];
    fmr: Record<string, number[]>; fmr_note: Record<string, string>;
  };
}
export async function getInterventionIntel(): Promise<InterventionIntel | null> {
  const { data, error } = await supabaseServer()
    .from('meta').select('value').eq('key', 'intervention_intel').maybeSingle();
  if (error) throw error;
  return (data?.value as InterventionIntel | undefined) ?? null;
}

/** Periods that actually have Data Quality data, newest first (from meta.dq_periods). */
export async function getDqPeriods(granularity: Granularity): Promise<string[]> {
  const { data, error } = await supabaseServer()
    .from('meta').select('value').eq('key', 'dq_periods').maybeSingle();
  if (error) throw error;
  const lists = (data?.value as Record<string, string[]> | null) ?? {};
  return [...(lists[granularity] ?? [])].reverse();
}

export interface DqRow {
  project_id: number;
  data: Record<string, number | null>;
}

/** Data Quality (APR Q6) rows for one period. */
export async function getDqMetrics(granularity: Granularity, period: string): Promise<DqRow[]> {
  const { data, error } = await supabaseServer()
    .from('dq_metrics')
    .select('project_id, data')
    .eq('granularity', granularity)
    .eq('period', period);
  if (error) throw error;
  return (data ?? []) as DqRow[];
}

/** Project rows for one period + filter combination. */
export async function getProjectMetrics(
  granularity: Granularity,
  period: string,
  household = 'All',
  subpopulation = 'All',
): Promise<ProjectMetric[]> {
  const { data, error } = await supabaseServer()
    .from('project_metrics')
    .select('*')
    .eq('granularity', granularity)
    .eq('period', period)
    .eq('household_type', household)
    .eq('subpopulation', subpopulation)
    .order('clients_served', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ProjectMetric[];
}

export interface SystemRecord {
  [k: string]: number | null;
}

/** Periods that actually have SPM data for a granularity, newest first.
 *  (System metrics stop at the last COMPLETE period — e.g. the partial current
 *  month exists in project_metrics but not in system_metrics.) */
export async function getSystemPeriods(granularity: Granularity): Promise<string[]> {
  const { data, error } = await supabaseServer()
    .from('system_metrics')
    .select('period')
    .eq('granularity', granularity)
    .eq('household_type', 'All')
    .eq('subpopulation', 'All');
  if (error) throw error;
  const set = Array.from(new Set((data ?? []).map((r) => r.period as string)));
  return set.sort().reverse();
}

/** System Performance (SPM) record for a period/filter (jsonb). */
export async function getSystemMetrics(
  granularity: Granularity,
  period: string,
  household = 'All',
  subpopulation = 'All',
): Promise<SystemRecord | null> {
  const { data, error } = await supabaseServer()
    .from('system_metrics')
    .select('data')
    .eq('granularity', granularity)
    .eq('period', period)
    .eq('household_type', household)
    .eq('subpopulation', subpopulation)
    .maybeSingle();
  if (error) throw error;
  return (data?.data as SystemRecord) ?? null;
}

/** All|All SPM records for ONE granularity, keyed by period — the avg-tick
 *  series on the SPM cards. Same-granularity ON PURPOSE (user 2026-09-09):
 *  the tick used to come from the monthly series at every granularity, so a
 *  fiscal-year headline sat next to a typical-month tick and every FY card
 *  looked ~10x above average. (~60 monthly / ~20 quarterly / ~6 fiscal rows
 *  — safely under PostgREST's 1000-row cap.) */
export async function getSystemAllSeries(granularity: Granularity): Promise<Record<string, SystemRecord>> {
  const { data, error } = await supabaseServer()
    .from('system_metrics')
    .select('period, data')
    .eq('granularity', granularity)
    .eq('household_type', 'All')
    .eq('subpopulation', 'All');
  if (error) throw error;
  const out: Record<string, SystemRecord> = {};
  (data ?? []).forEach((r: any) => {
    out[r.period as string] = r.data as SystemRecord;
  });
  return out;
}

export interface SystemCombo {
  household_type: string;
  subpopulation: string;
  data: SystemRecord;
}

/** Every household×subpopulation SPM record for one period (drives the heatmap). */
export async function getSystemPeriodCombos(
  granularity: Granularity,
  period: string,
): Promise<SystemCombo[]> {
  const { data, error } = await supabaseServer()
    .from('system_metrics')
    .select('household_type, subpopulation, data')
    .eq('granularity', granularity)
    .eq('period', period);
  if (error) throw error;
  return (data ?? []) as SystemCombo[];
}

export interface ReturnsBucket {
  exits: number;
  lt6: number;
  r6: number;
  r13: number;
  r2: number;
}

/** System returns (M2) aggregated by period+subpopulation at household 'All'
 *  (precomputed by the pipeline into meta.sys_returns). */
export async function getSystemReturns(): Promise<Record<string, Record<string, ReturnsBucket>>> {
  const { data, error } = await supabaseServer()
    .from('meta')
    .select('value')
    .eq('key', 'sys_returns')
    .maybeSingle();
  if (error) throw error;
  return (data?.value as Record<string, Record<string, ReturnsBucket>>) ?? {};
}

/** Periods that have Returns (M2) data, newest first (from meta.ret_periods). */
export async function getReturnsPeriods(granularity: Granularity): Promise<string[]> {
  const { data, error } = await supabaseServer()
    .from('meta').select('value').eq('key', 'ret_periods').maybeSingle();
  if (error) throw error;
  const lists = (data?.value as Record<string, string[]> | null) ?? {};
  return [...(lists[granularity] ?? [])].reverse();
}

export interface ReturnsRow {
  project_id: number;
  total_ph_exits: number | null;
  returns_lt6mo: number | null;
  returns_6to12mo: number | null;
  returns_13to24mo: number | null;
  returns_2yr: number | null;
}

/** Per-project Returns (M2) rows for one period + filter (rates derived = band ÷ exits). */
export async function getReturnsMetrics(
  granularity: Granularity,
  period: string,
  household = 'All',
  subpopulation = 'All',
): Promise<ReturnsRow[]> {
  const { data, error } = await supabaseServer()
    .from('returns_metrics')
    .select('project_id, total_ph_exits, returns_lt6mo, returns_6to12mo, returns_13to24mo, returns_2yr')
    .eq('granularity', granularity)
    .eq('period', period)
    .eq('household_type', household)
    .eq('subpopulation', subpopulation);
  if (error) throw error;
  return (data ?? []) as ReturnsRow[];
}

export interface ReturnsByDestRow {
  project_id: number;
  data: Record<string, { exits: number; returns: number }>;
}

/** Returns-by-prior-exit-destination rows for one period + filter (per project; aggregate client-side). */
export async function getReturnsByDest(
  period: string,
  household = 'All',
  subpopulation = 'All',
): Promise<ReturnsByDestRow[]> {
  const { data, error } = await supabaseServer()
    .from('returns_by_dest')
    .select('project_id, data')
    .eq('period', period)
    .eq('household_type', household)
    .eq('subpopulation', subpopulation);
  if (error) throw error;
  return (data ?? []) as ReturnsByDestRow[];
}

/** Periods that have Unit Utilization data, newest first (from meta.util_periods). */
export async function getUtilPeriods(granularity: Granularity): Promise<string[]> {
  const { data, error } = await supabaseServer()
    .from('meta').select('value').eq('key', 'util_periods').maybeSingle();
  if (error) throw error;
  const lists = (data?.value as Record<string, string[]> | null) ?? {};
  return [...(lists[granularity] ?? [])].reverse();
}

export interface UtilHH {
  c: number; o: number; u: number; p: number; pu: number; bt?: [string, number, number, number][];
  /** unit block only: RRH households enrolled but awaiting move-in (see UtilProject.aw). */
  aw?: number;
}
export interface UtilProject {
  n: string; t: string; k: string; cap: number; occ: number; util: number; pit: number; putil: number;
  /** RRH only: enrolled households still awaiting move-in. RRH capacity is
   *  dynamic (moved-in households, per HUD) so util pegs ~100% — this is the signal. */
  aw?: number;
  /** Dynamic-capacity project (RRH or hotel/motel): inventory = people actually
   *  housed/sheltered, so utilization is pegged at 100% by definition. */
  dyn?: boolean;
}
export interface UtilRecord {
  hh: Record<string, UtilHH>;
  unit: UtilHH;
  empty: number;
  over: number;
  under: number;
  projects: UtilProject[];
}

/** Unit utilization payload for a period. */
export async function getUtilization(period: string): Promise<UtilRecord | null> {
  const { data, error } = await supabaseServer()
    .from('util_metrics')
    .select('data')
    .eq('period', period)
    .maybeSingle();
  if (error) throw error;
  return (data?.data as UtilRecord) ?? null;
}
