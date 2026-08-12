/**
 * De-identification layer for the AI Layer-2 pilot (2026-08-12).
 *
 * Contract: EVERY payload bound for the Claude API passes through here first.
 * What leaves the server: the hashed pid (the same pseudonym the whole
 * dashboard runs on — the ONLY identifier sent, per the data owner's policy),
 * journey dates, and scrubbed note / next-step text. What never leaves: the
 * client's name, household members' names, staff names/emails, and anything
 * matching the SSN / phone / email / DOB patterns below.
 *
 * Scrubbing is deterministic code, not a model — the de-identifier of record
 * must be auditable line by line, and PII must never be sent to an external
 * service "to be de-identified".
 *
 * KNOWN RESIDUAL (accepted by the data owner, 2026-08-12): a rule-based scrub
 * cannot catch third-party names that exist only inside free text (e.g. "her
 * cousin Maria said…"). We scrub every name we KNOW — the roster name, the
 * household members, and the staff snapshots on notes/tasks — plus the
 * patterns; names we hold no record of pass through.
 */

export interface CaseInput {
  client: {
    pid: string;
    name: string | null;
    age: number | null;
    status: string;
    ptype: string | null;
    enrolled: boolean | null;
    days_homeless: number | null;
    chronic: boolean | null;
    returned: boolean | null;
    risk_band: string | null;
    milestones: Record<string, string | null> | null;
    ms_stage: string | null;
    ms_wait: number | null;
    hh_members: { pid: string; name: string; age: number | null; hoh: boolean }[] | null;
  };
  notes: { body: string; author_name: string | null; author_email: string | null; created_at: string }[];
  tasks: {
    body: string; status: string; created_at: string; done_at: string | null;
    created_by: string | null; done_by: string | null;
    assignees: { name: string | null }[] | null;
  }[];
}

/** Replacement counts — surfaced in the UI so a human can sanity-check the
 *  scrub did something plausible ("2 names, 1 phone removed"). */
export interface DeidReport {
  client_name: number;
  household_names: number;
  staff_names: number;
  ssn: number;
  phone: number;
  email: number;
  dob: number;
}

export interface DeidPayload {
  client: {
    pid: string;
    age: number | null;
    household_size: number;
    status: string;
    chronic: boolean;
    returned_after_housing: boolean;
    risk_band: string | null;
    days_homeless: number | null;
    current_project_type: string | null;
    currently_enrolled: boolean;
    journey_milestones: Record<string, string | null>;
    waiting_at: string | null;
    waiting_days: number | null;
  };
  notes: { date: string; text: string }[];
  next_steps: { text: string; status: string; created: string; completed: string | null }[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Split a full name into scrub tokens. ≥2 chars so initials don't nuke every
 *  matching letter; over-scrubbing a client named e.g. "Grant" is accepted —
 *  under-scrubbing is not. */
function nameParts(full: string | null | undefined): string[] {
  return (full ?? '')
    .split(/[^A-Za-zÀ-ÿ'’-]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

// SSN: 123-45-6789 / 123 45 6789 / 123456789 (the bare-9-digit rule can hit
// other long numbers — over-scrub accepted).
const RE_SSN = /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g;
const RE_SSN9 = /\b\d{9}\b/g;
// Phone: (305) 555-0123 / 305-555-0123 / 305.555.0123 / 3055550123
const RE_PHONE = /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// DOB: any date following a birth label, plus any UNlabeled full date whose
// 4-digit year is old enough (≤ 2014) that in a case note it almost certainly
// identifies a birthdate, not an appointment. Recent dates (court, appts,
// move-ins) are the timeline the summary needs — they stay.
const RE_DOB_LABEL = /\b(dob|d\.o\.b\.?|date of birth|birth\s*date|born(?: on)?)\b[:\s#-]*\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}/gi;
const RE_OLD_DATE = /\b\d{1,2}[/.\-]\d{1,2}[/.\-](19\d{2}|20(?:0\d|1[0-4]))\b/g;

export function deidentifyCase(input: CaseInput): { payload: DeidPayload; report: DeidReport } {
  const report: DeidReport = {
    client_name: 0, household_names: 0, staff_names: 0,
    ssn: 0, phone: 0, email: 0, dob: 0,
  };

  // ── name token sets, client tokens take precedence on shared surnames ─────
  const clientTokens = [...new Set(nameParts(input.client.name).map((t) => t.toLowerCase()))];
  const hhTokens = [...new Set(
    (input.client.hh_members ?? [])
      .filter((m) => m.pid !== input.client.pid)
      .flatMap((m) => nameParts(m.name))
      .map((t) => t.toLowerCase()),
  )].filter((t) => !clientTokens.includes(t));
  const staffTokens = [...new Set([
    ...input.notes.flatMap((n) => nameParts(n.author_name)),
    ...input.tasks.flatMap((t) => (t.assignees ?? []).flatMap((a) => nameParts(a.name))),
  ].map((t) => t.toLowerCase()))]
    .filter((t) => !clientTokens.includes(t) && !hhTokens.includes(t));

  const scrubTokens = (text: string, tokens: string[], repl: string, key: keyof DeidReport): string => {
    let out = text;
    for (const t of [...tokens].sort((a, b) => b.length - a.length)) {
      const re = new RegExp(`\\b${escapeRe(t)}\\b`, 'gi');
      out = out.replace(re, () => { report[key] += 1; return repl; });
    }
    // "the client the client" (first + last name adjacent) → one mention
    return out.replace(new RegExp(`${escapeRe(repl)}(?:[\\s,]+${escapeRe(repl)})+`, 'g'), repl);
  };
  const scrubPattern = (text: string, re: RegExp, repl: string, key: keyof DeidReport): string =>
    text.replace(re, () => { report[key] += 1; return repl; });

  const scrub = (raw: string): string => {
    let t = raw;
    t = scrubTokens(t, clientTokens, 'the client', 'client_name');
    t = scrubTokens(t, hhTokens, 'a family member', 'household_names');
    t = scrubTokens(t, staffTokens, 'staff', 'staff_names');
    t = scrubPattern(t, RE_EMAIL, '[EMAIL]', 'email');
    t = scrubPattern(t, RE_DOB_LABEL, '[DOB]', 'dob');
    t = scrubPattern(t, RE_OLD_DATE, '[DOB]', 'dob');
    t = scrubPattern(t, RE_SSN, '[SSN]', 'ssn');
    t = scrubPattern(t, RE_SSN9, '[SSN]', 'ssn');
    t = scrubPattern(t, RE_PHONE, '[PHONE]', 'phone');
    return t;
  };

  const c = input.client;
  const payload: DeidPayload = {
    client: {
      pid: c.pid,
      age: c.age,
      household_size: Math.max(c.hh_members?.length ?? 0, 1),
      status: c.status,
      chronic: !!c.chronic,
      returned_after_housing: !!c.returned,
      risk_band: c.risk_band,
      days_homeless: c.days_homeless,
      current_project_type: c.ptype,
      currently_enrolled: !!c.enrolled,
      journey_milestones: c.milestones ?? {},
      waiting_at: c.ms_stage,
      waiting_days: c.ms_wait,
    },
    notes: input.notes.map((n) => ({ date: n.created_at.slice(0, 10), text: scrub(n.body) })),
    // Assignee/author identities deliberately dropped (not even "staff A/B") —
    // the summary is about the client's trajectory, not staffing attribution.
    next_steps: input.tasks.map((t) => ({
      text: scrub(t.body),
      status: t.status,
      created: t.created_at.slice(0, 10),
      completed: t.done_at?.slice(0, 10) ?? null,
    })),
  };

  return { payload, report };
}
