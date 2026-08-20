import { supabaseBrowser } from './supabase-browser';
import { DEFAULT_RULES, type PriorityRules } from './helpline-options';

/** Fetch the admin-tuned priority rules (helpline_priority.sql, single row),
 *  merged over DEFAULT_RULES so partial edits and a missing table both
 *  degrade to the original behavior. Cached per session. */
let _cache: PriorityRules | undefined;

export async function fetchPriorityRules(force = false): Promise<PriorityRules> {
  if (!force && _cache !== undefined) return _cache;
  try {
    const { data, error } = await supabaseBrowser()
      .from('helpline_priority')
      .select('weights, bands, aging, sla_hours, emergency')
      .eq('id', 1)
      .maybeSingle();
    if (error || !data) {
      _cache = DEFAULT_RULES;
    } else {
      const w = (data.weights ?? {}) as Record<string, any>;
      _cache = {
        factors: { ...DEFAULT_RULES.factors, ...(w.factors ?? {}) },
        household: { ...DEFAULT_RULES.household, ...(w.household ?? {}) },
        sleeping: { ...DEFAULT_RULES.sleeping, ...(w.sleeping ?? {}) },
        bands: { ...DEFAULT_RULES.bands, ...((data.bands ?? {}) as object) },
        aging: { ...DEFAULT_RULES.aging, ...((data.aging ?? {}) as object) },
        repeatCall: Number(w.repeat_call ?? DEFAULT_RULES.repeatCall) || 0,
        hmisChronic: Number(w.hmis_chronic ?? DEFAULT_RULES.hmisChronic) || 0,
        slaHours: data.sla_hours === null ? null : Number(data.sla_hours),
        emergency: { ...DEFAULT_RULES.emergency, ...((data.emergency ?? {}) as object) },
      };
    }
  } catch {
    _cache = DEFAULT_RULES;
  }
  return _cache;
}

export function invalidatePriorityRules() {
  _cache = undefined;
}
