/**
 * verify-scoped.ts — verify scoping for the lane-facing chain (todo b73b1460,
 * Fleet monitor routing note 2, 2026-10-16). The lane verify chain runs only
 * what the change touches; the FULL suite lives in CI on the un-scoped paths
 * (.github/workflows/ci.yml `Backend tests` runs the FULL 4-shard suite on
 * push to main/batch/**, on workflow_call — deploy.yml needs:[gate,test] —
 * and on workflow_dispatch; PRs run related-only tests via
 * backend/scripts/ci-scope-pr.sh, FAIL-CLOSED to the full suite), plus the
 * nightly-full-suite.yml scheduled run — a third net, not the only one).
 *
 * The `.digby/config.json` command KEYS are unchanged (`typecheck`, `lint`,
 * `test`) so `verify({only})` subsets, the A1 chain signature and
 * edit-diagnostics' fixed-key reads keep working; only the commands behind the
 * keys move:
 *   - test:  changed files (worktree dirty ∪ untracked, else the branch's own
 *            commits vs merge-base origin/<base>) → `jest --findRelatedTests`
 *            over the changed backend code AND test files (a changed test is
 *            always inside its own related set). Deleted code files map to
 *            their co-located test. No backend code/test file changed → a
 *            small pinned SMOKE set. Any detection failure, a too-large set,
 *            a force-full surface (CI workflows, deploy scripts, prisma,
 *            jest/eslint/ts config, package manifests, .digby/config.json,
 *            this script) or the kill switch → the FULL suite verbatim.
 *            Fail closed, always.
 *   - lint:  eslint over the changed lintable files per package (backend
 *            `src --ext .ts`, frontend flat config). Nothing lintable changed
 *            → an explicit no-op pass with the reason printed. Too many files
 *            / force-full / kill switch → the full `npm run lint` of both.
 *   - typecheck is NOT wrapped: the config's own command moved to
 *     `tsc --noEmit --incremental --tsBuildInfoFile tmp/verify-cache/…`
 *     (worktree-local, gitignored by the root `tmp/` pattern) so the verify
 *     chain and edit-diagnostics share one program graph.
 *
 * Measured on the shared dev container 2026-10-16 (tmp/verify-scoping/
 * probe2.log + probe3.log): full chain ≈ tsc 146 s + lint 230 s + full jest;
 * scoped ≈ tsc 33–45 s (warm incremental) + lint ~8 s + jest 15 s (smoke)…
 * bounded by the related-test cap. SCOPED_VERIFY_DISABLED=1 restores the full
 * chain everywhere (the wrapper prints the reason and runs the full command).
 */

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ── Locations (script lives at backend/src/scripts/verify-scoped.ts) ─────────
export const WORKTREE_ROOT = path.resolve(__dirname, '..', '..', '..');
export const BACKEND_DIR = path.resolve(__dirname, '..', '..');

// ── Knobs ────────────────────────────────────────────────────────────────────
/** Kill switch: any truthy value makes every stage run the FULL command. */
export const KILL_SWITCH = 'SCOPED_VERIFY_DISABLED';
/** A scoped test run is bounded — this many related tests or more → FULL suite. */
export const FULL_IF_RELATED_MIN = 240;
/** More changed files than this is not a focused change → FULL suite. */
export const FULL_IF_CHANGED_MAX = 200;
/** Per-package lint: this many changed lintable files or more → full lint. */
export const LINT_FULL_IF_FILES_MIN = 120;

/** Every jest invocation this script can spawn, pinned worker-capped
 *  (e4edffa3 / PR #957: a single lane verify must not stampede the box). */
export const JEST_ARGSETS: Record<'full' | 'smoke' | 'scoped', string[]> = {
  full: ['--maxWorkers=2'],
  smoke: ['--maxWorkers=2', '--passWithNoTests'],
  scoped: ['--maxWorkers=2', '--passWithNoTests'],
};

/** The nothing-affected smoke set — small, fast, and pinning load-bearing
 *  surfaces: the jest worker caps, the config caps, related-test selection,
 *  the doctrine append path, credential redaction. Pinned to exist. */
export const SMOKE_TEST_FILES: readonly string[] = [
  'src/jest-config.test.ts',
  'src/modules/crossmodel/coding/verify-related.test.ts',
  'src/modules/crossmodel/coding/verify-env-streak.9a0a4223.test.ts',
  'src/modules/crossmodel/platform/lesson-writer.test.ts',
  'src/utils/redact-credentials.test.ts',
];

/** A change on any of these surfaces can alter what EVERY test sees — the
 *  scoped path never applies; the full suite runs (and CI re-runs it). */
export const FORCE_FULL_PREFIXES: readonly string[] = [
  '.github/workflows/',            // the CI full gate itself
  'scripts/deploy/',               // deploy runtime scripts + their harnesses
  'scripts/git-hooks/',
  'deploy/', 'deploy.sh', 'deploy-blue-green.sh', 'deploy-selective.sh',
  'rollback.sh', 'docker', 'docker-compose',
  '.digby/config.json',            // this chain
  '.digbyignore',
  'backend/prisma/',               // schema + migrations
  'backend/jest.config.js',
  'backend/jest.global-setup.js',
  'backend/eslint.config.js',
  'backend/tsconfig.json',
  'backend/package.json',
  'backend/package-lock.json',
  'frontend/eslint.config.mjs',
  'frontend/tsconfig.json',
  'frontend/package.json',
  'frontend/package-lock.json',
  'backend/src/scripts/verify-scoped.ts',        // the scoper itself
  'backend/src/scripts/verify-scoped.test.ts',   // …and its pins
];

const BACKEND_CODE_RE = /^backend\/(?:src|scripts)\/.*\.(?:[cm]?[jt]sx?)$/;
const BACKEND_LINT_RE = /^backend\/src\/.*\.(?:[cm]?[jt]sx?)$/; // full lint is `eslint src` — scripts/ is NOT covered
const BACKEND_TEST_RE = /^backend\/(?:src|scripts)\/.*\.test\.tsx?$/; // anchored (review F12): a non-backend .test.ts must not enter inputFiles
const FRONTEND_LINT_RE = /^frontend\/.*\.(?:[cm]?[jt]sx?)$/;

const truthy = (v: string | undefined) => v === '1' || v === 'true' || v === 'on';
const lines = (out: string): string[] =>
  [...new Set(String(out || '').split('\n').map((l) => l.trim()).filter(Boolean))];

// ── Changed-file detection ───────────────────────────────────────────────────
export type GitRunner = (args: string[], cwd: string) => string;

export const defaultGitRunner: GitRunner = (args, cwd) =>
  // core.quotePath=false: a non-ASCII path must reach the planner raw — the
  // default C-quoting ("caf\u00e9.ts") defeats BACKEND_CODE_RE and exists()
  // (review F5: a quoted name fail-OPENED to the smoke set). A path that is
  // STILL quoted (embedded quote/control char) is caught by the belt below
  // and fails closed to the full suite.
  execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

export interface ChangedFiles { files: string[]; source: string }

/**
 * Files the lane's verify should answer for, repo-root-relative:
 * dirty tree + staged + untracked; on a CLEAN tree, the branch's own commits
 * vs merge-base origin/<base> (the post-commit verify — lanes commit before
 * verifying). Throws on any git failure — callers fail closed to FULL.
 *
 * --no-renames everywhere (review F4): a rename must surface as BOTH sides
 * (D old + A new). With rename detection on, `--name-only` lists only the NEW
 * path — the old path's importers are then invisible to the planner while the
 * deleted-source guard never fires. Split, the old side hits the guard and
 * the plan fails closed to the full suite, whose runtime breakage is the
 * honest answer for a rename.
 */
export function listChangedFiles(run: GitRunner, cwd: string, baseBranch: string): ChangedFiles {
  const raw = [
    run(['diff', '--name-only', '--no-renames', 'HEAD'], cwd),
    run(['diff', '--name-only', '--no-renames', '--cached'], cwd),
    run(['ls-files', '--others', '--exclude-standard'], cwd),
  ].join('\n');
  // Belt: a path that is STILL quoted with core.quotePath=false carries an
  // embedded quote/control char the planner cannot trust — fail closed.
  const firstQuoted = lines(raw).find((l) => l.startsWith('"'));
  if (firstQuoted) throw new Error(`untrustworthy path in git output (${firstQuoted.slice(0, 40)}…) — fail closed`);
  const dirty = lines(raw);
  if (dirty.length) return { files: dirty, source: 'worktree (dirty + staged + untracked)' };
  const base = run(['merge-base', `origin/${baseBranch}`, 'HEAD'], cwd).trim();
  if (!base) throw new Error(`no merge-base vs origin/${baseBranch}`);
  const out = run(['diff', '--name-only', '--no-renames', base, 'HEAD'], cwd);
  const firstQuotedBase = lines(out).find((l) => l.startsWith('"'));
  if (firstQuotedBase) throw new Error(`untrustworthy path in git output (${firstQuotedBase.slice(0, 40)}…) — fail closed`);
  return {
    files: lines(out),
    source: `branch commits vs merge-base ${base.slice(0, 8)}`,
  };
}

// ── Related-test resolution ──────────────────────────────────────────────────
export type RelatedResolver = (backendRelFiles: string[]) => string[];

/** Default resolver: the project's own jest (`--findRelatedTests --listTests`),
 *  returning backend-root-relative test paths. Throws → planner fails closed. */
export const makeJestResolver = (backendDir: string): RelatedResolver => (files) => {
  const out = execFileSync('npx', ['jest', '--findRelatedTests', '--listTests', ...files], {
    cwd: backendDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  return lines(out).map((abs) => path.relative(backendDir, abs));
};

// ── Plans ────────────────────────────────────────────────────────────────────
export type Scope = 'scoped' | 'smoke' | 'full';

export interface TestPlan {
  scope: Scope; reason: string; changedCount: number; source: string;
  /** Backend-root-relative test files the scoped run covers (cap decision). */
  testFiles: string[];
  /** Backend-root-relative INPUT files handed to `jest --findRelatedTests`. */
  inputFiles: string[];
}

export interface LintPackagePlan { scope: Scope | 'none'; files: string[] }
export interface LintPlan {
  scope: Scope | 'none'; reason: string; changedCount: number; source: string;
  backend: LintPackagePlan; frontend: LintPackagePlan;
}

export interface PlanOptions {
  cwd: string;
  baseBranch?: string;
  env?: Record<string, string | undefined>;
  run?: GitRunner;
  findRelated?: RelatedResolver;
}

const forceFullHit = (files: string[]): string | null => {
  for (const f of files) {
    const hit = FORCE_FULL_PREFIXES.find((p) => f === p || f.startsWith(p));
    if (hit) return hit;
  }
  return null;
};

/** Plan the `test` stage. Pure aside from the injected git runner, resolver
 *  and fs existence checks — every failure path returns scope:'full'. */
export function planTestStage(opts: PlanOptions): TestPlan {
  const cwd = opts.cwd;
  const base = opts.baseBranch || 'main';
  const env = opts.env || process.env;
  const run = opts.run || defaultGitRunner;
  const basePlan = { changedCount: 0, source: '', testFiles: [] as string[], inputFiles: [] as string[] };
  if (truthy(env[KILL_SWITCH])) return { ...basePlan, scope: 'full', reason: `kill switch ${KILL_SWITCH}=1` };

  let changed: ChangedFiles;
  try {
    changed = listChangedFiles(run, cwd, base);
  } catch (e: any) {
    return { ...basePlan, scope: 'full', reason: `changed-file detection failed (${e?.message || e}) — fail closed` };
  }
  const files = changed.files;
  const full = (reason: string): TestPlan => ({ scope: 'full', reason, changedCount: files.length, source: changed.source, testFiles: [], inputFiles: [] });
  const smoke = (reason: string): TestPlan => ({ scope: 'smoke', reason, changedCount: files.length, source: changed.source, testFiles: [], inputFiles: [] });

  const hit = forceFullHit(files);
  if (hit) return full(`force-full surface changed (${hit})`);
  if (files.length > FULL_IF_CHANGED_MAX) return full(`${files.length} changed file(s) > cap ${FULL_IF_CHANGED_MAX}`);

  const exists = (f: string) => fs.existsSync(path.join(cwd, f));
  const code = files.filter((f) => BACKEND_CODE_RE.test(f) && exists(f));
  const deletedCode = files.filter((f) => BACKEND_CODE_RE.test(f) && !exists(f));
  // A DELETED backend source file fails closed to the full suite: its blast
  // radius is not derivable (jest --findRelatedTests cannot map the importers
  // of a file that no longer exists, and the tests that imported it fail at
  // RUNTIME — only the full suite catches that; typecheck catches the types).
  if (deletedCode.length) {
    return full(`deleted backend source file(s) — blast radius not derivable (${deletedCode.slice(0, 2).join(', ')}${deletedCode.length > 2 ? ', …' : ''})`);
  }
  const changedTests = files.filter((f) => BACKEND_TEST_RE.test(f) && exists(f));
  const strip = (f: string) => f.replace(/^backend\//, '');

  if (!code.length && !changedTests.length) {
    if (!files.length) return smoke(`nothing changed vs origin/${base}`);
    return smoke(`no backend code/test file changed (${files.length} non-code file(s): ${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''})`);
  }

  const inputFiles = [...new Set([...code, ...changedTests].map(strip))];
  let related: string[];
  try {
    related = (opts.findRelated || makeJestResolver(path.join(cwd, 'backend')))(inputFiles);
  } catch (e: any) {
    return full(`related-test resolution failed (${e?.message || e}) — fail closed`);
  }
  const testFiles = [...new Set([...related, ...changedTests.map(strip)])];
  if (testFiles.length >= FULL_IF_RELATED_MIN) {
    return full(`${testFiles.length} related test(s) ≥ cap ${FULL_IF_RELATED_MIN}`);
  }
  if (!testFiles.length) return smoke('no related test resolved for the changed files');
  return { scope: 'scoped', reason: `${inputFiles.length} changed backend file(s) → ${testFiles.length} related test(s) (cap ${FULL_IF_RELATED_MIN})`, changedCount: files.length, source: changed.source, testFiles, inputFiles };
}

/** Plan the `lint` stage. Scoped lint is never STRICTER than full lint: only
 *  files the package's own `npm run lint` would have linted are passed. */
export function planLintStage(opts: PlanOptions): LintPlan {
  const cwd = opts.cwd;
  const env = opts.env || process.env;
  const run = opts.run || defaultGitRunner;
  const empty: LintPlan = { scope: 'none', reason: '', changedCount: 0, source: '', backend: { scope: 'none', files: [] }, frontend: { scope: 'none', files: [] } };
  if (truthy(env[KILL_SWITCH])) return { ...empty, scope: 'full', reason: `kill switch ${KILL_SWITCH}=1`, backend: { scope: 'full', files: [] }, frontend: { scope: 'full', files: [] } };

  let changed: ChangedFiles;
  try {
    changed = listChangedFiles(run, cwd, opts.baseBranch || 'main');
  } catch (e: any) {
    return { ...empty, scope: 'full', reason: `changed-file detection failed (${e?.message || e}) — fail closed`, backend: { scope: 'full', files: [] }, frontend: { scope: 'full', files: [] } };
  }
  const files = changed.files;
  const both = (scope: Scope | 'none', reason: string): LintPlan => ({
    scope, reason, changedCount: files.length, source: changed.source,
    backend: { scope, files: [] }, frontend: { scope, files: [] },
  });
  const hit = forceFullHit(files);
  if (hit) return both('full', `force-full surface changed (${hit})`);

  const exists = (f: string) => fs.existsSync(path.join(cwd, f));
  const backendFiles = files.filter((f) => BACKEND_LINT_RE.test(f) && exists(f));
  const frontendFiles = files.filter((f) => FRONTEND_LINT_RE.test(f) && exists(f));
  const backend: LintPackagePlan = backendFiles.length >= LINT_FULL_IF_FILES_MIN
    ? { scope: 'full', files: [] }
    : { scope: backendFiles.length ? 'scoped' : 'none', files: backendFiles.map((f) => f.replace(/^backend\//, '')) };
  const frontend: LintPackagePlan = frontendFiles.length >= LINT_FULL_IF_FILES_MIN
    ? { scope: 'full', files: [] }
    : { scope: frontendFiles.length ? 'scoped' : 'none', files: frontendFiles.map((f) => f.replace(/^frontend\//, '')) };

  const reason = !files.length
    ? 'nothing changed vs base'
    : `${files.length} changed file(s) — backend: ${backendFiles.length} lintable, frontend: ${frontendFiles.length} lintable`;
  return { scope: backend.scope === 'full' || frontend.scope === 'full' ? 'full' : (backend.scope === 'scoped' || frontend.scope === 'scoped' ? 'scoped' : 'none'), reason, changedCount: files.length, source: changed.source, backend, frontend };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const CI_NOTE = 'the FULL suite runs in CI on the un-scoped paths (ci.yml push/workflow_call/dispatch Backend tests + nightly-full-suite.yml; the deploy test gate still needs it green) — merge gates still require it green';

function spawnInherit(cmd: string, args: string[], cwd: string): number {
  const r = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.error) {
    console.error(`verify-scoped: failed to spawn ${cmd}: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

export function usage(): string {
  return 'usage: verify-scoped.ts --stage <test|lint> [--plan] [--root <worktree>] (env: SCOPED_VERIFY_DISABLED=1 restores the full chain)';
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const val = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const stage = val('--stage') || argv.find((a) => a === 'test' || a === 'lint');
  const planOnly = argv.includes('--plan');
  const root = val('--root') || WORKTREE_ROOT;
  if (stage !== 'test' && stage !== 'lint') { console.error(usage()); return 2; }
  const opts: PlanOptions = { cwd: root, baseBranch: 'main', env: process.env };

  if (stage === 'test') {
    const plan = planTestStage(opts);
    console.error(`verify-scoped[test]: ${plan.scope} — ${plan.reason} [${plan.source || 'n/a'}]; ${CI_NOTE}`);
    if (planOnly) { console.log(JSON.stringify(plan)); return 0; }
    if (plan.scope === 'full') {
      console.error('verify-scoped[test]: running the FULL suite');
      return spawnInherit('npx', ['jest', ...JEST_ARGSETS.full], BACKEND_DIR);
    }
    if (plan.scope === 'smoke') {
      console.error(`verify-scoped[test]: running the smoke set (${SMOKE_TEST_FILES.length} suites)`);
      return spawnInherit('npx', ['jest', ...SMOKE_TEST_FILES, ...JEST_ARGSETS.smoke], BACKEND_DIR);
    }
    return spawnInherit('npx', ['jest', '--findRelatedTests', ...plan.inputFiles, ...JEST_ARGSETS.scoped], BACKEND_DIR);
  }

  const plan = planLintStage(opts);
  console.error(`verify-scoped[lint]: ${plan.scope} — ${plan.reason} [${plan.source || 'n/a'}]`);
  if (planOnly) { console.log(JSON.stringify(plan)); return 0; }
  let exit = 0;
  if (plan.backend.scope === 'full') { console.error('verify-scoped[lint]: backend — FULL lint'); exit = exit || spawnInherit('npm', ['run', 'lint'], BACKEND_DIR); }
  else if (plan.backend.scope === 'scoped') exit = exit || spawnInherit('npx', ['eslint', ...plan.backend.files, '--ext', '.ts', '--no-error-on-unmatched-pattern'], BACKEND_DIR);
  else console.error('verify-scoped[lint]: backend — nothing lintable changed, leg skipped');
  if (plan.frontend.scope === 'full') { console.error('verify-scoped[lint]: frontend — FULL lint'); exit = exit || spawnInherit('npm', ['run', 'lint'], path.join(WORKTREE_ROOT, 'frontend')); }
  else if (plan.frontend.scope === 'scoped') exit = exit || spawnInherit('npx', ['eslint', ...plan.frontend.files], path.join(WORKTREE_ROOT, 'frontend'));
  else console.error('verify-scoped[lint]: frontend — nothing lintable changed, leg skipped');
  return exit;
}

if (require.main === module) process.exit(main());
