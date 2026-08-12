import { NextResponse } from 'next/server';
import { createHash } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { supabaseServer, getViewer } from '../../../../lib/supabase-server';
import { deidentifyCase, type CaseInput } from '../../../../lib/ai/deidentify';

export const dynamic = 'force-dynamic';
// A generate call includes one Claude round-trip (adaptive thinking) — give it
// room beyond the platform's 10s default.
export const maxDuration = 60;

/**
 * AI Layer-2 pilot: per-client case summary + next-step extraction.
 *
 * POST { pid }                    → cache lookup only (never calls the API):
 *                                   returns the stored summary and whether the
 *                                   thread has changed since it was written.
 * POST { pid, generate: true }    → de-identify (lib/ai/deidentify) → Claude →
 *                                   upsert cache → return fresh result.
 * POST { pid, preview: true }     → ADMIN: return the exact de-identified
 *                                   payload that would be sent, WITHOUT calling
 *                                   the API — the "what leaves the building"
 *                                   audit view.
 *
 * Design rules (agreed 2026-08-12): de-identified real data only — scrubbing
 * happens server-side in deterministic code before any API call; AI PROPOSES,
 * HUMAN CONFIRMS — extracted steps are returned as suggestions and only become
 * cohort_tasks through the normal add_task path when a person clicks; every
 * summary is labeled generated in the UI. All reads run through the caller's
 * session client, so bnl_clients/bnl_notes RLS decides what exists — a viewer
 * without BNL access gets a 404 here, same as everywhere else.
 */

const MODEL = 'claude-opus-5';

const SYSTEM = `You are a case-summary assistant inside an HMIS (Homeless Management Information System) dashboard used by a county coordinated-entry team. Each request carries de-identified data for ONE person experiencing homelessness: coordinated-entry journey dates, case notes written over time by staff, and a staffing checklist of "next steps". All names and identifiers were removed before sending; refer to the person only as "the client".

Audience: a case manager preparing for a cohort staffing meeting. Two outputs:

summary — a tight narrative (under 120 words, plain prose, no headers or preamble) of the case since the first note: what has been accomplished, what is blocking housing, and where the case stands right now (use the journey data for the current wait). State only what the notes and data support; if activity is thin or the case has gone quiet, say so plainly — never pad or invent.

proposals — 0 to 4 concrete NEW next steps, each grounded in a specific note (source_date = that note's date, YYYY-MM-DD, or null). Match the terse imperative style of the existing next-step items. Never repeat or rephrase a step that is already open, and never propose something the completed steps show is done. An empty array is the correct answer when the notes surface nothing actionable.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Narrative case summary, under 120 words, plain prose.' },
    proposals: {
      type: 'array',
      description: 'At most 4 NEW next-step suggestions grounded in the notes; empty when nothing actionable.',
      items: {
        type: 'object',
        properties: {
          body: { type: 'string', description: 'Terse imperative next step, like the existing items.' },
          rationale: { type: 'string', description: 'One sentence: which note/fact motivates this.' },
          source_date: { type: ['string', 'null'], description: 'Date (YYYY-MM-DD) of the motivating note, or null.' },
        },
        required: ['body', 'rationale', 'source_date'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'proposals'],
  additionalProperties: false,
};

interface AiOut {
  summary: string;
  proposals: { body: string; rationale: string; source_date: string | null }[];
}

export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  let body: { pid?: string; generate?: boolean; preview?: boolean };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const pid = String(body.pid ?? '').trim();
  if (!pid) return NextResponse.json({ error: 'pid required' }, { status: 400 });

  const sb = supabaseServer();

  const [cRes, nRes, tRes] = await Promise.all([
    sb.from('bnl_clients')
      .select('pid, name, age, status, ptype, enrolled, days_homeless, chronic, returned, risk_band, milestones, ms_stage, ms_wait, hh_members')
      .eq('pid', pid).maybeSingle(),
    sb.from('bnl_notes')
      .select('id, body, author_name, author_email, created_at')
      .eq('pid', pid).order('created_at', { ascending: true }).limit(400),
    sb.from('cohort_tasks')
      .select('id, body, status, created_at, done_at, created_by, done_by, assignees')
      .eq('pid', pid).order('created_at', { ascending: true }),
  ]);
  if (cRes.error) return NextResponse.json({ error: cRes.error.message }, { status: 500 });
  if (!cRes.data) return NextResponse.json({ error: 'client not found (or no BNL access)' }, { status: 404 });
  const notes = nRes.error ? [] : (nRes.data ?? []);
  const tasks = tRes.error ? [] : (tRes.data ?? []);   // table may not exist yet — degrade

  if (!notes.length && !tasks.length) {
    return NextResponse.json(
      { error: 'Nothing to summarize yet — this client has no notes or next steps.' },
      { status: 422 });
  }

  // Regenerate ONLY when the thread actually changed. Notes are append-only
  // (bnl_notes has no update/delete policy), so ids alone identify them; tasks
  // can toggle, so their state participates; journey state rides along so a
  // new milestone also invalidates.
  const inputHash = createHash('sha256').update(JSON.stringify({
    n: notes.map((x) => x.id),
    t: tasks.map((x) => [x.id, x.status, x.body, x.done_at]),
    c: [cRes.data.status, cRes.data.ms_stage, cRes.data.ms_wait, cRes.data.milestones],
  })).digest('hex');

  // Cache read — degrades to cacheOk:false if ai_summaries.sql hasn't been run.
  let cacheOk = true;
  let cached: { summary: string; proposals: unknown; input_hash: string; model: string; created_at: string } | null = null;
  {
    const r = await sb.from('ai_summaries')
      .select('summary, proposals, input_hash, model, created_at')
      .eq('pid', pid).maybeSingle();
    if (r.error) cacheOk = false;
    else cached = r.data;
  }

  const { payload, report } = deidentifyCase({
    client: cRes.data,
    notes,
    tasks,
  } as CaseInput);

  if (body.preview) {
    if (!viewer.isAdmin) return NextResponse.json({ error: 'admin only' }, { status: 403 });
    return NextResponse.json({ payload, report });
  }

  if (cached && cached.input_hash === inputHash) {
    return NextResponse.json({
      summary: cached.summary, proposals: cached.proposals ?? [],
      model: cached.model, created_at: cached.created_at,
      current: true, cached: true, cacheOk, deid: report,
    });
  }
  if (!body.generate) {
    // Lookup only — report the stale cache (if any) and stop. No API call.
    return NextResponse.json(cached
      ? {
          summary: cached.summary, proposals: cached.proposals ?? [],
          model: cached.model, created_at: cached.created_at,
          current: false, cached: true, cacheOk, deid: report,
        }
      : { summary: null, proposals: [], current: false, cached: false, cacheOk });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }, { status: 500 });
  }

  const anthropic = new Anthropic({ apiKey });
  let resp: Anthropic.Message;
  try {
    resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 16000,   // hard cap on thinking + response together (thinking is on by default on Opus 5)
      system: SYSTEM,
      output_config: {
        effort: 'medium',  // summarization/extraction — high is overkill, low under-reads long threads
        format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
      },
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    });
  } catch (e) {
    const msg = e instanceof Anthropic.APIError
      ? `Claude API error (${e.status}): ${e.message}`
      : 'Could not reach the Claude API.';
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  if (resp.stop_reason === 'refusal') {
    return NextResponse.json(
      { error: 'The model declined this request (safety classifier). Nothing was generated — read the thread directly.' },
      { status: 502 });
  }
  const text = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
  if (resp.stop_reason !== 'end_turn' || !text) {
    return NextResponse.json(
      { error: `Generation did not complete (stop_reason: ${resp.stop_reason}).` },
      { status: 502 });
  }
  let out: AiOut;
  try { out = JSON.parse(text) as AiOut; } catch {
    return NextResponse.json({ error: 'Model returned unparseable output.' }, { status: 502 });
  }

  const nowIso = new Date().toISOString();
  if (cacheOk) {
    const u = await sb.from('ai_summaries').upsert({
      pid, summary: out.summary, proposals: out.proposals ?? [],
      input_hash: inputHash, model: MODEL,
      created_by: viewer.email ?? null, created_at: nowIso,
    }, { onConflict: 'pid' });
    if (u.error) cacheOk = false;
  }

  return NextResponse.json({
    summary: out.summary, proposals: out.proposals ?? [],
    model: MODEL, created_at: nowIso,
    current: true, cached: false, cacheOk, deid: report,
    usage: { input: resp.usage.input_tokens, output: resp.usage.output_tokens },
  });
}
