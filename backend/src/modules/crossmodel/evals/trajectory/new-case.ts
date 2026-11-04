/**
 * Trajectory evals — scaffold a hand-built case (build 2026-10-08 E-14).
 *
 *   npm run eval:trajectory:new -- <case-id> [--role project_supervisor] [--trigger owner_turn]
 *
 * Writes cases/<case-id>.json as a DRAFT the suite already loads: until the
 * TODOs are replaced, its placeholder incident does not fail any grader, so
 * `npm run eval:trajectory` fails on it — the case cannot merge half-written.
 * For an incident that lives in prod, prefer the one-step freeze instead:
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh freeze-trajectory-case.js <assistantMessageId> --id <case-id>
 */

import * as fs from 'fs';
import * as path from 'path';
import { CASES_DIR } from './suite';
import { CASE_ROLES, CASE_TRIGGERS } from './types';

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function scaffoldCase(id: string, role: string, trigger: string, now = new Date()): Record<string, unknown> {
  return {
    id,
    title: 'TODO — one line: what went wrong',
    status: 'draft',
    incident: {
      date: now.toISOString().slice(0, 10),
      source: 'TODO — the audit finding / ledger row / ticket this freezes',
      refs: [],
      summary: 'TODO — what the run did, what was true, why it mattered (the incident\'s own numbers).',
    },
    mast: [],
    role,
    trigger,
    input: {
      now: now.toISOString(),
      timezone: 'America/Los_Angeles',
      context: 'TODO — the frozen harness blocks the run saw ([SUPERVISOR STATE], [BOARD] …), or delete',
      message: 'TODO — the owner / user message or the machine wake prompt, verbatim',
    },
    fixtures: [
      { tool: 'get_chat_status', args: { chatId: 'TODO' }, output: { note: 'TODO — what the read returned at the time' } },
    ],
    graders: [
      { id: 'todo-outcome', kind: 'final_not_matches', why: 'TODO — the outcome this protects (one line).', pattern: 'TODO-the-incident-claim' },
      { id: 'answered', kind: 'final_nonempty', why: 'The run delivers an answer.' },
    ],
    recordings: [
      { id: 'incident', kind: 'incident', expect: 'fail', note: 'TODO — the incident run, one turn per tool call, the delivered answer last', turns: [{ content: 'TODO — the delivered answer, verbatim' }] },
    ],
  };
}

function main(argv: string[]): number {
  const id = argv.find((a) => !a.startsWith('--') && !argv[argv.indexOf(a) - 1]?.startsWith('--'));
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    console.error('usage: npm run eval:trajectory:new -- <case-id (kebab-case)> [--role <role>] [--trigger <trigger>]');
    return 2;
  }
  const role = arg(argv, '--role') ?? 'project_supervisor';
  const trigger = arg(argv, '--trigger') ?? 'owner_turn';
  if (!(CASE_ROLES as readonly string[]).includes(role)) { console.error(`--role must be one of ${CASE_ROLES.join(', ')}`); return 2; }
  if (!(CASE_TRIGGERS as readonly string[]).includes(trigger)) { console.error(`--trigger must be one of ${CASE_TRIGGERS.join(', ')}`); return 2; }
  const file = path.join(CASES_DIR, `${id}.json`);
  if (fs.existsSync(file)) { console.error(`${file} already exists`); return 1; }
  fs.writeFileSync(file, `${JSON.stringify(scaffoldCase(id, role, trigger), null, 2)}\n`);
  console.log(`wrote ${file} — replace every TODO, then: npm run eval:trajectory -- -t ${id}`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
