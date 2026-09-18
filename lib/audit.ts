// SERVER-SIDE ONLY — imported exclusively from server components and API
// routes. The service key is absent in the browser bundle, so `admin` would
// be null there anyway; never import this from a 'use client' module.
import { createClient } from '@supabase/supabase-js';

/**
 * Read/export audit trail (county-compliance gap #2, 2026-09-09).
 *
 * Server-side only: rows are written with the service role because the
 * access_log table grants NO insert to authenticated — a browser session must
 * not be able to forge (or suppress) audit entries. Callers pass the already-
 * verified viewer from getViewer(); this module never trusts request bodies
 * for identity.
 *
 * Fire-and-forget by contract: auditing must never break or slow the page
 * that triggered it, so every failure path swallows (the table missing before
 * supabase/access_log.sql runs included). Awaiting the returned promise is
 * still recommended in serverless routes so the write isn't killed mid-flight.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const admin = url && serviceKey
  ? createClient(url, serviceKey, { auth: { persistSession: false } })
  : null;

export type AuditAction =
  | 'bnl_view' | 'bnl_drawer' | 'bnl_export'
  | 'fixlist_view' | 'fixlist_export'
  | 'outliers_view' | 'outliers_export'
  | 'risklist_view' | 'risklist_export';

export async function audit(
  action: AuditAction,
  viewer: { id: string; email: string | null } | null,
  detail?: Record<string, unknown>,
): Promise<void> {
  if (!admin) return;
  try {
    await admin.from('access_log').insert({
      action,
      user_id: viewer?.id ?? null,
      user_email: viewer?.email ?? null,
      detail: detail ?? null,
    });
  } catch { /* auditing never breaks the request */ }
}
