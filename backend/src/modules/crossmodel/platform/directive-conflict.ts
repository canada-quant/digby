/**
 * update_schedule directive-conflict guard (remediation P2 item 8 — the
 * 2026-09-08 21:17Z incident): the owner typed a directive at 16:11Z; the lane
 * executed and benched it; the supervisor issued a GO — then a MACHINE-authored
 * update_schedule REWROTE the lane's standing prompt to say "no decision
 * pending", the cutover never ran, and five sweeps reported "nothing needs the
 * owner" while the directive rows stayed open.
 *
 * The guard fires ONLY on machine-authored prompt rewrites (no user-turn
 * anchor — the same discriminator promptSetBy uses) and refuses with a
 * `[DIRECTIVE CONFLICT]` envelope when the new prompt:
 *   (a) inserts a "no decision pending" / "resolved" idiom while a MATCHING
 *       owner decision is open (an open owner_questions row on the schedule's
 *       chat, or an open supervisor directive from the last 72h whose key
 *       terms overlap the schedule's stored prompt), or
 *   (b) DROPS the key terms of an open directive that the stored prompt
 *       carried (the rewrite steers the lane away from the owner's order).
 * A deliberate rewrite passes with `override:true` + a non-empty
 * `overrideReason` (both recorded in the emitted metric). Every evaluation
 * that finds a conflict emits ONE `directive_conflict` loop metric
 * (meta.overridden distinguishes refusals from override pass-throughs).
 *
 * Fail-OPEN: any read/parse failure lets the update proceed (the guard is a
 * tripwire, never an availability risk). Loaded via DYNAMIC import from
 * platform-tools (import-graph discipline).
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { listOpenDirectivesForUser } from './supervisor-state.service';
import { recordLoopMetric } from './loop-metrics.service';

/** How far back an open directive stays guard-relevant. */
export const DIRECTIVE_CONFLICT_WINDOW_MS = 72 * 60 * 60 * 1000;

/** "The decision is settled" idioms a machine rewrite must not insert while a matching decision is open. */
export const NO_DECISION_PENDING_RE =
  /\b(no (owner )?(decision|action|approval)s? (is |are )?(currently )?pending|nothing (is )?pending|no pending (owner )?(decision|approval)s?|decision (is |was )?(already )?resolved|all decisions? (are )?resolved|nothing (needs|awaits) the owner)\b/i;

/** Function words excluded from key terms (mirrors owner-questions' discipline, trimmed). */
const KEY_TERM_STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'without', 'is', 'are', 'was', 'were',
  'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'then', 'than', 'so', 'as', 'at', 'by', 'from',
  'into', 'about', 'over', 'under', 'we', 'you', 'i', 'me', 'my', 'our', 'your', 'do', 'does', 'did', 'will',
  'would', 'should', 'could', 'can', 'have', 'has', 'had', 'not', 'no', 'yes', 'please', 'now', 'when', 'if',
  'them', 'they', 'their', 'there', 'here', 'what', 'which', 'how', 'why', 'per', 'via', 'just', 'also', 'once',
]);

/** Stopword-free lowercase alphanumeric key terms. Pure; exported for tests. */
export function keyTerms(text: string): Set<string> {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !KEY_TERM_STOPWORDS.has(t)),
  );
}

/** Fraction of `of`'s terms present in `inSet` (0 when `of` is empty). Pure. */
export function termCoverage(of: Set<string>, inText: string): number {
  if (!of.size) return 0;
  const hay = keyTerms(inText);
  let hit = 0;
  for (const t of of) if (hay.has(t)) hit += 1;
  return hit / of.size;
}

/** A directive is "carried" by a prompt when at least this fraction of its key terms appear there. */
export const CARRIED_COVERAGE = 0.5;
/** …and "dropped" by the rewrite when the new prompt retains less than this fraction of them. */
export const RETAINED_COVERAGE = 0.5;
/** An open directive "matches" the schedule scope when it shares this much of its terms with the stored prompt. */
export const MATCHING_COVERAGE = 0.3;
/** Minimum key terms for a directive to participate (a 1-2 term directive proves nothing). */
const MIN_DIRECTIVE_TERMS = 3;

export interface DirectiveConflictVerdict {
  conflict: boolean;
  /** The model-facing refusal (present iff conflict). */
  message?: string;
}

/**
 * Evaluate a MACHINE-authored prompt rewrite against the user's open owner
 * decisions. Callers pass the resolved schedule row's stored prompt + chat.
 */
export async function checkScheduleDirectiveConflict(opts: {
  userId: string;
  scheduleId: string;
  sessionId: string;
  oldPrompt: string;
  newPrompt: string;
  override?: boolean;
  overrideReason?: string;
}): Promise<DirectiveConflictVerdict> {
  try {
    const now = Date.now();
    const since = now - DIRECTIVE_CONFLICT_WINDOW_MS;

    // Open owner decisions in scope: supervisor-ledger directives (72h, this
    // user) + open owner_questions on the schedule's own chat (or linked to it).
    const [directives, openQuestions] = await Promise.all([
      listOpenDirectivesForUser(opts.userId, since).catch(() => []),
      prisma.ownerQuestion.findMany({
        where: {
          userId: opts.userId,
          status: 'open',
          createdAt: { gte: new Date(since) },
          OR: [{ chatId: opts.sessionId }, { forChatId: opts.sessionId }],
        },
        select: { id: true, question: true },
        take: 20,
      }).catch(() => [] as Array<{ id: string; question: string }>),
    ]);

    const findings: string[] = [];

    // (a) "no decision pending" inserted while a matching decision is open.
    if (NO_DECISION_PENDING_RE.test(opts.newPrompt) && !NO_DECISION_PENDING_RE.test(opts.oldPrompt)) {
      if (openQuestions.length) {
        findings.push(
          `the rewrite asserts "no decision pending" while ${openQuestions.length} owner question(s) on this chat are OPEN: ` +
          openQuestions.slice(0, 3).map((q) => `${q.id.slice(0, 11)} "${q.question.slice(0, 80)}"`).join('; '),
        );
      }
      const matching = directives.filter((d) => {
        const terms = keyTerms(d.text);
        return terms.size >= MIN_DIRECTIVE_TERMS && termCoverage(terms, opts.oldPrompt) >= MATCHING_COVERAGE;
      });
      if (matching.length) {
        findings.push(
          `the rewrite asserts "no decision pending" while ${matching.length} owner directive(s) matching this schedule are OPEN: ` +
          matching.slice(0, 3).map((d) => `[${d.id.slice(0, 8)}] "${d.text.slice(0, 80)}"`).join('; '),
        );
      }
    }

    // (b) key terms of an open directive carried by the OLD prompt are DROPPED.
    for (const d of directives) {
      const terms = keyTerms(d.text);
      if (terms.size < MIN_DIRECTIVE_TERMS) continue;
      const carried = termCoverage(terms, opts.oldPrompt);
      if (carried < CARRIED_COVERAGE) continue; // the schedule never carried this directive
      const retained = termCoverage(terms, opts.newPrompt);
      if (retained >= RETAINED_COVERAGE) continue;
      findings.push(
        `the rewrite DROPS the key terms of OPEN owner directive [${d.id.slice(0, 8)}] "${d.text.slice(0, 100)}" ` +
        `(the stored prompt carried ${Math.round(carried * 100)}% of its terms; the new prompt retains ${Math.round(retained * 100)}%)`,
      );
    }

    if (!findings.length) return { conflict: false };

    const overridden = opts.override === true && String(opts.overrideReason ?? '').trim().length > 0;
    // Metric on EVERY conflict evaluation that found something — refusal or override.
    try {
      recordLoopMetric({
        kind: 'directive_conflict',
        sessionId: opts.sessionId,
        meta: { scheduleId: opts.scheduleId.slice(0, 8), findings: findings.length, overridden },
      });
    } catch { /* telemetry never blocks */ }
    if (overridden) {
      logger.warn(
        `directive-conflict: override accepted on schedule ${opts.scheduleId.slice(0, 8)} — reason: ${String(opts.overrideReason).slice(0, 200)}`,
      );
      return { conflict: false };
    }
    return {
      conflict: true,
      message:
        `[DIRECTIVE CONFLICT] update_schedule NOT applied — this machine-authored prompt rewrite contradicts open owner decision(s): ` +
        `${findings.join(' | ')}. ` +
        `Resolve the open decision first (answer/close it), or — if this rewrite is genuinely deliberate — re-call update_schedule with override:true AND overrideReason:"<why the open decision does not apply>". The override is metered and audited.`,
    };
  } catch (err: any) {
    logger.warn(`directive-conflict: guard failed open for schedule ${opts.scheduleId.slice(0, 8)}: ${err?.message ?? err}`);
    return { conflict: false };
  }
}
