/**
 * LESSON WRITER — the ONLY way the framework's repair loops (ticket dispatch,
 * the Framework Operator lane, an interactive session fixing a mishap) add
 * doctrine from now on (layered prompts, 2026-09-27).
 *
 *   recordLesson({ repoRoot, ruleId, section, rule, incident, date, ticket? })
 *
 *   (a) appends the GENERIC rule sentence as a bullet under the named core
 *       section of backend/src/modules/crossmodel/platform/core-doctrine.ts
 *       (CORE_SECTION_ANCHORS: standing / scope / gate / evidence) — the
 *       bullet reads `- <RULE> (rule <ruleId>): <sentence>` when the rule is
 *       new, or `- (rule <ruleId>) <sentence>` as an addendum to an existing
 *       rule id;
 *   (b) appends the dated incident row to docs/FRAMEWORK_LESSONS.md
 *       (`| date | incident | rule id | ticket |`);
 *   (c) runs the hygiene checks (prompt-hygiene.ts) on the RULE SENTENCE and
 *       REFUSES an inline date, ticket / oq_ / cf_ id, project name, model id,
 *       owner-quote marker or env toggle — the incident text may carry them,
 *       the rule may not.
 *
 * Nothing else appends to the prompts: the [FLEET_FACTS] anchor and
 * fleetChangelogNote() growth path are retired (supervisor-doctrine.ts is
 * frozen for the kill-switch path). A lane that wants a supervisor to learn
 * from an incident calls this and ships the diff through the normal PR gate;
 * the lint (prompt-hygiene.test.ts) then keeps the sentence honest in CI.
 *
 * File-system only — no DB, no network. Usable from a coding lane's worktree:
 *   node -e "require('./dist/modules/crossmodel/platform/lesson-writer').recordLessonCli()" -- --ruleId … --section … --rule '…' --incident '…' --date 2026-09-27
 */

import { promises as fs } from 'fs';
import path from 'path';
import { lintPromptText, formatFindings, type HygieneFinding } from './prompt-hygiene';
import { CORE_SECTION_ANCHORS } from './core-doctrine';

export type CoreSection = keyof typeof CORE_SECTION_ANCHORS;

export interface RecordLessonInput {
  /** Repository root (the directory holding backend/ and docs/). */
  repoRoot: string;
  /** Stable rule id, e.g. 'halt.owner-words' or a new 'receipt.stage-upload'. */
  ruleId: string;
  section: CoreSection;
  /** The GENERIC rule sentence — no dates, ids, project or model names. */
  rule: string;
  /** The dated incident narrative (may name everything) — goes to docs only. */
  incident: string;
  /** ISO date of the incident. */
  date: string;
  ticket?: string;
  /** Optional short RULE LABEL (uppercase) for a NEW rule id, e.g. 'RECEIPTS ARE THE EVIDENCE'. */
  label?: string;
  dryRun?: boolean;
}

export interface RecordLessonResult {
  ok: boolean;
  findings: HygieneFinding[];
  coreFile: string;
  lessonsFile: string;
  bullet?: string;
  row?: string;
}

export const CORE_DOCTRINE_PATH = path.join('backend', 'src', 'modules', 'crossmodel', 'platform', 'core-doctrine.ts');
export const LESSONS_DOC_PATH = path.join('docs', 'FRAMEWORK_LESSONS.md');
export const LESSONS_TABLE_ANCHOR = '<!-- lessons:append-below -->';

const RULE_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/** The bullet appended to the core section. Pure. */
export function lessonBullet(input: Pick<RecordLessonInput, 'ruleId' | 'rule' | 'label'>): string {
  const sentence = input.rule.trim().replace(/\s+/g, ' ');
  return input.label
    ? `- ${input.label.trim()} (rule ${input.ruleId}): ${sentence}`
    : `- (rule ${input.ruleId}) ${sentence}`;
}

/** The docs row. Pure. */
export function lessonRow(input: Pick<RecordLessonInput, 'date' | 'incident' | 'ruleId' | 'ticket'>): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  return `| ${cell(input.date)} | ${cell(input.incident)} | \`${input.ruleId}\` | ${input.ticket ? cell(input.ticket) : '—'} |`;
}

/** Validate the rule sentence (pure): the hygiene findings for it. */
export function validateLessonRule(input: Pick<RecordLessonInput, 'ruleId' | 'rule' | 'section' | 'date'>): HygieneFinding[] {
  const findings: HygieneFinding[] = [];
  if (!RULE_ID_RE.test(input.ruleId)) findings.push({ rule: 'incident_id', source: 'recordLesson', token: input.ruleId, excerpt: 'ruleId must look like <area>.<name> (lowercase, dotted)' });
  if (!(input.section in CORE_SECTION_ANCHORS)) findings.push({ rule: 'over_budget', source: 'recordLesson', token: String(input.section), excerpt: `section must be one of ${Object.keys(CORE_SECTION_ANCHORS).join(', ')}` });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) findings.push({ rule: 'dated_rule', source: 'recordLesson', token: input.date, excerpt: 'date must be YYYY-MM-DD' });
  const rule = input.rule.trim();
  if (rule.length < 40) findings.push({ rule: 'over_budget', source: 'recordLesson', token: `${rule.length} chars`, excerpt: 'a rule sentence is at least 40 chars' });
  if (rule.length > 900) findings.push({ rule: 'over_budget', source: 'recordLesson', token: `${rule.length} chars`, excerpt: 'a rule sentence is at most 900 chars' });
  // The rule is linted as a BULLET (rule text) so a date anywhere in it fails.
  findings.push(...lintPromptText({ source: 'recordLesson.rule', text: `- ${rule}` }));
  return findings;
}

/**
 * Insert a bullet at the end of the named `## ` section inside the TypeScript
 * template literal (the section ends at the next `## ` heading inside the same
 * literal, or at the literal's closing backtick). Pure.
 */
export function appendBulletToCoreSource(source: string, anchor: string, bullet: string): string {
  // The heading at the START of a line inside the template literal — not the
  // CORE_SECTION_ANCHORS object literal (same string, mid-line) above it.
  const esc = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A heading opens a literal (`  \`## Heading`) or follows a blank line
  // inside one (`\n## Heading`); the anchors object holds the same string
  // mid-line after a quote, which neither shape matches.
  const m = new RegExp(`(?:^|\\n)[ \\t]*\`?${esc}`, 'm').exec(source);
  if (!m) throw new Error(`core-doctrine.ts has no section starting with ${JSON.stringify(anchor)}`);
  const start = m.index + m[0].indexOf(anchor);
  // End of section: the next line that starts a heading, or the (unescaped) closing backtick of the literal.
  const rest = source.slice(start);
  const nextHeading = rest.search(/\n## /);
  const closing = rest.search(/(?<!\\)`;/);
  const endRel = [nextHeading, closing].filter(i => i > 0).sort((a, b) => a - b)[0];
  if (endRel === undefined) throw new Error('could not find the end of the section');
  const sectionEnd = start + endRel;
  const escaped = bullet.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return `${source.slice(0, sectionEnd)}\n${escaped}${source.slice(sectionEnd)}`;
}

/** Insert a row under the lessons table anchor. Pure. */
export function appendRowToLessonsDoc(doc: string, row: string): string {
  const idx = doc.indexOf(LESSONS_TABLE_ANCHOR);
  if (idx < 0) throw new Error(`${LESSONS_DOC_PATH} has no ${LESSONS_TABLE_ANCHOR} anchor`);
  const lineEnd = doc.indexOf('\n', idx);
  const at = lineEnd < 0 ? doc.length : lineEnd;
  return `${doc.slice(0, at)}\n${row}${doc.slice(at)}`;
}

export async function recordLesson(input: RecordLessonInput): Promise<RecordLessonResult> {
  const coreFile = path.join(input.repoRoot, CORE_DOCTRINE_PATH);
  const lessonsFile = path.join(input.repoRoot, LESSONS_DOC_PATH);
  const findings = validateLessonRule(input);
  if (findings.length) return { ok: false, findings, coreFile, lessonsFile };
  const bullet = lessonBullet(input);
  const row = lessonRow(input);
  if (input.dryRun) return { ok: true, findings: [], coreFile, lessonsFile, bullet, row };
  const [core, doc] = await Promise.all([fs.readFile(coreFile, 'utf8'), fs.readFile(lessonsFile, 'utf8')]);
  const nextCore = appendBulletToCoreSource(core, CORE_SECTION_ANCHORS[input.section], bullet);
  const nextDoc = appendRowToLessonsDoc(doc, row);
  await fs.writeFile(coreFile, nextCore, 'utf8');
  await fs.writeFile(lessonsFile, nextDoc, 'utf8');
  return { ok: true, findings: [], coreFile, lessonsFile, bullet, row };
}

/** Minimal CLI: --repoRoot --ruleId --section --rule --incident --date [--ticket] [--label] [--dry-run]. */
export async function recordLessonCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true; else { args[key] = next; i++; }
  }
  const str = (k: string) => (typeof args[k] === 'string' ? String(args[k]) : '');
  const res = await recordLesson({
    repoRoot: str('repoRoot') || process.cwd(),
    ruleId: str('ruleId'),
    section: str('section') as CoreSection,
    rule: str('rule'),
    incident: str('incident'),
    date: str('date'),
    ticket: str('ticket') || undefined,
    label: str('label') || undefined,
    dryRun: args['dry-run'] === true,
  });
  if (!res.ok) {
    process.stderr.write(`recordLesson REFUSED:\n${formatFindings(res.findings)}\n`);
    return 1;
  }
  process.stdout.write(`${res.bullet}\n${res.row}\n${res.coreFile}\n${res.lessonsFile}\n`);
  return 0;
}

if (require.main === module) {
  recordLessonCli().then(code => process.exit(code)).catch(err => { process.stderr.write(String(err?.message ?? err)); process.exit(2); });
}
