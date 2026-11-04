/**
 * Tests for scaffolding.service: ground-truth stack detection + file rendering +
 * the respect-existing-AGENTS.md behaviour. Filesystem-only (commit:false), no git.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  assessDocsHealth, commandsFingerprint, detectStack, ensureProjectDocs, nonTemplateHeadings,
  refreshProjectDocs, renderAgentsMd, renderConfigJson, renderDigbyIgnore, scaffoldProjectDocs,
} from './scaffolding.service';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'digby-scaffold-'));
}

describe('detectStack', () => {
  test('detects a TypeScript / Next.js project + verified-shape commands', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      dependencies: { next: '^16.0.0', react: '^19.0.0' },
      devDependencies: { typescript: '^5.4.0' },
      scripts: { dev: 'next dev', build: 'next build', test: 'jest', lint: 'eslint .' },
    }));
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
    await fs.writeFile(path.join(dir, 'tsconfig.json'), '{}');

    const stack = await detectStack(dir);
    expect(stack.empty).toBe(false);
    expect(stack.label).toContain('TypeScript');
    expect(stack.label).toContain('Next.js 16');
    expect(stack.cmd.install).toBe('npm install');
    expect(stack.cmd.dev).toBe('npm run dev');
    expect(stack.cmd.test).toBe('npm run test');
    // typecheck falls back to tsc for a TS project with no explicit script.
    expect(stack.cmd.typecheck).toBe('npx tsc --noEmit');
    // verify chain is cheapest-first and only includes present commands.
    expect(stack.verify).toEqual(['typecheck', 'lint', 'test']);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('picks pnpm from the lockfile', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), '');
    const stack = await detectStack(dir);
    expect(stack.cmd.install).toBe('pnpm install');
    expect(stack.cmd.test).toBe('pnpm test');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('Python without mypy has no typecheck in the verify chain', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'pyproject.toml'), '[tool.pytest.ini_options]\n[tool.ruff]\n');
    const stack = await detectStack(dir);
    expect(stack.label).toBe('Python');
    expect(stack.cmd.typecheck).toBeNull();
    expect(stack.verify).not.toContain('typecheck');
    expect(stack.verify).toContain('test');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('an empty dir is detected as blank', async () => {
    const dir = await tmpDir();
    const stack = await detectStack(dir);
    expect(stack.empty).toBe(true);
    expect(stack.label).toBe('');
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('renderers', () => {
  test('AGENTS.md is lean + project-specific (no restated generic doctrine)', async () => {
    const dir = await tmpDir();
    const stack = await detectStack(dir); // blank
    const md = renderAgentsMd('my-proj', 'main', stack);
    expect(md).toContain('# my-proj');
    expect(md).toContain('to be decided');
    expect(md).toContain('Done means verified');
    // Invariant doctrine must NOT be duplicated into the per-project file: no mode
    // definitions, no restated destructive-command safety list.
    expect(md).not.toMatch(/AUTO mode:|ASK mode:|PLAN mode:/);
    expect(md).not.toMatch(/rm -rf/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('AGENTS.md teaches the machine-final CLAIMS block contract (audit #6 phase 1)', async () => {
    const dir = await tmpDir();
    const md = renderAgentsMd('my-proj', 'main', await detectStack(dir));
    expect(md).toContain('Machine-run finals — claims block');
    expect(md).toContain('```claims'); // ONE worked example, fenced
    // The full vocabulary, in contract order — the finish_run type set
    // (ticket 6d7b379f; reviewer M1: this template IS a type-list surface):
    for (const t of ['push', 'pr', 'merge', 'deploy', 'commit', 'ticket_update', 'message_sent', 'dispatch', 'file_change', 'verify', 'schedule_armed', 'email_sent', 'state_update']) {
      expect(md).toContain(`\`${t}\``);
    }
    expect(md).toContain('marked UNVERIFIED');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('config.json is valid JSON with the expected shape', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'go.mod'), 'module x\n');
    const stack = await detectStack(dir);
    const cfg = JSON.parse(renderConfigJson('trunk', stack));
    expect(cfg.defaultBranch).toBe('trunk');
    expect(cfg.verified).toBe(false);
    expect(cfg.commands.test).toBe('go test ./...');
    expect(Array.isArray(cfg.verify)).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('.digbyignore blocks real .env but allows templates', () => {
    const ig = renderDigbyIgnore();
    expect(ig).toMatch(/^\.env$/m);
    expect(ig).toContain('!.env.example');
  });
});

describe('scaffoldProjectDocs', () => {
  test('writes AGENTS.md + .digby framework into a blank worktree (no commit)', async () => {
    const dir = await tmpDir();
    const r = await scaffoldProjectDocs(dir, { projectName: 'scratch', defaultBranch: 'main', commit: false });
    expect(r.wroteAgentsMd).toBe(true);
    expect(r.wroteFramework).toBe(true);
    expect(r.committed).toBe(false);
    await expect(fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8')).resolves.toContain('# scratch');
    await expect(fs.readFile(path.join(dir, '.digby', 'config.json'), 'utf8')).resolves.toContain('"version"');
    await expect(fs.access(path.join(dir, '.digbyignore'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, '.digby', 'notes', 'learnings.md'))).resolves.toBeUndefined();
    // P6 (B10/G10): the always-injected current-state rule ships in the scaffold set.
    const rule = await fs.readFile(path.join(dir, '.digby', 'rules', '00-current-state.md'), 'utf8');
    expect(rule).toContain('# Current state');
    expect(rule).toContain('injected into EVERY run');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('respects an existing AGENTS.md (never clobbers)', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'AGENTS.md'), '# Hand-written\nkeep me\n');
    const r = await scaffoldProjectDocs(dir, { projectName: 'x', commit: false });
    expect(r.wroteAgentsMd).toBe(false);
    // The .digby framework is still added alongside the user's file.
    expect(r.wroteFramework).toBe(true);
    await expect(fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8')).resolves.toBe('# Hand-written\nkeep me\n');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('is a no-op when both AGENTS.md and .digby already exist', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'AGENTS.md'), '# x\n');
    await fs.mkdir(path.join(dir, '.digby'), { recursive: true });
    const r = await scaffoldProjectDocs(dir, { projectName: 'x', commit: false });
    expect(r.scaffolded).toBe(false);
    expect(r.reason).toMatch(/respecting repo/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('docs health', () => {
  /** A minimal TypeScript/npm project at the worktree ROOT. */
  async function scaffoldNode(dir: string): Promise<void> {
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      devDependencies: { typescript: '^5.4.0' },
      scripts: { build: 'tsc' },
    }));
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
    await fs.writeFile(path.join(dir, 'tsconfig.json'), '{}');
  }

  test('new AGENTS.md carries the scaffold marker; a blank scaffold assesses as scaffold-untouched', async () => {
    const dir = await tmpDir();
    await scaffoldProjectDocs(dir, { projectName: 'scratch', defaultBranch: 'main', commit: false });
    const md = await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8');
    expect(md.startsWith('<!-- digby:scaffold v1 -->')).toBe(true);
    const health = await assessDocsHealth(dir);
    expect(health.guide).toBe('scaffold-untouched');
    expect(health.hasAgentsMd).toBe(true);
    expect(health.hasDigby).toBe(true);
    expect(health.drift).toEqual([]);
    expect(health.autoRefreshable).toBe(false); // blank — nothing better to say yet
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("legacy guide: 'to be decided' without a marker is still scaffold-untouched (the incident signature)", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'AGENTS.md'), '# old\nStack: **to be decided**\n');
    const health = await assessDocsHealth(dir);
    expect(health.guide).toBe('scaffold-untouched');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("a hand-written guide containing the bare phrase 'to be decided' is NOT a scaffold", async () => {
    const dir = await tmpDir();
    const guide = '# Our deploy runbook\n\nThe canary percentage is to be decided by on-call.\n';
    await fs.writeFile(path.join(dir, 'AGENTS.md'), guide);
    const health = await assessDocsHealth(dir);
    expect(health.guide).toBe('handwritten');
    const r = await refreshProjectDocs(dir, { projectName: 'runbook', commit: false, health });
    expect(r.rewroteAgentsMd).toBe(false);
    await expect(fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8')).resolves.toBe(guide);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('flat repo (no subdirectories): the untouched scaffold is still detected and refreshed', async () => {
    const dir = await tmpDir();
    // A stack but NO subdirectories — the structure section falls back to the
    // flat-repo stub placeholder, which must still count as "unedited scaffold".
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      devDependencies: { typescript: '^5.4.0' }, scripts: { build: 'tsc' },
    }));
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
    await scaffoldProjectDocs(dir, { projectName: 'flat', defaultBranch: 'main', commit: false });
    const before = await assessDocsHealth(dir);
    expect(before.guide).toBe('scaffold-untouched'); // NOT scaffold-edited
    // The repo drifts (gains a test script) → the guide must be regenerated.
    const pkgPath = path.join(dir, 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    pkg.scripts.test = 'jest';
    await fs.writeFile(pkgPath, JSON.stringify(pkg), 'utf8');
    const health = await assessDocsHealth(dir);
    expect(health.guide).toBe('scaffold-untouched');
    expect(health.autoRefreshable).toBe(true);
    const r = await refreshProjectDocs(dir, { projectName: 'flat', commit: false, health });
    expect(r.rewroteAgentsMd).toBe(true);
    await expect(fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8')).resolves.toContain('npm run test');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('hand-written guide is never touched by refresh', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'AGENTS.md'), '# Hand-written\nkeep me\n');
    const health = await assessDocsHealth(dir);
    expect(health.guide).toBe('handwritten');
    const r = await refreshProjectDocs(dir, { projectName: 'x', commit: false, health });
    expect(r.rewroteAgentsMd).toBe(false);
    expect(r.refreshed).toBe(false);
    await expect(fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8')).resolves.toBe('# Hand-written\nkeep me\n');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('blank → real stack: refresh regenerates the guide and fills the config, preserving loop + unknown keys', async () => {
    const dir = await tmpDir();
    await scaffoldProjectDocs(dir, { projectName: 'grow', defaultBranch: 'main', commit: false });
    // User tunes loop + adds an unknown key (neither is fingerprinted — both must survive).
    const cfgPath = path.join(dir, '.digby', 'config.json');
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    cfg.loop.maxAutoVerifyIterations = 99;
    cfg.customKey = 'keep';
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    // The project gains a real stack.
    await scaffoldNode(dir);

    const health = await assessDocsHealth(dir);
    expect(health.commandsUserOwned).toBe(false); // docsHash still matches
    expect(health.autoRefreshable).toBe(true);
    expect(health.drift.some(d => d.startsWith('commands.build'))).toBe(true);
    expect(health.drift.some(d => d.startsWith('commands.test'))).toBe(false); // no test script
    expect(health.drift.some(d => d.startsWith('stack:'))).toBe(true);

    const r = await refreshProjectDocs(dir, { projectName: 'grow', commit: false, health });
    expect(r.rewroteAgentsMd).toBe(true);
    expect(r.rewroteConfig).toBe(true);
    const md = await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8');
    expect(md).toContain('TypeScript 5');
    expect(md).not.toContain('to be decided');
    expect(md.startsWith('<!-- digby:scaffold v1 -->')).toBe(true); // regenerated guide keeps the marker
    const next = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    expect(next.commands.build).toBe('npm run build');
    expect(next.commands.typecheck).toBe('npx tsc --noEmit');
    expect(next.loop.maxAutoVerifyIterations).toBe(99);
    expect(next.customKey).toBe('keep');
    expect(next.docsHash).toBe(commandsFingerprint(next.stack, next.commands, next.verify));
    // Steady state: a second assess finds no drift and refresh is a write-noop.
    const after = await assessDocsHealth(dir);
    expect(after.drift).toEqual([]);
    const r2 = await refreshProjectDocs(dir, { projectName: 'grow', commit: false, health: after });
    expect(r2.refreshed).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('scaffold-edited guide (marker but placeholders filled): config refreshes, guide untouched', async () => {
    const dir = await tmpDir();
    await scaffoldNode(dir);
    await scaffoldProjectDocs(dir, { projectName: 'edited', defaultBranch: 'main', commit: false });
    // The user fills in the scaffold's prose (marker survives, placeholders gone).
    const edited = '<!-- digby:scaffold v1 -->\n\n# edited\n\n## Overview\n\nA real project.\n';
    await fs.writeFile(path.join(dir, 'AGENTS.md'), edited, 'utf8');
    // Then the repo drifts (gains a test script).
    const pkgPath = path.join(dir, 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    pkg.scripts.test = 'jest';
    await fs.writeFile(pkgPath, JSON.stringify(pkg), 'utf8');

    const health = await assessDocsHealth(dir);
    expect(health.guide).toBe('scaffold-edited');
    expect(health.drift.some(d => d.startsWith('commands.test'))).toBe(true);
    const r = await refreshProjectDocs(dir, { projectName: 'edited', commit: false, health });
    expect(r.rewroteAgentsMd).toBe(false);
    expect(r.rewroteConfig).toBe(true); // config is still Digby-owned → refreshed
    await expect(fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8')).resolves.toBe(edited);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('pm switch is detected as drift; a user-owned config is never rewritten', async () => {
    const dir = await tmpDir();
    await scaffoldNode(dir);
    await scaffoldProjectDocs(dir, { projectName: 'pm', defaultBranch: 'main', commit: false });
    await fs.rm(path.join(dir, 'package-lock.json'));
    await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), '');
    const health = await assessDocsHealth(dir);
    expect(health.drift.some(d => d.includes('commands.install') && d.includes('pnpm install'))).toBe(true);
    expect(health.commandsUserOwned).toBe(false);
    const r = await refreshProjectDocs(dir, { projectName: 'pm', commit: false, health });
    expect(r.rewroteConfig).toBe(true);
    const cfg = JSON.parse(await fs.readFile(path.join(dir, '.digby', 'config.json'), 'utf8'));
    expect(cfg.commands.install).toBe('pnpm install');
    await fs.rm(dir, { recursive: true, force: true });

    // A user-tuned config (non-null commands, no docsHash) is never rewritten.
    const dir2 = await tmpDir();
    await scaffoldNode(dir2);
    await fs.rm(path.join(dir2, 'package-lock.json'));
    await fs.writeFile(path.join(dir2, 'pnpm-lock.yaml'), '');
    await fs.writeFile(path.join(dir2, 'AGENTS.md'), '# mine\n');
    await fs.mkdir(path.join(dir2, '.digby'), { recursive: true });
    const userCfg = {
      version: 1, defaultBranch: 'main', stack: 'TypeScript 5',
      commands: { install: 'npm install', build: 'npm run build', typecheck: 'npx tsc --noEmit' },
      verify: ['typecheck'],
    };
    await fs.writeFile(path.join(dir2, '.digby', 'config.json'), JSON.stringify(userCfg, null, 2) + '\n', 'utf8');
    const health2 = await assessDocsHealth(dir2);
    expect(health2.commandsUserOwned).toBe(true);
    expect(health2.drift.length).toBeGreaterThan(0);
    expect(health2.autoRefreshable).toBe(false);
    const r2 = await refreshProjectDocs(dir2, { projectName: 'pm2', commit: false, health: health2 });
    expect(r2.rewroteConfig).toBe(false);
    const cfg2 = JSON.parse(await fs.readFile(path.join(dir2, '.digby', 'config.json'), 'utf8'));
    expect(cfg2.commands.install).toBe('npm install'); // untouched
    await fs.rm(dir2, { recursive: true, force: true });
  });

  test('monorepo guard: no root manifest + hand-maintained config → zero drift, zero writes', async () => {
    const dir = await tmpDir();
    await fs.mkdir(path.join(dir, 'backend'));
    await fs.mkdir(path.join(dir, 'frontend'));
    await fs.writeFile(path.join(dir, 'AGENTS.md'), '# mono\nHand-maintained.\n');
    await fs.mkdir(path.join(dir, '.digby'), { recursive: true });
    const cfg = {
      version: 1, defaultBranch: 'main', stack: 'TypeScript — Express + Next.js',
      commands: { typecheck: 'cd backend && npx tsc --noEmit', lint: 'cd backend && npm run lint', test: 'cd backend && npx jest' },
      verify: ['typecheck', 'lint', 'test'],
    };
    await fs.writeFile(path.join(dir, '.digby', 'config.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    const before = await fs.readFile(path.join(dir, '.digby', 'config.json'), 'utf8');
    const health = await assessDocsHealth(dir);
    expect(health.fresh.empty).toBe(true);
    expect(health.drift).toEqual([]);
    expect(health.commandsUserOwned).toBe(true);
    expect(health.autoRefreshable).toBe(false);
    const r = await refreshProjectDocs(dir, { projectName: 'mono', commit: false, health });
    expect(r.refreshed).toBe(false);
    await expect(fs.readFile(path.join(dir, '.digby', 'config.json'), 'utf8')).resolves.toBe(before);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('command rewrite forces verified:false; non-command drift preserves verified:true', async () => {
    const dir = await tmpDir();
    await scaffoldNode(dir);
    await scaffoldProjectDocs(dir, { projectName: 'honesty', defaultBranch: 'main', commit: false });
    const cfgPath = path.join(dir, '.digby', 'config.json');
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    cfg.verified = true; // a human probe-ran the commands (docsHash doesn't cover this field)
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    // Phase A: stack-label-only drift (framework added) — commands unchanged.
    const pkgPath = path.join(dir, 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    pkg.dependencies = { express: '^4.18.0' };
    await fs.writeFile(pkgPath, JSON.stringify(pkg), 'utf8');
    let health = await assessDocsHealth(dir);
    expect(health.drift).toEqual(['stack: "TypeScript 5.4" → "TypeScript 5.4 / Express 4.18"']);
    let r = await refreshProjectDocs(dir, { projectName: 'honesty', commit: false, health });
    expect(r.rewroteConfig).toBe(true);
    let next = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    expect(next.verified).toBe(true); // the probe still holds
    expect(next.stack).toBe('TypeScript 5.4 / Express 4.18');

    // Phase B: a command appears → verified flips back to false (detected-not-probed).
    pkg.scripts.test = 'jest';
    await fs.writeFile(pkgPath, JSON.stringify(pkg), 'utf8');
    health = await assessDocsHealth(dir);
    expect(health.drift.some(d => d.startsWith('commands.test'))).toBe(true);
    r = await refreshProjectDocs(dir, { projectName: 'honesty', commit: false, health });
    expect(r.rewroteConfig).toBe(true);
    next = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    expect(next.verified).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('docsHealth.autoRefresh=false opts out of all writes', async () => {
    const dir = await tmpDir();
    await scaffoldProjectDocs(dir, { projectName: 'optout', defaultBranch: 'main', commit: false });
    const cfgPath = path.join(dir, '.digby', 'config.json');
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    cfg.docsHealth = { autoRefresh: false };
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    await scaffoldNode(dir);
    const health = await assessDocsHealth(dir);
    expect(health.drift.length).toBeGreaterThan(0);
    expect(health.autoRefreshable).toBe(false);
    const before = await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8');
    const r = await refreshProjectDocs(dir, { projectName: 'optout', commit: false, health });
    expect(r.refreshed).toBe(false);
    expect(r.reason).toMatch(/opted out/);
    await expect(fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8')).resolves.toBe(before);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('ensureProjectDocs composes scaffold + refresh (first provision scaffolds, later drift refreshes)', async () => {
    const dir = await tmpDir();
    const first = await ensureProjectDocs(dir, { projectName: 'combo', defaultBranch: 'main', commit: false });
    expect(first.scaffold.scaffolded).toBe(true);
    expect(first.refresh.refreshed).toBe(false); // nothing better to say on first provision
    await scaffoldNode(dir);
    const second = await ensureProjectDocs(dir, { projectName: 'combo', defaultBranch: 'main', commit: false });
    expect(second.scaffold.scaffolded).toBe(false); // already scaffolded
    expect(second.refresh.refreshed).toBe(true);
    const md = await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8');
    expect(md).toContain('TypeScript 5');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('new configs carry a matching docsHash (Digby-owned)', async () => {
    const dir = await tmpDir();
    await scaffoldNode(dir);
    const cfg = JSON.parse(renderConfigJson('main', await detectStack(dir)));
    expect(cfg.docsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(cfg.docsHash).toBe(commandsFingerprint(cfg.stack, cfg.commands, cfg.verify));
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ── B9 (repo-integrity remediation, 2026-09-09): scaffold regen guard ─────────
// Real bug: a lane APPENDED sections to a scaffold AGENTS.md (as the doctrine
// tells it to) but left the template placeholders intact — refreshProjectDocs
// classified it 'scaffold-untouched', regenerated it wholesale, and
// auto-committed the wipe. A doc with any non-template heading is lane-edited:
// never regenerate it.
describe('B9: scaffold regen guard (lane-appended sections survive refresh)', () => {
  const APPENDED = '\n## Deployment notes\n\n- Deploys go through scripts/release.sh — never push images by hand.\n';

  async function scaffoldNode(dir: string): Promise<void> {
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      devDependencies: { typescript: '^5.4.0' },
      scripts: { build: 'tsc' },
    }));
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
    await fs.writeFile(path.join(dir, 'tsconfig.json'), '{}');
  }

  test('nonTemplateHeadings: pristine template → [], appended section → named, fenced # lines ignored', async () => {
    const dir = await tmpDir();
    const stack = await detectStack(dir); // blank
    const pristine = renderAgentsMd('proj', 'main', stack);
    expect(nonTemplateHeadings(pristine)).toEqual([]);
    expect(nonTemplateHeadings(pristine + APPENDED)).toEqual(['Deployment notes']);
    // A "#" heading inside a code fence is code, not a section.
    expect(nonTemplateHeadings(pristine + '\n```bash\n# not a heading\n```\n')).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a scaffold with a lane-appended section assesses as scaffold-edited (placeholders notwithstanding)', async () => {
    const dir = await tmpDir();
    await scaffoldProjectDocs(dir, { projectName: 'guarded', defaultBranch: 'main', commit: false });
    await fs.appendFile(path.join(dir, 'AGENTS.md'), APPENDED);
    const health = await assessDocsHealth(dir);
    expect(health.guide).toBe('scaffold-edited'); // NOT scaffold-untouched — never regenerated
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a doc with a custom section SURVIVES refresh even when a stale health claims scaffold-untouched (overwrite-site guard)', async () => {
    const dir = await tmpDir();
    await scaffoldProjectDocs(dir, { projectName: 'guarded', defaultBranch: 'main', commit: false });
    const staleHealth = await assessDocsHealth(dir); // captured BEFORE the lane edit
    await fs.appendFile(path.join(dir, 'AGENTS.md'), APPENDED);
    await scaffoldNode(dir); // stack drift appears → a regen would otherwise fire
    const before = await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8');
    const r = await refreshProjectDocs(dir, {
      projectName: 'guarded', commit: false,
      health: { ...staleHealth, fresh: await detectStack(dir), drift: ['stack: null → "TypeScript 5.4"'] },
    });
    expect(r.rewroteAgentsMd).toBe(false);
    expect(r.reason).toMatch(/regeneration refused/);
    expect(r.reason).toContain('Deployment notes');
    await expect(fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8')).resolves.toBe(before);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('end-to-end: ensureProjectDocs after stack drift preserves the appended section (config still refreshes)', async () => {
    const dir = await tmpDir();
    await ensureProjectDocs(dir, { projectName: 'combo9', defaultBranch: 'main', commit: false });
    await fs.appendFile(path.join(dir, 'AGENTS.md'), APPENDED);
    await scaffoldNode(dir);
    const second = await ensureProjectDocs(dir, { projectName: 'combo9', defaultBranch: 'main', commit: false });
    const md = await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8');
    expect(md).toContain('Deployment notes'); // the lane's work survives
    expect(md).toContain('to be decided'); // guide NOT regenerated…
    expect(second.refresh.rewroteConfig).toBe(true); // …but the Digby-owned config still tracks reality
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a pristine scaffold still regenerates (guard only protects edited docs)', async () => {
    const dir = await tmpDir();
    await scaffoldProjectDocs(dir, { projectName: 'pristine', defaultBranch: 'main', commit: false });
    await scaffoldNode(dir);
    const health = await assessDocsHealth(dir);
    expect(health.guide).toBe('scaffold-untouched');
    const r = await refreshProjectDocs(dir, { projectName: 'pristine', commit: false, health });
    expect(r.rewroteAgentsMd).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
