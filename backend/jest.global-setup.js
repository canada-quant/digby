/**
 * Jest global setup — durable TMPDIR for test fixtures (2026-08-24 nightly).
 *
 * Root cause of the workspace-restore flake: Digby coding containers wipe /tmp
 * aggressively (probe written by one command is gone ~2 min later; the same
 * hazard broke prod sessions cec340f2 / af773f1e mid-run). Suites that stage
 * REAL git fixtures under os.tmpdir() (workspace-restore/empty-repo/env/…)
 * race that wipe during full-suite runs: the suite's mkdtemp ROOT can vanish
 * mid-file, and the next ensureWorktree dies with
 *   fatal: repository '/tmp/digby-ws-restore-XXXXXX/remote.git' does not exist
 * (~1/9 full runs; reproduced on demand with --maxWorkers=6 on the 2-core
 * container). All 7 tests in the file then fail together — a fixture-level,
 * not test-logic, failure.
 *
 * Fix: give every jest worker a DURABLE tmp root inside the repo (the worktree
 * lives on the persistent volume, not the wiped /tmp). globalSetup runs once
 * in the main process before workers spawn, so the env var is inherited by
 * every worker; os.tmpdir() reads process.env.TMPDIR per call, so existing
 * mkdtempSync(path.join(os.tmpdir(), …)) call sites need no changes.
 *
 * Escape hatch: JEST_KEEP_TMPDIR=1 keeps the ambient TMPDIR (e.g. local dev
 * where /tmp is stable and preferred).
 *
 * No globalTeardown on purpose: concurrent jest invocations share this dir,
 * and suites rm their own mkdtemp roots in afterAll; leftovers are inert and
 * gitignored (.jest-tmp/).
 *
 * Second effect — GIT_CEILING_DIRECTORIES: the durable root sits INSIDE the
 * repo checkout, and `git rev-parse --git-dir` from a plain fixture dir walks
 * UP and would discover the OUTER repo's .git — breaking "not a git repo"
 * assertions (workspace-restore test 6) and, worse, the service's
 * broken-worktree detection it mirrors. Ceiling at tmpRoot stops the ascent
 * exactly at the fixture boundary: repos under tmpRoot are self-contained,
 * nothing legitimate ever needs to discover a repo at or above it.
 */

const fs = require('fs');
const path = require('path');

module.exports = async function globalSetup() {
  // cu-diag 2026-09-25 fix #9: the computer-use driver sleeps 600 ms (1.5 s
  // after open / Spotlight-Return) before every post-action auto-screenshot
  // in production. Under jest that is pure wall-clock on the mocked broker
  // (~15 s across the computer-agent suites), so the suite default is 0 —
  // a test that wants the real delay sets COMPUTER_SETTLE_MS itself.
  if (process.env.COMPUTER_SETTLE_MS === undefined) process.env.COMPUTER_SETTLE_MS = '0';
  if (process.env.JEST_KEEP_TMPDIR === '1') return;
  const tmpRoot = path.join(__dirname, '.jest-tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.TMPDIR = tmpRoot;
  // Some child processes (git) consult TEMP/TMP before TMPDIR on certain
  // platforms; align all three so nothing falls back to the wiped /tmp.
  process.env.TEMP = tmpRoot;
  process.env.TMP = tmpRoot;
  // Stop git repo discovery from ascending out of the fixture root into the
  // outer checkout (append if the ambient env already sets ceilings).
  const ceilings = (process.env.GIT_CEILING_DIRECTORIES || '').split(':').filter(Boolean);
  if (!ceilings.includes(tmpRoot)) ceilings.push(tmpRoot);
  process.env.GIT_CEILING_DIRECTORIES = ceilings.join(':');
  // eslint-disable-next-line no-console
  console.log(`[jest globalSetup] TMPDIR redirected to durable ${tmpRoot} (git ceiling set)`);
};
