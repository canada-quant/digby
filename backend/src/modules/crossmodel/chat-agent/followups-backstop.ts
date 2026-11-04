/**
 * followups-backstop.ts — ticket 4ac547de (2026-10-17).
 *
 * Level 2 ('thinking') answers on HUMAN-typed turns lost their follow-up
 * chips path-dependently: the supervisor doctrine's wake-close contract
 * ("CLOSE with exactly ONE of: 'WAKE: no-op' / 'ACTIONS TAKEN'") and the
 * answer-first split notice ("End with ONE line … 'Follow-through: …'")
 * outcompete the chat playbook's single [FOLLOWUPS] line, so the lead's
 * final text carries no block — and on supervisor chats (and any run whose
 * reconcile never delivered a draft block) the step-0 safety net at the
 * reconcile seam has nothing to re-append. Measured 2026-10-17: 126/126
 * zero-chip `chat_platform_usage` rows were human-typed 'thinking' turns,
 * 54 of 60 on the kimi-k3 lead; plain-chat turns that did carry a checker
 * draft stayed healthy. The old utility fallback
 * (moonshotIntegration.generateFollowUps — "Called as a fallback when Kimi's
 * synthesis didn't produce [FOLLOWUPS] tags") had ZERO callers at the time
 * of the regression.
 *
 * The backstop: when a HUMAN-typed, non-continuation Level 2 answer parses
 * ZERO chips, generate them with the dormant utility and ride them through
 * the SAME `followUps` variable the model's own block would have — metric,
 * 'followups' event and metadata persistence all flow from it, so no other
 * seam changes. Guest (anonymous) turns are INCLUDED: the doctrine mandates
 * 2-4 question chips for signed-out users too (capability-doctrine.ts
 * followUpsInstruction !hasUser branch), and the product alert that measures
 * this contract (product-watch.service.ts isUserTurnRow) counts every
 * machine !== true row — guests included — so a guest-blind backstop would
 * leave the alert trippable (adversarial review F2, ticket 4ac547de).
 *
 * Guarantees:
 *  - the model's own block ALWAYS wins (this only fires on zero parsed chips);
 *  - machine wakes stay out — NOT because their doctrine omits chips (it asks
 *    machine runs for 2-4 question chips, action chips only are forbidden)
 *    but because nobody is on the turn to tap one and the alert's user-turn
 *    filter never counts machine rows (adversarial review F3: the original
 *    "doctrine omits offers" rationale here was wrong and is retracted);
 *  - a utility error or timeout FAILS OPEN: the answer persists with no
 *    chips exactly as before, nothing throws on the answer path;
 *  - bounded: the race resolves after FOLLOWUP_BACKSTOP_TIMEOUT_MS (default
 *    4 s — the answer is already streamed by then; this only feeds the chip
 *    row + reload parity), and FOLLOWUP_BACKSTOP_DISABLED=1 is the kill
 *    switch. The losing generator promise is handled by construction (its
 *    own 12 s provider budget can outlive the race — a late rejection must
 *    never surface as an unhandled rejection; adversarial review F4).
 */
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';

/** Kill switch (env read lazily so tests can flip it per case). */
export function followupBackstopDisabled(): boolean {
  return process.env.FOLLOWUP_BACKSTOP_DISABLED === '1';
}

/** The bounded race budget. Default 4 s; 0/negative disables the wait (fail open). */
export function followupBackstopTimeoutMs(): number {
  const raw = Number(process.env.FOLLOWUP_BACKSTOP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 4_000;
}

export interface FollowupsBackstopInput {
  /** The user's question (seeds the generator). */
  question: string;
  /** The CLEAN final answer text (block already stripped by parseFollowUps). */
  cleanText: string;
  /** Memory context for personalized suggestions, when the run has one. */
  memoryContext?: string;
  /** Observability: the run's chat id, when the row should be attributable. */
  sessionId?: string;
}

export interface FollowupsBackstopResult {
  /** The generated chips (0-2+); [] on every failure shape. */
  followUps: string[];
  /** True when the backstop FIRED (regardless of outcome) — for the metric row. */
  fired: boolean;
}

/**
 * Generate follow-ups for a zero-chip Level 2 human turn. Returns [] on every
 * failure shape (provider down, timeout, empty, all lines filtered) — the
 * caller persists whatever it got and never throws. Fire-and-forget safe:
 * call sites may await (bounded) or void-race it; the metric row records the
 * outcome either way.
 */
export async function generateBackstopFollowUps(
  generate: (question: string, synthesis: string, memoryContext?: string) => Promise<string[]>,
  input: FollowupsBackstopInput,
): Promise<FollowupsBackstopResult> {
  const meta = { got: 0, timeoutMs: followupBackstopTimeoutMs() };
  let followUps: string[] = [];
  let outcome: 'ok' | 'empty' | 'error' | 'timeout' = 'empty';
  try {
    // F4 (adversarial review, ticket 4ac547de): the generator's own provider
    // budget (12 s) can outlive this race (4 s default). Attach the catch to
    // the generator promise ITSELF — a losing late rejection must never
    // surface as an unhandled rejection; it resolves the race to [] instead.
    const generator = generate(input.question, input.cleanText, input.memoryContext)
      .then((r) => ({ ok: true as const, r }))
      .catch((err: any) => ({ ok: false as const, err: String(err?.message ?? err) }));
    const raced = await Promise.race([
      generator,
      new Promise<{ ok: false }>((res) => { const t = setTimeout(() => res({ ok: false }), followupBackstopTimeoutMs()); t.unref?.(); }),
    ]);
    if (raced.ok) {
      followUps = (Array.isArray(raced.r) ? raced.r : []).map((q) => String(q ?? '').trim()).filter(Boolean).slice(0, 5);
      outcome = followUps.length ? 'ok' : 'empty';
      meta.got = followUps.length;
    } else {
      outcome = 'timeout';
    }
  } catch (err: any) {
    outcome = 'error';
    logger.warn(`followups-backstop: generator failed (fail open, no chips): ${err?.message ?? err}`, { source: 'chat-agent' });
  }
  try {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.FOLLOWUP_BACKSTOP,
      sessionId: input.sessionId,
      meta: { ...meta, outcome },
    });
  } catch { /* telemetry never breaks the turn */ }
  return { followUps, fired: true };
}
