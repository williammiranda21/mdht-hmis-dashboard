export type Granularity = 'monthly' | 'quarterly' | 'fiscal';

export interface ProjectMetric {
  period: string;
  granularity: Granularity;
  project_id: number;
  household_type: string;
  subpopulation: string;
  project_name: string | null;
  type_name: string | null;
  clients_served: number | null;
  leavers: number | null;
  exits_ph: number | null;
  ph_exit_rate: number | null;
  exits_unsub: number | null;
  unsub_rate: number | null;
  avg_los: number | null;
  is_partial: boolean;
  /** Full 34-column source record ({colName: value}) for the column picker / extra columns. */
  data: Record<string, number | string | null> | null;
}

export const HOUSEHOLD_OPTIONS = ['All', 'Adult Only', 'Adult with Children'] as const;

export const SUBPOPULATION_OPTIONS = [
  'All',
  'Chronic',
  'Disabled',
  'Elderly 65+',
  'Youth (18-24)',
  'Unaccompanied Youth',
  'Parenting Youth',
] as const;

export const GRANULARITY_LABEL: Record<Granularity, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  fiscal: 'Fiscal Year',
};

export interface DashboardFilters {
  period: string;
  granularity: Granularity;
  household: string;
  subpopulation: string;
}
