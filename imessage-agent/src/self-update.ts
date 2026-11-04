/**
 * Agent self-update (ticket 4e75cdea, 2026-10-08 — "the agent is not getting
 * updated automatically": three Macs sat on 0.6.3 below the 0.7.0 floor for
 * days after 0.7.3 shipped because NOTHING told an old agent a release existed).
 *
 * Contract with the backend (backend/src/modules/crossmodel/imessage/
 * agent-release.ts): every poll (and pair) response may carry an additive
 * `update` block { version, url, sha256, notes? } — present ONLY when this
 * agent is strictly older than the release. This module decides whether to
 * act on it and performs the swap:
 *
 *   1. GATES    — kill switch DIGBY_SELF_UPDATE=0; the advert must name a
 *                 strictly-newer version, an https URL and a 64-hex sha256;
 *                 this install must be SELF-MANAGED and writable (a tarball/
 *                 install.sh install under ~/Library/Application Support/Digby
 *                 or carrying the .digby-selfupdate marker). A .app-bundled
 *                 helper, a /Library/Digby .pkg install, a node_modules copy
 *                 or a dev checkout NEVER swaps itself.
 *   2. RETRY    — at most once per RETRY_BACKOFF_MS and MAX_ATTEMPTS failures
 *                 (a poison release must not crash-loop the fleet through
 *                 update→rollback→update).
 *   3. STAGE    — download → sha256 MUST match the advert → extract → the
 *                 tarball's own package.json version MUST equal the advert
 *                 version (a stale artifact is a NO-OP, never a downgrade:
 *                 the served tarball sat at 0.1.0 while agents ran 0.7.x).
 *   4. BUILD    — `npm ci && npm run build` inside the staging copy (the
 *                 published tarball ships src/, exactly like install.sh).
 *   4.5 CARRY   — (0e4c9601) npm ci rebuilt better_sqlite3 adhoc-signed; a
 *                 hardened-runtime interpreter (DigbyHelper) refuses adhoc
 *                 libraries. Copy the CURRENT tree's proven-loadable .node
 *                 over the staged one when the dep version is UNCHANGED;
 *                 REFUSE the swap when it changed (signed manual release).
 *   5. SMOKE    — `node <staging>/dist/index.js selftest` imports every
 *                 runtime module (better-sqlite3 ABI included, and every
 *                 native addon re-loaded in a FRESH child process — a cached
 *                 vnode signature cannot mask a Team-ID refusal) and must
 *                 print SELFTEST_OK <version>. A build that cannot boot is
 *                 never swapped in.
 *   6. SWAP     — mv agentRoot → agentRoot.bak-<ts> (kept for rollback);
 *                 mv staging → agentRoot. Config (~/.config/digby-agent) is
 *                 outside the tree and untouched.
 *   7. WATCHDOG — a detached child (`update-watchdog`) sleeps HEALTH_DEADLINE_MS
 *                 then checks the ok-marker this agent writes on its first
 *                 successful poll; missing → restore the backup. So a new
 *                 binary that crash-loops immediately is rolled back by code
 *                 from the OLD, known-good tree.
 *   8. RESTART  — process.exit(1): launchd KeepAlive relaunches from the
 *                 (new) agentRoot — the same idiom permission_relaunch uses.
 *
 * Everything above the macOS/network boundary is pure and unit-tested on Linux
 * CI (dist/self-update.js); the procedural wiring is pinned by source-bytes
 * tests in test/self-update.4e75cdea.test.mjs, the house idiom.
 */

import { join, dirname, resolve, basename } from 'path';
import {
  existsSync, mkdirSync, rmSync, renameSync, writeFileSync, readFileSync, accessSync, constants, readdirSync, copyFileSync,
} from 'fs';
import { execFile, spawnSync } from 'child_process';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { AGENT_VERSION } from './config';

/** The `update` block the backend may attach to a poll/pair response. */
export interface UpdateAdvert {
  version: string;
  url: string;
  sha256: string;
  notes?: string;
}

/** Persisted update state (~/.config/digby-agent/update-state.json) — the retry gate. */
interface UpdateState {
  lastAttemptAt: string;
  failures: number;
  /** The release the failure count is about (reviewer F2): a NEW target
   *  version starts from zero — a Mac that gave up on 0.8.0 still takes 0.9.0. */
  version?: string;
}

const CONFIG_DIR = join(homedir(), '.config', 'digby-agent');
const STATE_PATH = join(CONFIG_DIR, 'update-state.json');
const PENDING_PATH = join(CONFIG_DIR, 'update-pending.json');
const OK_PATH = join(CONFIG_DIR, 'update-ok');

/** One attempt per backoff window, hard-stopped after this many failures. */
const RETRY_BACKOFF_MS = 6 * 60 * 60 * 1000; // 6h
const MAX_ATTEMPTS = 3;
/** How long the watchdog waits for the new binary's first healthy poll. */
export const HEALTH_DEADLINE_MS = 3 * 60 * 1000;

export function selfUpdateDisabled(): boolean {
  return (process.env.DIGBY_SELF_UPDATE || '').trim() === '0';
}

/** Every runtime module a healthy agent must be able to load (the pre-swap
 *  smoke test — `node dist/index.js selftest` requires each and prints
 *  SELFTEST_OK <version>; trySelfUpdate refuses to swap a tree that fails). */
export const AGENT_SELFTEST_MODULES = [
  './config', './api', './chatdb', './sender', './calendar',
  './browser', './computer', './computer-keymap', './cdp-attach',
  './contacts', './permissions', './tcc-regrant', './self-update',
] as const;

/** Native addons whose code signature decides whether a HARDENED-runtime
 *  interpreter (DigbyHelper, Developer-ID Team-signed) can load them at all.
 *  `npm ci` rebuilds these ADHOC/linker-signed (codesign flags 0x20002) —
 *  loadable under a plain node, REFUSED under the hardened launchd context
 *  ("mapping process and mapped file (non-platform) have different Team IDs").
 *  Ticket 0e4c9601: the self-update must carry the current tree's proven-
 *  loadable signed .node across the swap instead of shipping the adhoc rebuild. */
export const AGENT_NATIVE_MODULES = ['better-sqlite3'] as const;

/** Where a dependency's built addon lives relative to its package root
 *  (better-sqlite3 prebuilds to build/Release/<name>.node; fall back to any
 *  *.node under build/ — the file NAME is not stable across dep versions).
 *  Canonical name = the npm module id: dashes → underscores. */
function findNativeAddon(agentRoot: string, dep: string): string | null {
  const releaseDir = join(agentRoot, 'node_modules', dep, 'build', 'Release');
  try {
    if (!existsSync(releaseDir)) return null;
    const files = readdirSync(releaseDir).filter((n) => n.endsWith('.node'));
    if (files.length === 0) return null;
    const canonical = `${dep.replace(/-/g, '_')}.node`;
    return join(releaseDir, files.find((n) => n === canonical) || files[0]);
  } catch {
    return null;
  }
}

/** A dependency's version from its package.json (null = unreadable). */
export function depVersion(agentRoot: string, dep: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(join(agentRoot, 'node_modules', dep, 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** Load a native addon in a FRESH child process and report whether this
 *  interpreter can dlopen it. In-process require() is NOT proof under macOS
 *  code-signing: the kernel may serve a CACHED signature for a vnode we
 *  overwrote in place, so the load succeeds here yet fails under the real
 *  launchd context on a fresh mapping (ticket 0e4c9601 — SELFTEST_OK printed
 *  with the adhoc module present). A child that never mapped the file has no
 *  cached signature to be fooled by. */
export function nativeAddonLoadable(agentRoot: string, dep: string): boolean {
  return nativeAddonProbe(agentRoot, dep).ok;
}

/** The probe's evidence: ok=false carries the child's REAL stderr (ticket
 *  8bcd1c4a — the 0e4c9601 message guessed "signature refused?" and hid the
 *  actual dlopen error, which on a plain Homebrew node is an ABI/missing-file
 *  failure the user could have fixed themselves in seconds). */
export function nativeAddonProbe(
  agentRoot: string,
  dep: string,
): { ok: true } | { ok: false; addon: string | null; error: string } {
  const addon = findNativeAddon(agentRoot, dep);
  if (!addon) return { ok: false, addon: null, error: `no built addon found under ${join(agentRoot, 'node_modules', dep, 'build', 'Release')}` };
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(addon)})`], { encoding: 'utf8', timeout: 30_000 });
  if (r.status === 0) return { ok: true };
  const raw = String(r.stderr || r.stdout || r.error?.message || `child ${r.status === null ? 'timed out or was killed' : `exit ${r.status}`}`).trim();
  return { ok: false, addon, error: summarizeChildError(raw) || `child ${r.status === null ? 'timed out or was killed' : `exit ${r.status}`}` };
}

/** Condense a child's stderr to the DIAGNOSTIC lines: node prints the actual
 *  error ("Error: … was compiled against a different Node.js version…")
 *  mid-stream with a stack around it — the raw tail is the least useful part
 *  (reviewer F4, 8bcd1c4a). */
function summarizeChildError(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 6) return lines.join('\n');
  const errIdx = lines.findIndex((l) => /^(Error|TypeError|SyntaxError|RangeError|EvalError)[: ]/.test(l) || /dlopen|NODE_MODULE_VERSION|different Node\.js version|file too short|not a mach-O/i.test(l));
  if (errIdx >= 0) return lines.slice(errIdx, errIdx + 3).join('\n');
  return [...lines.slice(0, 3), '…', ...lines.slice(-2)].join('\n');
}

/**
 * Carry the CURRENT install's proven-loadable native addons into the staged
 * tree (ticket 0e4c9601, step 3.5 between BUILD and SMOKE).
 *
 * Why: the staged tree's `npm ci` compiled better_sqlite3.node locally →
 * adhoc/linker-signed. A plain interpreter loads that fine (the smoke passes),
 * but a Team-signed HARDENED-runtime interpreter (DigbyHelper — the fleet's
 * canonical interpreter) refuses it at dlopen with a Team-ID mismatch, and the
 * agent then runs degraded (iMessage/FDA reads dead) without ever failing a
 * health check. The CURRENT tree's .node is proven loadable under THIS
 * interpreter (this process loaded it), so when the dependency version is
 * UNCHANGED we copy it over the staged adhoc rebuild. When the dependency
 * version CHANGED we REFUSE the swap — a rebuilt/signed module for the new
 * version must ship with a manual release (publish-agent-tarball.sh: ship the
 * signed .node beside src/ or run install.sh from a Team-signed context).
 */
export function carryNativeModules(currentRoot: string, stagedRoot: string): { ok: true; carried: string[] } | { ok: false; reason: string } {
  const carried: string[] = [];
  for (const dep of AGENT_NATIVE_MODULES) {
    const currentAddon = findNativeAddon(currentRoot, dep);
    if (!currentAddon) continue; // no native module in the current tree (or not installed) — nothing to carry; the fresh-child smoke decides
    const currentVersion = depVersion(currentRoot, dep);
    const stagedVersion = depVersion(stagedRoot, dep);
    if (!currentVersion || !stagedVersion) continue; // versions unreadable — do not guess; the fresh-child smoke decides
    if (currentVersion !== stagedVersion) {
      return { ok: false, reason: `native dep ${dep} version changed (${currentVersion} → ${stagedVersion}) — needs a signed manual release, refusing swap` };
    }
    const stagedAddon = findNativeAddon(stagedRoot, dep);
    if (!stagedAddon) continue;
    // 8bcd1c4a: only carry a module the CURRENT interpreter can actually LOAD.
    // The 0e4c9601 premise "this process loaded it" is false — better-sqlite3
    // loads its addon lazily (first Database construction), so a running agent
    // proves nothing. On the ticket's Mac the current tree's .node was
    // stale-ABI junk (npm ≥12 had blocked the rebuild); carrying it would
    // poison the staged tree and fail the smoke with no self-service remedy.
    // SKIP the carry instead of refusing the update: the staged tree's own
    // fresh build (allowScripts unblocks it on npm ≥ 12) then goes to the
    // smoke test. Caveat (reviewer F3): this guard only helps updaters that
    // ALREADY run this code — a 0.8.2 poller has no guard and will still
    // carry its broken module, fail the staged smoke and refuse the swap;
    // those Macs recover by re-running the one-line installer.
    if (!nativeAddonLoadable(currentRoot, dep)) continue;
    // Copy to a temp name and RENAME over the staged .node (never an in-place
    // overwrite): the ticket's root cause is the kernel serving a cached
    // signature for an in-place-overwritten vnode — a rename gives the staged
    // tree a FRESH vnode whose (Team-signed) signature is evaluated fresh when
    // launchd maps it.
    const tmp = `${stagedAddon}.carry-${Date.now()}`;
    copyFileSync(currentAddon, tmp);
    try {
      renameSync(tmp, stagedAddon);
    } catch (err) {
      try { rmSync(tmp, { force: true }); } catch { /* best-effort */ }
      throw err;
    }
    carried.push(`${dep}@${currentVersion}`);
  }
  return { ok: true, carried };
}

/** `index.js selftest` entry (ticket 4e75cdea; native-dep child probe added by
 *  0e4c9601). */
export function selfTest(): void {
  for (const m of AGENT_SELFTEST_MODULES) {
    try {
      require(m);
    } catch (e) {
      console.error(`SELFTEST_FAIL ${m}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }
  // 0e4c9601: require() above can pass on an adhoc-signed native module (the
  // kernel serves a cached signature for an in-place-overwritten vnode), so
  // every native addon is additionally loaded in a FRESH child process — no
  // cached signature to mask a Team-ID refusal.
  for (const dep of AGENT_NATIVE_MODULES) {
    // dist/ sits directly under the agent root — node_modules is a sibling.
    const probe = nativeAddonProbe(dirname(__dirname), dep);
    if (!probe.ok) {
      // 8bcd1c4a: print the child's REAL error, not a guess. The 0e4c9601
      // failure text hardcoded "signature refused?" — on the ticket's Mac the
      // interpreter was plain Homebrew node, where a signature refusal cannot
      // happen; the actual cause (npm ≥12 had BLOCKED the better-sqlite3
      // install script, or a Node upgrade had left a stale-ABI .node) was
      // invisible in the output.
      console.error(`SELFTEST_FAIL native:${dep}: fresh child process could not load the addon:`);
      console.error(`  ${probe.addon ?? '(addon missing)'}`);
      for (const line of probe.error.split('\n')) console.error(`  ${line}`);
      console.error('  Common causes: npm >= 12 blocked the install script (needs allowScripts in package.json — shipped 0.8.3), a Node.js upgrade left an addon built for an older ABI (re-run install.sh), or, under a hardened-runtime interpreter (DigbyHelper), macOS refuses an adhoc-signed addon (ticket 0e4c9601).');
      process.exit(1);
    }
  }
  console.log(`SELFTEST_OK ${AGENT_VERSION}`);
}


/** Semver-ish strictly-newer: '0.8.0' > '0.7.3' (the backend never downgrades). */
export function versionNewer(candidate: string, current: string): boolean {
  const a = String(candidate).split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(current).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/**
 * Should this advert be acted on at all? Pure + total: any malformed field
 * (bad version, non-https URL, non-hex sha) → false. The sha256 pin is the
 * load-bearing guard — without it a swapped/stale artifact on the server
 * would be installed verbatim.
 */
export function advertActionable(advert: unknown, currentVersion: string): advert is UpdateAdvert {
  if (!advert || typeof advert !== 'object') return false;
  const a = advert as Record<string, unknown>;
  if (typeof a.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(a.version)) return false;
  if (typeof a.url !== 'string' || !/^https:\/\//.test(a.url)) return false;
  if (typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256)) return false;
  return versionNewer(a.version, currentVersion);
}

/**
 * Is the install at `agentRoot` self-managed (safe to swap)?
 *   ALLOWED: writable + package.json present + (the install.sh marker
 *   `.digby-selfupdate` OR the canonical tarball path under
 *   ~/Library/Application Support/Digby).
 *   NEVER: inside a .app bundle (updated by the app's DMG + bundleReplaced
 *   self-heal), under /Library/Digby (root-owned .pkg), inside node_modules,
 *   or a repo checkout (../.git exists) — a dev tree is not a deployment.
 */
export function isSelfManagedInstall(agentRoot: string): boolean {
  try {
    const root = resolve(agentRoot);
    if (root.includes('.app/Contents/Resources')) return false;
    if (root.startsWith('/Library/Digby')) return false;
    if (root.includes(`${join('', 'node_modules')}${join('')}`.replace(/^\/+|\/+$/g, '/'))) return false;
    if (root.split('/').includes('node_modules')) return false;
    if (existsSync(join(dirname(root), '.git'))) return false;
    if (!existsSync(join(root, 'package.json'))) return false;
    accessSync(root, constants.W_OK);
    const marked = existsSync(join(root, '.digby-selfupdate'));
    const canonical = root === join(homedir(), 'Library', 'Application Support', 'Digby', 'imessage-agent');
    return marked || canonical;
  } catch {
    return false;
  }
}

/** The retry gate: too-soon or too-many-failures → not now. Pure over the state.
 *  Reviewer F2 (4e75cdea): the failure cap is PER RELEASE — a state stamped for
 *  a different target version never counts against this one (a Mac that gave up
 *  on 0.8.0 must still take 0.9.0 without a manual state-file edit). */
export function retryAllowed(state: UpdateState | null, now: number, forVersion?: string): boolean {
  if (!state) return true;
  const failures = forVersion && state.version && state.version !== forVersion ? 0 : (state.failures || 0);
  if (failures >= MAX_ATTEMPTS) return false;
  const last = Date.parse(state.lastAttemptAt || '');
  if (Number.isFinite(last) && now - last < RETRY_BACKOFF_MS) return false;
  return true;
}

export function loadUpdateState(): UpdateState | null {
  try {
    if (!existsSync(STATE_PATH)) return null;
    return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as UpdateState;
  } catch {
    return null;
  }
}

export function saveUpdateState(state: UpdateState): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch { /* best-effort: a lost state only means an extra attempt */ }
}

/** The tarball ships imessage-agent/package.json — its version must equal the advert. */
export function parseTarballVersion(packageJsonText: string): string | null {
  try {
    const v = (JSON.parse(packageJsonText) as { version?: unknown }).version;
    return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** sha256 of a file (streamed) as lowercase hex. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const { createReadStream } = require('fs') as typeof import('fs');
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs, env: opts.env }, (err, stdout, stderr) => {
      resolveRun({ code: err ? ((err as any).code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** 51d8dbe0: the ORIGINAL node the DigbyAgent runtime copy was made from —
 *  install.sh records it in .node-origin BESIDE the copy (stable: outside
 *  every agent tree, so the self-update swap never moves it). null = no
 *  marker (plain node / DigbyHelper / dev tree): process.execPath IS the
 *  origin. Read lazily, best-effort. */
export function nodeOriginPath(execPath: string = process.execPath): string | null {
  try {
    const origin = readFileSync(join(dirname(execPath), '.node-origin'), 'utf8').trim();
    return origin && origin !== execPath ? origin : null;
  } catch {
    return null;
  }
}

/** npm-cli.js shipped beside this node binary (homebrew node has it; a bare
 *  DigbyHelper does not — but those installs are excluded anyway).
 *  51d8dbe0: when running as the DigbyAgent COPY, the directory beside
 *  process.execPath (…/Digby/bin) holds no npm-cli.js — fall back to the
 *  ORIGINAL node the copy was made from (see nodeOriginPath). */
export function npmCliPath(execPath: string = process.execPath): string | null {
  const candidates: string[] = [];
  const addCandidate = (dir: string) => {
    candidates.push(join(dir, 'npm-cli.js'));
    candidates.push(join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  };
  addCandidate(dirname(execPath));
  const origin = nodeOriginPath(execPath);
  if (origin) addCandidate(dirname(origin));
  for (const c of candidates) {
    try {
      accessSync(c, constants.R_OK);
      return c;
    } catch { /* next */ }
  }
  return null;
}

export type SelfUpdateResult =
  | { outcome: 'applied'; version: string; backupDir: string }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'failed'; reason: string };

/**
 * Try to self-update to the advertized release. NEVER throws — a failed
 * update must leave the running agent untouched (outcome 'failed').
 * macOS/network path; unit tests cover the pure gates above and pin this
 * wiring by source bytes.
 */
export async function trySelfUpdate(advert: unknown, agentRoot: string): Promise<SelfUpdateResult> {
  if (selfUpdateDisabled()) return { outcome: 'skipped', reason: 'DIGBY_SELF_UPDATE=0' };
  if (!advertActionable(advert, AGENT_VERSION)) return { outcome: 'skipped', reason: 'advert not actionable (older/malformed)' };
  const a = advert as UpdateAdvert;
  if (!isSelfManagedInstall(agentRoot)) return { outcome: 'skipped', reason: 'install not self-managed (app/pkg/dev tree)' };
  if (!retryAllowed(loadUpdateState(), Date.now(), a.version)) return { outcome: 'skipped', reason: 'retry backoff / max attempts' };

  const npm = npmCliPath();
  if (!npm) return { outcome: 'failed', reason: 'npm-cli.js not found beside node — cannot build' };

  saveUpdateState({ lastAttemptAt: new Date().toISOString(), failures: (loadUpdateState()?.failures || 0), version: a.version });

  const stagingRoot = join(agentRoot, '..', `.digby-update-staging-${Date.now()}`);
  const stagedAgent = join(stagingRoot, 'imessage-agent');
  const tgz = join(stagingRoot, 'agent.tar.gz');
  // Reviewer follow-up (4e75cdea): a hung download must never hang the poll
  // loop — bound the whole fetch, not just the shell steps.
  const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
  try {
    // 1. Download + verify checksum (the pin that makes a stale/poisoned
    //    artifact on the server a NO-OP instead of a fleet rollback).
    mkdirSync(stagingRoot, { recursive: true });
    const res = await fetch(a.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) return { outcome: 'failed', reason: `download HTTP ${res.status}` };
    const bytes = Buffer.from(await res.arrayBuffer());
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== a.sha256) return { outcome: 'failed', reason: `sha256 mismatch (got ${digest.slice(0, 12)}…)` };
    writeFileSync(tgz, bytes);

    // 2. Extract + the tarball's own version must equal the advert (no
    //    downgrade / no bait-and-switch artifact).
    const ex = await run('tar', ['-xzf', tgz, '-C', stagingRoot], { timeoutMs: 60_000 });
    if (ex.code !== 0 || !existsSync(join(stagedAgent, 'package.json'))) {
      return { outcome: 'failed', reason: `extract failed: ${ex.stderr.slice(0, 200)}` };
    }
    const tarVersion = parseTarballVersion(readFileSync(join(stagedAgent, 'package.json'), 'utf8'));
    if (!tarVersion || tarVersion !== a.version) {
      return { outcome: 'failed', reason: `tarball version ${tarVersion || '?'} ≠ advert ${a.version}` };
    }

    // 3. Build (the tarball ships src/, same as install.sh). Reviewer F6: a
    //    launchd session has a minimal PATH — make the toolchain (clang,
    //    python3, node-gyp helpers) discoverable for the native build.
    //    51d8dbe0: when we run as the DigbyAgent copy, the ORIGIN node's dir
    //    heads the PATH — an nvm-installed origin would otherwise be
    //    invisible to the staged npm ci/build.
    const originNode = nodeOriginPath();
    const buildEnv = {
      ...process.env,
      PATH: `${originNode ? `${dirname(originNode)}:` : ''}${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`,
    };
    const ci = await run(process.execPath, [npm, 'ci', '--no-audit', '--no-fund'], { cwd: stagedAgent, timeoutMs: 10 * 60_000, env: buildEnv });
    if (ci.code !== 0) return { outcome: 'failed', reason: `npm ci failed: ${ci.stderr.slice(0, 200)}` };
    const build = await run(process.execPath, [npm, 'run', 'build'], { cwd: stagedAgent, timeoutMs: 5 * 60_000, env: buildEnv });
    if (build.code !== 0) return { outcome: 'failed', reason: `npm run build failed: ${build.stderr.slice(0, 200)}` };
    if (!existsSync(join(stagedAgent, 'dist', 'index.js'))) return { outcome: 'failed', reason: 'build produced no dist/index.js' };

    // 3.5 NATIVE CARRY (ticket 0e4c9601): `npm ci` just rebuilt better_sqlite3
    //     ADHOC/linker-signed in the staging tree. A Team-signed hardened-
    //     runtime interpreter (DigbyHelper) refuses adhoc libraries at dlopen —
    //     but only under the real launchd context, so the smoke below could
    //     still pass and the swap would silently kill iMessage reads (exactly
    //     what mbp-5 hit live on the 0.8.0 bootstrap). The CURRENT tree's
    //     .node is proven loadable under THIS interpreter — carry it over the
    //     staged rebuild when the dep version is unchanged; a version change
    //     REFUSES the swap (a signed module for the new version must ship with
    //     a manual release — see publish-agent-tarball.sh).
    const carry = carryNativeModules(agentRoot, stagedAgent);
    if (!carry.ok) return { outcome: 'failed', reason: carry.reason };

    // 4. Smoke test the NEW tree before swapping: imports every runtime module
    //    (better-sqlite3 native ABI included — each native addon also loaded
    //    in a FRESH child, 0e4c9601) and must self-report the version.
    const smoke = await run(process.execPath, [join(stagedAgent, 'dist', 'index.js'), 'selftest'], { cwd: stagedAgent, timeoutMs: 120_000, env: buildEnv });
    if (smoke.code !== 0 || !smoke.stdout.includes(`SELFTEST_OK ${a.version}`)) {
      return { outcome: 'failed', reason: `selftest failed: ${(smoke.stderr || smoke.stdout).slice(0, 200)}` };
    }

    // 5. Swap with rollback retained: agentRoot → bak, staging → agentRoot.
    const backupDir = `${agentRoot}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(agentRoot, backupDir);
    try {
      renameSync(stagedAgent, agentRoot);
    } catch (e) {
      // Put the old tree back before giving up — never leave a hole.
      renameSync(backupDir, agentRoot);
      return { outcome: 'failed', reason: `swap failed: ${String(e).slice(0, 200)}` };
    }
    try { rmSync(join(agentRoot, '.digby-selfupdate'), { force: true }); writeFileSync(join(agentRoot, '.digby-selfupdate'), `${a.version}\n`); } catch { /* marker best-effort */ }

    // Reviewer F8 (4e75cdea): prune older backups — keep the newest one (the
    // immediate rollback target) and drop stale trees from prior releases so
    // ~200MB node_modules copies don't bleed disk forever. Best-effort.
    try {
      const parent = dirname(agentRoot);
      const base = `${basename(agentRoot)}.bak-`;
      const baks = readdirSync(parent).filter((n) => n.startsWith(base)).sort();
      while (baks.length > 1) {
        const oldest = baks.shift()!;
        try { rmSync(join(parent, oldest), { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    } catch { /* best-effort */ }

    // 6. Pending marker + detached watchdog from the OLD tree (the code now at
    //    backupDir) — if the new binary never writes the ok-marker within the
    //    deadline, the watchdog restores the backup.
    try {
      if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(PENDING_PATH, JSON.stringify({ version: a.version, backupDir, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
      try { rmSync(OK_PATH, { force: true }); } catch { /* absent is fine */ }
      const { spawn } = require('child_process') as typeof import('child_process');
      const watchdog = spawn(process.execPath, [join(backupDir, 'dist', 'index.js'), 'update-watchdog', agentRoot, backupDir, String(HEALTH_DEADLINE_MS)], {
        detached: true, stdio: 'ignore', env: buildEnv,
      });
      watchdog.unref();
    } catch { /* watchdog best-effort: without it the swap still stands (manual rollback = the .bak dir) */ }

    return { outcome: 'applied', version: a.version, backupDir };
  } catch (e: any) {
    return { outcome: 'failed', reason: `unexpected: ${String(e?.message || e).slice(0, 200)}` };
  } finally {
    try { rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Called by the run loop after a SUCCESSFUL poll: this binary is alive and
 * talking to the backend — if it is the pending update, confirm it (the
 * watchdog sees the ok-marker and stands down; the .bak dir is kept for
 * manual rollback and ages out with the next successful update).
 */
export function noteHealthyPoll(): void {
  try {
    if (!existsSync(PENDING_PATH)) return;
    const pending = JSON.parse(readFileSync(PENDING_PATH, 'utf8')) as { version?: string };
    if (pending.version !== AGENT_VERSION) return; // not about this binary
    writeFileSync(OK_PATH, `${AGENT_VERSION} ${new Date().toISOString()}\n`);
    rmSync(PENDING_PATH, { force: true });
    saveUpdateState({ lastAttemptAt: new Date().toISOString(), failures: 0, version: pending.version });
  } catch { /* best-effort */ }
}

/**
 * `update-watchdog <agentRoot> <backupDir> <deadlineMs>` — detached child of
 * the OLD tree. Sleeps the deadline, then: ok-marker present → exit 0 (the
 * update confirmed itself); missing → restore the backup and record a
 * failure (the retry gate then backs off before trying that release again).
 */
export async function runWatchdog(agentRoot: string, backupDir: string, deadlineMs: number): Promise<number> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  await sleep(Math.max(1000, deadlineMs));
  try {
    if (existsSync(OK_PATH)) {
      try { rmSync(PENDING_PATH, { force: true }); } catch { /* already gone */ }
      return 0;
    }
    // Not healthy in time → roll back.
    try { rmSync(agentRoot, { recursive: true, force: true }); } catch { /* fall through to restore */ }
    renameSync(backupDir, agentRoot);
    const state = loadUpdateState();
    // F2: count the failure against the release we were moving TO (the pending
    // marker names it; fall back to keeping the recorded version).
    let targetVersion = state?.version;
    try {
      if (existsSync(PENDING_PATH)) {
        targetVersion = (JSON.parse(readFileSync(PENDING_PATH, 'utf8')) as { version?: string }).version || targetVersion;
      }
    } catch { /* best-effort */ }
    saveUpdateState({ lastAttemptAt: new Date().toISOString(), failures: (state?.failures || 0) + 1, version: targetVersion });
    try { rmSync(PENDING_PATH, { force: true }); } catch { /* best-effort */ }
    return 1;
  } catch {
    return 1;
  }
}
