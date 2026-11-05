/**
 * lesson-writer.test.ts — recordLesson is the ONLY doctrine-append path
 * (layered prompts, 2026-09-27): it refuses a rule sentence carrying a date,
 * an id, a project or model name; appends the generic bullet under the named
 * core section (inside the TS template literal, never the anchors object);
 * appends the dated row to docs/FRAMEWORK_LESSONS.md; and round-trips on a
 * temp copy of the real files (the repo's own core-doctrine.ts + lessons doc).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  recordLesson, validateLessonRule, lessonBullet, lessonRow, appendBulletToCoreSource, appendRowToLessonsDoc,
  CORE_DOCTRINE_PATH, LESSONS_DOC_PATH, LESSONS_TABLE_ANCHOR,
} from './lesson-writer';
import { CORE_SECTION_ANCHORS } from './core-doctrine';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const GOOD = {
  ruleId: 'receipt.stage-upload',
  section: 'evidence' as const,
  rule: 'A file hand-off is complete only when stage_upload returned a receipt id you cite; a described upload with no receipt did not happen.',
  incident: 'A lane reported "uploaded the CSV to the analyst chat" with no stage_upload receipt; the file never arrived.',
  date: '2026-09-27',
  ticket: 'ticket 0badf00d',
};

describe('validateLessonRule — the refusal set', () => {
  it('accepts a generic rule and refuses dates, ids, project names, model ids, quote markers, env toggles, bad ids', () => {
    expect(validateLessonRule(GOOD)).toEqual([]);
    const bad = [
      { ...GOOD, rule: 'Never re-send a wake the gate parked (owner 2026-09-26) — see ticket 661fb494.' },
      { ...GOOD, rule: 'The CanLaw grant covers every spend inside the program, never file a card for it.' },
      { ...GOOD, rule: 'Always route the seat to kimi-k3 when the lead provider is down for more than an hour.' },
      { ...GOOD, rule: 'Set INFRA_ACTIONS_ENABLED=1 before pruning the build cache on the coding host machine.' },
      { ...GOOD, ruleId: 'NotARule' },
      { ...GOOD, date: '27/09/2026' },
      { ...GOOD, rule: 'too short' },
    ];
    for (const b of bad) expect(validateLessonRule(b).length).toBeGreaterThan(0);
  });
});

describe('the pure renderers', () => {
  it('bullet + row shapes', () => {
    expect(lessonBullet(GOOD)).toBe(`- (rule receipt.stage-upload) ${GOOD.rule}`);
    expect(lessonBullet({ ...GOOD, label: 'FILE HAND-OFFS ARE RECEIPTED' })).toBe(`- FILE HAND-OFFS ARE RECEIPTED (rule receipt.stage-upload): ${GOOD.rule}`);
    expect(lessonRow(GOOD)).toBe(`| 2026-09-27 | ${GOOD.incident} | \`receipt.stage-upload\` | ticket 0badf00d |`);
    expect(lessonRow({ ...GOOD, ticket: undefined })).toContain('| — |');
  });

  it('appendBulletToCoreSource inserts at the END of the named section inside the template literal — not at the anchors object, not into the next section', () => {
    const src = [
      'export const CORE_SECTION_ANCHORS = { standing: \'## Standing owner directives\', scope: \'## Directive scope\' } as const;',
      'export const A =',
      '  `## Standing owner directives (bind every wake)',
      '- first rule',
      '- second rule`;',
      '',
      'export const B =',
      '  `## Directive scope — applying',
      '- scope rule`;',
    ].join('\n');
    const out = appendBulletToCoreSource(src, '## Standing owner directives', '- (rule x.y) a `quoted` ${thing}');
    expect(out).toContain('- second rule\n- (rule x.y) a \\`quoted\\` \\${thing}`;');
    expect(out.indexOf('- (rule x.y)')).toBeGreaterThan(out.indexOf('export const A ='));
    expect(out.indexOf('- (rule x.y)')).toBeLessThan(out.indexOf('export const B ='));
    const out2 = appendBulletToCoreSource(src, '## Directive scope', '- (rule s.t) new scope bullet');
    expect(out2).toContain('- scope rule\n- (rule s.t) new scope bullet`;');
    expect(() => appendBulletToCoreSource(src, '## Nope', '- x')).toThrow(/no section/);
  });

  it('appendRowToLessonsDoc inserts right under the anchor', () => {
    const doc = `# Lessons\n\n| date | incident | rule | ticket |\n|---|---|---|---|\n${LESSONS_TABLE_ANCHOR}\n| 2026-09-20 | old | \`a.b\` | — |\n`;
    const out = appendRowToLessonsDoc(doc, lessonRow(GOOD));
    expect(out.split('\n')[4]).toBe(LESSONS_TABLE_ANCHOR);
    expect(out.split('\n')[5]).toBe(lessonRow(GOOD));
    expect(() => appendRowToLessonsDoc('no anchor here', 'x')).toThrow(/anchor/);
  });
});

describe('recordLesson on a temp copy of the REAL files', () => {
  it('refuses without writing; dry-run writes nothing; a real call appends to both files under every real section anchor', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-'));
    const coreSrc = fs.readFileSync(path.join(REPO_ROOT, CORE_DOCTRINE_PATH), 'utf8');
    const doc = fs.readFileSync(path.join(REPO_ROOT, LESSONS_DOC_PATH), 'utf8');
    fs.mkdirSync(path.join(tmp, path.dirname(CORE_DOCTRINE_PATH)), { recursive: true });
    fs.mkdirSync(path.join(tmp, path.dirname(LESSONS_DOC_PATH)), { recursive: true });
    fs.writeFileSync(path.join(tmp, CORE_DOCTRINE_PATH), coreSrc);
    fs.writeFileSync(path.join(tmp, LESSONS_DOC_PATH), doc);

    const refused = await recordLesson({ ...GOOD, repoRoot: tmp, rule: 'Never do this again (ticket 661fb494) — the CanLaw lane parked.' });
    expect(refused.ok).toBe(false);
    expect(fs.readFileSync(path.join(tmp, CORE_DOCTRINE_PATH), 'utf8')).toBe(coreSrc);

    const dry = await recordLesson({ ...GOOD, repoRoot: tmp, dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.bullet).toBe(lessonBullet(GOOD));
    expect(fs.readFileSync(path.join(tmp, LESSONS_DOC_PATH), 'utf8')).toBe(doc);

    for (const section of Object.keys(CORE_SECTION_ANCHORS) as Array<keyof typeof CORE_SECTION_ANCHORS>) {
      const r = await recordLesson({ ...GOOD, repoRoot: tmp, section, ruleId: `test.${section}` });
      expect(r.ok).toBe(true);
    }
    const nextCore = fs.readFileSync(path.join(tmp, CORE_DOCTRINE_PATH), 'utf8');
    const nextDoc = fs.readFileSync(path.join(tmp, LESSONS_DOC_PATH), 'utf8');
    for (const section of Object.keys(CORE_SECTION_ANCHORS)) {
      expect(nextCore).toContain(`- (rule test.${section}) ${GOOD.rule}`);
      expect(nextDoc).toContain(`\`test.${section}\``);
    }
    // the bullets landed INSIDE the literals (after their section), never in the anchors object line
    const anchorsLine = nextCore.split('\n').find(l => l.includes('export const CORE_SECTION_ANCHORS'))!;
    expect(anchorsLine).not.toContain('rule test.');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
