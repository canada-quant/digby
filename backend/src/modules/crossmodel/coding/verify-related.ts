/**
 * Related-tests-first verify (harness roadmap item 8a, autonomy loop #7,
 * 2026-09-19) — test-impact selection.
 *
 * A lane's `verify` runs the project's WHOLE test suite (crossmodel: ~5 min
 * of jest) even when it changed one file. Jest and Vitest both know which
 * tests import a changed file (`jest --findRelatedTests`, `vitest related`),
 * so the chain now runs that subset FIRST as a `test:related` stage:
 *   - subset FAILS → the chain stops there (a failing subset implies the full
 *     suite fails — it is a superset) and the lane gets its red in seconds;
 *   - subset passes / cannot run → the full `test` stage runs exactly as before
 *     (verify stays the check of record; a green subset is never a green chain).
 * Changed files come from git (worked tree + index + untracked) and are made
 * relative to the command's `cd <dir> &&` prefix; a change set over
 * RELATED_MAX_FILES, a multi-step command, or a non-jest/vitest runner derives
 * nothing and the chain is unchanged.
 */

export const RELATED_MAX_FILES = 40;
export const RELATED_STAGE_KEY = 'test:related';

const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** `npm run x` / `npm test` / `pnpm (run) x` / `yarn (run) x` → the package-manager, script name. Pure. */
export function parsePackageScript(run: string): { pm: 'npm' | 'pnpm' | 'yarn'; script: string } | null {
  const m = run.match(/^(?:npx\s+)?(npm|pnpm|yarn)\s+(?:run\s+)?([A-Za-z0-9:_.-]+)\s*$/);
  if (!m) return null;
  const pm = m[1] as 'npm' | 'pnpm' | 'yarn';
  const script = m[2];
  if (pm !== 'yarn' && script === 'run') return null;
  return { pm, script };
}

export type ReadPackageScript = (dir: string, script: string) => Promise<string | null>;

/**
 * Derive the related-tests command from the project's test command.
 * Accepts a SINGLE jest or vitest invocation, optionally behind one
 * `cd <dir> &&` prefix — either written out (`npx jest`) or behind a package
 * script (`npm run test`, `pnpm test`, `yarn test`) whose body `readScript`
 * resolves from `<dir>/package.json` (live 2026-09-20: the first lane to reach
 * the stage ran `npm run test`, so nothing derived). Anything else (chains,
 * other runners) → null. Files outside the prefix directory are dropped; none
 * left → null.
 */
export async function deriveRelatedTestCommand(testCommand: string, changedFiles: string[], readScript?: ReadPackageScript): Promise<string | null> {
  const cmd = String(testCommand || '').trim();
  if (!cmd) return null;
  const m = cmd.match(/^(?:cd\s+([^\s&;|]+)\s*&&\s*)?([^&;|]+)$/);
  if (!m) return null; // more than one step — not scopable
  const dir = (m[1] || '').replace(/^\.\//, '').replace(/\/+$/, '');
  const run = m[2].trim();
  // A package script: resolve its body and treat that as the runner. Args are
  // appended THROUGH the script (`npm run test -- <args>`), so the script's own
  // env/config flags stay in force; vitest's `related` is a subcommand that
  // cannot ride behind `vitest run`, so it is invoked directly in the same dir.
  const pkg = parsePackageScript(run);
  let runner = run;
  let via: { pm: 'npm' | 'pnpm' | 'yarn'; script: string } | null = null;
  if (pkg) {
    if (!readScript) return null;
    const body = (await readScript(dir || '.', pkg.script).catch(() => null)) ?? '';
    if (!body || /&&|;|\|\|/.test(body)) return null;
    runner = body.trim();
    via = pkg;
  }
  const isJest = /\bjest\b/.test(runner);
  const isVitest = /\bvitest\b/.test(runner);
  if (!isJest && !isVitest) return null;
  if (/--findRelatedTests|\brelated\b|--changedSince|--onlyChanged|\s-o\b/.test(runner)) return null; // already scoped by the project
  const files = changedFiles
    .map((f) => f.replace(/^\.?\//, ''))
    .filter((f) => f && SOURCE_FILE_RE.test(f))
    .filter((f) => !dir || f === dir || f.startsWith(`${dir}/`))
    .map((f) => (dir && f.startsWith(`${dir}/`) ? f.slice(dir.length + 1) : f))
    .filter((f) => f && f !== dir);
  const unique = [...new Set(files)];
  if (!unique.length || unique.length > RELATED_MAX_FILES) return null;
  const quoted = unique.map(quote).join(' ');
  let scoped: string;
  if (isJest) {
    const args = `--findRelatedTests ${quoted} --passWithNoTests`;
    scoped = via ? `${run} ${via.pm === 'yarn' ? '' : '-- '}${args}` : `${run} ${args}`;
  } else if (via) {
    scoped = `npx vitest related ${quoted} --run --passWithNoTests`;
  } else {
    // `vitest related` is a subcommand: it must follow the binary, before any flags.
    scoped = `${run.replace(/\bvitest\b/, 'vitest related ' + quoted)} --run --passWithNoTests`;
  }
  return `${dir ? `cd ${dir} && ` : ''}${scoped}`;
}

type ExecShell = (command: string, cwd?: string, timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>;

/**
 * Changed files in the worktree: modified + staged + untracked (git). When the
 * worked tree is CLEAN (lanes commit before they verify — the crossmodel nightly
 * lane's 23:53Z verify ran on a clean tree, so nothing derived), fall back to
 * the branch's own commits against the base branch (`merge-base origin/<base>`).
 * [] on any failure.
 */
export async function listChangedFiles(execShell: ExecShell, worktree: string, baseBranch = 'main'): Promise<string[]> {
  const parse = (out: string) => [...new Set(String(out || '').split('\n').map((l) => l.trim()).filter(Boolean))].slice(0, RELATED_MAX_FILES + 1);
  try {
    const { stdout } = await execShell(
      'git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null',
      worktree, 20_000,
    );
    const dirty = parse(stdout);
    if (dirty.length) return dirty;
    const base = String(baseBranch || 'main').replace(/[^A-Za-z0-9._/-]/g, '');
    const branch = await execShell(
      `B=$(git merge-base origin/${base} HEAD 2>/dev/null || git merge-base ${base} HEAD 2>/dev/null); [ -n "$B" ] && git diff --name-only "$B" HEAD 2>/dev/null`,
      worktree, 20_000,
    );
    return parse(branch.stdout);
  } catch {
    return [];
  }
}

/** Read `<dir>/package.json` scripts[name] through the worktree shell. null when absent/unparseable. */
export function packageScriptReader(execShell: ExecShell, worktree: string): ReadPackageScript {
  return async (dir, script) => {
    try {
      const rel = dir && dir !== '.' ? `${dir.replace(/'/g, '')}/package.json` : 'package.json';
      const { stdout } = await execShell(`cat ${quote(rel)} 2>/dev/null`, worktree, 10_000);
      const scripts = JSON.parse(String(stdout || '{}'))?.scripts;
      const body = scripts && typeof scripts[script] === 'string' ? scripts[script] : null;
      return body && body.length <= 500 ? body : null;
    } catch {
      return null;
    }
  };
}
