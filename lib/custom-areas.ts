import { supabaseBrowser } from './supabase-browser';
import type { Geometry } from './slippy';

/** Admin-drawn routing polygon (supabase/custom_areas.sql). The NAME is the
 *  zone string: the intake pin stamps it as the case area (checked before
 *  districts/municipalities) and outreach_teams.zones matches it verbatim. */
export interface CustomArea {
  id: number;
  name: string;
  polygon: Geometry;
  active: boolean;
}

let _cache: CustomArea[] | undefined;

/** Active custom areas, fetched once per session through the caller's own
 *  RLS-scoped browser session. Missing table (custom_areas.sql not run) or
 *  any error → empty list; every consumer degrades to no-custom-areas. */
export async function fetchCustomAreas(force = false): Promise<CustomArea[]> {
  if (!force && _cache !== undefined) return _cache;
  try {
    const { data, error } = await supabaseBrowser()
      .from('custom_areas')
      .select('id, name, polygon, active')
      .eq('active', true)
      .order('name');
    _cache = error ? [] : ((data ?? []) as CustomArea[]);
  } catch {
    _cache = [];
  }
  return _cache;
}

/** Call after an insert/delete so the next fetch sees the change. */
export function invalidateCustomAreas() {
  _cache = undefined;
}
