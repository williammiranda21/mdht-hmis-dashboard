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

/** All monthly SPM records at household 'All' / subpop 'All', keyed by period.
 *  Drives the 12-month average line and prior-period deltas on the SPM cards.
 *  (~371 rows — safely under PostgREST's 1000-row cap.) */
export async function getSystemMonthlyAllSeries(): Promise<Record<string, SystemRecord>> {
  const { data, error } = await supabaseServer()
    .from('system_metrics')
    .select('period, data')
    .eq('granularity', 'monthly')
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

export interface UtilHH { c: number; o: number; u: number; p: number; pu: number; bt?: [string, number, number, number][] }
export interface UtilProject { n: string; t: string; k: string; cap: number; occ: number; util: number; pit: number; putil: number }
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
