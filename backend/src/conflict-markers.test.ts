/**
 * Repo-wide tripwire: committed merge-conflict markers must never reach main.
 * Motivated 2026-08-24: a fleet branch committed '<<<<<<< Updated upstream'
 * stash debris into .github/workflows/deploy.yml — invalid YAML, a zero-job
 * "failed deploy" run, and a merge would have regressed the deploy pipeline.
 * The fleet runs this suite before pushing, so the marker dies pre-push.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..');
// Only scan text sources the fleet edits; binaries and locks excluded.
const SCAN_RE = /\.(ts|tsx|js|jsx|mjs|json|yml|yaml|sh|md|prisma|css|sql)$/;
const SKIP_RE = /(node_modules\/|package-lock\.json$|\.test\.ts$)/; // tests may quote markers (this file does)
const MARKER_RE = /^(<{7} |={7}$|>{7} )/m;

test('no committed merge-conflict markers anywhere in the repo', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 })
    .toString().split('\n').filter(f => f && SCAN_RE.test(f) && !SKIP_RE.test(f));
  expect(files.length).toBeGreaterThan(100); // sanity: the scan actually saw the repo
  const offenders: string[] = [];
  for (const f of files) {
    let text: string;
    try { text = readFileSync(join(REPO_ROOT, f), 'utf8'); } catch { continue; }
    if (MARKER_RE.test(text)) offenders.push(f);
  }
  expect(offenders).toEqual([]);
});
