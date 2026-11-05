/**
 * export-mode.ts — detect a PUBLIC-EXPORT tree and read its files honestly.
 *
 * WHY THIS EXISTS (Phase 2b Step 2b-export-CI)
 *   `scripts/publish/export-public-tree.sh` drops the private-only doctrine
 *   wholesale (`.digby/`, `AGENTS.md`, `CLAUDE.md`, `memory-bank/`, …). Suites
 *   that SOURCE-PIN one of those files therefore die with `ENOENT` in the
 *   export even though the code under test is perfectly healthy — a false red
 *   that hides real ones, and the reason the exported `ci.yml` backend-jest leg
 *   could not reach rc=0.
 *
 *   The fix is NOT "try/catch and carry on". A missing file has two very
 *   different meanings and they must never be conflated:
 *
 *     - absent BECAUSE this is a scrubbed export  -> legitimate, skip the pin
 *     - absent for any other reason               -> a real defect, FAIL LOUDLY
 *
 *   `isExportTree` distinguishes them structurally: an export is a tree where
 *   EVERY dropped-private path is gone at once while the public tree is intact.
 *   One missing file is not an export — it is a broken checkout, and it throws.
 *
 * THE FAIL-CLOSED PIN
 *   `assertTreeClass` is the load-bearing assertion, and it is two-sided:
 *   the tree must be either fully PRIVATE (every dropped path present) or fully
 *   EXPORTED (every dropped path absent). A MIX is fatal. That is precisely the
 *   scrub's own contract stated as a test rather than a script, so a future
 *   rules-file regression that ships a private file into the export reds CI
 *   instead of being noticed later by a human reading a diff.
 *
 * KEEP IN SYNC WITH the `drop` lines of `.digby/publish/scrub-rules.txt`. That
 * file is itself private (it lives under `.digby/`, which the export drops), so
 * this list cannot be parsed from it at test time — it is a deliberate mirror of
 * the doctrine-bearing subset, not the full drop list. `export-mode.test.ts`
 * pins the mirror against the real rules file whenever the private tree is
 * present, so the two cannot drift silently.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Private-only paths the export drops. All of them are gone in an export and
 * all of them are present in the private tree — the conjunction is the
 * signature that tells the two trees apart.
 */
export const EXPORT_DROPPED_PATHS = [
  '.digby/config.json',
  'AGENTS.md',
  'CLAUDE.md',
  'memory-bank',
] as const;

/**
 * A path that exists in BOTH trees. An export still has its README, so a tree
 * with no README is not "the export" — it is not a checkout at all.
 */
const PUBLIC_MARKER = 'README.md';

/** Repo root as seen from `backend/src/utils/` at test time. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export type TreeClass = 'private' | 'export' | 'mixed' | 'unknown';

/**
 * Classify a tree by the presence pattern of the dropped-private paths.
 *
 *   private  every dropped path present           (the normal dev/CI tree)
 *   export   every dropped path absent, marker ok (a scrubbed public export)
 *   mixed    some present, some absent            -> ALWAYS a defect
 *   unknown  no public marker                     -> not a checkout
 *
 * Only 'export' licenses a skip. 'mixed' is deliberately NOT a skip: it is the
 * exact shape a half-applied drop list produces, and the whole point of the
 * scrub is that the private files leave together or not at all.
 */
export function classifyTree(root: string = REPO_ROOT): TreeClass {
  if (!fs.existsSync(path.join(root, PUBLIC_MARKER))) return 'unknown';
  const present = EXPORT_DROPPED_PATHS.filter((p) => fs.existsSync(path.join(root, p)));
  if (present.length === EXPORT_DROPPED_PATHS.length) return 'private';
  if (present.length === 0) return 'export';
  return 'mixed';
}

/** True only for a genuine scrubbed export tree. */
export function isExportTree(root: string = REPO_ROOT): boolean {
  return classifyTree(root) === 'export';
}

/**
 * Read a dropped-private file, returning `null` when this is an export tree
 * (the caller then skips its pin). Throws when the file is missing for any
 * OTHER reason, so a broken private checkout keeps failing loudly.
 */
export function readDroppedFile(relPath: string, root: string = REPO_ROOT): string | null {
  const abs = path.join(root, relPath);
  if (fs.existsSync(abs)) return fs.readFileSync(abs, 'utf8');
  if (isExportTree(root)) return null;
  throw new Error(
    `readDroppedFile: ${relPath} is missing from ${root}, but that tree is NOT an export ` +
      `(tree class: ${classifyTree(root)}). A dropped-private file missing outside an export ` +
      `is a broken checkout, not something to skip.`,
  );
}

/**
 * THE PIN. Assert the tree is wholesale private or wholesale exported.
 * Returns the observed class so callers/tests can report which mode they ran in.
 */
export function assertTreeClass(root: string = REPO_ROOT): TreeClass {
  const cls = classifyTree(root);
  if (cls === 'mixed' || cls === 'unknown') {
    const present = EXPORT_DROPPED_PATHS.filter((p) => fs.existsSync(path.join(root, p)));
    throw new Error(
      `assertTreeClass: ${root} is '${cls}'. The export drops these paths together and the ` +
        `private tree carries them together — a mixture means the scrub half-applied (or the ` +
        `checkout is damaged). Present: [${present.join(', ') || 'none'}]; ` +
        `dropped class: [${EXPORT_DROPPED_PATHS.join(', ')}].`,
    );
  }
  return cls;
}