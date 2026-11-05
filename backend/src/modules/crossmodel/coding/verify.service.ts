/**
 * Digby Code — the LOOP primitive: verify chain + failure signatures.
 *
 * Reads `.digby/config.json` (scaffolded from ground truth), resolves the
 * cheapest-first verify chain (typecheck → lint → test), and runs it fail-fast.
 * Used by the agent-callable `verify` tool AND by the harness auto-verify loop
 * (agent.ts), which — on the model's "finish" — re-runs the chain and feeds the
 * first failing stage back so the agent keeps iterating instead of stopping short.
 *
 * Honesty note: commands here are DETECTED, not yet probe-run at scaffold time, so
 * the verify chain is best-effort. The harness treats a failure as "keep working",
 * never as an un-appealable hard gate (a wrong detected command must not trap a
 * session forever). A hard PR gate waits on probe-verified commands (roadmap).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import logger from '../../../utils/logger';
import type { RepoHooksConfig } from './repo-hooks';
import { deriveRelatedTestCommand, listChangedFiles, packageScriptReader, RELATED_STAGE_KEY } from './verify-related';
import { DEFAULT_PER_COMMAND_TIMEOUT_MS, stageTimeoutAdvice, killedAtMsFromTail } from './loop-defaults';

export interface DigbyLoopConfig {
  maxAutoVerifyIterations: number;
  resumeStepBudget: number;
  perCommandTimeoutMs: number;
  sameFailureStop: number;
  oscillationWindow: number;
  gatePullRequest: boolean;
  /** GOAL-CONTINUE loop: how many bounded resumes an auto-mode run gets while
   *  the plan still has unfinished steps AND progress is being made. Generous —
   *  a stall guard (2 no-progress rounds) and the step budget bound it far
   *  before this; the ceiling only stops a pathological plan that never settles. */
  maxAutoContinueRounds: number;
}

export interface DigbyConfig {
  defaultBranch?: string;
  commands?: Record<string, string | null>;
  /** Canonical: string keys into commands* (scaffolded). ALSO accepted
   * (ticket 7ac4b499-adjacent, dispatched 2026-10-01 23:49Z): the belt-and-braces
   * OBJECT form a hand-authored repo writes — [{ name, command }] — where each
   * entry is self-describing: resolve by `name` into commands.*, else run the
   * inline `command`. Both forms may be mixed in one array. */
  verify?: (string | { name?: string; command?: string })[];
  loop?: Partial<DigbyLoopConfig>;
  /** Repo-level deterministic tool hooks (coding/repo-hooks.ts): postEdit / preCommand. */
  hooks?: RepoHooksConfig;
}

// Loop ceilings raised to the practical max (owner directive 2026-07-22):
// unattended runs should keep fixing until genuinely done or genuinely stuck.
// The smart guards (same-failure signature, diff oscillation) still stop
// pathological thrash long before the raw ceilings; repos can tune everything
// per-project via .digby/config.json `loop`.
export const DEFAULT_LOOP: DigbyLoopConfig = {
  maxAutoVerifyIterations: 10,
  resumeStepBudget: 20,
  perCommandTimeoutMs: DEFAULT_PER_COMMAND_TIMEOUT_MS,
  sameFailureStop: 3,
  oscillationWindow: 6,
  gatePullRequest: true, // P4: the agent must get verify green before open_pull_request (human "Open PR" bypasses)
  maxAutoContinueRounds: 40,
};

export async function readDigbyConfig(worktree: string): Promise<DigbyConfig | null> {
  const r = await readDigbyConfigDetailed(worktree);
  return 'config' in r ? r.config : null;
}

/**
 * DW-2 (backlog, 2026-10-02): readDigbyConfig used to catch ALL of readFile +
 * JSON.parse into `null`, so a hand-mangled .digby/config.json (truncated
 * write, trailing comma, BOM, EACCES) was indistinguishable from an absent
 * one — the verify tool answered "No verify chain configured" over a config
 * the author DID write, and nothing recorded why. This variant keeps the
 * three states apart so the tool seam can name the file + error (one line in
 * the tool result) and the audit can see it (loop_metrics kind
 * `verify_config_read_error`, tools.ts/agent.ts). Read behavior otherwise
 * unchanged: ENOENT ⇒ absent; anything else that throws ⇒ readError with the
 * error's message.
 */
export type DigbyConfigRead =
  | { config: DigbyConfig }
  | { absent: true }
  | { readError: string };

export async function readDigbyConfigDetailed(worktree: string): Promise<DigbyConfigRead> {
  const file = path.join(worktree, '.digby', 'config.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { absent: true };
    return { readError: `read .digby/config.json: ${e?.message || String(e)}` };
  }
  try {
    return { config: JSON.parse(raw) as DigbyConfig };
  } catch (e: any) {
    return { readError: `parse .digby/config.json: ${e?.message || String(e)}` };
  }
}

export function loopConfig(config: DigbyConfig | null): DigbyLoopConfig {
  return { ...DEFAULT_LOOP, ...(config?.loop || {}) };
}

export interface VerifyChainEntry { key: string; command: string; }

/**
 * Normalize ONE verify[] entry into {key, command}, or null when it names
 * nothing runnable.
 *
 * Two shapes are accepted (the tt-rd defect, dispatched 2026-10-01 23:49Z):
 *  - 'string' — the canonical scaffolded key into commands.*;
 *  - {name?, command?} — the belt-and-braces form a hand-authored repo
 *    writes. Resolution order: commands[name] (single source of truth —
 *    a name that matches commands.* wins, so one edit to commands.*
 *    re-points every surface), then the entry's own inline `command`
 *    (self-describing; runs even when commands.* has no such key — that is
 *    the point of the belt-and-braces form), then null.
 *
 * Before the fix, a {name, command} entry coerced to the string
 * "[object Object]" as a commands.* lookup → undefined → silently DROPPED,
 * so an object-form chain came back EMPTY and the verify tool answered
 * "No verify chain configured" over a config that verifiably had commands.
 */
function verifyEntryToStage(
  entry: string | { name?: string; command?: string },
  commands: Record<string, string | null>,
): VerifyChainEntry | null {
  if (typeof entry === 'string') {
    const command = commands[entry];
    return command ? { key: entry, command } : null;
  }
  // Object form (not a string): resolve by name into commands.*, else inline.
  const byName = entry?.name ? commands[entry.name] : null;
  if (byName) return { key: entry.name as string, command: byName };
  if (entry?.command) {
    // Unnamed inline command (belt-and-braces form): reverse-map the exact
    // command text to its commands.* key when one exists, so a nameless entry
    // still gets a stable stage id and `only:['test']` matches it. Otherwise
    // the raw command text is the key (self-describing).
    const reverse = Object.entries(commands).find(([, v]) => v === entry.command);
    return { key: (entry.name || reverse?.[0] || entry.command) as string, command: entry.command };
  }
  return null;
}

/** Resolve the ordered, cheapest-first chain of {key,command} that actually exist. */
export function resolveVerifyChain(config: DigbyConfig | null, only?: string[]): VerifyChainEntry[] {
  if (!config?.commands) return [];
  const order: (string | { name?: string; command?: string })[] =
    (config.verify && config.verify.length ? config.verify : ['typecheck', 'lint', 'test']);
  const chain: VerifyChainEntry[] = [];
  for (const entry of order) {
    const stage = verifyEntryToStage(entry, config.commands);
    if (!stage) continue;
    if (only && only.length && !only.includes(stage.key)) continue;
    if (chain.some(s => s.key === stage.key)) continue; // dedupe by key (mixed forms)
    chain.push(stage);
  }
  return chain;
}

export interface VerifyStage {
  key: string; command: string; exitCode: number; passed: boolean; skipped?: boolean; outputTail: string;
  /** 2026-09-10 OOM-herd fix: the stage died ENVIRONMENTALLY (SIGKILL/OOM —
   *  exit 137, or non-zero with a completely empty output tail). Retried once
   *  in-chain; when it persists the failure is labeled infra, not code. */
  environmental?: boolean;
  /** Ticket 7c5745d4: the stage's wrapper shell died BEFORE it could echo the
   *  __DIGBY_EXIT__ marker (harness per-command timeout SIGTERM, the 16 MiB
   *  maxBuffer kill, or an external kill) — so exitCode is the missing-marker
   *  DEFAULT (1), not a tool verdict, and outputTail is a truncated stream.
   *  Always environmental; the tail is prefixed with the CAPTURE INCOMPLETE
   *  cause so a lane never "fixes" code against a capture artifact. */
  terminated?: boolean;
  /** T2e (todo a04cda91, ticket 7ec6200b): the stage died at the harness
   *  PER-COMMAND TIMEOUT — split out of `environmental`. A hung stage may be
   *  a CODE defect (infinite loop, deadlock), so it is surfaced as a FAILURE
   *  (telemetry kind verify_stage_timeout), never auto-labeled infra. The
   *  env-class (OOM/SIGKILL diagnostics-free) is untouched. */
  stageTimeout?: boolean;
  /** Framework Operator run 3 (2026-09-22, the e4edffa3 isolation class): the
   *  chain was DEFERRED before its first leg — the shared dev container's
   *  memory cgroup is saturated by peer lanes' verify stages, so a cold
   *  tsc/jest now would only OOM-die (exit-137 false reds). Rides the v1#30
   *  hollow-pass semantics (skipped + unverified): no fix-loop burn, no green
   *  checkmark, honest deferral. */
  deferred?: boolean;
  /** ff262da5 (2026-10-16): the ENV-STARVED verdict — the chain did not run
   *  because the ENVIRONMENT could not host it (container/host memory, or
   *  this session's own background-process allowance). Always paired with
   *  deferred; adds the ticket's own verdict class so a starved environment
   *  is never retried as if it were a code failure. */
  envStarved?: boolean;
}
export interface VerifyResult {
  passed: boolean;
  ran: boolean;
  stages: VerifyStage[];
  failedStage: string | null;
  /**
   * v1#30 (P5): true when the chain "passed" only because ≥1 stage was SKIPPED
   * (its tool is not installed). A skipped stage must not drive fix-loops
   * (passed stays true so auto-verify doesn't thrash on a missing linter), but
   * it is NOT a verified pass either — the PR gate and the result text treat
   * an unverified chain as not-verified, honestly.
   */
  unverified: boolean;
}

/**
 * A non-zero exit that means the TOOL isn't installed (not a code defect):
 * exit 127 is the shell's definitive "command not found"; "No module named X"
 * is `python -m <tool>` with the tool absent. We treat these as SKIPPED so a
 * missing linter/typechecker doesn't drive fruitless fix-loops. (We
 * deliberately do NOT match "No such file or directory" — that's a legitimate
 * test failure, not a missing tool.) A skipped stage makes the chain
 * UNVERIFIED (v1#30): it no longer counts as a full pass anywhere a gate reads
 * the outcome.
 */
function toolMissing(exitCode: number, output: string): boolean {
  return exitCode === 127 || /\bno module named\b/i.test(output);
}

// ── Environmental-red relay + telemetry (2026-09-10) ─────────────────────────
//
// The chain (here) knows WHICH stage died environmentally but not the session;
// recordVerify (verify-state.ts) knows the sessionId but receives only
// passed/failedStage from its call sites. The chain parks its verdict per
// WORKTREE (worktrees are per-session, so chains running concurrently under the
// verify-slot limiter can never cross); captureVerifyFingerprint — always taken
// between the chain and the record, on the same worktree — consumes it and
// carries it into recordVerify, which persists environmental:true and emits the
// VERIFY_ENV_RED metric. Consume deletes, and every chain's terminal outcome
// replaces the worktree's entry, so a verdict stranded by a flow that died
// between chain and record can never mislabel a later failure; the TTL bounds
// the one remaining pickup path (a fingerprint taken with no fresh chain).

export interface EnvironmentalRed { stage: string; exitCode: number; }

const envRedByWorktree = new Map<string, EnvironmentalRed & { at: number }>();
export const ENVIRONMENTAL_RED_TTL_MS = 600_000;

/** Pick up (and delete) the environmental verdict the last chain on this
 *  worktree parked, if it is still fresh. */
export function consumeEnvironmentalRed(worktree: string): EnvironmentalRed | null {
  const parked = envRedByWorktree.get(worktree);
  if (!parked) return null;
  envRedByWorktree.delete(worktree);
  if (Date.now() - parked.at > ENVIRONMENTAL_RED_TTL_MS) return null;
  return { stage: parked.stage, exitCode: parked.exitCode };
}

/**
 * Telemetry: ONE loop_metrics row (kind verify_env_red) per environmental stage
 * failure, emitted where the sessionId is known (recordVerify). DYNAMIC import:
 * verify.service is an env-free leaf (its tests mock only the logger) — a
 * static loop-metrics import would drag config/database → config/env into its
 * graph (the import-graph landmine). Never throws.
 */
export async function noteEnvironmentalVerifyRed(sessionId: string | undefined, env: EnvironmentalRed): Promise<void> {
  try {
    const { recordLoopMetric, LOOP_METRIC_KINDS } = await import('../platform/loop-metrics.service');
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.VERIFY_ENV_RED,
      sessionId,
      meta: { stage: env.stage, exitCode: env.exitCode },
    });
  } catch { /* telemetry must never take the verify path down */ }
}

/**
 * ff262da5 (2026-10-16): ONE loop_metrics row (kind verify_pressure_deferred)
 * per ENV-STARVED chain — the ticket's AFTER-number series (the audit bakes
 * env-starved / verify_env_red rates per day). DYNAMIC import for the same
 * env-free-leaf reason as noteEnvironmentalVerifyRed. Never throws.
 */
/**
 * ff262da5 (2026-10-16): ONE loop_metrics row (kind verify_pressure_deferred)
 * per ENV-STARVED chain — the ticket's AFTER-number series (the audit bakes
 * env-starved / verify_env_red rates per day). DYNAMIC import for the same
 * env-free-leaf reason as noteEnvironmentalVerifyRed. Never throws.
 */
export async function noteVerifyEnvStarved(sessionId: string | undefined, meta: Record<string, unknown>): Promise<void> {
  try {
    const { recordLoopMetric, LOOP_METRIC_KINDS } = await import('../platform/loop-metrics.service');
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.VERIFY_PRESSURE_DEFERRED,
      sessionId,
      meta: { arm: 'pressure', ...meta },
    });
  } catch { /* telemetry must never take the verify path down */ }
}

/**
 * T2e (todo a04cda91, ticket 7ec6200b, 2026-10-17): ONE loop_metrics row
 * (kind verify_stage_timeout) per stage that died at the harness per-command
 * timeout — the FAILURE-class split from the environmental class (a hung
 * stage may be a code defect). Same dynamic-import/env-free-leaf discipline.
 * Never throws.
 */
export async function noteVerifyStageTimeout(sessionId: string | undefined, meta: Record<string, unknown>): Promise<void> {
  try {
    const { recordLoopMetric, LOOP_METRIC_KINDS } = await import('../platform/loop-metrics.service');
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.VERIFY_STAGE_TIMEOUT,
      sessionId,
      meta: { ...meta },
    });
  } catch { /* telemetry must never take the verify path down */ }
}

type ExecShell = (command: string, cwd?: string, timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>;

function tail(s: string, lines = 60): string {
  const arr = s.split('\n');
  return arr.slice(-lines).join('\n');
}

/**
 * Ticket d927d0cd / 769fa54a / 28ab7db2 / 733ffdef / fe0a8dc2 (mishap cluster,
 * 2026-10-17): a FAILED verify stage's outputTail showed ONLY the last 60
 * lines — in a ~20k-test run those are jest's trailing PASS lines plus the
 * worker-exit warning, and the failing tests' identities (the in-line
 * `FAIL <file>` / `● <suite › test>` / `✕ <test>` blocks, printed thousands of
 * lines before the end) scrolled out of the window. Five lanes hit
 * 3×-tool-failure streaks on tails that named ZERO failing tests — one tail
 * even ended mid-line ("FAIL s"). The lane cannot fix what it cannot see, so
 * the breaker filed the streak as "framework or model?" on diagnose-blind
 * evidence.
 *
 * Fix: on a FAILED stage, prepend a bounded excerpt of the FAILURE-IDENTITY
 * lines (jest / vitest / pytest / go test / tsc shapes) that are NOT already
 * inside the tail — the actionable signal rides WITH the tail instead of
 * being truncated away. Pure, exported for the replay suite. A green stage
 * never calls it (call-site gate) and a run whose identities all sit inside
 * the tail gets the tail back byte-identical.
 */
const FAILURE_IDENTITY_RE = /^(?:\s*(?:FAIL\s|●\s|✕\s|×\s|FAILED\s|--- FAIL:|ERROR\s)|Summary of all failing tests|short test summary info)/;
// tsc lines start with a path — "<file>(<line>,<col>): error TS2345: …" — so
// the pattern cannot be line-anchored; the `: error TS<code>: ` shape is the
// identity (the code + file:line is what the lane needs).
const TSC_IDENTITY_RE = /: error TS\d+:/;

export function appendFailureExcerpt(fullOutput: string, tailText: string, max = 25): string {
  if (!fullOutput || !tailText) return tailText;
  const inTail = new Set(tailText.split('\n').map((l) => l.trim()));
  const seen = new Set<string>();
  const excerpt: string[] = [];
  for (const raw of fullOutput.split('\n')) {
    if (!FAILURE_IDENTITY_RE.test(raw) && !TSC_IDENTITY_RE.test(raw)) continue;
    const line = raw.trimEnd();
    const key = line.trim();
    if (seen.has(key)) continue; // jest repeats identities in the final summary — once is enough
    seen.add(key);
    if (!inTail.has(key)) excerpt.push(line); // only the ones the tail LOST
    if (excerpt.length >= max) break;
  }
  if (!excerpt.length) return tailText;
  return `--- failing-test identities (excerpt, first ${excerpt.length} — these scrolled OUT of the output tail; the tail follows) ---\n${excerpt.join('\n')}\n--- end excerpt · last 60 lines of output ---\n${tailText}`;
}

/**
 * Framework Operator run 3 (2026-09-22, the e4edffa3 isolation class): parse
 * the `__CG__ <current> <max>` line the pre-chain reap leg prints from the
 * container's cgroup v2 memory files (bytes; `memory.max` may be the literal
 * 'max' = unlimited). Returns null — the caller runs the chain UNCHANGED —
 * for anything unparseable: no marker (older containers, a stripped reap
 * output), non-numeric values, the unlimited sentinel, max ≤ 0, or a
 * nonsensical current > max. Fail-open by design: the pre-flight check must
 * never itself wedge a verify chain. Exported for the pin suite.
 */
export function parseCgroupPressure(stdout: string): { pct: number; currentKb: number; maxKb: number; rawPct?: number; workingSetKb?: number; inactiveFileKb?: number } | null {
  const m = stdout.match(/__CG__\s+(\S+)\s+(\S+)(?:\s+(\S+))?/);
  if (!m) return null;
  const current = Number(m[1]);
  const maxRaw = m[2];
  if (!Number.isFinite(current) || current < 0) return null;
  if (maxRaw === 'max' || maxRaw === 'x') return null; // unlimited / unreadable
  const max = Number(maxRaw);
  if (!Number.isFinite(max) || max <= 0 || current > max) return null;
  const base = { currentKb: Math.round(current / 1024), maxKb: Math.round(max / 1024) };
  // 2026-09-29 (box C): memory.current COUNTS PAGE CACHE. The shared dev container
  // read 76 % with 36 MB of process memory and 4.3 GB of inactive (reclaimable) file
  // cache, so the deferral fired on cache. Pressure is now the WORKING SET — current
  // minus inactive_file from memory.stat (the kubelet eviction metric). A missing /
  // unreadable / nonsensical inactive_file keeps the raw reading (fail-open to the
  // old behaviour). Kill switch VERIFY_PRESSURE_RAW_CURRENT=1 restores the raw pct.
  const inactive = m[3] !== undefined && m[3] !== 'x' ? Number(m[3]) : NaN;
  const rawPct = (current / max) * 100;
  if (process.env.VERIFY_PRESSURE_RAW_CURRENT === '1' || !Number.isFinite(inactive) || inactive < 0 || inactive > current) {
    return { pct: rawPct, ...base };
  }
  const workingSet = current - inactive;
  return { pct: (workingSet / max) * 100, ...base, rawPct, workingSetKb: Math.round(workingSet / 1024), inactiveFileKb: Math.round(inactive / 1024) };
}

/**
 * ff262da5 (2026-10-16): parse the `__OOM__ <n>` line the pre-chain reap leg
 * prints from cgroup v2 memory.events (the container-level cumulative
 * oom_kill counter — the ticket's AFTER-number). Returns null for a missing
 * marker / non-numeric value (older containers, stripped output) — fail-open,
 * the same contract as the other two parsers.
 */
export function parseOomKillCount(stdout: string): number | null {
  const m = stdout.match(/__OOM__\s+(\S+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The shared ENV-STARVED defer stage (ff262da5): the ticket's ask — a
 *  starved environment is not a code failure and must be its OWN verdict,
 *  never retried. Carries the measured numbers so the lane / audit can see
 *  what moved. Rides the v1#30 hollow-pass semantics like the existing
 *  pressure arms (passed:true + unverified:true + one deferred stage: no
 *  fix-loop burn, no green checkmark). */
function envStarvedStage(key: string, detail: string): VerifyStage {
  return {
    key, command: '', exitCode: 0, passed: true, skipped: true, deferred: true, envStarved: true,
    outputTail: `[ENV-STARVED — ${detail}] The shared dev container's memory is too low to run a cold verify chain: this is an ENVIRONMENT condition, not a code failure (ticket ff262da5). The chain did NOT run and must NOT be retried in a tight loop — every retry would add load to the starving container. Wait for peer load to subside (typically minutes), then run verify again. Ops: thresholds VERIFY_PRESSURE_DEFER_PCT (default 85, WORKING SET — memory.current minus inactive_file, the kubelet eviction metric; the RAW reading counts reclaimable page cache and reads ~60 points high) and VERIFY_SESSION_ALLOWANCE_MB (default 2048).`,
  };
}

/**
 * Ticket 7fbc34cd (2026-10-09): parse the `__MEM__ <availKb> <totalKb>` line
 * the pre-chain reap leg prints from /proc/meminfo (kB). Inside the container
 * /proc/meminfo is the HOST's (verified live: MemTotal 32314036 kB == the
 * host's 33,089,572,864 B), which is exactly the scope the incident's killer
 * operated on — the container cgroup read a healthy 32% while the host was
 * starved. Returns null — the caller runs the chain UNCHANGED — for anything
 * unparseable: no marker, the 'x' sentinel (unreadable meminfo / missing
 * fields), non-numeric or non-positive values, or avail > total (nonsense).
 * Fail-open by design, same contract as parseCgroupPressure. Exported for the
 * pin suite.
 */
export function parseHostMemoryPressure(stdout: string): { availPct: number; availKb: number; totalKb: number } | null {
  const m = stdout.match(/__MEM__\s+(\S+)\s+(\S+)/);
  if (!m) return null;
  const avail = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isFinite(avail) || !Number.isFinite(total) || avail < 0 || total <= 0 || avail > total) return null;
  return { availPct: (avail / total) * 100, availKb: Math.round(avail), totalKb: Math.round(total) };
}

/** Run the chain cheapest-first, fail-fast. Stops at the first non-zero exit. */
export async function runVerifyChain(
  execShell: ExecShell,
  worktree: string,
  chain: VerifyChainEntry[],
  perCommandTimeoutMs: number,
  opts?: { baseBranch?: string; sessionId?: string },
): Promise<VerifyResult> {
  const stages: VerifyStage[] = [];
  if (!chain.length) return { passed: false, ran: false, stages, failedStage: null, unverified: false };


  // 2026-09-10 OOM-herd fix (oom_kill 159/day in the shared dev container):
  // (a) reap ORPHANED verify processes — worker restarts (deploys) orphan the
  //     docker-exec'd tsc/jest inside the container, which accumulate against
  //     the cgroup until every fresh leg is SIGKILLed; kill only ancient ones
  //     (>30 min — perCommandTimeoutMs bounds every legitimate leg well below);
  // (b) heap-cap every leg (NODE_OPTIONS) so one compiler can't take the cgroup.
  // Both best-effort.
  //
  // Framework Operator run 3 (2026-09-22, the e4edffa3 isolation class): the
  // reap leg now also prints the container's cgroup v2 memory.current /
  // memory.max (ONE shell round-trip — the reap already ran), and a saturated
  // cgroup DEFERS the whole chain instead of letting it OOM-die: the six
  // existing defenses are all reactive (they discover peer pressure by dying —
  // up to 2×10 min of doomed jest), and the 2026-09-21/22 incident window
  // (cgroup 99.95%, oom_kill 236→249, three lanes' exit-137 false reds while
  // the same suites passed 3/3 in isolation) is exactly the false-red class a
  // pre-flight check prevents. Deferral rides the v1#30 hollow-pass semantics:
  // passed:true + unverified:true + a deferred stage — no fix-loop burn, no
  // green checkmark, the lane retries when peer pressure subsides. Fail-OPEN
  // (no cgroup v2 files / memory.max 'max' / unreadable → run the chain as
  // before). Threshold
  // VERIFY_PRESSURE_DEFER_PCT (default 85 since ff262da5, 2026-10-16 — the
  // ticket's ~85% ask; was 92. Measured on the WORKING SET, not raw
  // memory.current — see parseCgroupPressure).
  // Framework Operator 2026-10-09 (ticket 7fbc34cd): the cgroup reading above is
  // CONTAINER-scoped, but the 7fbc34cd incident killed legs from OUTSIDE it —
  // the container read 32% (7.8/24.5 GB) minutes before two full-suite jest
  // legs were SIGKILLed with no marker, i.e. the HOST was starved by
  // co-tenant containers while THIS cgroup looked healthy (container max
  // 24.5 GB vs host total 33 GB leaves ~8.5 GB for everything else; the
  // kernel OOM-killer picks the largest RSS process — a full-suite jest tree).
  // /proc/meminfo inside the container is the HOST's (no lxcfs mask — verified
  // live: MemTotal 32314036 kB == the host's 33,089,572,864 B), so the same
  // reap round-trip now also prints MemAvailable/MemTotal and a HOST-starved
  // box defers exactly like a saturated cgroup: running now is the doomed-jest
  // class the ticket documents (2× SIGKILL, no exit marker, red tail a
  // no-code-change lane cannot fix). Same hollow-pass semantics, fail-OPEN on
  // any unreadable/garbage read (older containers, stripped output, no
  // /proc/meminfo), never fires when the cgroup leg already deferred above.
  // Threshold VERIFY_HOST_PRESSURE_DEFER_PCT (default 15 — MemAvailable % of MemTotal
  // BELOW which we defer; MemAvailable, not MemFree, because reclaimable cache
  // is genuinely available to a cold jest).
  const reap = 'for p in $(pgrep -f "tsc --noEmit|node_modules/.bin/jest" 2>/dev/null); do e=$(ps -o etimes= -p $p 2>/dev/null | tr -d " "); if [ -n "$e" ] && [ "$e" -gt 1800 ]; then kill -9 $p 2>/dev/null; fi; done; echo "__CG__ $(cat /sys/fs/cgroup/memory.current 2>/dev/null || echo x) $(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo x) $(awk \'/^inactive_file /{print $2; f=1} END{if(!f) print "x"}\' /sys/fs/cgroup/memory.stat 2>/dev/null || echo x)"; echo "__MEM__ $(awk \'/^MemAvailable:/{a=$2} /^MemTotal:/{t=$2} END{print (a==""||t==""?"x":a" "t)}\' /proc/meminfo 2>/dev/null || echo x)"; echo "__OOM__ $(awk \'/^oom_kill/{print $2}\' /sys/fs/cgroup/memory.events 2>/dev/null || echo x)"';
  const reapOut = await execShell(reap, worktree, 30_000).catch(() => ({ stdout: '', stderr: '' }));
  const pressure = parseCgroupPressure(reapOut?.stdout || '');
  const hostPressure = parseHostMemoryPressure(reapOut?.stdout || '');
  // ff262da5 (2026-10-16): admission control, per-session half. The same
  // round-trip now also counts oom_kill events (the container-level AFTER-
  // number) and the verify legs below append the session's own background
  // RSS accounting (see the allowance check before the first leg). The
  // kernel cannot give a session its own cgroup here — /sys/fs/cgroup is
  // mounted READ-ONLY in the shared dev container with no delegated
  // controllers (verified live 2026-10-16: 'cgroup2 ... ro', empty
  // cgroup.subtree_control, zero effective capabilities) — so this is the
  // requests-and-limits EQUIVALENT: account per session (ps RSS attribution,
  // session-bg.ts), enforce an allowance at the admission point, defer when
  // the container OR the session is over budget.
  const oomKill = parseOomKillCount(reapOut?.stdout || '');
  const pressureThresholdPct = Number(process.env.VERIFY_PRESSURE_DEFER_PCT) || 85;
  const hostPressureMinPct = Number(process.env.VERIFY_HOST_PRESSURE_DEFER_PCT) || 15;
  const hostStarved = !!(hostPressure && hostPressure.availPct < hostPressureMinPct);
  if (pressure && pressure.pct >= pressureThresholdPct) {
    const p = pressure;
    logger.warn(`verify: ENV-STARVED — container memory cgroup working set at ${p.pct.toFixed(1)}% (${p.workingSetKb ?? p.currentKb}/${p.maxKb} KB ≥ ${pressureThresholdPct}% threshold; raw memory.current ${p.rawPct ? p.rawPct.toFixed(1) : '?'}% incl. reclaimable cache): peer verify stages own the memory a cold chain would need; running now is the exit-137 false-red class (ticket ff262da5)`);
    void noteVerifyEnvStarved(opts?.sessionId, { arm: 'pressure', pct: Math.round(p.pct), rawPct: p.rawPct ? Math.round(p.rawPct) : null, thresholdPct: pressureThresholdPct, oomKill });
    return {
      passed: true, ran: false, unverified: true, failedStage: null,
      stages: [envStarvedStage('pressure', `container memory working set at ${p.pct.toFixed(1)}% (raw ${p.rawPct ? p.rawPct.toFixed(1) : '?'}% including ${Math.round((p.inactiveFileKb ?? 0) / 1024)} MB reclaimable page cache; oom_kill ${oomKill ?? '?'} cumulative)`)],
    };
  }
  if (hostStarved) {
    const h = hostPressure!;
    logger.warn(`verify: ENV-STARVED — HOST memory starved: MemAvailable ${h.availPct.toFixed(1)}% (${h.availKb}/${h.totalKb} KB < ${hostPressureMinPct}% floor): co-tenant containers own the memory a cold chain would need (the container cgroup itself reads healthy); running now is the 7fbc34cd class (full-suite jest SIGKILLed with no exit marker)`);
    void noteVerifyEnvStarved(opts?.sessionId, { arm: 'host_pressure', availPct: Math.round(h.availPct), floorPct: hostPressureMinPct });
    return {
      passed: true, ran: false, unverified: true, failedStage: null,
      stages: [envStarvedStage('host_pressure', `host memory starved — MemAvailable ${h.availPct.toFixed(1)}% (${h.availKb}/${h.totalKb} KB < ${hostPressureMinPct}% floor) while the container cgroup reads healthy (the 7fbc34cd class)`)],
    };
  }

  // ff262da5 charter item 2 — the per-session allowance (the cgroup
  // equivalent, see the note above): a session whose OWN background processes
  // hold more than VERIFY_SESSION_ALLOWANCE_MB (default 2048) of RSS must not
  // buy more memory with a fresh chain — its daemons are exactly the class the
  // run-end reap / idle sweep clean up. Read via the session-bg scan (one
  // extra round-trip ONLY when a sessionId hint was threaded through; absent
  // → skipped, fail-open). Tracked monitors count too: they are real memory
  // the chain would compete with. Kill switch: VERIFY_SESSION_ALLOWANCE_DISABLED=1
  // (this arm only).
  const sessionId = opts?.sessionId;
  if (sessionId && process.env.VERIFY_SESSION_ALLOWANCE_DISABLED !== '1') {
    const allowanceMb = Number(process.env.VERIFY_SESSION_ALLOWANCE_MB) || 2048;
    try {
      const bg = await import('./session-bg');
      const { stdout } = await execShell(bg.sessionBgScanScript(bg.sessionBgWorkspaceRoot()), worktree, 20_000);
      const mine = bg.parseSessionBgRows(stdout || '').filter((r) => r.sessionId === sessionId);
      const rssMb = Math.round(mine.reduce((n, r) => n + r.rssKb, 0) / 1024);
      if (rssMb > allowanceMb) {
        logger.warn(`verify: ENV-STARVED — session ${sessionId} background allowance exceeded: ${mine.length} attributed process(es) hold ${rssMb} MB RSS > ${allowanceMb} MB (run-end reap / idle sweep own this class; ff262da5)`);
        void noteVerifyEnvStarved(sessionId, { arm: 'session_allowance', procs: mine.length, rssMb, allowanceMb });
        return {
          passed: true, ran: false, unverified: true, failedStage: null,
          stages: [envStarvedStage('session_allowance', `this session's ${mine.length} background process(es) hold ${rssMb} MB RSS, over the per-session allowance ${allowanceMb} MB — a fresh chain would compete with its own daemons for the same container (the class the run-end reap and idle sweep clean up; stop_process them or wait for the sweep)`)],
        };
      }
    } catch { /* best-effort: an unreadable scan never blocks the chain */ }
  }

  // Related-tests-first (harness roadmap item 8a): when the chain REACHES the
  // test stage, run the tests that import the changed files first — a failing
  // subset is a red chain in seconds; a green subset never stands in for the
  // full stage. Decided lazily here so an earlier red never pays the git read.
  const work: VerifyChainEntry[] = [...chain];
  let relatedConsidered = false;
  for (let i = 0; i < work.length; i++) {
    let { key, command } = work[i];
    if (key === 'test' && !relatedConsidered) {
      relatedConsidered = true;
      const changed = await listChangedFiles(execShell, worktree, opts?.baseBranch);
      const related = await deriveRelatedTestCommand(command, changed, packageScriptReader(execShell, worktree));
      if (related) {
        work.splice(i, 0, { key: RELATED_STAGE_KEY, command: related });
        ({ key, command } = work[i]);
        logger.info(`verify: related-tests-first on ${changed.length} changed file(s) — ${related.slice(0, 160)}`);
      } else {
        logger.info(`verify: related-tests-first — nothing derivable (${changed.length} changed file(s); test command "${command.slice(0, 80)}") — full suite only`);
      }
    }
    // Ticket 7fbc34cd (2026-10-09): the cap used to be a POSIX-scoping NO-OP —
    // `NODE_OPTIONS="…" cd backend && npx jest` binds the assignment to `cd`
    // ONLY (verified empirically: sh -c 'FOO=1 cd / && echo [$FOO]' prints []),
    // so on every `cd X && …` leg — this repo's exact command shape — the heap
    // cap NEVER reached jest/tsc. `export` + `;` scopes it to the whole leg.
    // The value is 4096, NOT the historical 2048: that number was chosen while
    // the cap was a no-op and was never load-bearing — making it real at 2048
    // KILLS this repo's cold `tsc --noEmit` (probed live 2026-10-09: dies at
    // 200 s with "Ineffective mark-compacts near heap limit" at 2042 MB; the
    // same tsc exits 0 under 4096). 4096 still bounds a leg's every node
    // process (main + jest workers) well inside the 24.5 GB container cgroup.
    const leg = `export NODE_OPTIONS="--max-old-space-size=4096"; ${command}`;
    // One in-chain retry for ENVIRONMENTAL deaths (SIGKILL/OOM): exit 137, a
    // non-zero exit that printed NOTHING, or NO exit marker at all (7c5745d4 —
    // the wrapper was killed before it could echo the marker: timeout SIGTERM /
    // 16 MiB maxBuffer kill / external kill; a real tool failure always survives
    // to echo its own exit code).
    // T2e (todo a04cda91, ticket 7ec6200b): the PER-COMMAND TIMEOUT death is
    // split OUT of the retry loop — a hung stage may be a code defect (infinite
    // loop, deadlock), so it never auto-retries as infra and is surfaced as a
    // real failure with the verify_stage_timeout telemetry kind. The maxBuffer
    // kill and the diagnostics-free external SIGKILL stay env-class.
    let exitCode = 1; let cleaned = ''; let environmental = false;
    let terminated = false; let terminatedCause = '';
    let stageTimedOut = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      // Append an explicit exit-code marker so we can classify pass/fail from a pipe.
      const { stdout, stderr } = await execShell(`${leg}; echo "__DIGBY_EXIT__ $?"`, worktree, perCommandTimeoutMs)
        .catch((e: any) => ({ stdout: e.stdout?.toString?.() || '', stderr: (e.stderr?.toString?.() || e.message || '') + '\n__DIGBY_EXIT__ 1' }));
      const combined = [stdout, stderr].filter(Boolean).join('\n');
      // LAST match wins (2026-08-30 audit): the real marker is appended LAST —
      // first-match-wins let a command's own output containing a literal
      // "__DIGBY_EXIT__ 0" (old logs, fixtures, this repo's source via grep)
      // flip a failing stage to passed.
      const markers = [...combined.matchAll(/__DIGBY_EXIT__ (\d+)/g)];
      const m = markers.length ? markers[markers.length - 1] : null;
      exitCode = m ? Number(m[1]) : 1;
      // 7c5745d4: NO marker anywhere = the wrapper shell died before the echo —
      // deterministic proof the exit code is the default 1, NOT a tool verdict
      // (the ticket's signature: pytest killed at 99%, thousands of output
      // lines, no summary — previously indistinguishable from a test failure).
      terminated = markers.length === 0;
      stageTimedOut = false;
      if (terminated) {
        // Best-effort cause from the exec layers' `[exit: …]` stamp (Node 20,
        // verified empirically against the repo's own catch expression): the
        // async-exec 16 MiB maxBuffer kill carries code
        // ERR_CHILD_PROCESS_STDIO_MAXBUFFER with NO suffix (e.killed is
        // undefined on that path — ENOBUFS is the SYNC-path code and never
        // appears here), while the per-command timeout kill carries code
        // 'error' plus the ' — timed out' suffix. Match the CODE field; the
        // suffix text is load-bearing elsewhere (process.service.ts parses it).
        const timedOut = /\[exit: [^\]]*— timed out\]/.test(combined);
        stageTimedOut = timedOut;
        terminatedCause = /\[exit: ERR_CHILD_PROCESS_STDIO_MAXBUFFER\b/.test(combined)
          ? 'the output stream exceeded the 16 MiB capture buffer and the stage was killed mid-run'
          : timedOut
            ? `the stage was killed at the harness per-command timeout (${perCommandTimeoutMs} ms)`
            : 'the wrapper shell died before the tool reported an exit code (external SIGKILL/OOM)';
      } else {
        terminatedCause = '';
      }
      // Strip EVERY marker occurrence, not just a trailing one — with non-empty stderr
      // the join puts `__DIGBY_EXIT__ N` mid-string, and a $-anchored strip would leak
      // it into the output the model sees.
      cleaned = combined.replace(/^__DIGBY_EXIT__ \d+\s*$/gm, '').replace(/__DIGBY_EXIT__ \d+/g, '').trim();
      // 127 = missing tool (the v1#30 unverified lane) — never environmental.
      // terminated (7c5745d4): a stage whose wrapper died before the marker can
      // never have rendered a verdict — treat as infra, never as code-red.
      // T2e: a stage that TIMED OUT is NOT environmental — it is a failure the
      // lane must see (a hung test may be its own defect).
      environmental = exitCode !== 0 && exitCode !== 127 && !stageTimedOut && (exitCode === 137 || cleaned === '' || terminated);
      if (stageTimedOut) break; // never blind-retry a timeout as infra
      if (!environmental || attempt === 1) break;
      logger.warn(`verify: stage ${key} died environmentally (exit ${exitCode}, ${cleaned ? 'output' : 'EMPTY output'}) — one memory-gated retry after backoff`);
      // T2e (ticket 7ec6200b): the env retry is MEMORY-GATED — read the host's
      // MemAvailable (the same source the pre-chain host-pressure arm uses) and
      // EXTEND the backoff, bounded, while starved: a blind retry into a starved
      // box is the second 137 (the ticket's "blind retries" evidence). Bounded
      // extension: at most VERIFY_ENV_RETRY_MAX_BACKOFF_MS (default 120 s) total
      // wait, so a permanently starved host never wedges the chain.
      const baseBackoffMs = Number(process.env.VERIFY_ENV_RETRY_BACKOFF_MS) || 20_000;
      const maxBackoffMs = Number(process.env.VERIFY_ENV_RETRY_MAX_BACKOFF_MS) || 120_000;
      let backoffMs = baseBackoffMs;
      try {
        const meminfo = await fs.readFile('/proc/meminfo', 'utf8');
        const availKb = Number(/^\s*MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo)?.[1] ?? NaN);
        const totalKb = Number(/^\s*MemTotal:\s+(\d+)\s*kB/m.exec(meminfo)?.[1] ?? NaN);
        if (Number.isFinite(availKb) && Number.isFinite(totalKb) && totalKb > 0) {
          const availPct = (availKb / totalKb) * 100;
          const floorPct = Number(process.env.VERIFY_ENV_RETRY_MEM_FLOOR_PCT) || 15;
          if (availPct < floorPct) {
            const extended = Math.min(baseBackoffMs * 3, maxBackoffMs);
            logger.warn(`verify: env retry MEMORY-GATED — host MemAvailable ${availPct.toFixed(1)}% < ${floorPct}% floor; backoff extended ${baseBackoffMs} → ${extended} ms (bounded at ${maxBackoffMs})`);
            backoffMs = extended;
          }
        }
      } catch { /* unreadable /proc/meminfo → the base backoff stands */ }
      await new Promise(r => setTimeout(r, backoffMs));
    }
    const skipped = exitCode !== 0 && toolMissing(exitCode, cleaned);
    const passed = exitCode === 0 || skipped; // a missing tool can't fail the chain
    if (key === RELATED_STAGE_KEY) {
      // A related pass that could not run (tool missing / environmental) never
      // decides anything — the full stage right behind it is the check of record.
      if (skipped || environmental) {
        stages.push({ key, command, exitCode, passed: true, skipped: true, outputTail: tail(cleaned) || (environmental ? '[ENVIRONMENTAL] related-tests pass died; the full test stage runs next.' : '') });
        continue;
      }
    }
    stages.push({
      key, command, exitCode, passed, skipped,
      ...(environmental ? { environmental: true } : {}),
      ...(terminated ? { terminated: true } : {}),
      ...(stageTimedOut ? { stageTimeout: true } : {}),
      outputTail: stageTimedOut
        ? `[STAGE TIMEOUT — not classified environmental] ${terminatedCause}. The output below is a TRUNCATED stream. A hung stage CAN be a code defect (an infinite loop, a deadlock, a test awaiting something that never arrives) — investigate THIS stage; do not treat it as infra. If the code is sound, the per-command timeout may need raising for a legitimately slow stage (perCommandTimeoutMs=${perCommandTimeoutMs}).\n${tail(cleaned)}`
        : environmental && !cleaned
        ? (terminated
          ? `[ENVIRONMENTAL] stage terminated without an exit code (${terminatedCause}); zero diagnostics — infra, NOT a code failure. Retried once; retry the verify later rather than "fixing" code.`
          : `[ENVIRONMENTAL] process was SIGKILLed (exit ${exitCode}, zero diagnostics) — OOM/infra, NOT a code failure. Retried once; retry the verify later rather than "fixing" code.`)
        : (terminated
          ? `[CAPTURE INCOMPLETE — no exit marker: ${terminatedCause}. The output below is a TRUNCATED stream, NOT a test verdict.]\n${tail(cleaned)}`
          // d927d0cd cluster: a REAL red's tail must name its failing tests —
          // identities that scrolled out of the 60-line window ride in an
          // excerpt ABOVE the tail. Green/skipped stages keep the plain tail.
          : (exitCode !== 0 && !skipped ? appendFailureExcerpt(cleaned, tail(cleaned)) : tail(cleaned))),
    });
    // Fail-fast only on a REAL non-zero exit (the tool ran and found problems).
    if (exitCode !== 0 && !skipped) {
      // T2e: a stage timeout is a REAL failure — its own telemetry row, never
      // the env-red verdict (which would mislabel a possible code defect as
      // infra and mute the fix loop).
      if (stageTimedOut) {
        envRedByWorktree.delete(worktree);
        void noteVerifyStageTimeout(opts?.sessionId, { stage: key, timeoutMs: perCommandTimeoutMs });
      } else if (environmental) {
        // Park (or clear) the environmental verdict for the recordVerify that
        // follows — relayed via captureVerifyFingerprint (see the relay block).
        envRedByWorktree.set(worktree, { stage: key, exitCode, at: Date.now() });
      } else {
        envRedByWorktree.delete(worktree);
      }
      return { passed: false, ran: true, stages, failedStage: key, unverified: false };
    }
  }
  envRedByWorktree.delete(worktree); // a green chain leaves no stranded verdict
  return { passed: true, ran: true, stages, failedStage: null, unverified: stages.some(s => s.skipped) };
}

/**
 * Normalized signature of a failure so "same failure recurring" detection isn't
 * defeated by line numbers / timestamps / temp paths (Reflexion consecutive-fail).
 */
export function failureSignature(stage: string, output: string): string {
  const norm = output
    .replace(/\d+/g, '#')
    .replace(/0x[0-9a-f]+/gi, '0x#')
    .replace(/\/tmp\/\S+/g, '/tmp/#')
    .replace(/\d{2}:\d{2}:\d{2}/g, '#');
  return crypto.createHash('sha256').update(stage + '\n' + norm.slice(-4000)).digest('hex').slice(0, 16);
}

/** The structured feedback injected when a verify stage fails (drives the retry). */
export function renderVerifyFeedback(result: VerifyResult, attempt: number, maxAttempts: number): string {
  const st = result.stages[result.stages.length - 1];
  if (!st) return 'Verification could not run.';
  const header = `[AUTO-VERIFY FAILED${st.environmental ? ' — ENVIRONMENTAL' : ''}] stage: ${st.key} (exit ${st.exitCode}) · attempt ${attempt}/${maxAttempts}
Command: ${st.command}
--- output tail ---
${st.outputTail}
---`;
  if (st.environmental) {
    // Infra-red, not code-red: an OOM/SIGKILL diagnostics-free death must never
    // drive code edits — "fixing" byte-identical code was the db25c401 loop.
    return `${header}
This failure is ENVIRONMENTAL (OOM/SIGKILL infrastructure death): your code is NOT implicated, and the stage already got one automatic in-chain retry. Do NOT edit code, tests, or verify config in response to this. Retry verify later (the box may be under memory pressure), or proceed with other pending work and re-run verify before finishing.`;
  }
  // Ticket 91120212: a STAGE TIMEOUT is a FAILURE (T2e) whose one sanctioned
  // remedy IS a config edit — `loop.perCommandTimeoutMs` in .digby/config.json
  // (the per-repo override loopConfig merges over DEFAULT_LOOP). The generic
  // branch below says "Do NOT … edit tests/verify config to force a pass", so a
  // legitimately slow suite (329 s against a 300 s scaffolded cap) got four
  // deterministic kills and a notice forbidding the only escape. Name it.
  if (st.stageTimeout) {
    return `${header}
${stageTimeoutAdvice(killedAtMsFromTail(st.outputTail))}
Earlier stages already passed — only "${st.key}" is in question.`;
  }
  return `${header}
The task is NOT complete until this exits 0. Fix the underlying cause above and continue.
Do NOT disable the check, weaken it, or edit tests/verify config to force a pass. Earlier stages already passed — only fix "${st.key}".`;
}

/** Pull the numeric cap the death was reported against out of the tail the
 *  chain already wrote ("...per-command timeout (300000 ms)"), so the advice
 *  quotes the lane's ACTUAL budget rather than a guess. */
function timeoutLookingCause(outputTail: string): string {
  const m = /per-command timeout \((\d+) ms\)/.exec(outputTail || '');
  return m ? ` (at ${m[1]} ms)` : '';
}
