/**
 * dream:learnings runner (audit #11 close-out) — the CLI wrapper around the
 * pure coding-memory dreamLearnings(). Pins: path resolution ($LEARNINGS_PATH
 * file override > repo-root arg > this checkout), rewrite-on-change with a
 * summary diff count, the no-op pass, exit 1 on an unreadable file, and the
 * ANTI-WIPE REFUSAL — guardTripped ⇒ exit 2 with the file left byte-identical.
 * The dream itself is mocked (its dedupe/merge/guard math is pinned in
 * coding-memory.test.ts); this suite owns the file/exit-code contract.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const mockDreamLearnings: jest.Mock = jest.fn();
jest.mock('../modules/crossmodel/coding/coding-memory.service', () => ({
  __esModule: true,
  dreamLearnings: (...a: any[]) => mockDreamLearnings(...a),
}));

import { runDreamLearnings, resolveLearningsPath, GUARD_EXIT_CODE } from './dream-learnings';
import { isExportTree, REPO_ROOT } from '../utils/export-mode';

const INPUT = [
  '# Learned conventions (durable)',
  '',
  '- fact one',
  '- fact one',
  '- fact two',
].join('\n');

const dreamResult = (over: Partial<any> = {}) => ({
  content: INPUT, changed: false, entriesBefore: 3, entriesAfter: 3,
  removedVerbatim: 0, mergedNearDupes: 0, guardTripped: false,
  ...over,
});

let root: string;
let file: string;
const lines: string[] = [];
const log = (l: string) => lines.push(l);
const savedEnvPath = process.env.LEARNINGS_PATH;

beforeEach(() => {
  jest.clearAllMocks();
  lines.length = 0;
  delete process.env.LEARNINGS_PATH;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-learnings-'));
  file = path.join(root, '.digby', 'notes', 'learnings.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, INPUT);
});

afterEach(() => {
  if (savedEnvPath === undefined) delete process.env.LEARNINGS_PATH;
  else process.env.LEARNINGS_PATH = savedEnvPath;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveLearningsPath', () => {
  it('$LEARNINGS_PATH (a FILE path) wins over everything', () => {
    process.env.LEARNINGS_PATH = '/tmp/elsewhere/learnings.md';
    expect(resolveLearningsPath('/some/repo')).toBe(path.resolve('/tmp/elsewhere/learnings.md'));
  });

  it('a repo-root arg maps to <root>/.digby/notes/learnings.md', () => {
    expect(resolveLearningsPath(root)).toBe(file);
  });

  it("the default is this checkout's own .digby/notes/learnings.md (which exists)", () => {
    const def = resolveLearningsPath();
    expect(def.endsWith(path.join('.digby', 'notes', 'learnings.md'))).toBe(true);
    // EXPORT TREE (todo 13069ce2, 2026-11-05): the public export drops `.digby/`
    // wholesale, so the DEFAULT path is legitimately absent there. The pin's real
    // subject is the path SHAPE (asserted above, true in both trees); existence is
    // a fact about which tree this is. Asserting the correct answer for each tree
    // keeps this meaningful everywhere — and fails if an export ever ships the
    // private notes folder by accident.
    expect(fs.existsSync(def)).toBe(!isExportTree(REPO_ROOT));
  });
});

describe('runDreamLearnings', () => {
  it('a changed pass REWRITES the file and prints the summary diff count (exit 0)', async () => {
    const DEDUPED = '# Learned conventions (durable)\n\n- fact one\n- fact two\n';
    mockDreamLearnings.mockResolvedValue(dreamResult({
      content: DEDUPED, changed: true, entriesAfter: 2, removedVerbatim: 1,
    }));

    const code = await runDreamLearnings(root, log);

    expect(code).toBe(0);
    expect(mockDreamLearnings).toHaveBeenCalledWith(INPUT); // the file content, verbatim
    expect(fs.readFileSync(file, 'utf8')).toBe(DEDUPED);
    const summary = lines.join('\n');
    expect(summary).toContain('3 → 2 entries');
    expect(summary).toContain('1 verbatim duplicate(s) removed');
    expect(summary).toContain('0 near-duplicate(s) merged');
  });

  it('ANTI-WIPE REFUSAL: guardTripped ⇒ exit 2, file byte-identical, warning surfaced', async () => {
    mockDreamLearnings.mockResolvedValue(dreamResult({
      guardTripped: true,
      warning: 'learnings dream would drop 3/3 entries (>30%) — keeping the original file',
    }));

    const code = await runDreamLearnings(root, log);

    expect(code).toBe(GUARD_EXIT_CODE);
    expect(GUARD_EXIT_CODE).toBe(2);
    expect(fs.readFileSync(file, 'utf8')).toBe(INPUT); // untouched
    const out = lines.join('\n');
    expect(out).toContain('REFUSED (anti-wipe guard)');
    expect(out).toContain('would drop 3/3 entries');
    expect(out).toContain('left untouched');
  });

  it('an unchanged pass leaves the file alone (exit 0, no rewrite)', async () => {
    mockDreamLearnings.mockResolvedValue(dreamResult());
    const before = fs.statSync(file).mtimeMs;

    const code = await runDreamLearnings(root, log);

    expect(code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(INPUT);
    expect(fs.statSync(file).mtimeMs).toBe(before);
    expect(lines.join('\n')).toContain('nothing to fold');
  });

  it('a missing file exits 1 with the path in the message — never a throw', async () => {
    fs.rmSync(file);
    const code = await runDreamLearnings(root, log);
    expect(code).toBe(1);
    expect(mockDreamLearnings).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain(`cannot read ${file}`);
  });

  it('honors $LEARNINGS_PATH as the file to dream over', async () => {
    const alt = path.join(root, 'alt-learnings.md');
    fs.writeFileSync(alt, INPUT);
    process.env.LEARNINGS_PATH = alt;
    mockDreamLearnings.mockResolvedValue(dreamResult({ content: 'rewritten\n', changed: true, entriesAfter: 1, removedVerbatim: 2 }));

    const code = await runDreamLearnings(undefined, log);

    expect(code).toBe(0);
    expect(fs.readFileSync(alt, 'utf8')).toBe('rewritten\n');
    expect(fs.readFileSync(file, 'utf8')).toBe(INPUT); // the default target untouched
  });
});
