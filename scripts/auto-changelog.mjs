#!/usr/bin/env node
/**
 * Auto-changelog: turns a pushed commit range into a ✨ "Dashboard update"
 * announcement (history-only — it never takes over the live banner; expires_on
 * is set to yesterday so it lands straight in /dashboard/announcements'
 * Changelog tab). Runs in GitHub Actions on every push to main
 * (.github/workflows/changelog.yml); Claude writes the user-facing copy from
 * the commit messages, aimed at agency staff, not developers.
 *
 * Env: ANTHROPIC_API_KEY, SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL),
 *      SUPABASE_SERVICE_ROLE_KEY, CHANGELOG_AUTHOR_ID (announcements.created_by
 *      references auth.users — use the admin's uuid), RANGE_FROM, RANGE_TO.
 * Flags: --dry-run  (print the entry, write nothing)
 */
import { execFileSync } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const DRY = process.argv.includes('--dry-run');
const env = (k, fallback) => process.env[k] ?? fallback ?? null;

// No process.exit() anywhere below — with keep-alive sockets still closing it
// trips a libuv teardown assert on Windows (exit code 9) and would read as a
// CI failure. Return from main() and let node exit naturally instead.
await main();

async function main() {
if (!env('ANTHROPIC_API_KEY') || !env('SUPABASE_SERVICE_ROLE_KEY')) {
  console.log('changelog secrets not configured — skipping (see workflow header)');
  return;
}
const from = env('RANGE_FROM');
const to = env('RANGE_TO', 'HEAD');
// First push / unknown parent (all-zero SHA): describe just the head commit.
const range = from && !/^0+$/.test(from) ? `${from}..${to}` : `${to}~1..${to}`;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const commits = git('log', '--format=--- %s%n%b', range);
const stat = git('diff', '--stat', range).split('\n').slice(-30).join('\n');
if (!commits.trim()) {
  console.log('no commits in range — nothing to announce');
  return;
}
if (/\[skip-changelog\]/i.test(commits)) {
  console.log('[skip-changelog] present — skipping');
  return;
}

const client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') });
const response = await client.beta.messages.create({
  model: 'claude-opus-5',
  max_tokens: 4000,
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
  system: [
    'You write release notes for the Miami-Dade County Homeless Trust HMIS dashboard.',
    'The audience is agency staff — case managers and HMIS data-entry users, not developers.',
    'You are given the git commit messages and changed-file stats from one deploy.',
    'Write what CHANGED FOR THE USER: new things they can see or do, in their words',
    '(fix-lists, DQ scores, exports, By-Name List, announcements — the dashboard features).',
    'Never mention commits, files, code, SQL, refactors, or internal tooling.',
    'Skip the entry entirely (skip=true) when the changes have no user-visible effect',
    '(pure pipeline/infra/docs work). body: one plain sentence, max 280 characters, no',
    'markdown. details: 2-6 short plain lines, one point per line, no markdown, no bullets',
    '— each line renders as its own paragraph.',
  ].join(' '),
  messages: [{
    role: 'user',
    content: `Commit messages:\n${commits}\n\nChanged files (tail of diff --stat):\n${stat}`,
  }],
  output_config: {
    format: {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          skip: { type: 'boolean' },
          reason: { type: 'string' },
          body: { type: 'string' },
          details: { type: 'string' },
        },
        required: ['skip', 'reason', 'body', 'details'],
        additionalProperties: false,
      },
    },
  },
});

if (response.stop_reason === 'refusal') {
  console.log('model declined the request — no entry written');
  return;
}
const note = JSON.parse(response.content.find((b) => b.type === 'text').text);
if (note.skip) {
  console.log(`skipped: ${note.reason}`);
  return;
}
const body = note.body.slice(0, 300);
console.log(`\n✨ ${body}\n\n${note.details}\n`);
if (DRY) {
  console.log('(dry run — nothing written)');
  return;
}

const sb = createClient(
  env('SUPABASE_URL', env('NEXT_PUBLIC_SUPABASE_URL')),
  env('SUPABASE_SERVICE_ROLE_KEY'),
);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const { error } = await sb.from('announcements').insert({
  body,
  details: note.details.slice(0, 5000),
  kind: 'update',
  expires_on: yesterday, // changelog-only: never displaces the live banner
  created_by: env('CHANGELOG_AUTHOR_ID'),
});
if (error) {
  console.error('insert failed:', error.message);
  process.exitCode = 1;
  return;
}
console.log('changelog entry published');
}
