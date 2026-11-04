/**
 * B2 (repo-integrity remediation, 2026-09-09) — the .digby framework is
 * COMMITTABLE: installWorktreeExcludes excludes ONLY `.digby/session/`
 * (runtime scratch, incl. the secret-bearing env.sh), not the whole `.digby/`.
 *
 * Real bug: the blanket `.digby/` info/exclude made the scaffold's
 * `git add AGENTS.md .digby …` fail ("paths are ignored"), so the scaffold
 * commit NEVER landed (committed:false forever), the framework files
 * (config.json, notes/learnings.md) never reached the branch, and every
 * re-provision re-scaffolded a stub — silently discarding lane learnings.
 *
 * Uses real git in a temp repo (the git_show pattern in tools.test.ts).
 */

// Post-P0 merge, scaffolding's import graph can reach config/env (fail-fast
// zod validation that process.exit(1)s without env) — satisfy the schema
// before any import runs (worker.test.ts convention).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-at-least-32-chars!!';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// project-lock (new workspace.service dependency, todo fed7731d) pulls
// config/redis → config/env (process.exit at import) — same boundary mock.
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(async () => 'OK'), eval: jest.fn(async () => 1) },
}));

import { installWorktreeExcludes } from './workspace.service';
import { scaffoldProjectDocs } from './scaffolding.service';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

describe('B2: scaffold commit tracks the .digby framework', () => {
  let dir: string;
  const sh = (args: string[]): string => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'digby-b2-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    sh(['config', 'user.email', 't@example.com']);
    sh(['config', 'user.name', 't']);
    await fs.writeFile(path.join(dir, 'seed.txt'), 'seed\n');
    sh(['add', '.']);
    sh(['commit', '-qm', 'seed']);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('committed:true — AGENTS.md AND the .digby framework land in the scaffold commit; .digby/session/ stays excluded', async () => {
    await installWorktreeExcludes(dir);
    const r = await scaffoldProjectDocs(dir, { projectName: 'b2-proj', defaultBranch: 'main' }); // commit defaults ON
    expect(r.scaffolded).toBe(true);
    expect(r.committed).toBe(true); // the missing pin — was silently false under the blanket exclude

    const tracked = sh(['ls-files']).split('\n');
    expect(tracked).toEqual(expect.arrayContaining([
      'AGENTS.md', '.digbyignore', '.digby/config.json', '.digby/README.md', '.digby/notes/learnings.md',
    ]));

    // Runtime scratch (secrets!) is still git-invisible: env.sh never shows up.
    await fs.mkdir(path.join(dir, '.digby', 'session'), { recursive: true });
    await fs.writeFile(path.join(dir, '.digby', 'session', 'env.sh'), 'export SECRET=1\n');
    expect(sh(['status', '--porcelain']).trim()).toBe('');
  });

  it('lane learnings appended to .digby/notes/learnings.md are commit-visible (git add -A stages them)', async () => {
    await installWorktreeExcludes(dir);
    await scaffoldProjectDocs(dir, { projectName: 'b2-proj', defaultBranch: 'main' });
    await fs.appendFile(path.join(dir, '.digby', 'notes', 'learnings.md'), '- Tests need Postgres up first.\n');
    sh(['add', '-A']);
    sh(['commit', '-qm', 'learn']);
    expect(sh(['show', 'HEAD:.digby/notes/learnings.md'])).toContain('Tests need Postgres up first');
  });

  it('migrates a pre-B2 blanket `.digby/` exclude in place', async () => {
    const excludePath = path.join(dir, '.git', 'info', 'exclude');
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    await fs.appendFile(excludePath, '\n# Digby Code harness scratch — never commit\n.digby/\n');
    await installWorktreeExcludes(dir);
    const cur = await fs.readFile(excludePath, 'utf8');
    expect(cur).toContain('.digby/session/');
    expect(cur).not.toMatch(/^\.digby\/$/m);
  });
});
