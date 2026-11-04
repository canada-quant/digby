/**
 * Digby Code — per-session verify state (for the PR gate, P4; sha-keyed P5 v1#29).
 *
 * Records whether the verify chain has passed this session so the agent's
 * autonomous `open_pull_request` can be hard-gated on a green verify. Persisted
 * in the context store (survives reattach / process swap). The human "Open PR"
 * button bypasses this gate (an explicit user decision).
 *
 * P5 (v1#29): the bare boolean was session-scoped and STALE across commits — a
 * verify that passed 10 commits ago still opened the gate. The state is now
 * KEYED to the workspace content at verify time:
 *   - `sha`  = HEAD at verify time (honesty/messages);
 *   - `tree` = a git tree hash of the FULL worktree content (tracked changes +
 *     untracked non-ignored files), computed against a throwaway GIT_INDEX_FILE
 *     so nothing in the real index/worktree is touched.
 * The PR gate re-fingerprints at open time and requires tree equality — so a
 * plain `git_commit` of exactly the verified content still passes (commit moves
 * HEAD but not the tree), while ANY new edit or new commit with different
 * content invalidates the pass without mutation tools having to clear anything.
 *
 * P5 (v1#30): `unverified` records that the chain "passed" only because one or
 * more stage tools were not installed (skipped) — that satisfies NO gate.
 *
 * 2026-09-10: `environmental` records that the failure was an infra death
 * (OOM/SIGKILL), relayed from the chain via the fingerprint capture — the PR
 * gate and the next firing must not read an infra-red as evidence against the
 * code (and the red is telemetered as loop_metrics kind verify_env_red).
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { storeGet, storePut } from '../memory/context-store';
import { consumeEnvironmentalRed, EnvironmentalRed, noteEnvironmentalVerifyRed } from './verify.service';
import { git } from './workspace.service';

export interface VerifyFingerprint {
  /** HEAD commit sha at capture time (null on unborn HEAD / read failure). */
  sha: string | null;
  /** git tree hash of the full worktree content (null on capture failure). */
  tree: string | null;
  /** The chain's parked infra-red verdict, relayed worktree → record
   *  (2026-09-10): the capture is the one call between runVerifyChain and
   *  recordVerify that knows the worktree. Inert to the PR-gate comparison. */
  environmental?: EnvironmentalRed;
}

export interface VerifyState {
  passed: boolean;
  /** True when the pass is hollow: ≥1 stage skipped because its tool is not installed (v1#30). */
  unverified?: boolean;
  /** Framework Operator run 3 (2026-09-22): true when the chain was DEFERRED
   *  pre-flight — container memory cgroup pressure (peer verify stages). The
   *  PR-gate note says DEFERRED, not "tool not installed"; the pass is hollow
   *  (unverified) exactly like a skipped stage. */
  deferred?: boolean;
  failedStage?: string;
  at: string;
  sha?: string | null;
  tree?: string | null;
  /** True when the recorded failure was ENVIRONMENTAL (OOM/SIGKILL infra death,
   *  2026-09-10) — infra-red, not code-red: the PR gate and the next firing
   *  must not read it as evidence against the code. Absent = false (code-red). */
  environmental?: boolean;
  /** A1 (2026-10-04, verify-unchanged-skip.ts): signature of the chain that
   *  produced this record (stage keys + commands). The auto seam skips a
   *  re-run only when the last GREEN was this exact chain on this exact tree —
   *  a `verify({only})` subset pass or a legacy record (absent) never does. */
  chainSig?: string;
  /** A1: the stage keys that ran (display only — the skip line names them). */
  stages?: string[];
}

const NS = (sessionId: string) => [sessionId, 'coding-verify'];
const KEY = 'state';

/**
 * Fingerprint the worktree content: HEAD sha + a content tree hash built by
 * `git add -A` into a THROWAWAY index (GIT_INDEX_FILE in tmpdir) + `write-tree`.
 * Includes untracked non-ignored files; never touches the real index or the
 * worktree. Best-effort: returns null only when BOTH reads fail.
 */
export async function captureVerifyFingerprint(worktree: string): Promise<VerifyFingerprint | null> {
  // Relay pickup (2026-09-10): the chain that just ran on this worktree may have
  // parked an environmental (infra-red) verdict — consumed here (deleted, so one
  // failure relays exactly once) and carried to recordVerify, which alone knows
  // the sessionId. A capture that fails BOTH reads drops the verdict with the
  // fingerprint (the record then falls back to code-red — the null contract of
  // this function is load-bearing for the PR gate's fail-open-on-absence).
  // Fixer 2026-09-27 (finding 4): the two reads live in readHeadSha /
  // captureWorktreeTree so a COMPARISON caller (the self-audit receipt rule)
  // can take the tree without this relay pickup — a telemetry read must never
  // delete the chain's parked verdict.
  const environmental = consumeEnvironmentalRed(worktree) || undefined;
  const sha = await readHeadSha(worktree);
  const tree = await captureWorktreeTree(worktree);
  return sha || tree ? { sha, tree, ...(environmental ? { environmental } : {}) } : null;
}

/** HEAD sha (ms; null on an unborn HEAD / read failure). No side effects. */
export async function readHeadSha(worktree: string): Promise<string | null> {
  try {
    return (await git(['rev-parse', 'HEAD'], worktree, 15_000)).stdout.trim() || null;
  } catch { return null; } // unborn HEAD (no commits yet) is legitimate
}

/**
 * The worktree CONTENT tree hash (tracked changes + untracked non-ignored
 * files) via `git add -A` into a THROWAWAY index + `write-tree`. Never
 * touches the real index or the worktree, never consumes the chain's parked
 * environmental verdict (fixer 2026-09-27, finding 4 — the fingerprint
 * capture does; a comparison read must not). Cost: the add writes every
 * changed / untracked blob into the object store (120 s + 30 s bounds), so
 * callers take it only when the answer can change what they do. null on
 * failure (the caller compares what exists).
 */
export async function captureWorktreeTree(worktree: string): Promise<string | null> {
  const idx = path.join(os.tmpdir(), `digby-verify-idx-${crypto.randomBytes(8).toString('hex')}`);
  try {
    // Ticket 58cb5dfc: .digby/secrets/ never reaches the object store via this
    // throwaway index either — gitEnv's core.excludesFile skips it silently.
    await git(['add', '-A'], worktree, 120_000, { GIT_INDEX_FILE: idx });
    return (await git(['write-tree'], worktree, 30_000, { GIT_INDEX_FILE: idx })).stdout.trim() || null;
  } catch {
    return null; // fingerprint degrades to sha-only (gate compares what exists)
  } finally {
    await fs.rm(idx, { force: true }).catch(() => {});
  }
}

export async function recordVerify(
  sessionId: string,
  passed: boolean,
  failedStage?: string,
  extra?: { fingerprint?: VerifyFingerprint | null; unverified?: boolean; deferred?: boolean; chainSig?: string; stages?: string[] },
): Promise<void> {
  // Environmental honesty (2026-09-10): accept the chain's relayed infra-red
  // verdict (it rode in on the fingerprint — see captureVerifyFingerprint) only
  // for a FAILING record of the stage that actually died; persist it and emit
  // the VERIFY_ENV_RED metric here — the one place the verdict and the
  // sessionId meet. Emitted before the store write so a store outage can never
  // silence the infra alarm.
  const relayed = extra?.fingerprint?.environmental;
  const environmental = !passed && !!relayed && (!failedStage || relayed.stage === failedStage);
  if (environmental) await noteEnvironmentalVerifyRed(sessionId, relayed!);
  try {
    await storePut(NS(sessionId), KEY, {
      passed,
      failedStage,
      at: new Date().toISOString(),
      ...(extra?.unverified ? { unverified: true } : {}),
      ...(extra?.deferred ? { deferred: true } : {}),
      ...(environmental ? { environmental: true } : {}),
      ...(extra?.fingerprint ? { sha: extra.fingerprint.sha, tree: extra.fingerprint.tree } : {}),
      // A1 (2026-10-04): which chain this record covers — the unchanged-skip
      // key. Callers omit both under AUTO_VERIFY_UNCHANGED_SKIP_DISABLED=1.
      ...(extra?.chainSig ? { chainSig: extra.chainSig } : {}),
      ...(extra?.stages?.length ? { stages: extra.stages } : {}),
    } as any);
  } catch { /* best-effort */ }
}

export async function getVerifyState(sessionId: string): Promise<VerifyState | null> {
  try { return await storeGet<VerifyState>(NS(sessionId), KEY); } catch { return null; }
}

// ── A4 (2026-09-27 spark-cluster audit): "no verify chain" is STATE, not silence ──
// The harness auto-verify used to `break` silently when `.digby/config.json`
// resolved to an empty chain — no event, no metric, no board line — so every
// "verified" on a chain-less project (spark-cluster: 0 verify_result in 669
// runs) was the lane's own probe and nothing said so. The marker below lives
// under its OWN key so the PR gate's `state` record (fail-open on absence) is
// untouched; the session status card reads it and prints the honest line.
// Recorded unconditionally since 2026-11-02 (marker + event + row).

const ABSENT_KEY = 'absent';

export interface VerifyAbsentState {
  /** Always 'no_chain' today — kept as a field so a future reason (e.g. a
   *  config that fails to parse) can ride the same marker. */
  reason: 'no_chain';
  /** Which seam observed it: the harness auto-verify or the lane's own `verify` call. */
  seam: 'auto' | 'tool';
  /** True when `.digby/config.json` exists but has no runnable typecheck/lint/test command. */
  configPresent: boolean;
  at: string;
  /** How many times this session has hit the seam (auto + tool). */
  count: number;
}

/** Record that a verify seam found no chain. Best-effort; never throws. */
export async function recordVerifyAbsent(
  sessionId: string,
  input: { seam: 'auto' | 'tool'; configPresent: boolean },
): Promise<void> {
  try {
    const prev = await storeGet<VerifyAbsentState>(NS(sessionId), ABSENT_KEY).catch(() => null);
    await storePut(NS(sessionId), ABSENT_KEY, {
      reason: 'no_chain',
      seam: input.seam,
      configPresent: !!input.configPresent,
      at: new Date().toISOString(),
      count: (prev?.count || 0) + 1,
    } as any);
  } catch { /* best-effort */ }
}

export async function getVerifyAbsent(sessionId: string): Promise<VerifyAbsentState | null> {
  try { return await storeGet<VerifyAbsentState>(NS(sessionId), ABSENT_KEY); } catch { return null; }
}
