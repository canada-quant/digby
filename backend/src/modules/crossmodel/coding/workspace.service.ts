/**
 * Digby Code — Workspace Service
 *
 * Manages the on-disk git workspaces backing coding sessions:
 *   ${CODING_WORKSPACE_ROOT}/repos/<projectId>.git   — bare mirror cache (one clone per project)
 *   ${CODING_WORKSPACE_ROOT}/worktrees/<sessionId>   — a git worktree per session (own branch)
 * (build 2026-10-08 ISO: or, per-user subtree, `<root>/<userKey>/repos/…` and
 * `<root>/<userKey>/worktrees/…` — workspace-layout.ts; repoMirrorPath /
 * worktreePath resolve wherever the data IS.)
 *
 * A project is cloned once (bare mirror); each session adds a lightweight worktree
 * off that mirror on a fresh branch, so N sessions on one repo share storage and
 * don't collide. Requires `git` on the host (added to the backend Dockerfile).
 *
 * Auth: private GitHub repos use the user's stored OAuth token, injected into the
 * HTTPS remote as `https://x-access-token:<token>@github.com/...`. The token is
 * used only for the clone/fetch subprocess and is NEVER written to disk in the
 * remote config (we set the sanitized URL back after fetching).
 *
 * NOTE (ephemerality): blue-green deploys start fresh containers, so worktrees do
 * not survive a deploy unless CODING_WORKSPACE_ROOT is a mounted volume. Sessions
 * are re-provisionable (ensureWorktree re-creates from the mirror), so this is
 * recoverable, not fatal. A Docker volume mount is the durability upgrade.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import { writeFileSync } from 'fs';
import * as path from 'path';
import logger from '../../../utils/logger';
import { withProjectLock } from './project-lock';
import {
  redactGitError,
  redactUrlCredentials,
} from '../../../utils/redact-credentials';
// build 2026-10-08 ISO — per-user workspace subtree: the dual-read resolvers
// (always on; byte-identical answers while nothing is placed per-user) and the
// placement of NEW worktrees / mirrors (switch CODING_WORKSPACE_PER_USER_SUBTREE).
import {
  resolveWorktreePathSync, resolveMirrorPathSync, legacyWorktreePath, isMigratedCompatLinkSync,
  noteWorktreePlacement, noteMirrorPlacement, forgetPlacement, listPerUserWorktreeDirsSync,
} from './workspace-layout';
import { placeNewWorktree, placeNewMirror, recordIsolationMetric } from './workspace-placement';

const execFileAsync = promisify(execFile);

// Exported for worktree-snapshot.service's disk lock-litter sweep (firing 3,
// 2026-09-22) — the leaked `.snap-index-*.lock` strays live directly in here.
export const WORKSPACE_ROOT = process.env.CODING_WORKSPACE_ROOT || '/app/coding-workspaces';
const REPOS_DIR = path.join(WORKSPACE_ROOT, 'repos');
const WORKTREES_DIR = path.join(WORKSPACE_ROOT, 'worktrees');
// Per-session env seeds ($DIGBY_ENV) persisted OUTSIDE the git worktree so they
// survive worktree reaps. See persistSessionEnv below (2026-08-20 canlaw wipe).
// SECURITY (review 2026-08-20): the sidecar lives on its OWN volume mounted only
// into backend/worker (CODING_ENV_ROOT, docker-compose.app.yml coding_session_env)
// — NOT inside the workspace volume, which session containers can receive
// whole-volume as a fallback mount. Default: a sibling of WORKSPACE_ROOT (prod
// compose mounts the named volume there; tests point both roots at tmp dirs).
const SESSION_ENV_DIR = process.env.CODING_ENV_ROOT
  || path.join(path.dirname(WORKSPACE_ROOT), 'coding-session-env');
// Fail-fast footgun guard (review round 2): the sidecar store must NEVER sit
// inside the workspace volume — session containers can mount that volume
// whole as a fallback, which is exactly the cross-session exposure the
// separation exists to close. A misconfigured env kills the boot loudly
// instead of silently reopening the hole.
{
  const wsAbs = path.resolve(WORKSPACE_ROOT);
  const envAbs = path.resolve(SESSION_ENV_DIR);
  if (envAbs === wsAbs || envAbs.startsWith(wsAbs + path.sep)) {
    throw new Error(
      `CODING_ENV_ROOT (${envAbs}) must not live inside CODING_WORKSPACE_ROOT (${wsAbs}) — ` +
      `session containers can mount that volume; env seeds would be readable cross-session.`,
    );
  }
}

/**
 * Paths the harness must NEVER sweep into a git object (ticket 58cb5dfc,
 * 2026-09-19): `.digby/secrets/` had no ignore coverage anywhere — the repo
 * .gitignore doesn't know it and worktree info/exclude covered only
 * `.digby/session/` — so the checkpoint's wip-stash `git add -A` carried
 * secret files into the shared mirror's object store, and the reattach
 * `git stash apply` staged them in the lane's REAL index, one broad
 * `git commit` away from a pushed credential. Written to a harness-level
 * ignore file that gitEnv points every git subprocess at via
 * `core.excludesFile`: ignored paths on a directory-traversal `git add -A`
 * skip SILENTLY (unlike a literal `:(exclude)` pathspec, which dies with
 * "paths are ignored" the moment the path is also gitignored — verified
 * 2026-09-19), and a MISSING file is treated as empty, so an unwritable
 * WORKSPACE_ROOT degrades to pre-fix behavior instead of failing every call.
 * installWorktreeExcludes additionally git-ignores the same paths per
 * worktree so the LANE's own shell-side `git add -A` is covered too.
 */
export const GIT_ADD_NEVER_INCLUDE = ['.digby/secrets/'] as const;
const HARNESS_ADD_IGNORE_FILE = path.join(WORKSPACE_ROOT, '.digby-harness-add-ignore');
let harnessAddIgnoreReady = false;
function ensureHarnessAddIgnoreFile(): void {
  if (harnessAddIgnoreReady) return;
  try {
    writeFileSync(HARNESS_ADD_IGNORE_FILE, `${GIT_ADD_NEVER_INCLUDE.join('\n')}\n`);
    harnessAddIgnoreReady = true;
  } catch { /* degrade: git treats a missing excludesFile as empty */ }
}

// git subprocess env: strip provider API keys so a hostile repo hook can't exfil
// them, and disable interactive/credential prompts so a private repo without a
// token fails fast instead of hanging.
function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  ensureHarnessAddIgnoreFile();
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: WORKSPACE_ROOT,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/true',
    GIT_CONFIG_NOSYSTEM: '1',
    // Never let repo discovery ascend out of the workspace root: probes like
    // `git rev-parse --git-dir` from a plain/broken worktree dir MUST fail so
    // reattachWorktree rebuilds. Without this, a WORKSPACE_ROOT nested inside
    // any outer git checkout (jest fixtures under backend/.jest-tmp,
    // 2026-08-24) makes the broken-worktree probe "find" the outer repo and
    // return the stale dir as if healthy. Every legitimate repo lives UNDER
    // WORKSPACE_ROOT, so nothing real is blocked.
    GIT_CEILING_DIRECTORIES: WORKSPACE_ROOT,
    // Ownership-drift resilience (nightly 2026-08-02): dirs in the shared volume
    // are normally nodejs-owned, but per-session runner containers (root in stock
    // node:20) can leave root-owned paths behind between entrypoint chowns — git
    // then refuses with "fatal: detected dubious ownership" (prod: 49 fails/48h
    // after the 2026-08-02 03:54Z chown). Subprocess-scoped: these git calls only
    // ever operate on our own workspace volume.
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
    // 58cb5dfc: harness git adds skip GIT_ADD_NEVER_INCLUDE via this ignore
    // file regardless of the worktree's own exclude state (a pre-fix
    // worktree's info/exclude may not have been topped up yet).
    GIT_CONFIG_KEY_1: 'core.excludesFile',
    GIT_CONFIG_VALUE_1: HARNESS_ADD_IGNORE_FILE,
    // Deterministic identity for commits the agent makes. Avatar on GitHub is
    // driven by this email via Gravatar (digby@digby.ai → the Digby icon).
    GIT_AUTHOR_NAME: 'Digby',
    GIT_AUTHOR_EMAIL: 'digby@digby.ai',
    GIT_COMMITTER_NAME: 'Digby',
    GIT_COMMITTER_EMAIL: 'digby@digby.ai',
  };
  return { ...base, ...extra };
}

export interface GitResult {
  stdout: string;
  stderr: string;
}

/** Run a git command; throws on non-zero exit. cwd is required for worktree ops.
 *  Backlog audit T7 (2026-09-28): a failure is rethrown with its message /
 *  stack / cmd / stderr / stdout run through `redactGitError` — execFile
 *  echoes the full argv into `err.message`, so an authed remote URL
 *  (`https://x-access-token:<token>@…`) rode every caller's
 *  `logger.warn(err.message)` into app_error_logs. Same error object (code,
 *  signal, killed survive); `GIT_ERROR_CREDENTIAL_SCRUB_DISABLED=1` restores
 *  the raw rethrow. */
export async function git(
  args: string[],
  cwd?: string,
  timeoutMs = 120_000,
  extraEnv: Record<string, string> = {},
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      env: gitEnv(extraEnv),
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (err) {
    throw redactGitError(err);
  }
}

/**
 * Where the project's bare mirror IS — the legacy `repos/<id>.git` unless it
 * lives under a per-user subtree (build 2026-10-08 ISO dual-read; identical
 * answer while nothing is placed per-user). A mirror that does not exist yet
 * resolves to the legacy path; ensureRepoMirror places NEW ones.
 */
export function repoMirrorPath(projectId: string): string {
  return resolveMirrorPathSync(projectId, WORKSPACE_ROOT);
}

/** Where the session's worktree IS (dual-read — see repoMirrorPath). */
export function worktreePath(sessionId: string): string {
  return resolveWorktreePathSync(sessionId, WORKSPACE_ROOT);
}

/**
 * build 2026-10-08 ISO: the directory a NEW worktree for this session goes to
 * (per-user subtree when the switch applies and the session is new, else the
 * legacy path) with its parent created. A dangling compatibility symlink left
 * at the legacy path (its migrated target is gone) is removed first so a
 * legacy re-provision never trips over it. Telemetry: one `workspace_isolation`
 * placement row whenever the switch is on.
 */
async function placeWorktreeDir(sessionId: string): Promise<string> {
  const legacy = legacyWorktreePath(sessionId, WORKSPACE_ROOT);
  if (isMigratedCompatLinkSync(legacy) && !(await pathExists(legacy))) {
    await fs.unlink(legacy).catch(() => {});
  }
  const placed = await placeNewWorktree(sessionId, WORKSPACE_ROOT);
  await fs.mkdir(path.dirname(placed.path), { recursive: true });
  if (placed.reason !== 'switch_off') {
    recordIsolationMetric('placement', { what: 'worktree', layout: placed.layout, reason: placed.reason }, sessionId);
  }
  return placed.path;
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

// ── Session env seed durability ($DIGBY_ENV sidecar) ─────────────────────────
// The per-session env file (<wt>/.digby/session/env.sh — the $DIGBY_ENV agents
// append `export FOO=…` lines to) is GIT-IGNORED by design (installWorktreeExcludes
// adds .digby/session/ to info/exclude), so neither durability mechanism ever captured
// it: the reaper's `git add -A` WIP commit and the checkpoint's stash snapshot
// both respect excludes. Reaping a worktree therefore DESTROYED the session's
// env seed and re-provision started empty — the 2026-08-20 "canlaw key wiped"
// root cause (CANLAW_SSH_PRIV_B64/CANLAW_SA_PRIV_B64 lived only in env.sh; 13
// sessions mass-reaped 08-20 02:36Z under disk pressure). Force-adding it to
// git is NOT an option: env.sh may hold secrets and the session branch gets
// pushed upstream. Instead we keep a sidecar copy OUTSIDE git, on the same
// named workspace volume (survives deploys + reaps), captured at every
// checkpoint/reap and restored on re-provision. Never mounted into session
// containers under scoped mounts (same host-only trust domain as the mirror).

const sessionEnvSidecarPath = (sessionId: string) => path.join(SESSION_ENV_DIR, `${sessionId}.sh`);
const worktreeEnvPath = (wt: string) => path.join(wt, '.digby', 'session', 'env.sh');

// Persist failures warn ONCE per session+error-code per process: persistSessionEnv
// runs at every checkpoint, so a durable failure floods app_error_log (2026-08-22:
// the root-owned env volume EACCES produced 8,299 rows/48h and masked every
// other signal). Failure semantics are unchanged — every call still returns
// false; only the log emission is gated. Keyed on the error CODE as well as the
// session so a CHANGED failure class (EACCES→ENOSPC) re-fires once (review).
const envPersistWarnedSessions = new Set<string>();
const noteEnvPersistFailure = (sessionId: string, code: string | undefined, emit: () => void): void => {
  const key = `${sessionId}:${code ?? 'unknown'}`;
  if (envPersistWarnedSessions.has(key)) return;
  envPersistWarnedSessions.add(key);
  emit();
};

/**
 * Snapshot the session's env seed to the sidecar (atomic tmp+rename, mode 600).
 * Best-effort: returns false when there is nothing to persist.
 */
export async function persistSessionEnv(wt: string, sessionId: string): Promise<boolean> {
  try {
    const src = worktreeEnvPath(wt);
    try {
      await fs.access(src);
    } catch (probeErr: any) {
      if (probeErr?.code === 'ENOENT') {
        // The live file is the source of truth: when env.sh is GONE (agent/user
        // deleted it — e.g. revoking a leaked key), the sidecar must die too,
        // otherwise the next re-provision would RESURRECT the removed secrets.
        // P6 (spark B24 / CanLaw B12) — missing ≠ empty: that rule holds ONLY
        // while the worktree itself exists. When the WHOLE worktree is gone
        // (reaped/wiped — e.g. a reap pass over an already-wiped worktree, or a
        // checkpoint firing post-wipe), the sidecar is the ONLY surviving copy
        // of the env seed; deleting it here destroyed exactly the backup that
        // restoreSessionEnv needs. Keep it unless the worktree is present.
        if (await pathExists(wt)) {
          await fs.rm(sessionEnvSidecarPath(sessionId), { force: true }).catch(() => {});
        }
      } else {
        // Transient fs error (EMFILE/EIO…): keep the existing sidecar rather
        // than delete a healthy backup on a bad probe (review round 2).
        // Rate-limited like the outer catch — a durable SRC-side failure
        // (e.g. EACCES on a root-owned .digby/session dir) would otherwise
        // reproduce the same per-checkpoint log storm (review round 3).
        noteEnvPersistFailure(sessionId, probeErr?.code, () =>
          logger.warn(`coding workspace: env persist probe failed for ${sessionId} (${probeErr.message}) — keeping existing sidecar (further failures for this session suppressed in this process)`));
      }
      return false;
    }
    await fs.mkdir(SESSION_ENV_DIR, { recursive: true });
    const dst = sessionEnvSidecarPath(sessionId);
    // Unique per CALL, not per process (autonomy loop #8): a checkpoint, a
    // finalize and a reap can persist the same session concurrently from one
    // pid — sharing `${dst}.${pid}.tmp` let the second writer's rename find
    // the file already moved (ENOENT, 8×/day in prod logs).
    const tmp = `${dst}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
    await fs.copyFile(src, tmp);
    await fs.chmod(tmp, 0o600).catch(() => {});
    await fs.rename(tmp, dst);
    return true;
  } catch (err: any) {
    noteEnvPersistFailure(sessionId, err?.code, () =>
      logger.warn(`coding workspace: session env persist failed for ${sessionId}: ${err.message} (further failures for this session suppressed in this process)`));
    return false;
  }
}

/**
 * Restore the sidecar env seed into a (re)provisioned worktree. NEVER
 * overwrites an existing env.sh — the worktree's own file is the live one.
 */
export async function restoreSessionEnv(wt: string, sessionId: string): Promise<boolean> {
  try {
    const src = sessionEnvSidecarPath(sessionId);
    const dst = worktreeEnvPath(wt);
    if (!(await pathExists(src)) || (await pathExists(dst))) return false;
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
    await fs.chmod(dst, 0o600).catch(() => {});
    logger.info(`coding workspace: restored session env seed for session ${sessionId} from sidecar`);
    return true;
  } catch (err: any) {
    logger.warn(`coding workspace: session env restore failed for ${sessionId}: ${err.message}`);
    return false;
  }
}

/** Delete the sidecar when the session itself is deleted (secret hygiene). */
export async function removeSessionEnv(sessionId: string): Promise<void> {
  await fs.rm(sessionEnvSidecarPath(sessionId), { force: true }).catch(() => {});
}

/** Session ids with a sidecar on disk — for the orphan sweep (deleted users'
 *  sessions leave no DB row, so their env seeds must not outlive them). */
export async function listSessionEnvSidecars(): Promise<string[]> {
  try {
    return (await fs.readdir(SESSION_ENV_DIR))
      .filter(f => f.endsWith('.sh'))
      .map(f => f.slice(0, -3));
  } catch { return []; }
}

/** Build an authenticated HTTPS clone URL when a token is provided.
 *  Exported for session-history-sync: mirrors persist a TOKENLESS origin (the
 *  finally-block below strips credentials), so any push from a mirror must
 *  build its own authed URL per operation. */
export function authedUrl(repoUrl: string, token?: string | null): string {
  if (!token) return repoUrl;
  try {
    const u = new URL(repoUrl);
    if (u.protocol !== 'https:') return repoUrl;
    // GitHub accepts x-access-token:<token>; generic hosts accept the same.
    u.username = 'x-access-token';
    u.password = token;
    return u.toString();
  } catch {
    return repoUrl;
  }
}

/**
 * Ticket d6110694 (2026-09-28, prod project 922fd3ad cql-accelerator): git
 * error messages embed the full cmd / stderr text that can carry credential
 * shapes (x-access-token:<live OAuth token>@ in a set-url cmdline, a bare
 * ghp_… PAT in stderr). Redaction is CENTRAL (utils/redact-credentials):
 * `git()` rethrows through `redactGitError` (the object seam, T6/T7) and every
 * warn site here stringifies through `redactUrlCredentials` (the string seam).
 * Both paths carry the d6110694 GitHub token-prefix shapes ported into the
 * central util — shape-based redaction, never URL parsing.
 */

/**
 * Ticket d6110694 (2026-09-28, prod project 922fd3ad cql-accelerator): a
 * mirror born under the 'local' provider (`git init --bare` — no remote) can
 * outlive its provider: persistProjectRepo flips the project row to 'github'
 * after the session's first push creates a real repo, but NOTHING ever adds
 * `origin` to the existing mirror. Every later provision then died at
 * `git remote set-url origin <authed-url>` ("No such remote 'origin'") —
 * logged 3× at 17:47Z during the owner's spark-cluster window — and the
 * mirror could never refresh from upstream again. Heal it in place: probe the
 * remote and ADD it when missing. Idempotent; probe is one cheap
 * config --get.
 */
async function healMissingOrigin(mirror: string, repoUrl: string): Promise<void> {
  try {
    const { stdout } = await git(['config', '--get', 'remote.origin.url'], mirror, 10_000);
    if (String(stdout).trim()) return; // origin exists — nothing to heal
  } catch {
    // --get exits 1 when unset — the exact origin-less shape we heal.
  }
  logger.warn(`coding workspace: mirror at ${mirror} has NO origin remote (local-born mirror under a github/git project) — adding origin ${repoUrl}`);
  try {
    await git(['remote', 'add', 'origin', repoUrl], mirror, 30_000);
    await demoteMirrorRefspec(mirror); // fetch layout, never a mirror-prune layout
  } catch (err: any) {
    logger.warn(`coding workspace: could not add missing origin to ${mirror}: ${redactUrlCredentials(err.message)}`);
  }
}


/**
 * Ensure the project's bare mirror exists and is reasonably fresh.
 * Returns the mirror path. Safe to call repeatedly.
 */
export async function ensureRepoMirror(
  projectId: string,
  repoUrl: string,
  token?: string | null,
): Promise<string> {
  // Clone/fetch mutates the SHARED per-project bare mirror (repos/<id>.git on
  // the volume shared by web + worker + blue/green) — run the whole body under
  // the cross-process project lock (#252 review; todo fed7731d) so concurrent
  // provisions serialize instead of racing a clone/fetch --prune. Fail-open
  // posture preserved: Redis down → in-process mutex only (see project-lock).
  return withProjectLock(projectId, async () => {
    await fs.mkdir(REPOS_DIR, { recursive: true });
    let mirror = repoMirrorPath(projectId);
    const url = authedUrl(repoUrl, token);

    if (await pathExists(mirror)) {
      // A Digby-owned bare repo (provider 'local' — repoUrl '') has no remote to
      // refresh from: it IS the origin. The set-url/fetch below used to log
      // "No such remote 'origin'" on every attach (noise only, but 3×/day).
      if (!repoUrl || !String(repoUrl).trim()) return mirror;
      // d6110694-A: a local-born mirror under a github/git project (provider
      // flipped by persistProjectRepo after the first push) has NO origin —
      // set-url below would die "No such remote 'origin'" on EVERY provision
      // (prod 922fd3ad, 3× at 17:47Z) and the mirror never refreshes. Heal.
      await healMissingOrigin(mirror, repoUrl);
      // Refresh; tolerate transient network errors (worktree can still use cache).
      try {
        await git(['remote', 'set-url', 'origin', url], mirror);
        await demoteMirrorRefspec(mirror); // A1 — see below; idempotent
        await git(['fetch', '--prune', 'origin'], mirror, 180_000);
        await unshallowMirrorIfNeeded(mirror); // b3a35131 — see below; best-effort
      } catch (err: any) {
        // d6110694-B: git error text embeds the AUTHED URL (live OAuth token) —
        // redact before it reaches any log surface.
        logger.warn(`coding workspace: mirror fetch failed for ${projectId} (using cache): ${redactUrlCredentials(err.message)}`);
      } finally {
        // Never leave the token in the persisted remote config.
        await git(['remote', 'set-url', 'origin', repoUrl], mirror).catch(() => {});
      }
      return mirror;
    }

    // FO firing 19 (2026-09-24, prod run d2c9ad39 / session 356cea22): a
    // 'local'-provider project (repoUrl NULL by design — its mirror is a
    // Digby-owned bare repo born in ensureProvisioned, never cloned) whose
    // mirror directory is gone (host volume loss) reached this clone with an
    // EMPTY source: `git clone --mirror '' <mirror>` → "fatal: repository ''
    // does not exist" → the run failed with a cryptic cause and the session
    // stayed permanently unrunnable. Fail fast with the actionable truth
    // instead: a remote-backed project names its repo; a local one names the
    // self-heal path. (No data loss either way: the worktree-rm branch in
    // reattachWorktree runs AFTER this call, so a hard throw here preserves
    // the existing worktree for the mirror-first re-provision order.)
    if (!repoUrl || !String(repoUrl).trim()) {
      throw new Error(
        `project ${projectId} has no repoUrl and its local mirror is missing — ` +
        `a 'local' workspace mirror must be re-created via project-workspace ensureProvisioned ` +
        `(or configureWorkspace with a repoUrl); nothing can be cloned`,
      );
    }

    // build 2026-10-08 ISO: a NEW mirror goes under the project owner's
    // per-user subtree when the switch applies to the owner (else legacy —
    // the switch off answers with no DB access, byte-identical).
    const placed = await placeNewMirror(projectId, WORKSPACE_ROOT);
    if (placed.layout === 'per_user') {
      mirror = placed.path;
      await fs.mkdir(path.dirname(mirror), { recursive: true });
    }
    if (placed.reason !== 'switch_off') recordIsolationMetric('placement', { what: 'mirror', projectId, layout: placed.layout, reason: placed.reason });
    logger.info(`coding workspace: cloning mirror for project ${projectId}`);
    try {
      await git(['clone', '--mirror', url, mirror], undefined, 300_000);
      await demoteMirrorRefspec(mirror);
    } finally {
      await git(['remote', 'set-url', 'origin', repoUrl], mirror).catch(() => {});
    }
    if (placed.layout === 'per_user') noteMirrorPlacement(projectId, mirror);
    return mirror;
  });
}

/**
 * A1 (One-Digby amendment): a `--mirror` clone fetches `+refs/*:refs/*` with
 * prune semantics that DELETE any local ref not on the remote. That silently
 * destroys Digby-owned local branches — unpushed `digby/session-*` branches the
 * moment their worktree is reaped (prune refuses only while a branch is checked
 * out), and `digby/knowledge` (never auto-pushed by design). Demote the remote
 * to a normal fetch layout: remote state lives under refs/remotes/origin/*
 * (pruned freely), local refs/heads/* (Digby's branches) are never touched.
 * Idempotent; safe on existing mirrors (their stale refs/heads copies of remote
 * branches simply stop updating — worktree bases resolve origin/<branch> which
 * now maps to refs/remotes/origin/<branch>).
 */
async function demoteMirrorRefspec(mirror: string): Promise<void> {
  await git(['config', 'remote.origin.mirror', 'false'], mirror).catch(() => {});
  await git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], mirror).catch(() => {});
}

/**
 * b3a35131 (2026-09-14): a mirror that has gone SHALLOW (an ops re-clone with
 * --depth, a disk-prune re-seed, …) silently breaks git archaeology in EVERY
 * session worktree: `git log -- <path>` stops at the shallow boundary, whose
 * grafted diff spans the whole tree — so path-scoped history collapses to one
 * unrelated-looking commit, rev ranges die with "unknown revision", and read
 * roles (explorer/reviewer, no shell) can no longer do per-file archaeology at
 * all. Detect + heal at the single choke point every provisioning passes
 * through: a full `fetch --unshallow` restores complete history (one-time cost
 * per mirror; afterwards the is-shallow probe is one cheap rev-parse). Runs
 * while the authed URL is set so private repos heal too. Best-effort: on
 * failure the cached (shallow) mirror still works and the next ensure retries.
 */
async function unshallowMirrorIfNeeded(mirror: string): Promise<void> {
  let shallow = false;
  try {
    const { stdout } = await git(['rev-parse', '--is-shallow-repository'], mirror);
    shallow = stdout.trim() === 'true';
  } catch {
    return; // probe failed (very old git / odd mirror) — never block provisioning
  }
  if (!shallow) return;
  logger.warn(`coding workspace: mirror at ${mirror} is SHALLOW — fetching full history (unshallow)`);
  try {
    await git(['fetch', '--unshallow', 'origin'], mirror, 600_000);
    logger.info(`coding workspace: mirror unshallowed OK (${mirror})`);
  } catch (err: any) {
    logger.warn(`coding workspace: mirror unshallow failed for ${mirror} (staying shallow): ${redactUrlCredentials(err.message)}`);
  }
  await pruneUnreachableShallowResidue(mirror);
}

/**
 * d6110694-C (prod 0560b7b8 spark-cluster, 2026-09-28): a mirror can carry a
 * shallow file entry for a commit UNREACHABLE from every ref (a squashed-PR
 * lineage whose branch was later deleted on origin: fetch --prune removed
 * the ref, the dead lineage's boundary entry stayed and its ancestors are
 * missing, so --unshallow — which only clears entries it actually deepens —
 * exits 0 as a silent no-op and REWRITES the file keeping the dead entry).
 * The probe still says true on every provision and the warn/unshallow pair
 * repeats forever (16 pairs in 26h on box C) while archaeology stays broken.
 * Verify the heal actually landed; when it did not, prune entries that are
 * unreachable from every ref — residue by definition, and provably safe:
 * no ref can walk into a lineage no ref reaches. NOTE: an EMPTY shallow file
 * still reports is-shallow=true (verified live, git 2.39/2.52) — the file
 * must be DELETED, never truncated.
 *
 * EXPORTED so the residue cases in workspace-shared-mirror.d6110694.test.ts can
 * drive the prune DIRECTLY. They used to reach it by skipping the fetch with a
 * now-deleted env kill switch, because a real
 * `fetch --unshallow` in that fixture heals the mirror first and the prune then
 * early-returns — so those cases asserted an end state any of two paths could
 * produce. Calling this function with no fetch in the picture is strictly more
 * discriminating, and it cost the kill switch nothing to keep.
 */
export async function pruneUnreachableShallowResidue(mirror: string): Promise<void> {
  try {
    const { stdout } = await git(['rev-parse', '--is-shallow-repository'], mirror);
    if (stdout.trim() !== 'true') return; // healed for real — nothing to do
    const shallowFile = path.join(mirror, 'shallow');
    const entries = (await fs.readFile(shallowFile, 'utf8')).split('\n').filter(Boolean);
    const reachable: string[] = [];
    for (const sha of entries) {
      // A boundary whose object is missing entirely, or whose commits no ref
      // can reach (`rev-list --count <sha> --not --all` > 0), is residue.
      const exists = await git(['cat-file', '-e', `${sha}^{commit}`], mirror, 15_000)
        .then(() => true).catch(() => false);
      if (!exists) continue;
      const count = await git(['rev-list', '--count', sha, '--not', '--all'], mirror, 60_000)
        .then(r => parseInt(r.stdout.trim(), 10)).catch(() => NaN);
      if (Number.isFinite(count) && count === 0) reachable.push(sha); // genuinely reachable — keep
    }
    if (reachable.length === entries.length) {
      logger.warn(`coding workspace: mirror at ${mirror} still SHALLOW after unshallow — every boundary reachable; leaving as-is (will retry next provision)`);
      return;
    }
    if (reachable.length === 0) {
      await fs.rm(shallowFile, { force: true }); // empty file still reads as shallow — delete
    } else {
      await fs.writeFile(shallowFile, `${reachable.join('\n')}\n`);
    }
    logger.warn(`coding workspace: pruned ${entries.length - reachable.length} unreachable shallow-boundary entr${entries.length - reachable.length === 1 ? 'y' : 'ies'} from ${mirror} (${reachable.length} reachable kept)`);
    const { stdout: after } = await git(['rev-parse', '--is-shallow-repository'], mirror);
    if (after.trim() !== 'true') {
      logger.info(`coding workspace: mirror at ${mirror} is now complete after residue prune`);
    }
  } catch (err: any) {
    logger.warn(`coding workspace: shallow-residue verify/prune failed for ${mirror} (left as-is): ${redactUrlCredentials(err.message)}`);
  }
}

/**
 * Seed an initial commit into a bare mirror whose upstream has ZERO commits
 * (empty repo): one commit over git's well-known empty tree, stored as
 * refs/heads/<baseBranch>, so worktree/branch operations have a valid base.
 * Mirror-LOCAL only — never pushed upstream (the agent's first session-branch
 * push carries it up organically; if the owner later pushes their own initial
 * commit, the two roots coexist and new sessions simply base off
 * origin/<baseBranch> again). Identity is subprocess-scoped (-c flags) — no
 * config writes.
 */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git's built-in empty tree
async function seedEmptyMirrorBase(mirror: string, baseBranch: string): Promise<void> {
  const { stdout } = await git(
    ['-c', 'user.name=Digby', '-c', 'user.email=digby@digby.ai',
     'commit-tree', EMPTY_TREE_SHA, '-m', 'Initial commit (seeded by Digby — upstream repository was empty)'],
    mirror,
  );
  await git(['update-ref', `refs/heads/${baseBranch}`, stdout.trim()], mirror);
  // Point the mirror's unborn HEAD at the seeded branch too, so later sessions'
  // `rev-parse --verify HEAD` resolves and never re-seeds (review MINOR 2).
  await git(['symbolic-ref', 'HEAD', `refs/heads/${baseBranch}`], mirror).catch(() => {});
  logger.warn(`coding workspace: upstream repo is empty — seeded a mirror-local initial commit on ${baseBranch} (never pushed)`);
}

// ── worktree add: cross-process serialization + bounded lock-class retry ──────
// 2026-10-20 + 2026-10-09 prod incidents (sessions d66f78f9 / f0dd977c): two
// same-project provisions started <100ms apart (63ms / 3.2s) both ran
// `git worktree add -b … origin/main` against the SAME shared bare mirror.
// Setting up the new branch's upstream config writes the mirror's ONE shared
// config file; the loser died "could not lock config file config: File exists
// / unable to write upstream branch configuration", flipped to
// status='error' — and because sweepPendingFirstPrompts only picks
// status:'ready' rows, its stashed first prompt was never delivered until a
// later dispatch healed it (d66f78f9 sat parked 2h34m). Primary fix: the add
// runs under the SAME cross-process project lock ensureRepoMirror already
// serializes mirror mutations with. The retry covers contenders that do NOT
// hold the project lock: the reaper's worktree remove/prune, and agent-side
// `git config` in OTHER sessions' worktrees (a linked worktree's plain
// `git config` writes the COMMON config file) — those hold the mirror's
// config.lock for milliseconds, which a short bounded retry bridges.
const WORKTREE_ADD_LOCK_RETRY_MS = 500;
const WORKTREE_ADD_LOCK_ATTEMPTS = 8; // ~3.5s worst case before surfacing the real error

function isGitConfigLockError(err: any): boolean {
  return /could not lock config file|Another git process seems to be running|unable to write upstream branch configuration/i
    .test(String(err?.message ?? ''));
}

/**
 * `git worktree add` under the cross-process project lock, with a bounded
 * retry on git's transient config-lock class. `freshBranch` names the branch a
 * `-b` add creates: a failed attempt may leave the branch ref and a partial
 * worktree dir behind, both artifacts of THIS attempt (a `-b` add over a
 * pre-existing branch fails BEFORE any config write, so a branch present at
 * cleanup time was created by us) — clean both before retrying so the retry
 * starts from a blank slate instead of dying "already exists".
 */
async function addWorktreeSerialized(
  projectId: string,
  mirror: string,
  wt: string,
  args: string[],
  freshBranch?: string,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await withProjectLock(projectId, () => git(args, mirror, 180_000));
      return;
    } catch (err: any) {
      if (attempt >= WORKTREE_ADD_LOCK_ATTEMPTS || !isGitConfigLockError(err)) throw err;
      logger.warn(
        `coding workspace: worktree add hit a git config lock on ${projectId} (attempt ${attempt}/${WORKTREE_ADD_LOCK_ATTEMPTS}) — clearing this attempt's partial state, retrying in ${WORKTREE_ADD_LOCK_RETRY_MS}ms`,
      );
      await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
      await git(['worktree', 'prune'], mirror).catch(() => {}); // drop the half-registered admin dir
      if (freshBranch) await git(['branch', '-D', freshBranch], mirror).catch(() => {});
      await new Promise(res => setTimeout(res, WORKTREE_ADD_LOCK_RETRY_MS));
    }
  }
}

/**
 * Create (or recreate) a worktree for a session on a fresh branch off baseBranch.
 * Returns the worktree path.
 */
export async function ensureWorktree(
  projectId: string,
  sessionId: string,
  repoUrl: string,
  baseBranch: string,
  branch: string,
  token?: string | null,
  startRef?: string | null,
): Promise<string> {
  const mirror = await ensureRepoMirror(projectId, repoUrl, token);
  await fs.mkdir(WORKTREES_DIR, { recursive: true });
  let wt = worktreePath(sessionId);

  if (await pathExists(wt)) {
    await restoreSessionEnv(wt, sessionId); // no-op when env.sh already exists
    // Reuse path: top up the exclude set (idempotent) — worktrees provisioned
    // before .digby/secrets/ joined (ticket 58cb5dfc) never re-run
    // provisioning, so without this the secrets path stays stageable via
    // index-writing paths that bypass gitEnv (worktreeDiffHash's
    // `git add -A -N`) — the reviewer's M3/M6 reproduced gap.
    await installWorktreeExcludes(wt);
    return wt; // already provisioned
  }
  // build 2026-10-08 ISO: a NEW worktree goes where placement says (legacy
  // unless the per-user switch applies to this new session).
  wt = await placeWorktreeDir(sessionId);

  // Resolve the base ref: chain from a prior session's branch tip when one is
  // given (so a new session inherits earlier work), else the project's base
  // branch, else HEAD. All sessions share the mirror, so a prior session branch
  // (e.g. digby/session-abc123) is a local ref here.
  let baseRef = '';
  if (startRef) {
    try { await git(['rev-parse', '--verify', startRef], mirror); baseRef = startRef; } catch { baseRef = ''; }
  }
  if (!baseRef) {
    baseRef = `origin/${baseBranch}`;
    try { await git(['rev-parse', '--verify', baseRef], mirror); } catch { baseRef = 'HEAD'; }
  }
  if (baseRef === 'HEAD') {
    // Empty-upstream case: a repo with zero commits has no origin/<baseBranch>
    // AND an unborn HEAD, so `worktree add … HEAD` dies with "fatal: invalid
    // reference: HEAD" and the session wedges at coding.status=error (2026-08-16
    // prod reports: freshly-created empty GitHub repos attached to projects).
    // Verify HEAD before trusting it; when it too is unborn, seed a mirror-local
    // initial commit and base the session branch on that.
    try { await git(['rev-parse', '--verify', 'HEAD'], mirror); }
    catch {
      // baseBranch is user-controlled (project.defaultBranch) and lands here
      // UNPREFIXED for the first time — validate it before it reaches a
      // commit-ish slot so a garbage name fails with the real cause
      // (review MINOR 1: execFile = no shell risk, but fail clearly).
      await git(['check-ref-format', '--branch', baseBranch], mirror);
      await seedEmptyMirrorBase(mirror, baseBranch);
      baseRef = baseBranch;
    }
  }

  // Create the worktree with a new branch. Add to the mirror's worktree list.
  // Serialized + retried (2026-10-20 race): see addWorktreeSerialized.
  await addWorktreeSerialized(projectId, mirror, wt, ['worktree', 'add', '-b', branch, wt, baseRef], branch);
  noteWorktreePlacement(sessionId, wt);
  await setWorktreeIdentity(wt);
  await restoreSessionEnv(wt, sessionId); // re-seed env after a reap/wipe
  logger.info(`coding workspace: worktree ready for session ${sessionId} (branch ${branch}, from ${baseRef})`);
  return wt;
}

/**
 * Consistent commit identity for session worktrees. Without this, authorship
 * falls back to whatever the backend host's global gitconfig says — and agents
 * have been observed hand-running `git config user.email …` mid-session
 * (fa767dbf) to compensate. Repo-local; best-effort.
 */
async function setWorktreeIdentity(wt: string): Promise<void> {
  await git(['config', 'user.name', 'Digby'], wt).catch(() => {});
  await git(['config', 'user.email', 'digby@digby.ai'], wt).catch(() => {});
  await installWorktreeExcludes(wt);
}

/**
 * Keep the harness scratch dir out of `git status` at the WORKTREE level (not a
 * committed .gitignore, which would itself dirty the tree). Writes to the
 * per-worktree info/exclude — resolved via `git rev-parse --git-path` so it's
 * correct for linked worktrees (shared common dir) and blank standalone repos.
 * Covers the creds env.sh that plan's gitignore never reached (prod session
 * b92ef13f: committed a dirty tsbuildinfo). Idempotent + best-effort.
 *
 * B2 (remediation 2026-09-09): the exclude is `.digby/session/` (runtime
 * scratch: env.sh, attachments, plan lifeboat) — NOT the whole `.digby/`. The
 * old blanket `.digby/` made the scaffold's `git add … .digby` fail with
 * "paths are ignored", so `chore: scaffold Digby Code agent guide` never
 * committed, the framework files (config.json, notes/learnings.md, rules/)
 * never reached the branch, and every re-provision re-scaffolded a stub —
 * silently discarding lane-appended learnings. The secret-bearing env.sh
 * stays excluded (it lives under .digby/session/).
 *
 * 58cb5dfc (2026-09-19): `.digby/secrets/` joined the narrow set — lanes keep
 * credentials there and nothing git-ignored them (repo .gitignore doesn't
 * know the path; the B2 set covered only session/), so a checkpoint wip
 * stash + lane-side `git add -A` could stage them for commit. Older excludes
 * are topped up in place (idempotent).
 */
export async function installWorktreeExcludes(wt: string): Promise<void> {
  try {
    const { stdout } = await git(['rev-parse', '--git-path', 'info/exclude'], wt);
    const rel = stdout.trim();
    if (!rel) return;
    const excludePath = path.isAbsolute(rel) ? rel : path.join(wt, rel);
    const marker = '# Digby Code harness scratch — never commit';
    // Narrow set: runtime scratch + secret-bearing ops state.
    // `.digby/secrets/` joined 2026-09-19 (ticket 58cb5dfc) — lanes keep
    // credentials there and NOTHING else git-ignored them, so a broad
    // `git add -A` staged them for commit. The framework files
    // (config.json, notes/learnings.md, rules/) stay committable (B2).
    const patterns = ['.digby/session/', '.digby/secrets/'];
    let cur = '';
    try { cur = await fs.readFile(excludePath, 'utf8'); } catch { /* new file */ }
    if (cur.includes(marker)) {
      // Migrate a pre-B2 blanket exclude in place (blank-project clone chains
      // reuse the source repo's exclude file) so the framework becomes trackable.
      if (/^\.digby\/$/m.test(cur)) {
        cur = cur.replace(/^\.digby\/$/m, '.digby/session/');
        await fs.writeFile(excludePath, cur, 'utf8');
      }
      // Top up patterns an older install predates (idempotent).
      const missing = patterns.filter((p) => !new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(cur));
      if (missing.length) await fs.appendFile(excludePath, `${missing.join('\n')}\n`, 'utf8');
      return;
    }
    await fs.mkdir(path.dirname(excludePath), { recursive: true }).catch(() => {});
    await fs.appendFile(excludePath, `\n${marker}\n${patterns.join('\n')}\n`, 'utf8');
  } catch { /* best-effort — a missing exclude never blocks provisioning */ }
}

// ── Run-start divergence notice (I2a, remediation 2026-09-09) ────────────────
// Real incident: an external project's main ran as two divergent lines for ~11
// days because lanes kept building on a stale line and nothing at run start
// said so. This computes how far origin/<base> has moved past the session
// branch's merge-base and returns a one-line [REPO NOTICE] when it exceeds
// the threshold — injected into the run's repo-context block.
//   - Best-effort `git fetch origin <base>` first (bounded; the mirror's
//     stored origin URL is sanitized/token-less, so private repos may fail
//     the fetch — we then compare against the provision-time origin ref,
//     which is still fresh enough to catch multi-day divergence).
//   - Cached per worktree (workers re-run run-start assembly with the
//     parent's worktree — one fetch per run, not one per delegate).
const REPO_NOTICE_THRESHOLD = 20;
const REPO_NOTICE_TTL_MS = 10 * 60_000;
const repoNoticeCache = new Map<string, { at: number; notice: string }>();

/** Test hook — clears the per-worktree notice cache. */
export function resetRepoNoticeCache(): void { repoNoticeCache.clear(); }

export async function buildRepoDivergenceNotice(wt: string, baseBranch?: string | null): Promise<string> {
  if (!baseBranch) return '';
  const cached = repoNoticeCache.get(wt);
  if (cached && Date.now() - cached.at < REPO_NOTICE_TTL_MS) return cached.notice;
  let notice = '';
  try {
    // Best-effort freshen of origin/<base> — never fatal (offline, private
    // repo without ambient creds, blank standalone repo with no origin).
    await git(['fetch', 'origin', baseBranch], wt, 15_000).catch(() => {});
    const baseRef = `origin/${baseBranch}`;
    await git(['rev-parse', '--verify', baseRef], wt, 10_000); // no origin ref → no notice
    const behind = parseInt((await git(['rev-list', '--count', `HEAD..${baseRef}`], wt, 20_000)).stdout.trim(), 10);
    if (Number.isFinite(behind) && behind > REPO_NOTICE_THRESHOLD) {
      const ahead = parseInt((await git(['rev-list', '--count', `${baseRef}..HEAD`], wt, 20_000)).stdout.trim(), 10) || 0;
      const headSha = (await git(['rev-parse', 'HEAD'], wt, 10_000)).stdout.trim().slice(0, 10);
      const baseSha = (await git(['rev-parse', baseRef], wt, 10_000)).stdout.trim().slice(0, 10);
      notice = `[REPO NOTICE] origin/${baseBranch} has advanced ${behind} commits past this branch's merge-base `
        + `(this branch is ${ahead} ahead; branch tip ${headSha}, origin/${baseBranch} tip ${baseSha}). `
        + `The base has diverged substantially — expect conflict-heavy merges; sync/rebase before wide edits, `
        + `and NEVER resolve a conflict by emptying a file.`;
    }
  } catch { notice = ''; /* best-effort — a broken repo state never blocks the run */ }
  repoNoticeCache.set(wt, { at: Date.now(), notice });
  return notice;
}

/**
 * Provision a worktree for a BLANK project (no remote): a fresh standalone git
 * repo per session with an initial empty commit on baseBranch, then the session
 * branch checked out. No mirror — blank projects have no shared upstream.
 */
export async function ensureBlankWorktree(
  sessionId: string,
  baseBranch: string,
  branch: string,
  sourceWorktree?: string | null,
): Promise<string> {
  await fs.mkdir(WORKTREES_DIR, { recursive: true });
  let wt = worktreePath(sessionId);
  if (await pathExists(wt)) {
    await restoreSessionEnv(wt, sessionId); // no-op when env.sh already exists
    // Reuse path: top up the exclude set (idempotent) — same 58cb5dfc gap as
    // ensureWorktree's reuse return; blank worktrees persist across runs too.
    await installWorktreeExcludes(wt);
    return wt;
  }
  wt = await placeWorktreeDir(sessionId); // build 2026-10-08 ISO — see ensureWorktree

  // Chain from a prior session's repo when it still exists on disk, so a new
  // session inherits the earlier session's committed code + history. Blank
  // projects have no shared mirror — each session is a standalone repo — so we
  // clone from the prior worktree (local clone copies history; committed state
  // only, not the prior working tree's uncommitted edits).
  if (sourceWorktree && await pathExists(sourceWorktree)) {
    try {
      await git(['clone', sourceWorktree, wt], undefined, 180_000);
      await git(['remote', 'remove', 'origin'], wt).catch(() => {}); // keep it standalone
      await setWorktreeIdentity(wt);
      await git(['checkout', '-b', branch], wt); // branch from the inherited tip
      noteWorktreePlacement(sessionId, wt);
      await restoreSessionEnv(wt, sessionId); // re-seed env after a wipe
      logger.info(`coding workspace: blank worktree for session ${sessionId} chained from prior session (branch ${branch})`);
      return wt;
    } catch (err: any) {
      logger.warn(`coding workspace: chain-from-prior failed for ${sessionId} (${err.message}); starting fresh`);
      await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
    }
  }

  await fs.mkdir(wt, { recursive: true });
  await git(['init', '-b', baseBranch], wt);
  await setWorktreeIdentity(wt);
  // Seed an initial commit so HEAD exists and branches can be created.
  await fs.writeFile(path.join(wt, '.gitkeep'), '');
  await git(['add', '-A'], wt);
  await git(['commit', '-m', 'Initial commit'], wt);
  await git(['checkout', '-b', branch], wt);
  noteWorktreePlacement(sessionId, wt);
  await restoreSessionEnv(wt, sessionId); // re-seed env after a wipe
  logger.info(`coding workspace: blank worktree ready for session ${sessionId} (branch ${branch})`);
  return wt;
}

/**
 * A session's worktree git state captured into the durable run checkpoint
 * (812767b7): the checked-out branch plus a stash commit of any uncommitted
 * work, stored under refs/digby-wip/<sessionId>. Worktree refs + objects live
 * in the mirror's SHARED git dir, so the snapshot survives the worktree being
 * wiped (deploys recreate containers) and reattachWorktree can re-apply it.
 */
export interface WorktreeGitSnapshot {
  /** Branch checked out at snapshot time (null = detached HEAD → no preference). */
  branch: string | null;
  /** Stash-commit SHA holding the uncommitted state (null = tree was clean). */
  wip: string | null;
}

/** Shared mirror ref holding a session's uncommitted-work snapshot. */
function wipRefName(sessionId: string): string {
  return `refs/digby-wip/${sessionId}`;
}

/**
 * `git add -A` for the snapshot, tolerant of EMBEDDED repositories (rollout
 * watch tick 10, 2026-09-15): a lane had cloned a dataset repo into its
 * worktree without checking out a commit, and every checkpoint since
 * (142 in 24h, session 421938f3) died on "error: 'audit-pack12/' does not
 * have a commit checked out / fatal: adding files failed" — 13 hours with no
 * git snapshot, so a deploy kill would have lost the lane's uncommitted work.
 * A nested repo's contents are not ours to snapshot anyway: parse the
 * offending paths out of git's stderr and retry with pathspec excludes
 * (bounded), logging what was left out. Any other failure propagates.
 */
const EMBEDDED_REPO_ERR_RE = /error: '([^']+)' does not have a commit checked out/g;
const MAX_EMBEDDED_REPO_EXCLUDES = 8;
const SNAPSHOT_ADD_TIMEOUT_MS = 120_000;
/** Pause before the one volatile-tree retry — long enough for a mid-write file to settle. */
const SNAPSHOT_UNSTABLE_RETRY_DELAY_MS = 750;

/**
 * Failure class of a snapshot `git add` (autonomy loop #12, 2026-09-20). The
 * live warn line read "Command failed: git add -A -- ." with nothing else for
 * 6 of 8 failures in an afternoon — that empty-stderr shape is execFile's
 * TIMEOUT (killed: true / SIGTERM; two lanes with multi-GB untracked trees hit
 * the 120 s add every checkpoint), and the other shape, "fatal: confused by
 * unstable object source data", is a file being WRITTEN while git hashes it
 * (a training run / test emitting output mid-checkpoint). Named so the warn
 * line and the loop metric say what happened instead of "Command failed".
 */
export type SnapshotAddErrorClass = 'timeout' | 'unstable' | 'embedded' | 'killed' | 'other';
export function classifySnapshotAddError(err: any): SnapshotAddErrorClass {
  const text = `${err?.stderr ?? ''}\n${err?.message ?? ''}`;
  if (err?.killed === true || err?.signal === 'SIGTERM' || /\btimed? ?out\b/i.test(text)) return 'timeout';
  if (/confused by unstable object source data/i.test(text)) return 'unstable';
  if (/does not have a commit checked out/.test(text)) return 'embedded';
  // Loop #16: "Command failed: git add -A -- ." with EMPTY stderr and no
  // timeout is git dying to an external signal (SIGKILL — the worker box's
  // OOM killer while hashing a big tree; e083ff2e 3× on 2026-09-21 07:49–07:57Z).
  if (typeof err?.signal === 'string' && err.signal) return 'killed';
  return 'other';
}
/** exit code / signal suffix for the warn line — every class names its shape now. */
export function describeExecFailure(err: any): string {
  return `exit code=${err?.code ?? 'null'}, signal=${err?.signal ?? 'none'}`;
}
const SNAPSHOT_KILLED_RETRY_DELAY_MS = 1500;

async function addAllExcludingEmbeddedRepos(
  wt: string,
  sessionId: string,
  env: Record<string, string>,
  beforeRetry?: () => Promise<void>,
): Promise<string[]> {
  const excludes: string[] = [];
  let unstableRetried = false;
  let killedRetried = false;
  let ignoreErrors = false;
  for (let attempt = 0; attempt <= MAX_EMBEDDED_REPO_EXCLUDES + 1; attempt++) {
    try {
      // .digby/secrets/ never enters the wip stash: gitEnv's core.excludesFile
      // (58cb5dfc) skips it silently on this traversal add.
      await git(['add', '-A', ...(ignoreErrors ? ['--ignore-errors'] : []), '--', '.', ...excludes.map((p) => `:(exclude)${p}`)], wt, SNAPSHOT_ADD_TIMEOUT_MS, env);
      if (excludes.length) logger.info(`coding workspace: snapshot for ${sessionId} excluded embedded repo(s) ${excludes.join(', ')}`);
      if (ignoreErrors) logger.info(`coding workspace: snapshot for ${sessionId} staged with --ignore-errors after a volatile-tree add (files mid-write were skipped this checkpoint)`);
      return excludes;
    } catch (err: any) {
      const text = `${err?.stderr ?? ''}\n${err?.message ?? ''}`;
      const found = Array.from(text.matchAll(EMBEDDED_REPO_ERR_RE), (m) => m[1].replace(/\/+$/, '')).filter((p) => p && !excludes.includes(p));
      if (found.length && excludes.length + found.length <= MAX_EMBEDDED_REPO_EXCLUDES) {
        excludes.push(...found);
        continue;
      }
      // Firing 3 (2026-09-22): before ANY retry, the caller reseeds the temp
      // index — a signal-killed `git add` (SIGKILL has no cleanup) leaves
      // `<tmpIndex>.lock` behind and the retry would die instantly on
      // `Unable to create … .lock: File exists` (live: e083ff2e 3× on
      // 2026-09-22, each ~1.7 s after the killed attempt — kill + the 1.5 s
      // killed-retry pause + instant exit 128; class 'other', checkpoint
      // lost). Reseeding unlinks the stale lock and re-copies the real index
      // so the retry starts from the same staged state as attempt 0.
      // Volatile tree (loop #12): ONE retry with --ignore-errors after a short
      // pause — git skips the file still being written and stages the rest; a
      // partial snapshot protects the lane's other uncommitted work where the
      // old path protected nothing. Timeouts are NOT retried (another 120 s of
      // hashing would only delay the checkpoint); they propagate classified.
      if (!unstableRetried && classifySnapshotAddError(err) === 'unstable') {
        unstableRetried = true;
        if (beforeRetry) await beforeRetry();
        ignoreErrors = true;
        await new Promise((r) => setTimeout(r, SNAPSHOT_UNSTABLE_RETRY_DELAY_MS));
        continue;
      }
      // Killed by a signal (loop #16 — the worker box's OOM killer under a
      // concurrent-checkpoint memory spike): ONE retry after a short pause.
      if (!killedRetried && classifySnapshotAddError(err) === 'killed') {
        killedRetried = true;
        if (beforeRetry) await beforeRetry();
        await new Promise((r) => setTimeout(r, SNAPSHOT_KILLED_RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }
  return excludes;
}

/**
 * Capture the worktree's git state for the durable run checkpoint (812767b7).
 * Untracked files are included — `git add -A` stages them before `stash create`.
 * All staging happens against a TEMPORARY index (GIT_INDEX_FILE seeded from the
 * real index so unchanged files keep cached stat data): the real index is never
 * read-modified or locked, so a checkpoint fired mid-run can't corrupt the
 * agent's own `git diff` / `git add` / `git commit` flow or die on index.lock
 * contention. A clean tree deletes any stale wip ref so a later restore never
 * re-applies ancient state. Best-effort: returns null on any git failure rather
 * than failing the checkpoint.
 */
const inflightSnapshots = new Map<string, Promise<WorktreeGitSnapshot | null>>();

/**
 * Per-session COALESCE (loop #16): two checkpoints for one session fired 16 ms
 * apart live (e083ff2e 07:57:29.273/.289Z) and both died the same way — two
 * concurrent `git add -A` over the same big tree double the memory spike on
 * the worker box. A snapshot already in flight for the session is shared: the
 * second caller awaits the first's result instead of starting another walk.
 */
export async function snapshotWorktreeGitState(wt: string, sessionId: string): Promise<WorktreeGitSnapshot | null> {
  const inflight = inflightSnapshots.get(sessionId);
  if (inflight) {
    logger.debug(`coding workspace: snapshot for ${sessionId} already in flight — coalescing this checkpoint onto it`);
    void import('../platform/loop-metrics.service')
      .then((m) => m.recordLoopMetric({ kind: m.LOOP_METRIC_KINDS.WORKTREE_SNAPSHOT_COALESCED, sessionId }))
      .catch(() => {});
    return inflight;
  }
  const p: Promise<WorktreeGitSnapshot | null> = (async () => {
    try { return await snapshotWorktreeGitStateUncoalesced(wt, sessionId); } finally { inflightSnapshots.delete(sessionId); }
  })();
  inflightSnapshots.set(sessionId, p);
  return p;
}

async function snapshotWorktreeGitStateUncoalesced(wt: string, sessionId: string): Promise<WorktreeGitSnapshot | null> {
  const tmpIndex = path.join(
    WORKSPACE_ROOT,
    `.snap-index-${sessionId}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    const branchOut = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], wt)).stdout.trim();
    const branch = branchOut && branchOut !== 'HEAD' ? branchOut : null;
    const env = { GIT_INDEX_FILE: tmpIndex };
    // Seed the temp index from the real one (missing index = fresh worktree →
    // start empty; add -A then stages the full tree, same content result).
    const realIndex = (await git(['rev-parse', '--git-path', 'index'], wt)).stdout.trim();
    const realIndexAbs = path.isAbsolute(realIndex) ? realIndex : path.join(wt, realIndex);
    const seedTempIndex = () => fs.copyFile(realIndexAbs, tmpIndex).catch(() => {});
    await seedTempIndex();
    // Firing 3 (2026-09-22): a retry must NEVER inherit a stale index lock.
    // A signal-killed `git add` dies before git's lock cleanup, so
    // `<tmpIndex>.lock` survives it; the retry then aborts instantly on
    // `Unable to create '<tmpIndex>.lock': File exists` (exit 128 — class
    // 'other'). Reseed = drop the leaked index AND its lock, re-copy the
    // real index, so every attempt starts exactly like attempt 0.
    const reseedTempIndex = async () => {
      await fs.unlink(`${tmpIndex}.lock`).catch(() => {});
      await seedTempIndex();
    };
    await addAllExcludingEmbeddedRepos(wt, sessionId, env, reseedTempIndex);
    const wip = (await git(['stash', 'create'], wt, 120_000, env)).stdout.trim() || null;
    if (wip) await git(['update-ref', wipRefName(sessionId), wip], wt);
    else await git(['update-ref', '-d', wipRefName(sessionId)], wt).catch(() => {});
    // The stash above can never carry .digby/session/env.sh (git-ignored) —
    // sidecar it so the session's env seed survives any future wipe/reap.
    await persistSessionEnv(wt, sessionId);
    return { branch, wip };
  } catch (err: any) {
    // Classified warn + metric (loop #12): "Command failed: git add -A -- ."
    // with nothing after it is a 120 s TIMEOUT on a large untracked tree —
    // say so, and let the metric count the classes per lane.
    const cls = classifySnapshotAddError(err);
    const why = cls === 'timeout'
      ? `git add exceeded ${Math.round(SNAPSHOT_ADD_TIMEOUT_MS / 1000)} s (a large untracked tree — the lane keeps its previous snapshot this checkpoint)`
      : cls === 'unstable'
        ? 'files were still being written while git hashed them (retried once with --ignore-errors)'
        : cls === 'killed'
          ? `git was killed by ${err?.signal} while staging (memory pressure on the worker box — retried once after ${SNAPSHOT_KILLED_RETRY_DELAY_MS} ms; the lane keeps its previous snapshot)`
          : `${String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 300)} (${describeExecFailure(err)})`;
    logger.warn(`coding workspace: worktree snapshot failed for ${sessionId} [${cls}]: ${why}`);
    void import('../platform/loop-metrics.service')
      .then((m) => m.recordLoopMetric({ kind: m.LOOP_METRIC_KINDS.WORKTREE_SNAPSHOT_FAILED, sessionId, meta: { class: cls, code: err?.code ?? null, signal: err?.signal ?? null } }))
      .catch(() => {});
    return null;
  } finally {
    // Firing 3 (2026-09-22): unlink the leaked LOCK as well — a git killed
    // mid-add leaves `<tmpIndex>.lock` behind and it was never cleaned here,
    // so zero-byte strays accumulated in WORKSPACE_ROOT since August (12+
    // observed live on box C's worker container, incl. `.stash.<pid>.lock`
    // shapes from `stash create`). Best-effort both, like the index itself.
    await fs.unlink(tmpIndex).catch(() => {});
    await fs.unlink(`${tmpIndex}.lock`).catch(() => {});
  }
}

/**
 * Is `wt` a usable git worktree? (#142) Probes with `git rev-parse --git-dir`.
 * Only a "not a git repository" failure — a dangling gitdir link (mirror
 * re-cloned / project changed) or a dir that was never a repo at all — counts
 * as unusable; git ≥ 2.56 spells the same dangling-gitfile fatal
 * "gitfile does not point to a valid repository", so BOTH spellings match
 * (2026-10-27 runner-image roll to git 2.56: a one-spelling probe classified
 * broken worktrees usable and the #142 rebuild never fired — PR #2029 CI red).
 * Any other error (index locks, transient I/O, timeout) returns
 * TRUE so callers never destroy a worktree git merely hesitated on. Ownership
 * drift can't trip the probe: gitEnv carries safe.directory=* (2026-08-02).
 */
export async function isUsableWorktree(wt: string): Promise<boolean> {
  return git(['rev-parse', '--git-dir'], wt, 30_000)
    .then(() => true)
    .catch((err: any) =>
      !/not a git repository|gitfile does not point to a valid repository/.test(err?.message ?? ''));
}

/**
 * Re-attach a worktree for a session whose worktree was reaped (One-Digby 1B).
 * The session's branch still lives in the mirror (A1 keeps local branches safe
 * from fetch --prune), so we attach TO it instead of creating a new one; falls
 * back to ensureWorktree when the branch is genuinely gone.
 *
 * Durability (812767b7): when the checkpoint carried a worktree snapshot,
 * prefer the branch the agent had actually checked out and re-apply its stashed
 * uncommitted work — a wiped worktree no longer rolls the session back to its
 * own branch tip with a clean tree.
 */
export async function reattachWorktree(
  projectId: string,
  sessionId: string,
  repoUrl: string,
  baseBranch: string,
  branch: string,
  token?: string | null,
  restore?: WorktreeGitSnapshot | null,
): Promise<string> {
  const mirror = await ensureRepoMirror(projectId, repoUrl, token);
  await fs.mkdir(WORKTREES_DIR, { recursive: true });
  let wt = worktreePath(sessionId);
  const existed = await pathExists(wt);
  if (existed) {
    // Validate before reusing (#142): a worktree whose .git gitdir link dangles
    // (mirror re-cloned, or the session's project changed) or that was never a
    // repo at all (botched provisioning) passes pathExists but fails EVERY git
    // op — checkpoint snapshots then return null and a mid-run resume restores
    // nothing. A broken dir is removed and rebuilt through the normal
    // worktree-add path below; a merely unwell one (locks, transient I/O) is
    // reused untouched (see isUsableWorktree).
    if (await isUsableWorktree(wt)) {
      // Worktree intact — top up its env seed from the sidecar if the file is
      // somehow missing (no-op when env.sh already exists).
      await restoreSessionEnv(wt, sessionId);
      // Reuse path: top up the exclude set (idempotent) — a pre-58cb5dfc
      // worktree survives attach cycles without ever re-running provisioning,
      // so the .digby/secrets/ ignore must be refreshed here (index-writing
      // paths like worktreeDiffHash's `git add -A -N` bypass gitEnv's
      // core.excludesFile).
      await installWorktreeExcludes(wt);
      return wt;
    }
    logger.warn(`coding workspace: existing worktree for session ${sessionId} is not a usable git repo — rebuilding from mirror (#142)`);
    try {
      await persistSessionEnv(wt, sessionId); // rescue the env seed BEFORE the rm
      await fs.rm(wt, { recursive: true, force: true });
    } catch (err: any) {
      logger.warn(`coding workspace: stale worktree removal failed for ${sessionId} (${err.message}); reusing as-is`);
      return wt;
    }
    await git(['worktree', 'prune'], mirror).catch(() => {}); // drop any stale registration
  }
  const hasBranch = await git(['rev-parse', '--verify', branch], mirror).then(() => true).catch(() => false);
  // build 2026-10-08 ISO: a worktree that did not exist is re-created where
  // placement says (a broken one is rebuilt in place, above). The fallback
  // below (ensureWorktree) re-derives the same placement.
  if (hasBranch && !existed) wt = await placeWorktreeDir(sessionId);
  if (hasBranch) {
    // Prefer the branch recorded at the last checkpoint (the agent's working
    // branch) when it still exists in the mirror; the session branch is the
    // fallback.
    let target = branch;
    if (restore?.branch && restore.branch !== branch) {
      const hasRestore = await git(['rev-parse', '--verify', restore.branch], mirror).then(() => true).catch(() => false);
      if (hasRestore) target = restore.branch;
    }
    await git(['worktree', 'prune'], mirror).catch(() => {}); // clear stale registration
    try {
      // Serialized + retried (2026-10-20 race): see addWorktreeSerialized.
      await addWorktreeSerialized(projectId, mirror, wt, ['worktree', 'add', wt, target]);
    } catch (err: any) {
      // e.g. the preferred branch is checked out in another worktree — fall back
      // to the session branch rather than failing the resume.
      if (target === branch) throw err;
      logger.warn(`coding workspace: re-attach on ${target} failed (${err.message}); falling back to ${branch}`);
      await git(['worktree', 'prune'], mirror).catch(() => {});
      await addWorktreeSerialized(projectId, mirror, wt, ['worktree', 'add', wt, branch]);
      target = branch;
    }
    noteWorktreePlacement(sessionId, wt);
    await setWorktreeIdentity(wt);
    // Re-apply the uncommitted work snapshotted at the last checkpoint. The wip
    // ref lives in the mirror's shared refs, so it survived the wipe. On a
    // conflicting apply, reset the JUST-CREATED worktree (nothing else to lose)
    // and keep the ref for manual recovery.
    if (restore?.wip) {
      const applied = await git(['stash', 'apply', restore.wip], wt, 180_000).then(() => true).catch(() => false);
      if (applied) {
        // Index hygiene (ticket 58cb5dfc): `git stash apply` lands the restored
        // paths in the REAL index as staged entries (older git) or intent-to-add
        // " A" rows (newer git) — an externally-staged state one broad lane
        // `git add -A`/`git commit` away from committing files the lane never
        // staged (CanLaw 2026-09-18: 408 .digby/* entries incl. .digby/secrets/).
        // Unstage everything: restored content stays in the worktree, back to
        // its true pre-snapshot state (untracked / unstaged-modified). A mixed
        // reset never touches worktree files.
        await git(['reset'], wt, 60_000).catch((err: any) => logger.warn(`coding workspace: post-restore index reset failed for ${sessionId}: ${err.message}`));
        await git(['update-ref', '-d', wipRefName(sessionId)], wt).catch(() => {});
        logger.info(`coding workspace: restored uncommitted work for session ${sessionId} from checkpoint snapshot`);
      } else {
        await git(['reset', '--hard'], wt).catch(() => {});
        logger.warn(`coding workspace: wip snapshot ${restore.wip} did not apply for session ${sessionId}; kept at ${wipRefName(sessionId)}`);
      }
    }
    await restoreSessionEnv(wt, sessionId); // env seed survives the wipe too
    logger.info(`coding workspace: re-attached worktree for session ${sessionId} (branch ${target})`);
    return wt;
  }
  return ensureWorktree(projectId, sessionId, repoUrl, baseBranch, branch, token);
}

/** Remove a session's worktree (best-effort; used on session archive/delete). */
export async function removeWorktree(projectId: string, sessionId: string): Promise<void> {
  const mirror = repoMirrorPath(projectId);
  const wt = worktreePath(sessionId);
  try {
    if (await pathExists(mirror)) {
      await git(['worktree', 'remove', '--force', wt], mirror).catch(() => {});
      await git(['worktree', 'prune'], mirror).catch(() => {});
    }
    if (await pathExists(wt)) await fs.rm(wt, { recursive: true, force: true });
    // build 2026-10-08 ISO: a migrated session's legacy compatibility link dies
    // with its worktree (never a dangling link a later legacy re-provision trips on).
    const legacy = legacyWorktreePath(sessionId, WORKSPACE_ROOT);
    if (legacy !== wt && isMigratedCompatLinkSync(legacy)) await fs.unlink(legacy).catch(() => {});
    forgetPlacement(sessionId);
    // Ticket 1c767622 NOTE: deliberately NOT deleting the shared snapshot
    // here — the REAPER calls removeWorktree too, and a reaped session is
    // still browsable (its snapshot is then the ONLY copy; the 30d TTL is the
    // backstop). True session-DELETE sites drop the snapshot explicitly.
  } catch (err: any) {
    logger.warn(`coding workspace: removeWorktree failed for ${sessionId}: ${err.message}`);
  }
}

/** A short, filesystem/branch-safe session slug for branch names. */
export function sessionBranchName(sessionId: string): string {
  return `digby/session-${sessionId.slice(0, 8)}`;
}

// ── Volume ownership + on-disk census (Review 2026-09-13 issue 8) ────────────
// The coding-workspaces volume lives on ONE box (box C, the 24-slot worker).
// Box A keeps a stale pre-split COPY of it, and its 0-slot cron-only worker
// won the 6h worktree-reaper claim: it deleted A's copy and then nulled the
// SHARED DB path, orphaning C's real directory — 177 of 223 dirs (79 GB) ended
// up invisible to the reaper. Two rules follow: (a) only the volume owner may
// write reap outcomes to the DB or touch session containers; (b) the reaper
// must census what is actually ON DISK, not only rows with a non-null path.

/**
 * Review 2026-09-13 issue 8: does THIS process run on the box that owns the
 * coding-workspaces volume? Opt-in override `CODING_WORKSPACE_VOLUME_OWNER=1|0`
 * wins; otherwise inferred from the worker's slot count (box C runs
 * CODING_WORKER_CONCURRENCY>0, box A runs 0). Unset concurrency (dev, a
 * single-box install) keeps today's behaviour — the only box owns everything.
 */
export function isWorkspaceVolumeOwner(): boolean {
  const explicit = (process.env.CODING_WORKSPACE_VOLUME_OWNER || '').trim();
  if (explicit === '1') return true;
  if (explicit === '0') return false;
  const rawConc = parseInt(process.env.CODING_WORKER_CONCURRENCY || '', 10);
  if (Number.isFinite(rawConc) && rawConc >= 0) return rawConc > 0;
  return true;
}

export interface WorktreeDirEntry {
  /** Directory name under worktrees/ — by layout, the session (chatCodingState) id. */
  sessionId: string;
  /** Directory mtime — the only idleness signal for a dir with no DB row. */
  mtimeMs: number;
}

/**
 * Review 2026-09-13 issue 8: census of the session worktree directories that
 * exist ON DISK under the workspaces root (dot-entries such as `.sandbox-home`
 * are skipped). Returns null when the root is missing/unreadable so callers
 * can tell "no dirs" from "could not look" and fail SAFE (skip, never reap on
 * uncertainty).
 */
export async function listWorktreeDirsOnDisk(): Promise<WorktreeDirEntry[] | null> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(WORKTREES_DIR, { withFileTypes: true });
  } catch { return null; }
  const out: WorktreeDirEntry[] = [];
  for (const e of entries) {
    // A migrated session's compatibility SYMLINK is not a directory entry
    // here (isDirectory() is false for a link) — its physical per-user dir is
    // listed below instead.
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    try {
      const st = await fs.stat(path.join(WORKTREES_DIR, e.name));
      out.push({ sessionId: e.name, mtimeMs: st.mtimeMs });
    } catch { /* vanished between readdir and stat — not ours to reap this pass */ }
  }
  // build 2026-10-08 ISO: per-user subtree worktrees join the census (the
  // reaper resolves each id back to its physical path via worktreePath()).
  const seen = new Set(out.map((d) => d.sessionId));
  for (const d of listPerUserWorktreeDirsSync(WORKSPACE_ROOT)) {
    if (seen.has(d.sessionId)) continue;
    seen.add(d.sessionId);
    out.push({ sessionId: d.sessionId, mtimeMs: d.mtimeMs });
  }
  return out;
}

export const CODING_WORKSPACE_ROOT = WORKSPACE_ROOT;
