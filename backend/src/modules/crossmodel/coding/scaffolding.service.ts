/**
 * Digby Code — project scaffolding (AGENTS.md + .digby/ framework).
 *
 * On a project's first worktree provision we scaffold an agent-instruction set so
 * every session starts grounded. The design is the synthesis of a deep audit of
 * the SOTA agentic-coding tools (Claude Code, OpenAI Codex, Cline, Cursor,
 * opencode, aider, Amp) adapted to Digby Code's exact capabilities. Full spec +
 * deferred roadmap: docs/DIGBY_CODE_HARNESS.md.
 *
 * Two hard principles (both from the research):
 *   1. LEAN + PROJECT-SPECIFIC. AGENTS.md is re-injected every session and the
 *      open-source drivers have small effective context, so the per-project file
 *      holds ONLY what's specific to this repo. Invariant doctrine (tool protocol,
 *      permission modes, safety, subagent/memory mechanics) lives ONCE in the
 *      global "Digby defaults" system prompt — not restated here.
 *   2. GROUND TRUTH, NOT GUESSING. Commands/stack are detected by INSPECTING
 *      manifests + lockfiles, never LLM-freeform-generated (freeform measurably
 *      reduces task success). We do not yet probe-run commands at scaffold time,
 *      so detected commands are labelled "verify before relying" — honest about
 *      what has and hasn't been confirmed.
 *
 * A machine-readable `.digby/config.json` mirrors the commands for a future
 * harness gate; today it is a declarative record of intent, not an enforced gate,
 * and nothing here claims enforcement Digby doesn't have.
 *
 * All work is best-effort and never blocks/breaks provisioning.
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import logger from '../../../utils/logger';
import { git } from './workspace.service';

/**
 * Telemetry (remediation P0 scaffold_commit_failed) via DYNAMIC import: this
 * module is an env-free leaf (its test mocks only the logger), and a static
 * loop-metrics import would drag config/database → config/env into its graph
 * (the import-graph landmine). Never throws.
 */
async function noteScaffoldCommitFailed(project: string, lane: 'scaffold' | 'docs_refresh', err: unknown): Promise<void> {
  try {
    const { recordLoopMetric, LOOP_METRIC_KINDS } = await import('../platform/loop-metrics.service');
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.SCAFFOLD_COMMIT_FAILED,
      meta: { project, lane, error: String((err as any)?.message ?? err).slice(0, 200) },
    });
  } catch { /* telemetry must never break the scaffold */ }
}

// ── stack detection (ground truth only) ─────────────────────────────────────

export interface StackCommands {
  install: string | null;
  dev: string | null;
  build: string | null;
  test: string | null;
  testOne: string | null;
  typecheck: string | null;
  lint: string | null;
}

export interface DetectedStack {
  /** Human label with versions, e.g. "TypeScript 5 / Next.js 16, React 19". */
  label: string;
  cmd: StackCommands;
  /** Ordered, cheapest-first verify keys present in `cmd` (typecheck→lint→test). */
  verify: Array<keyof StackCommands>;
  /** Notable top-level dirs worth calling out (≤6). */
  keyDirs: string[];
  /** Convention hints detected from config (tsconfig strict, prettier, etc.). */
  conventions: string[];
  /** Manifest we read commands from, for provenance. */
  source: string;
  /** True when nothing meaningful was detected (blank/greenfield). */
  empty: boolean;
}

const EMPTY_CMD: StackCommands = { install: null, dev: null, build: null, test: null, testOne: null, typecheck: null, lint: null };

async function readJson(p: string): Promise<any | null> {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
}
async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}
/** "^16.1.0" → "16"; "~3.12" → "3.12"; ">=5" → "5". Best-effort major/clean. */
function cleanVer(v: string | undefined): string {
  if (!v || typeof v !== 'string') return '';
  const m = v.replace(/[\^~>=<\s]/g, '').match(/^(\d+(?:\.\d+)?)/);
  return m ? m[1] : '';
}

async function detectNodePM(root: string): Promise<'bun' | 'pnpm' | 'yarn' | 'npm'> {
  if (await exists(path.join(root, 'bun.lockb'))) return 'bun';
  if (await exists(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(path.join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

const RUN_PREFIX: Record<string, string> = { bun: 'bun run', pnpm: 'pnpm', yarn: 'yarn', npm: 'npm run' };
const EXEC_PREFIX: Record<string, string> = { bun: 'bunx', pnpm: 'pnpm dlx', yarn: 'yarn dlx', npm: 'npx' };

function detectNodeFramework(deps: Record<string, string>): { name: string; dep: string } {
  const table: Array<[string, string]> = [
    ['Next.js', 'next'], ['Nuxt', 'nuxt'], ['Remix', '@remix-run/react'], ['NestJS', '@nestjs/core'],
    ['Express', 'express'], ['Fastify', 'fastify'], ['Vite', 'vite'], ['React', 'react'],
    ['Vue', 'vue'], ['Svelte', 'svelte'],
  ];
  for (const [name, dep] of table) if (dep in deps) return { name, dep };
  return { name: '', dep: '' };
}

/** Compute the cheapest-first verify chain from whatever commands exist. */
function verifyChain(cmd: StackCommands): Array<keyof StackCommands> {
  const chain: Array<keyof StackCommands> = [];
  if (cmd.typecheck) chain.push('typecheck'); // omitted for dynamically-typed (never set)
  if (cmd.lint) chain.push('lint');
  if (cmd.test) chain.push('test');
  return chain;
}

/**
 * Inspect the worktree and return the detected stack. Reads manifests/lockfiles
 * only — never executes anything.
 */
export async function detectStack(root: string): Promise<DetectedStack> {
  const conventions: string[] = [];
  const cmd: StackCommands = { ...EMPTY_CMD };
  let label = '';
  let source = '';

  // ── Node / TypeScript ──────────────────────────────────────────────────
  const pkg = await readJson(path.join(root, 'package.json'));
  if (pkg) {
    source = 'package.json';
    const pm = await detectNodePM(root);
    const run = RUN_PREFIX[pm];
    const exec = EXEC_PREFIX[pm];
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const isTS = 'typescript' in deps || (await exists(path.join(root, 'tsconfig.json')));
    const fw = detectNodeFramework(deps);
    const parts: string[] = [];
    if (isTS) parts.push(`TypeScript${cleanVer(deps['typescript']) ? ' ' + cleanVer(deps['typescript']) : ''}`);
    else parts.push('JavaScript');
    if (fw.name) parts.push(`${fw.name}${cleanVer(deps[fw.dep]) ? ' ' + cleanVer(deps[fw.dep]) : ''}`);
    if (fw.name !== 'React' && 'react' in deps) parts.push(`React ${cleanVer(deps['react'])}`.trim());
    label = parts.join(' / ');

    cmd.install = pm === 'npm' ? 'npm install' : `${pm} install`;
    const scripts: Record<string, string> = pkg.scripts || {};
    const sc = (name: string) => `${run} ${name}`;
    if (scripts.dev) cmd.dev = sc('dev');
    else if (scripts.start) cmd.dev = sc('start');
    if (scripts.typecheck) cmd.typecheck = sc('typecheck');
    else if (scripts['type-check']) cmd.typecheck = sc('type-check');
    else if (isTS) cmd.typecheck = `${exec} tsc --noEmit`;
    if (scripts.lint) cmd.lint = sc('lint');
    if (scripts.test) { cmd.test = sc('test'); cmd.testOne = `${sc('test')} -- <file-or-pattern>`; }
    if (scripts.build) cmd.build = sc('build');

    if (isTS) conventions.push('TypeScript — keep it `tsc`-clean; do not introduce new type errors.');
    if ('prettier' in deps || (await exists(path.join(root, '.prettierrc'))) || (await exists(path.join(root, 'prettier.config.js'))))
      conventions.push('Prettier is configured — match it; do not hand-reformat.');
    if ('eslint' in deps || (await exists(path.join(root, '.eslintrc.json'))) || (await exists(path.join(root, '.eslintrc.js'))) || (await exists(path.join(root, 'eslint.config.js'))))
      conventions.push('ESLint is configured — run the lint command before committing.');
  }

  // ── Python (dynamically typed → no typecheck unless mypy present) ──────────
  if (!label) {
    const pyproject = await exists(path.join(root, 'pyproject.toml'));
    const reqs = await exists(path.join(root, 'requirements.txt'));
    const setup = await exists(path.join(root, 'setup.py'));
    if (pyproject || reqs || setup) {
      label = 'Python';
      source = pyproject ? 'pyproject.toml' : reqs ? 'requirements.txt' : 'setup.py';
      const usesUv = await exists(path.join(root, 'uv.lock'));
      const usesPoetry = await exists(path.join(root, 'poetry.lock'));
      const pyText = pyproject ? await fs.readFile(path.join(root, 'pyproject.toml'), 'utf8').catch(() => '') : '';
      const runner = usesUv ? 'uv run ' : usesPoetry ? 'poetry run ' : '';
      cmd.install = usesUv ? 'uv sync' : usesPoetry ? 'poetry install' : reqs ? 'pip install -r requirements.txt' : 'pip install -e .';
      if (/pytest/.test(pyText) || (await exists(path.join(root, 'pytest.ini'))) || (await exists(path.join(root, 'tests')))) {
        cmd.test = `${runner}pytest`;
        cmd.testOne = `${runner}pytest <path::test_name>`;
      }
      if (/ruff/.test(pyText)) { cmd.lint = `${runner}ruff check .`; conventions.push('Ruff is configured — lint + format with it.'); }
      if (/mypy/.test(pyText)) cmd.typecheck = `${runner}mypy .`;
    }
  }

  // ── Rust / Go / Ruby ───────────────────────────────────────────────────────
  if (!label && (await exists(path.join(root, 'Cargo.toml')))) {
    label = 'Rust'; source = 'Cargo.toml';
    cmd.build = 'cargo build'; cmd.test = 'cargo test'; cmd.lint = 'cargo clippy'; cmd.typecheck = 'cargo check';
    conventions.push('Run `cargo fmt` + `cargo clippy` before committing.');
  }
  if (!label && (await exists(path.join(root, 'go.mod')))) {
    label = 'Go'; source = 'go.mod';
    cmd.build = 'go build ./...'; cmd.test = 'go test ./...'; cmd.lint = 'go vet ./...';
    conventions.push('Run `gofmt`/`go vet` before committing.');
  }
  if (!label && (await exists(path.join(root, 'Gemfile')))) {
    label = 'Ruby'; source = 'Gemfile';
    cmd.install = 'bundle install'; cmd.test = 'bundle exec rspec';
  }

  // ── Makefile targets (augment any stack) ────────────────────────────────────
  if (await exists(path.join(root, 'Makefile'))) {
    const mk = await fs.readFile(path.join(root, 'Makefile'), 'utf8').catch(() => '');
    const targets = Array.from(mk.matchAll(/^([a-zA-Z][\w-]*):/gm)).map(m => m[1]);
    if (targets.includes('test') && !cmd.test) cmd.test = 'make test';
    if (targets.includes('lint') && !cmd.lint) cmd.lint = 'make lint';
    if (targets.includes('build') && !cmd.build) cmd.build = 'make build';
    if (!source) source = 'Makefile';
  }

  // ── key directories ────────────────────────────────────────────────────────
  let keyDirs: string[] = [];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const IGNORE = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'target', '__pycache__', '.venv', 'venv', '.digby', 'vendor', '.idea', '.vscode', 'coverage']);
    keyDirs = entries.filter(e => e.isDirectory() && !IGNORE.has(e.name) && !e.name.startsWith('.'))
      .map(e => e.name).sort().slice(0, 6);
  } catch { /* none */ }

  const hasAny = Object.values(cmd).some(Boolean);
  const empty = !label && !hasAny;
  return { label, cmd, verify: verifyChain(cmd), keyDirs, conventions, source, empty };
}

// ── file rendering ─────────────────────────────────────────────────────────

const CMD_LABEL: Record<keyof StackCommands, string> = {
  install: 'Install', dev: 'Dev/run', build: 'Build', test: 'Test',
  testOne: 'Test (one)', typecheck: 'Typecheck', lint: 'Lint',
};
const CMD_ORDER: Array<keyof StackCommands> = ['install', 'dev', 'typecheck', 'lint', 'test', 'testOne', 'build'];

function commandsFence(stack: DetectedStack): string {
  const present = CMD_ORDER.filter(k => stack.cmd[k]);
  if (!present.length) {
    return [
      '```',
      'Install:   <e.g. npm install / uv sync / cargo fetch>',
      'Dev/run:   <e.g. npm run dev>',
      'Typecheck: <e.g. npx tsc --noEmit>',
      'Lint:      <e.g. npm run lint>',
      'Test:      <e.g. npm test>',
      'Build:     <e.g. npm run build>',
      '```',
    ].join('\n');
  }
  const width = Math.max(...present.map(k => CMD_LABEL[k].length));
  const lines = present.map(k => `${(CMD_LABEL[k] + ':').padEnd(width + 2)}${stack.cmd[k]}`);
  return '```\n' + lines.join('\n') + '\n```';
}

/** The lean, PROJECT-SPECIFIC AGENTS.md. Invariant doctrine lives in Digby defaults. */
export function renderAgentsMd(projectName: string, defaultBranch: string, stack: DetectedStack): string {
  const overview = stack.empty
    ? `A new project scaffolded in Digby Code. **Stack: to be decided** — fill in the`
      + ` one-line "what/why", the Stack, and the Commands below once the shape is chosen.`
    : `_(One line: what ${projectName} is and why it exists.)_`;
  const stackLine = stack.empty ? 'to be decided' : (stack.label || 'mixed');

  const cmdNote = stack.empty
    ? 'No manifest yet — fill these in (and keep them current) as soon as the stack exists.'
    : `Detected from \`${stack.source}\` by inspection. **Not yet run in this project — verify with `
      + `\`run_command\` before relying on one, and fix this list when a line is wrong** (a bad command`
      + ' sends every future session into failing loops).';

  const structure = stack.keyDirs.length
    ? stack.keyDirs.map(d => `- \`${d}/\` — _(describe)_`).join('\n')
    : '- _(add the 3–5 directories that matter, one line each — not a full tree)_';

  const conventions = stack.conventions.length
    ? stack.conventions.map(c => `- ${c}`).join('\n')
    : '- Match the surrounding code style; read a neighbouring file before adding a new one.';

  const verifyList = stack.verify.length
    ? stack.verify.map(k => `\`${stack.cmd[k]}\``).join(' → ')
    : 'the project\'s typecheck/lint/test commands (see above)';

  // The HTML-comment marker on line 1 lets docs-health tell an UNEDITED scaffold
  // (safe to regenerate on stack drift) from a hand-written guide (never touched).
  // It is invisible to markdown renderers and negligible against the 8000-char
  // prompt-injection cap. Delete it to take ownership of the file.
  return `<!-- digby:scaffold v1 -->

# ${projectName}

> **Agent guide — read first, kept lean on purpose.** Digby Code injects this file
> into every session, so it holds only what is SPECIFIC to this project. How Digby
> works (tools, permission modes, safety, subagents, memory) is built in — it is not
> repeated here. When you learn a durable project fact, update this file (or
> \`.digby/notes/learnings.md\`) instead of letting it die with the session.

## Overview

${overview}
Stack: **${stackLine}**  <!-- language + framework with versions -->

## Environment

- \`run_command\` runs in an **isolated per-session container**, not the user's machine. The worktree
  is ephemeral: commit real progress to your branch before the session ends.
- You start on a **fresh branch off \`${defaultBranch}\`** — no need to create one for normal work.
- There is no \`git_branch\`/\`git_fetch\`/\`git_pull\` tool: make a second branch with \`git checkout -b\`
  via \`run_command\` if you must, and don't try to sync a diverged \`${defaultBranch}\` mid-session.

## Commands

${cmdNote}

${commandsFence(stack)}

Never assume a library is installed — \`grep\` the manifest or a neighbouring import first.

## Project Structure

${structure}

Discovery/secret exclusions live in \`.digbyignore\`; the machine-readable command list is \`.digby/config.json\`.

## Conventions

${conventions}
- Make focused changes that match surrounding code; prefer editing over rewriting.

## Docs are part of the change

When a change alters behaviour, an API/CLI surface, configuration, setup steps, or an operational
procedure, update the documentation that describes it — README, docs/, this file, \`.env.example\` —
in the SAME commit/PR. Before finishing, grep the repo's markdown for the symbols/commands/paths you
changed and fix every claim your change invalidated; a doc you cannot confidently fix gets a dated
\`> ⚠ STALE (YYYY-MM-DD): …\` banner instead of silence. Pure-internal refactors with no observable
change need no doc edits — say so explicitly.

A results/tracker/journal APPEND is a RECORD, not a change — do not open a PR for it alone: keep
appending on the session branch and open ONE PR per day (or when a code/script change lands).
Results logs and trackers are APPEND-ONLY on main: archive (\`results/archive/<name>-<YYYY-MM-DD>.md\`),
never truncate; roll a log over into a new dated file when it passes ~200 KB. The CURRENT queue /
next step / of-record numbers live in \`.digby/rules/00-current-state.md\` (injected every run); the
durable record lives in \`results/\`. The supervisors read that state file from the DEFAULT branch (a
mirror of main, refreshed within 30 min), not from a session branch — a state-only PR (only
\`.digby/**\` files) is exempt from the one-PR-per-day rule: land it whenever the queue / next step
changes. Of-record NUMBERS also go to the goal's premise register (\`goal_premise_set\`) — that, not a
PR, is how movement is seen upstream.

## Done means verified

"Looks done" is not done. Before you call a task complete, run ${verifyList} and show the command +
its output as evidence; fix failures and re-run until green. For a behaviour change, also drive the
changed flow and observe it. If there is no runtime surface to drive (pure refactor), say so rather
than fabricating an observation.

### Machine-run finals — claims block

A machine-triggered run (schedule / hook / auto-resume) that pushed, opened a PR, deployed,
updated tickets, or sent messages ENDS its final answer with a typed claims block — the
harness verifies each entry against its own tool receipts (receipt lookup, not prose parsing):

\`\`\`claims
[{"type":"push","ref":"1539fa86","note":"branch digby/fix-x"},{"type":"pr","ref":"241"}]
\`\`\`

Types: \`push\` \`pr\` \`merge\` \`deploy\` \`commit\` \`ticket_update\` \`message_sent\` \`dispatch\` \`file_change\` \`verify\` \`schedule_armed\` \`email_sent\` \`state_update\` — the same type set the finish_run tool documents. A \`commit\` entry is a LOCAL commit (sha ref, vouched by a git_commit receipt, never a push); a \`schedule_armed\` entry cites a schedule id; an \`email_sent\`/\`state_update\` entry cites the send / state action.
\`ref\` is the receipt-visible id of what you actually did: the pushed sha or branch, the PR
number/URL from the open_pull_request result, the ticket id, the changed path, or a receipt id
an envelope returned. A \`verify\` entry is vouched ONLY by a this-run \`verify\`-tool receipt (a
passed chain) — checks executed via \`run_command\` cannot vouch it, so report those as prose with
the quoted output line, never as a \`verify\` entry. An entry may add optional
\`"scope":"session"\` (work an earlier run of THIS chat did) or
\`"scope":"relayed"\` (a receipt you read with get_run_receipts this run) — a
scoped entry that matched no this-run receipt is re-checked against the chat's
recent receipt history instead of being struck. Claim ONLY what a tool call in THIS run
performed — an entry with no matching receipt is marked UNVERIFIED, while a
fully-verified block vouches for the matching prose. No consequential actions this run → no block.

## Project boundaries

_(Repo-specific off-limits only — generic safety is built in.)_
- Ask before touching: _(e.g. \`auth/\`, \`payments/\`, \`prisma/migrations/\`, any \`.env\`)_

## More context

Loads on demand, not injected here: \`.digby/notes/learnings.md\` (durable learned conventions) ·
\`.digby/rules/*.md\` (path-scoped) · \`.digby/docs/*.md\` (deep reference — \`read_file\` when relevant).
`;
}

/** Fixed comparison order for the 7 command keys (fingerprint + drift). */
const CMD_KEYS: Array<keyof StackCommands> = ['install', 'dev', 'build', 'test', 'testOne', 'typecheck', 'lint'];

/**
 * Canonical fingerprint of the docs-relevant config fields ({stack, commands,
 * verify}) with the command keys in fixed order and missing→null. Stored as
 * `docsHash` in .digby/config.json: a match means Digby wrote exactly that block
 * (safe to auto-refresh on drift); a mismatch (or a legacy config with non-null
 * commands and no hash) means user-tuned — never auto-rewrite, nudge only.
 */
export function commandsFingerprint(
  stack: string | null,
  commands: Partial<StackCommands> | null | undefined,
  verify: readonly string[] | null | undefined,
): string {
  const canonical = {
    stack: stack || null,
    commands: Object.fromEntries(CMD_KEYS.map(k => [k, commands?.[k] ?? null])),
    verify: verify ?? [],
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Machine-readable half the harness reads (commands + intended verify chain). */
export function renderConfigJson(defaultBranch: string, stack: DetectedStack): string {
  const config = {
    // Declarative record of detected intent. NOTE: commands are DETECTED (not yet
    // probe-run), so the verify chain is best-effort and the PR gate stays off.
    version: 1,
    defaultBranch,
    stack: stack.label || null,
    commands: stack.cmd,
    verify: stack.verify, // cheapest-first keys into commands (drives verify tool + auto-verify loop)
    docsHash: commandsFingerprint(stack.label || null, stack.cmd, stack.verify),
    verified: false,      // commands were detected, not yet probe-run in a container
    // LOOP: bounds for the harness auto-verify loop (agent.ts). gatePullRequest:
    // the agent must get the verify chain green before it can open_pull_request
    // (a human clicking "Open PR" bypasses it). Set false to disable the gate for
    // this project. See docs/DIGBY_CODE_HARNESS.md.
    loop: {
      maxAutoVerifyIterations: 3,
      resumeStepBudget: 8,
      perCommandTimeoutMs: 300000,
      sameFailureStop: 2,
      oscillationWindow: 4,
      gatePullRequest: true,
    },
    ignore: '.digbyignore',
  };
  return JSON.stringify(config, null, 2) + '\n';
}

/** Repo-level .gitignore scaffolded into BLANK projects (never overwrites an existing one). */
export function renderRepoGitignore(): string {
  return `# Secrets — real values live in .env; document names in .env.example
.env
.env.*
!.env.example

# Python
__pycache__/
*.py[cod]
.venv/
venv/

# Node
node_modules/
dist/
build/

# Logs / caches
*.log
.cache/
wandb/

# OS junk
.DS_Store
Thumbs.db
`;
}

export function renderDigbyIgnore(): string {
  return `# Digby Code — discovery/index + secret-read exclusions.
# Keeps glob/grep fast and blocks reading real secret files (defense-in-depth on
# top of Digby's built-in secret deny). Template files are explicitly allowed so
# the agent can read required-variable lists.

node_modules/
dist/
build/
.next/
out/
target/
coverage/
__pycache__/
.venv/
venv/
*.lock
*-lock.json
*.lockb

# Ephemeral per-session scratch (plan/todo lifeboat) — never index or commit
.digby/session/

# Real secrets — never read
.env
.env.local
.env.*.local

# ...but allow templates
!.env.example
!.env.sample
`;
}

export function renderLearnings(): string {
  return `# Learned conventions (durable)

One short, imperative line per durable discovery — a fact you verified that a future
session would otherwise re-learn the hard way. Keep it deduped and specific. Promote
anything load-bearing into AGENTS.md.

<!-- e.g. - Tests need Postgres up first: \`docker compose up -d db\`. -->
`;
}

/**
 * P6 (spark B10/G10): the scaffolded always-injected current-state rule.
 * .digby/rules/*.md files are injected into EVERY run's system prompt (up to 6
 * files × 6,000 chars each), while AGENTS.md is injected only up to its first
 * 8,000 chars — so this file is the reliable channel for must-see doctrine.
 */
export function renderCurrentStateRule(): string {
  return `# Current state (always injected)

This file is injected into EVERY run's system prompt (all \`.digby/rules/*.md\`
files are — up to 6 files, 6,000 chars each). AGENTS.md is injected only up to
its first 8,000 characters, so anything the agent MUST see every run belongs
here, not deep in AGENTS.md.

Keep here (short, current, pruned — THIS FILE ONLY: replace superseded entries,
never append forever; results logs and trackers under results/ are the opposite —
append-only on main, archived under results/archive/, never truncated):
- The project's CURRENT phase/goals and active constraints.
- The CURRENT work queue, next step and of-record numbers for scheduled lanes —
  this file is the cross-run state channel (injected every run). A results log
  that must be re-landed on main every firing is not: a results/tracker append
  is a RECORD, not a change — batch appends on the session branch, one PR per
  day or with the next code change. The supervisors read THIS file from the
  default branch (a mirror of main, refreshed within 30 min) — a PR touching
  only \`.digby/**\` is state-only and exempt from that rule: land it whenever
  the queue / next step changes. Of-record numbers ALSO go to the goal's
  premise register (goal_premise_set) — the supervisors read movement from
  there, never from PR ids.
- Standing directives for scheduled/monitor lanes (reference this file from the
  schedule prompt instead of rewriting the prompt).
- "Do not touch" areas and pointers to deeper docs.

<!-- Nothing here yet — the agent or the owner fills this in as the project takes shape. -->
`;
}

export function renderDigbyReadme(): string {
  return `# .digby/

Digby Code's per-project framework directory. Digby scaffolds it on project create.

- \`config.json\` — machine-readable commands + verify chain (source of truth).
- \`notes/learnings.md\` — durable, git-committed learned conventions (self-improving).
- \`rules/*.md\` — path/topic-scoped rules, loaded on demand (add as needed).
- \`docs/*.md\` — deep reference (architecture, testing, db), read on demand.

The lean always-on guide is the root \`AGENTS.md\`. Invariant Digby doctrine (tools,
permission modes, safety) is built into the agent, not stored here.
`;
}

// ── orchestration ─────────────────────────────────────────────────────────────

export interface ScaffoldResult {
  scaffolded: boolean;
  wroteAgentsMd: boolean;
  wroteFramework: boolean;
  committed: boolean;
  reason?: string;
}

/**
 * Scaffold AGENTS.md + the .digby/ framework into a freshly-provisioned worktree,
 * then commit. Respects an existing AGENTS.md (never clobbers it) and any existing
 * .digby/. Best-effort: returns a result but never throws.
 */
export async function scaffoldProjectDocs(
  worktree: string,
  opts: { projectName: string; defaultBranch?: string; commit?: boolean; repoHygiene?: boolean },
): Promise<ScaffoldResult> {
  const result: ScaffoldResult = { scaffolded: false, wroteAgentsMd: false, wroteFramework: false, committed: false };
  try {
    const defaultBranch = opts.defaultBranch || 'main';
    const agentsPath = path.join(worktree, 'AGENTS.md');
    const digbyDir = path.join(worktree, '.digby');

    // Repo hygiene for BLANK projects (session fa767dbf: no .gitignore existed,
    // a __pycache__/*.pyc got committed, and privacy infra was retrofitted only
    // when the user asked). Never clobbers existing files; imported repos skip
    // this (they own their hygiene).
    if (opts.repoHygiene) {
      const giPath = path.join(worktree, '.gitignore');
      if (!(await exists(giPath))) {
        await fs.writeFile(giPath, renderRepoGitignore(), 'utf8');
      }
      const envExPath = path.join(worktree, '.env.example');
      if (!(await exists(envExPath))) {
        await fs.writeFile(envExPath, '# Document required env vars here with PLACEHOLDER values only.\n# Real values go in .env (gitignored) — never commit real secrets.\n', 'utf8');
      }
    }

    const hasAgents = await exists(agentsPath);
    const hasDigby = await exists(digbyDir);
    if (hasAgents && hasDigby) {
      result.reason = 'AGENTS.md and .digby/ already present — respecting repo';
      return result;
    }

    const stack = await detectStack(worktree);

    if (!hasAgents) {
      await fs.writeFile(agentsPath, renderAgentsMd(opts.projectName, defaultBranch, stack), 'utf8');
      result.wroteAgentsMd = true;
      logger.info(`coding scaffold: AGENTS.md for "${opts.projectName}" (stack: ${stack.label || 'blank'})`);
    } else {
      result.reason = 'AGENTS.md present — added .digby framework only';
    }

    if (!hasDigby) {
      await fs.mkdir(path.join(digbyDir, 'notes'), { recursive: true });
      await fs.mkdir(path.join(digbyDir, 'rules'), { recursive: true });
      await fs.writeFile(path.join(digbyDir, 'config.json'), renderConfigJson(defaultBranch, stack), 'utf8');
      await fs.writeFile(path.join(digbyDir, 'README.md'), renderDigbyReadme(), 'utf8');
      await fs.writeFile(path.join(digbyDir, 'notes', 'learnings.md'), renderLearnings(), 'utf8');
      // P6 (B10/G10): the always-injected current-state rule — the reliable
      // channel for doctrine an oversized AGENTS.md can't guarantee to carry.
      await fs.writeFile(path.join(digbyDir, 'rules', '00-current-state.md'), renderCurrentStateRule(), 'utf8');
      await fs.writeFile(path.join(worktree, '.digbyignore'), renderDigbyIgnore(), 'utf8');
      result.wroteFramework = true;
    }

    result.scaffolded = result.wroteAgentsMd || result.wroteFramework;

    if (result.scaffolded && opts.commit !== false) {
      try {
        // Stage only the paths that actually exist — a partial scaffold (e.g. repo
        // already had .digby but not AGENTS.md) must not fail `git add` on a missing
        // pathspec and abort the whole commit.
        const candidates = ['AGENTS.md', '.digby', '.digbyignore', '.gitignore', '.env.example'];
        const toAdd: string[] = [];
        for (const c of candidates) if (await exists(path.join(worktree, c))) toAdd.push(c);
        if (toAdd.length) await git(['add', ...toAdd], worktree);
        await git(['commit', '-m', 'chore: scaffold Digby Code agent guide (AGENTS.md + .digby framework)'], worktree);
        result.committed = true;
      } catch (err: any) {
        // Non-fatal: files still exist in the worktree for the agent to read.
        logger.warn(`coding scaffold: commit skipped for "${opts.projectName}": ${err.message}`);
        // Telemetry (remediation P0): a scaffold that silently fails to commit
        // leaves the framework un-versioned — chart it instead of losing it.
        await noteScaffoldCommitFailed(opts.projectName, 'scaffold', err);
      }
    }
    return result;
  } catch (err: any) {
    logger.warn(`coding scaffold: failed for "${opts.projectName}" (non-fatal): ${err.message}`);
    return result;
  }
}

// ── docs health (staleness assessment + safe refresh) ─────────────────────────
//
// The scaffold's "respect existing, never clobber" rule means an UNEDITED
// scaffold would otherwise live forever: a blank project's placeholder guide
// ("stack: to be decided") survives even after the repo gains a real stack, and
// every later session is injected a wrong guide. assessDocsHealth detects that
// drift deterministically (ground-truth re-detection, never LLM); refreshProjectDocs
// regenerates ONLY what Digby still owns (untouched scaffold guide, hash-matched
// config commands). Hand-written guides and user-tuned configs are never
// rewritten — their drift reaches the agent via the DOCS HEALTH prompt nudge
// (agent.ts buildAgentGuide).

const SCAFFOLD_MARKER = '<!-- digby:scaffold v1 -->';

// ── B9 (remediation 2026-09-09): scaffold regen guard ─────────────────────────
// Real incident: refreshProjectDocs classified a guide as 'scaffold-untouched'
// because the TEMPLATE placeholders survived — but a lane had APPENDED its own
// sections ("append one bullet / a durable fact to AGENTS.md" is doctrine), and
// the wholesale regeneration wiped them and auto-committed the wipe. A doc that
// contains ANY non-template heading is lane/user-edited: never regenerate it —
// skip with a log and let drift reach the agent via the DOCS HEALTH nudge.

/** Every heading the v1 scaffold template can render (lowercased, trimmed). */
const TEMPLATE_HEADINGS = new Set([
  'overview',
  'environment',
  'commands',
  'project structure',
  'conventions',
  'docs are part of the change',
  'done means verified',
  'machine-run finals — claims block',
  'project boundaries',
  'more context',
]);

/**
 * Markdown headings in `content` that the scaffold template does NOT own.
 * Fence-aware (a `#` inside a ``` block is code, not a heading). The first
 * h1 is the template's `# <projectName>` title; any later h1 is custom.
 */
export function nonTemplateHeadings(content: string): string[] {
  const out: string[] = [];
  let inFence = false;
  let seenH1 = false;
  for (const line of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    if (m[1].length === 1) {
      if (!seenH1) { seenH1 = true; continue; }
      out.push(m[2]);
      continue;
    }
    if (!TEMPLATE_HEADINGS.has(m[2].trim().toLowerCase())) out.push(m[2]);
  }
  return out;
}

/**
 * Exact blank-scaffold signatures: BOTH template forms of the stack placeholder
 * (overview sentence + stack line) plus the blank commands fence. The bare phrase
 * 'to be decided' is ordinary English prose — a hand-written doc containing it
 * must NOT be classified as a scaffold (it would get clobbered).
 */
function hasBlankStackPlaceholder(content: string): boolean {
  return content.includes('Stack: **to be decided**')
    || content.includes('**Stack: to be decided**')
    || content.includes('<e.g. npm install');
}

/** Structure-section placeholder: per-dir '_(describe)_' OR the flat-repo stub
 *  (repos with no subdirectories get the stub instead — both mean "unedited"). */
function hasStructurePlaceholder(content: string): boolean {
  return content.includes('_(describe)_') || content.includes('_(add the 3–5 directories');
}

export interface DocsHealth {
  hasAgentsMd: boolean;
  hasDigby: boolean;
  /**
   * 'scaffold-untouched' = marker+placeholders survive (or the legacy blank
   * placeholder 'to be decided' — the exact stale-scaffold signature) → safe to
   * regenerate. 'scaffold-edited' = marker but placeholders filled → nudge only.
   * 'handwritten' = no marker, no blank placeholder → never touched.
   */
  guide: 'handwritten' | 'scaffold-untouched' | 'scaffold-edited' | 'none';
  /** True when the commands block is user-tuned (docsHash mismatch / legacy non-null) — never auto-rewritten. */
  commandsUserOwned: boolean;
  /** Human-readable drift entries (recorded config vs detected ground truth), capped at 6. */
  drift: string[];
  /** Cached detectStack result so refresh doesn't re-detect. */
  fresh: DetectedStack;
  /** True when refreshProjectDocs would change files (not opted out, something better to say, not user-owned). */
  autoRefreshable: boolean;
  /** True when config sets docsHealth.nudge=false — suppresses the DOCS HEALTH prompt block. */
  nudgeSilenced: boolean;
}

/**
 * Assess the worktree's agent docs against ground truth. Pure reads — never
 * writes, never throws (callers still wrap best-effort).
 */
export async function assessDocsHealth(worktree: string): Promise<DocsHealth> {
  const agentsPath = path.join(worktree, 'AGENTS.md');
  const hasAgentsMd = await exists(agentsPath);
  const hasDigby = await exists(path.join(worktree, '.digby'));
  const fresh = await detectStack(worktree);

  let guide: DocsHealth['guide'] = 'none';
  if (hasAgentsMd) {
    const content = await fs.readFile(agentsPath, 'utf8').catch(() => '');
    if (content.includes(SCAFFOLD_MARKER)) {
      const untouched = hasBlankStackPlaceholder(content)
        || (content.includes('_(One line:') && hasStructurePlaceholder(content));
      guide = untouched ? 'scaffold-untouched' : 'scaffold-edited';
    } else {
      // Legacy scaffolds predate the marker: require the template's exact blank
      // signatures — the bare phrase 'to be decided' is ordinary English prose.
      guide = hasBlankStackPlaceholder(content) ? 'scaffold-untouched' : 'handwritten';
    }
    // B9: surviving placeholders do NOT prove the doc is pristine — a lane may
    // have APPENDED sections around them. Any non-template heading demotes the
    // classification to 'scaffold-edited' so refresh never regenerates it.
    if (guide === 'scaffold-untouched' && nonTemplateHeadings(content).length > 0) {
      guide = 'scaffold-edited';
    }
  }

  const config = await readJson(path.join(worktree, '.digby', 'config.json'));
  const commands = (config?.commands ?? null) as Partial<StackCommands> | null;
  // verify[] is canonically string keys, but hand-authored configs may use the
  // object form (verify.service resolveVerifyChain accepts both). An
  // object-form array is BY CONSTRUCTION hand-authored — our scaffolding only
  // ever writes the string form — so it is always USER-OWNED: never
  // hash-matched, never auto-rewritten (a projected-key match must not let
  // refresh clobber a hand-tuned inline `command`). The string projection
  // below is for drift DISPLAY only, so [object Object] never leaks there.
  const configVerifyRaw: unknown[] = Array.isArray(config?.verify) ? config.verify : [];
  const configVerifyObjectForm = configVerifyRaw.some((e: unknown) => typeof e !== 'string');
  const configVerify: string[] = configVerifyRaw.map((e: unknown) =>
    (typeof e === 'string' ? e : ((e as { name?: string; command?: string })?.name ?? (e as { command?: string })?.command ?? ''))).filter(Boolean);
  const hashMatches = !configVerifyObjectForm && typeof config?.docsHash === 'string'
    && config.docsHash === commandsFingerprint(config?.stack ?? null, commands, configVerify);
  const allNull = CMD_KEYS.every(k => !commands?.[k]);
  // Digby-owned iff the fingerprint matches (we wrote exactly this block), or a
  // legacy blank scaffold (no hash yet, every command null). Anything else —
  // including a legacy config with any non-null command — is user-tuned.
  const commandsUserOwned = config !== null && !hashMatches && !(typeof config.docsHash !== 'string' && allNull);

  // Direction-aware drift: a detected-NULL command is NEVER drift. detectStack
  // only reads worktree-ROOT manifests, so monorepos with per-package manifests
  // (and a hand-maintained config) must not false-positive.
  const drift: string[] = [];
  if (config) {
    for (const k of CMD_KEYS) {
      const det = fresh.cmd[k];
      if (!det) continue;
      const cur = commands?.[k] ?? null;
      if (!cur) drift.push(`commands.${k}: null → "${det}"`);
      else if (cur !== det) drift.push(`commands.${k}: "${cur}" → "${det}"`);
    }
    if (fresh.verify.length && JSON.stringify(configVerify) !== JSON.stringify(fresh.verify)) {
      drift.push(`verify: [${configVerify.join(', ')}] → [${fresh.verify.join(', ')}]`);
    }
    const freshLabel = fresh.label || null;
    if (freshLabel && (config.stack ?? null) !== freshLabel) {
      drift.push(`stack: ${config.stack ? `"${config.stack}"` : 'null'} → "${freshLabel}"`);
    }
  }

  const optedOut = config?.docsHealth?.autoRefresh === false;
  const guideRefresh = guide === 'scaffold-untouched' && (!fresh.empty || drift.length > 0);
  const configRefresh = config !== null && !commandsUserOwned && drift.length > 0 && !fresh.empty;

  return {
    hasAgentsMd,
    hasDigby,
    guide,
    commandsUserOwned,
    drift: drift.slice(0, 6),
    fresh,
    autoRefreshable: !optedOut && (guideRefresh || configRefresh),
    nudgeSilenced: config?.docsHealth?.nudge === false,
  };
}

export interface RefreshResult {
  refreshed: boolean;
  rewroteAgentsMd: boolean;
  rewroteConfig: boolean;
  committed: boolean;
  reason?: string;
}

/**
 * Safely refresh stale scaffold docs. Rewrites ONLY what Digby still owns:
 * an untouched-scaffold AGENTS.md (regenerated from fresh detection) and/or a
 * hash-matched (or legacy all-null) config's stack/commands/verify/docsHash —
 * preserving loop, verified, defaultBranch, ignore, docsHealth, and unknown keys.
 * Byte-identical output is never written. Commit failure leaves the files in
 * place. Never throws.
 */
export async function refreshProjectDocs(
  worktree: string,
  opts: { projectName: string; defaultBranch?: string; commit?: boolean; health?: DocsHealth },
): Promise<RefreshResult> {
  const result: RefreshResult = { refreshed: false, rewroteAgentsMd: false, rewroteConfig: false, committed: false };
  try {
    const health = opts.health ?? await assessDocsHealth(worktree);
    const agentsPath = path.join(worktree, 'AGENTS.md');
    const configPath = path.join(worktree, '.digby', 'config.json');
    const raw = await readJson(configPath);
    if (raw?.docsHealth?.autoRefresh === false) {
      result.reason = 'docsHealth.autoRefresh=false — opted out';
      return result;
    }

    if (health.guide === 'scaffold-untouched' && (!health.fresh.empty || health.drift.length > 0)) {
      const next = renderAgentsMd(opts.projectName, raw?.defaultBranch || opts.defaultBranch || 'main', health.fresh);
      const cur = await fs.readFile(agentsPath, 'utf8').catch(() => null);
      // B9 defense-in-depth at the OVERWRITE site (callers may pass a stale
      // health): a doc carrying any lane-appended (non-template) heading is
      // never regenerated — skip with a log; drift reaches the agent via the
      // DOCS HEALTH nudge instead.
      const custom = cur !== null ? nonTemplateHeadings(cur) : [];
      if (custom.length > 0) {
        result.reason = `regeneration refused — lane-appended sections present (${custom.slice(0, 4).join('; ').slice(0, 160)})`;
        logger.info(`docs refresh: REFUSED to regenerate AGENTS.md for "${opts.projectName}" — non-template headings present (${custom.slice(0, 4).join('; ').slice(0, 200)}); appended content is preserved, drift reaches the agent via the DOCS HEALTH nudge`);
      } else if (cur !== next) {
        await fs.writeFile(agentsPath, next, 'utf8');
        result.rewroteAgentsMd = true;
        logger.info(`docs refresh: regenerated scaffold AGENTS.md for "${opts.projectName}" (stack: ${health.fresh.label || 'blank'})`);
      }
    }

    if (raw && !health.commandsUserOwned && health.drift.length > 0 && !health.fresh.empty) {
      const commandsChanged = CMD_KEYS.some(k => (raw.commands?.[k] ?? null) !== health.fresh.cmd[k]);
      const next = {
        ...raw,
        stack: health.fresh.label || null,
        commands: { ...health.fresh.cmd },
        verify: [...health.fresh.verify],
        docsHash: commandsFingerprint(health.fresh.label || null, health.fresh.cmd, health.fresh.verify),
        // New commands are detected-not-probed — a prior verified:true can't survive a rewrite.
        ...(commandsChanged ? { verified: false } : {}),
      };
      const serialized = JSON.stringify(next, null, 2) + '\n';
      const curRaw = await fs.readFile(configPath, 'utf8').catch(() => null);
      if (curRaw !== serialized) {
        await fs.writeFile(configPath, serialized, 'utf8');
        result.rewroteConfig = true;
        logger.info(`docs refresh: updated .digby/config.json for "${opts.projectName}" (${health.drift.length} drift: ${health.drift.join('; ').slice(0, 200)})`);
      }
    }

    result.refreshed = result.rewroteAgentsMd || result.rewroteConfig;

    if (result.refreshed && opts.commit !== false) {
      try {
        const toAdd: string[] = [];
        for (const c of ['AGENTS.md', path.join('.digby', 'config.json')]) {
          if (await exists(path.join(worktree, c))) toAdd.push(c);
        }
        if (toAdd.length) {
          await git(['add', ...toAdd], worktree);
          await git(['commit', '-m', 'docs: refresh agent guide — stack drift detected'], worktree);
          result.committed = true;
        }
      } catch (err: any) {
        // Non-fatal: refreshed files still exist in the worktree for the agent to read.
        logger.warn(`docs refresh: commit skipped for "${opts.projectName}": ${err.message}`);
        // Telemetry (remediation P0): same signal as the scaffold lane.
        await noteScaffoldCommitFailed(opts.projectName, 'docs_refresh', err);
      }
    }
    if (!result.refreshed && !result.reason) result.reason = 'no actionable drift — guide/config user-owned or already current';
  } catch (err: any) {
    logger.warn(`docs refresh: failed for "${opts.projectName}" (non-fatal): ${err.message}`);
  }
  return result;
}

/**
 * The ONLY correct provision-time entry point for project docs: scaffold (first
 * provision) → assess → safe refresh (untouched scaffolds track the real stack).
 * Call this from every provisioning path — never scaffoldProjectDocs directly —
 * so the two can't drift apart. Best-effort: never throws, safe to run on every
 * provision (steady-state is zero writes, zero commits).
 */
export async function ensureProjectDocs(
  worktree: string,
  opts: { projectName: string; defaultBranch?: string; commit?: boolean; repoHygiene?: boolean },
): Promise<{ scaffold: ScaffoldResult; refresh: RefreshResult }> {
  const scaffold = await scaffoldProjectDocs(worktree, opts);
  let refresh: RefreshResult = { refreshed: false, rewroteAgentsMd: false, rewroteConfig: false, committed: false };
  try {
    const health = await assessDocsHealth(worktree);
    if (health.autoRefreshable) {
      refresh = await refreshProjectDocs(worktree, {
        projectName: opts.projectName, defaultBranch: opts.defaultBranch, commit: opts.commit, health,
      });
    }
  } catch { /* docs health must never break provisioning */ }
  return { scaffold, refresh };
}
