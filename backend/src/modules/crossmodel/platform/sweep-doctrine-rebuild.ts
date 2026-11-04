/**
 * Trigger-keyed sweep-doctrine rebuild (R&D stream 3, test-bench experiment
 * #2, 2026-09-18 — owner-gate oq_33a72186 cleared GO).
 *
 * The standing doctrine (STANDING_OWNER_DIRECTIVE_HEADER + the lane's
 * precedence rule [+ DIRECTIVE_SCOPE_RULE on project lanes]) used to ride BOTH
 * the supervisor lanes' system prompts AND the stored recurring sweep bodies
 * (the deliberate 2026-09-14 preflight duplication: fleet ~4855c/~1150 cl100k
 * tokens, project ~6243c/~1473t, paid on EVERY sweep firing). The system
 * prompt is the cached prefix every wake pays for anyway, so the stored sweep
 * bodies are now SLIM (doctrine removed — see buildFleetSweepPrompt /
 * buildProjectSupervisorSweepPrompt) and the doctrine reaches the wake through
 * the system prompt alone.
 *
 * The invariant that must never break: NO WAKE RUNS DOCTRINE-LESS. This module
 * enforces it at fire time, keyed on the trigger class:
 *   fireScheduleTarget (coding/schedule.service.ts) calls
 *   rebuildSweepPromptDoctrine with the finalized firing message and the
 *   target lane's systemPrompt:
 *   - not a stock sweep (no opener match)          → untouched ('not-sweep');
 *   - prompt already carries the doctrine (a legacy pre-heal stored body)
 *                                                  → untouched ('already-inline')
 *                                                    — never double-injected;
 *   - lane system prompt carries the doctrine      → untouched slim body
 *                                                    ('system-prompt') — the
 *                                                    dedup win: the doctrine
 *                                                    rides the cached prefix;
 *   - lane system prompt LACKS the doctrine (customized/stale/unreadable)
 *                                                  → doctrine REBUILT into the
 *                                                    firing message at the END
 *                                                    of the body
 *                                                    ('inlined-fallback');
 *   - SWEEP_DOCTRINE_FORCE_INLINE=1                → always rebuilt inline
 *                                                    ('inlined-forced') — the
 *                                                    escape hatch restoring
 *                                                    pre-dedup firing shape
 *                                                    without a rollback.
 *
 * Wake-class coverage of the invariant (pinned in sweep-doctrine-rebuild
 * .test.ts):
 *   - cold wake: the system prompt is messages[0] on the first turn — the
 *     stock lane system prompts carry the full doctrine set verbatim;
 *   - post-compaction wake: plain-chat history windowing never touches the
 *     system prompt (it is rebuilt from the DB every run), and the coding-loop
 *     compactMessages keeps messages[0] verbatim — the doctrine survives;
 *   - trigger-keyed sweep wake: this rebuild.
 *
 * LEAF-ish module: imports ONLY supervisor-doctrine.ts (a true leaf) so
 * schedule.service can use it without an import cycle (schedule.service →
 * this → supervisor.service → schedule.service would cycle). Pure functions —
 * the unit tests need no mocks.
 */

import { SWEEP_PROMPT_OPENER, PROJECT_SWEEP_PROMPT_OPENER, DOCTRINE_PROBE_MARKER } from './supervisor-doctrine';
// Layered prompts (2026-09-27): the doctrine a fallback firing carries is the
// GENERIC core (core-doctrine.ts) — the same layer-1 text the lane's system
// prompt holds. A leaf, so schedule.service still imports this without a cycle.
import { CORE_STANDING_DIRECTIVES, corePrecedenceRule, CORE_SCOPE_RULE } from './core-doctrine';

export type SweepClass = 'fleet' | 'project';

/** The trigger key: a firing message is a stock sweep iff it opens with one of
 *  the stock sweep openers (the same prefixes the stale-prompt heals key on —
 *  a user-customized sweep prompt is never matched, never touched). */
export function classifySweepPrompt(prompt: string): SweepClass | null {
  if (typeof prompt !== 'string') return null;
  if (prompt.startsWith(SWEEP_PROMPT_OPENER)) return 'fleet';
  if (prompt.startsWith(PROJECT_SWEEP_PROMPT_OPENER)) return 'project';
  return null;
}

/** The exact doctrine text for a sweep class — the same blocks (and the same
 *  joins) the pre-dedup stored bodies carried (fleet joined header + precedence
 *  with a single \n; project separated its three blocks with \n\n). PLACEMENT
 *  changed 2026-09-18 (test-bench #3, review finding C6): the block is now
 *  appended at the END of the firing body (see injectDoctrineAtEnd) — the
 *  after-opener placement let the user-role clip elide it mid-block. */
export function sweepDoctrineBlock(cls: SweepClass): string {
  // Layered (2026-09-27): the standing directives + the tier's precedence rule
  // (+ the scope rule on project lanes) from the generic core. Deliberately
  // NOT the whole core (gate outcomes + evidence rules ride only the system
  // prompt): the fallback block must fit the user-role clip's retained
  // 7,000-char tail (C6 pin in sweep-doctrine-rebuild.test.ts).
  return sweepDoctrineBlocks(cls).join('\n\n');
}

/** The doctrine blocks a lane of this class must carry (system prompt AND a
 *  fallback firing) — the layered core sections. The rebuild tests pin the
 *  union on these. */
export function sweepDoctrineBlocks(cls: SweepClass): string[] {
  return cls === 'fleet'
    ? [CORE_STANDING_DIRECTIVES, corePrecedenceRule('fleet')]
    : [CORE_STANDING_DIRECTIVES, corePrecedenceRule('project'), CORE_SCOPE_RULE];
}

export type SweepDoctrineMode =
  | 'not-sweep' // no opener match — untouched
  | 'already-inline' // legacy pre-heal stored body still carrying the doctrine — untouched
  | 'system-prompt' // doctrine verified in the lane's system prompt — slim body fired as-is
  | 'inlined-fallback' // system prompt lacked the doctrine — rebuilt into the firing
  | 'inlined-forced'; // SWEEP_DOCTRINE_FORCE_INLINE=1 — always rebuilt into the firing

/** Append the doctrine at the END of the firing body (opener line, duties,
 *  blank line, doctrine). Two constraints decide the placement: the opener
 *  stays at offset 0 (the heals and the UI classifier key on the prefix), and
 *  the doctrine must survive the coding-loop clip — a fallback/forced firing
 *  composite exceeds PER_MSG_CHAR_CAP (fleet 14,657c / project 16,022c,
 *  wake-prompt-size bench 2026-09-18) and clipOversizedMessages keeps only the
 *  first + last 7,000c of a role:'user' message. The exp #2 placement (right
 *  after the opener line) put the doctrine at ~5.6k–11.9k of the composite,
 *  exactly where the clip's middle elision lands — adversarial review C6,
 *  test-bench #3, 2026-09-18: a clipped fleet fallback lost 657c spanning the
 *  incident-born halt rule, a clipped project fallback lost
 *  SUPERVISOR_PRECEDENCE_RULE verbatim. End-injection keeps the whole block
 *  inside the retained tail (margins: 2,144c fleet / 753c project — pinned by
 *  the clip-survival test, so deliberate doctrine growth trips it). */
function injectDoctrineAtEnd(prompt: string, doctrine: string): string {
  return `${prompt.replace(/\s+$/, '')}\n\n${doctrine}`;
}

export function rebuildSweepPromptDoctrine(opts: {
  prompt: string;
  systemPrompt: string | null | undefined;
  forceInline?: boolean;
}): { prompt: string; mode: SweepDoctrineMode } {
  const { prompt, systemPrompt, forceInline } = opts;
  const cls = classifySweepPrompt(prompt);
  if (!cls) return { prompt, mode: 'not-sweep' };
  // Transition-window guard: a legacy stored body (the heals converge stored
  // rows to the slim builder — project bodies + both system prompts within
  // ≤15 min via the attention watchdog; the FLEET stored body is
  // activity-bound via ensureFleetSupervisor call sites — but firings can
  // race either) still carries the doctrine: firing it unchanged keeps the
  // wake doctrine-laden without double-injecting.
  if (prompt.includes(DOCTRINE_PROBE_MARKER)) return { prompt, mode: 'already-inline' };
  if (forceInline) {
    return { prompt: injectDoctrineAtEnd(prompt, sweepDoctrineBlock(cls)), mode: 'inlined-forced' };
  }
  // The dedup win: the lane's system prompt (the cached prefix) carries the
  // doctrine — the slim firing body goes out as-is.
  if (typeof systemPrompt === 'string' && systemPrompt.includes(DOCTRINE_PROBE_MARKER)) {
    return { prompt, mode: 'system-prompt' };
  }
  // Doctrine absent from the system prompt (customized, stale, or unreadable
  // — the call site passes null on a read error: uncertainty resolves TOWARD
  // doctrine, never away from it). Rebuild it into the firing message.
  return { prompt: injectDoctrineAtEnd(prompt, sweepDoctrineBlock(cls)), mode: 'inlined-fallback' };
}
