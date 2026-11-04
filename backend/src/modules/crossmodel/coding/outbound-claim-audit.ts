/**
 * Outbound arg claim audit (P4 v1#25 / spark B3+B4).
 *
 * THE GAP: the evidence guard adjudicated only the run's FINAL ANSWER — the
 * text a machine run pushed OUTWARD mid-run (send_chat_message to another
 * lane, a todo/goal blockedReason "note", a file_feedback description) was
 * never claim-audited, so a fabricated completion report could leave the run
 * through a side door and be believed by its recipient even when the final
 * was later replaced. This module runs the SAME claim extractor over the
 * outgoing TEXT arg at DISPATCH time and resolves each claim against the
 * run's harness receipts:
 *
 *   - notes (todo_update / goal_update blockedReason+description,
 *     file_feedback description): convicted claim lines are ANNOTATED inline
 *     with ' [unverified]' — annotate-not-block: a blocker note must still
 *     land, honestly labeled.
 *   - send_chat_message: when the whole message is a completion report
 *     (convicted claim lines ≥ half its non-empty lines) the dispatch is
 *     REFUSED with a reject-back-style envelope naming the receipt-less
 *     claims; a mixed message gets the note treatment (inline annotation).
 *
 * BOUNDS: machine-triggered runs only; texts > OUTBOUND_MIN_TEXT_CHARS only.
 *
 * Leaf discipline: imports only the pure extractor (run-evidence-guard) and
 * the pure receipt matcher (run-receipts). No prisma, no config/env import.
 */

import { extractCompletionClaims, type CompletionClaim } from './run-evidence-guard';
import { receiptMatchesClaim, type ToolReceipt } from './run-receipts';

/** Tools whose outgoing text args are audited, with their text-arg keys. */
export const OUTBOUND_AUDITED_TOOL_ARGS: Record<string, string[]> = {
  send_chat_message: ['message'],
  todo_update: ['blockedReason'],
  goal_update: ['blockedReason', 'description'],
  file_feedback: ['description'],
};

export const OUTBOUND_MIN_TEXT_CHARS = 80;

/** Appended to a convicted claim LINE in an annotated outgoing text. */
export const OUTBOUND_UNVERIFIED_MARK = ' [unverified]';

/** Refusal threshold for send_chat_message: the message IS a completion
 *  report when convicted claim lines make up at least this share of its
 *  non-empty lines. */
export const OUTBOUND_REFUSE_LINE_SHARE = 0.5;

export interface OutboundAuditResult {
  action: 'clean' | 'annotated' | 'refused';
  /** For 'annotated': the args copy with the text arg(s) annotated. */
  args?: any;
  /** For 'refused': the failure-shaped tool result to return WITHOUT dispatching. */
  refusal?: string;
  /** Convicted claim kinds (deduped) — telemetry meta. */
  kinds: string[];
  /** The convicted claim lines (deduped, capped at 5) — telemetry meta. */
  convictedLines: string[];
}

const CLEAN: OutboundAuditResult = { action: 'clean', kinds: [], convictedLines: [] };

/** Annotate each convicted line of `text` once, appending the mark. */
function annotateText(text: string, convictedLines: Set<string>): string {
  return text
    .split('\n')
    .map((l) => {
      const t = l.trim();
      if (!t || !convictedLines.has(t)) return l;
      if (l.trimEnd().endsWith(OUTBOUND_UNVERIFIED_MARK.trim())) return l; // idempotent
      return `${l}${OUTBOUND_UNVERIFIED_MARK}`;
    })
    .join('\n');
}

/**
 * Audit one outbound dispatch. Pure and deterministic; never throws (a broken
 * arg shape degrades to 'clean' — the dispatch itself will surface it).
 */
export function auditOutboundArgs(opts: {
  tool: string;
  args: any;
  /** This run's receipt union (in-process collector ∪ prior attempts). */
  receipts: ToolReceipt[];
  machineTriggered: boolean;
}): OutboundAuditResult {
  try {
    if (!opts.machineTriggered) return CLEAN;
    const argKeys = OUTBOUND_AUDITED_TOOL_ARGS[opts.tool];
    if (!argKeys || !opts.args || typeof opts.args !== 'object') return CLEAN;

    const convicted = new Map<string, CompletionClaim[]>(); // argKey → convicted claims
    for (const key of argKeys) {
      const text = opts.args[key];
      if (typeof text !== 'string' || text.length <= OUTBOUND_MIN_TEXT_CHARS) continue;
      const bad = extractCompletionClaims(text).filter((c) => !receiptMatchesClaim(c, opts.receipts));
      if (bad.length) convicted.set(key, bad);
    }
    if (!convicted.size) return CLEAN;

    const allClaims = [...convicted.values()].flat();
    const kinds = Array.from(new Set(allClaims.map((c) => c.kind)));
    const convictedLines = Array.from(new Set(allClaims.map((c) => c.text.trim()).filter(Boolean)));

    // send_chat_message: a message that IS a completion report is refused —
    // the recipient lane would act on it as fact (spark B3's laundering path).
    if (opts.tool === 'send_chat_message' && convicted.has('message')) {
      const text = String(opts.args.message);
      const nonEmpty = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const lineSet = new Set(convicted.get('message')!.map((c) => c.text.trim()));
      const claimLineCount = nonEmpty.filter((l) => lineSet.has(l)).length;
      if (nonEmpty.length > 0 && claimLineCount / nonEmpty.length >= OUTBOUND_REFUSE_LINE_SHARE) {
        const shown = convictedLines.slice(0, 3).map((l) => `"${l.length > 120 ? `${l.slice(0, 120)}…` : l}"`).join('; ');
        return {
          action: 'refused',
          refusal: JSON.stringify({
            ok: false,
            tool: opts.tool,
            reason: 'unverified_outbound_claims',
            message: `NOT sent. This message is a completion report, but its claims have NO matching receipts in this run's tool journal (${kinds.join(', ')}): ${shown}. Do the verification NOW with real tool calls and resend citing the returned ids (PR#, sha, run/deploy id, receipt id) — or rewrite the claims as "attempted, unverified". An uncited completion report must never leave this run.`,
          }, null, 1),
          kinds,
          convictedLines: convictedLines.slice(0, 5),
        };
      }
    }

    // Everything else (and mixed messages): annotate-not-block.
    const annotatedArgs: any = { ...opts.args };
    for (const [key, claims] of convicted) {
      annotatedArgs[key] = annotateText(String(opts.args[key]), new Set(claims.map((c) => c.text.trim())));
    }
    return { action: 'annotated', args: annotatedArgs, kinds, convictedLines: convictedLines.slice(0, 5) };
  } catch {
    return CLEAN;
  }
}
