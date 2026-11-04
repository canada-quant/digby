/**
 * A1 — SKIP AUTO-VERIFY WHEN NOTHING CHANGED SINCE THE LAST GREEN (2026-10-04,
 * coding quick wins; the owner chose option A of the coding dynamic-roster
 * options readout).
 *
 * Why: the harness auto-verify (agent.ts, the clean auto-mode finish) ran the
 * FULL .digby verify chain on every finish — even when the worktree content
 * was byte-identical to the content this session's last GREEN verify had
 * already passed. 97 % of the 3,182 lane runs in the 14-day prod readout were
 * machine-triggered (schedule 2,010 / agent 939 / hook 149); a recurring lane
 * that only reads and reports re-ran a minutes-long tsc / lint / test chain on
 * unchanged content every firing.
 *
 * Rule (deterministic, no model): the auto seam SKIPS the chain when ALL hold —
 *   - the session's verify record (verify-state.ts) is a REAL pass: passed,
 *     not unverified (a stage tool missing), not deferred (memory pressure),
 *     not environmental;
 *   - it carries a content `tree` and a `chainSig` equal to the signature of
 *     the chain about to run (same stage keys AND commands, same order) — a
 *     `verify({only:[…]})` subset pass, a config edit, or a legacy record
 *     written before this change never qualifies;
 *   - the worktree's content tree NOW (captureWorktreeTree — the same
 *     throwaway-index hash the PR gate compares) equals that tree.
 *
 * Honesty: a skip is NOT a new pass. Nothing is recorded into the verify state
 * (the earlier green's `at` / `sha` / `tree` stay the record of evidence — the
 * PR gate keeps comparing against it, exactly as it would have), no
 * `verify_result` / "✓ Auto-verify passed" is emitted, and the transcript line
 * names the earlier green it relies on. Telemetry: one loop_metrics
 * `verify_unchanged_skip` row per skip.
 *
 * Pure leaf (crypto only) so the many agent tests that mock verify-state
 * wholesale never lose these helpers. Kill switch
 * AUTO_VERIFY_UNCHANGED_SKIP_DISABLED=1: the chain runs on every finish again
 * and no chainSig / stages are written into new verify records.
 */

import * as crypto from 'crypto';

export function autoVerifyUnchangedSkipDisabled(): boolean {
  const v = String(process.env.AUTO_VERIFY_UNCHANGED_SKIP_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** Stable signature of a verify chain: stage keys + commands, in order (16 hex). */
export function verifyChainSignature(chain: ReadonlyArray<{ key: string; command: string }>): string {
  const canon = (chain ?? []).map((c) => [String(c?.key ?? ''), String(c?.command ?? '')]);
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 16);
}

/** The verify-record fields the skip reads (verify-state.ts VerifyState shape). */
export interface GreenVerifyRecord {
  passed?: boolean;
  unverified?: boolean;
  deferred?: boolean;
  environmental?: boolean;
  tree?: string | null;
  sha?: string | null;
  at?: string;
  chainSig?: string;
  stages?: string[];
}

/**
 * Pure: the record is a REAL green of exactly this chain with a content tree to
 * compare. Everything else (a red, a hollow pass, a subset pass, a legacy
 * record without chainSig, a missing tree) runs the chain.
 */
export function greenCoversChain(vs: GreenVerifyRecord | null | undefined, chainSig: string): boolean {
  if (!vs || vs.passed !== true) return false;
  if (vs.unverified === true || vs.deferred === true || vs.environmental === true) return false;
  if (typeof vs.tree !== 'string' || !vs.tree) return false;
  return typeof vs.chainSig === 'string' && !!chainSig && vs.chainSig === chainSig;
}

/** `2026-10-04T09:12Z` (minute precision) or '' for a missing / invalid stamp. */
function minuteStamp(at: string | undefined): string {
  const d = at ? new Date(at) : null;
  return d && Number.isFinite(d.getTime()) ? `${d.toISOString().slice(0, 16)}Z` : '';
}

/**
 * The transcript line for a skip. Deliberately NOT the green-check "Auto-verify
 * passed" line: nothing ran this run — it names the earlier green that covers
 * this exact content.
 */
export function unchangedSinceGreenText(vs: GreenVerifyRecord, stages: ReadonlyArray<string>): string {
  const when = minuteStamp(vs.at);
  const sha = typeof vs.sha === 'string' && vs.sha ? ` on ${vs.sha.slice(0, 12)}` : '';
  return `↺ Auto-verify skipped — the worktree content is unchanged since this session's last GREEN verify (${stages.join(', ')}${when ? ` at ${when}` : ''}${sha}). The chain did not run this time; that earlier pass is the evidence for this exact content.`;
}
