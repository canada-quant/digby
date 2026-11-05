/**
 * export-mode.test.ts — pins the export/private tree classifier AND the
 * fail-closed scrub posture as a TEST rather than a script.
 *
 * The load-bearing property (Phase 2b acceptance criterion): suites may skip
 * their private-file pins ONLY in a genuine export, and a tree that is neither
 * wholesale-private nor wholesale-exported must be FATAL. A future rules-file
 * regression that lets one private file through reds here.
 *
 * The mirror-vs-real-rules check is conditional on the private rules file being
 * present: this suite is ITSELF exported, so it can never hard-require
 * `.digby/publish/scrub-rules.txt`. When the file IS present (the private
 * tree — dev, CI, every PR) it asserts the mirror is complete, so drift between
 * EXPORT_DROPPED_PATHS and the real drop list cannot pass unnoticed.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  EXPORT_DROPPED_PATHS,
  REPO_ROOT,
  assertTreeClass,
  classifyTree,
  isExportTree,
  readDroppedFile,
} from './export-mode';

/** Build a throwaway tree: `present` paths are created, everything else is not. */
function mkTree(present: readonly string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-mode-'));
  // A real checkout always has the public marker.
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  for (const p of present) {
    const abs = path.join(root, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // Directories (memory-bank) vs files: write a file either way; existsSync
    // is what classifyTree consults, and it is true for both.
    fs.writeFileSync(abs, 'private\n');
  }
  return root;
}

describe('export-mode — tree classification', () => {
  it('every dropped path present => private', () => {
    expect(classifyTree(mkTree(EXPORT_DROPPED_PATHS))).toBe('private');
    expect(isExportTree(mkTree(EXPORT_DROPPED_PATHS))).toBe(false);
  });

  it('every dropped path absent => export', () => {
    const root = mkTree([]);
    expect(classifyTree(root)).toBe('export');
    expect(isExportTree(root)).toBe(true);
  });

  it('a PARTIAL drop is mixed, never export — the fail-closed property', () => {
    // Exactly what a half-applied drop list looks like: two left behind.
    const root = mkTree(EXPORT_DROPPED_PATHS.slice(0, 2));
    expect(classifyTree(root)).toBe('mixed');
    // The critical negative: a mixed tree must NEVER license an export skip.
    expect(isExportTree(root)).toBe(false);
  });

  it('one dropped path missing from an otherwise-private tree is mixed, not export', () => {
    // A single accidentally-deleted private file must not reclassify the whole
    // tree as an export and silence every private-file pin.
    const root = mkTree(EXPORT_DROPPED_PATHS.slice(1));
    expect(classifyTree(root)).toBe('mixed');
    expect(isExportTree(root)).toBe(false);
  });

  it('no public marker => unknown, never a silent export verdict', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-mode-empty-'));
    expect(classifyTree(root)).toBe('unknown');
    expect(isExportTree(root)).toBe(false);
  });
});

describe('export-mode — assertTreeClass is the two-sided pin', () => {
  it('passes and reports the class for a wholesale private tree', () => {
    expect(assertTreeClass(mkTree(EXPORT_DROPPED_PATHS))).toBe('private');
  });

  it('passes and reports the class for a wholesale export', () => {
    expect(assertTreeClass(mkTree([]))).toBe('export');
  });

  it('THROWS on a mixed tree, naming what survived', () => {
    const root = mkTree(EXPORT_DROPPED_PATHS.slice(0, 1));
    expect(() => assertTreeClass(root)).toThrow(/is 'mixed'/);
    // The message must name the survivor — a fail-closed verdict has to say
    // WHICH private path leaked, or the operator cannot act on it.
    expect(() => assertTreeClass(root)).toThrow(new RegExp(EXPORT_DROPPED_PATHS[0]!.replace(/\./g, '\\.')));
  });

  it('THROWS on a tree that is not a checkout at all', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-mode-unknown-'));
    expect(() => assertTreeClass(root)).toThrow(/is 'unknown'/);
  });

  it('the real working tree is wholesale, never mixed', () => {
    // Mutating the real repo is not this test's job; it asserts only that the
    // tree the suite runs in is one of the two legitimate classes, so a damaged
    // checkout surfaces here rather than as a scattering of ENOENTs.
    expect(['private', 'export']).toContain(assertTreeClass(REPO_ROOT));
  });
});

describe('export-mode — readDroppedFile skips in an export and only there', () => {
  it('returns the content when the file is present', () => {
    const root = mkTree(EXPORT_DROPPED_PATHS);
    expect(readDroppedFile('CLAUDE.md', root)).toBe('private\n');
  });

  it('returns null in a wholesale export (the licensed skip)', () => {
    expect(readDroppedFile('CLAUDE.md', mkTree([]))).toBeNull();
  });

  it('THROWS when the file is missing outside an export', () => {
    // Mixed tree = not an export = not a licence to skip. Absent path must be
    // the one we then read, or the fixture proves nothing: remove CLAUDE.md
    // alone while its siblings survive.
    const root = mkTree(EXPORT_DROPPED_PATHS.filter((p) => p !== 'CLAUDE.md'));
    expect(classifyTree(root)).toBe('mixed');
    expect(() => readDroppedFile('CLAUDE.md', root)).toThrow(/NOT an export/);
  });

  it('THROWS when the file is missing from an unknown tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-mode-unknown2-'));
    expect(() => readDroppedFile('CLAUDE.md', root)).toThrow(/NOT an export/);
  });
});

describe('export-mode — the mirror matches the REAL scrub rules', () => {
  const RULES = path.join(REPO_ROOT, '.digby', 'publish', 'scrub-rules.txt');

  // In an export the rules file is (correctly) gone; the mirror check is then
  // vacuous and must say so rather than pretend to have verified anything.
  const rulesPresent = fs.existsSync(RULES);

  (rulesPresent ? it : it.skip)('every mirrored path carries a drop rule in scrub-rules.txt', () => {
    const dropGlobs = fs
      .readFileSync(RULES, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('drop\t'))
      .map((l) => l.split('\t')[1]!.trim());

    for (const dropped of EXPORT_DROPPED_PATHS) {
      // A drop entry is either the exact path, or a parent prefix written with
      // a trailing '/' (`.digby/` drops `.digby/config.json`; `memory-bank/`
      // IS the rule for the directory). Normalise the glob, then compare both
      // exact and prefix.
      const matched = dropGlobs.some((raw) => {
        const g = raw.endsWith('/') ? raw.slice(0, -1) : raw;
        return g === dropped || dropped.startsWith(`${g}/`);
      });
      expect({ dropped, matched }).toEqual({ dropped, matched: true });
    }
  });

  it('reports which mode this run executed in', () => {
    // Deliberate visibility: a green export run and a green private run are
    // different facts, and the log should never leave that ambiguous.
    const cls = classifyTree(REPO_ROOT);
    // eslint-disable-next-line no-console
    console.log(`[export-mode] tree=${cls} rulesFile=${rulesPresent ? 'present' : 'absent(export)'}`);
    expect(['private', 'export']).toContain(cls);
    if (cls === 'export') expect(rulesPresent).toBe(false);
    if (cls === 'private') expect(rulesPresent).toBe(true);
  });
});