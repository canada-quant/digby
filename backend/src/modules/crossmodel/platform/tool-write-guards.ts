/**
 * Tool-write integrity guards (ticket f3e56567).
 *
 * WHY THIS FILE EXISTS. The ticket reported a SILENT-LOSS shape on the agent's
 * tool surface that "reports plausible success": a supervisor's
 * `todo_update(progressNote)` was attempted 6+ times across wakes and each time
 * "progressNote stayed null and updatedAt stayed unchanged" on read-back, while
 * the tool returned no error.
 *
 * That is NOT a transport fault; it is a contract hole. `updateTodo` /
 * `updateGoal` collect the requested fields into a `data` object and then:
 *
 *     if (Object.keys(data).length) { … prisma.update … }
 *
 * so a call whose mutating fields do not actually FORWARD performs ZERO writes
 * and returns the CURRENT row — indistinguishable, to the agent, from a
 * successful update. The agent concludes the write "was silently lost" and
 * retries, producing exactly the reported 6+ loop.
 *
 * THE FIX IS A LOUD REFUSAL, never a silent no-op and never a guess. The ticket's
 * own acceptance bar is "land byte-intact … or fail loudly"; the same standard
 * applies to a write that would not happen. A refusal names what is missing so
 * the caller can re-issue correctly in ONE retry.
 *
 * CRITICAL DESIGN POINT (independent review B2/N1, 2026-10-30): the guard must
 * mirror the executor's REAL forwarding predicates, not mere key PRESENCE. The
 * tool handlers forward conditionally —
 *
 *     status:        args.status !== undefined && args.status !== null
 *     dependsOn*:    Array.isArray(args.dependsOn*)
 *     evidence:      a NON-BLANK string (blank = "nothing supplied")
 *
 * so `{todoId, status: null}` and `{todoId, dependsOnTodoIds: null}` perform
 * ZERO writes while LOOKING like mutations. Presence-only checking would have
 * let both through — the very defect this file removes. Each predicate below is
 * a line-for-line mirror of `platform-tools.ts` (todo_update ~:5451,
 * goal_update ~:5292).
 *
 * `evidence` is the one field this leaf deliberately does NOT adjudicate
 * (ticket ac87ab80): whether it writes depends on the ROW — a done/dropped row
 * AMENDS the stored citation, an open row 400s naming the rule — and a pure
 * leaf cannot read the row. Both outcomes are honest, so a non-blank `evidence`
 * counts as an attempted mutation and the service owns the decision. Only a
 * BLANK string (which the service trims to '' and stores as nothing) is still
 * refused here.
 *
 * Pure leaf — no imports, so it is safe for platform-tools' static import graph
 * (which must never reach config/env under jest) and trivially testable.
 */

/** The kind of write a tool call is asking for. */
export type WriteToolName = 'todo_update' | 'goal_update';

/** Is this field actually forwarded/STORED by the handler? Per-tool predicates. */
const WRITES: Record<WriteToolName, (a: Record<string, unknown>) => boolean> = {
  // platform-tools.ts todo_update forwarding list (~:5451-5469).
  todo_update: (a) =>
    a.title !== undefined                                                    // title
    || (a.status !== undefined && a.status !== null)                         // status
    || a.blockedReason !== undefined                                         // blockedReason
    || a.blockKind !== undefined                                             // blockKind
    || a.gateQuestionId !== undefined                                        // gateQuestionId
    || a.assigneeChatId !== undefined                                        // assigneeChatId
    || a.progressNote !== undefined                                          // progressNote
    || Array.isArray(a.dependsOnTodoIds)                                     // dependsOnTodoIds
    // evidence: on a done/dropped transition goals.service stores it; on a row
    // that is ALREADY done/dropped it AMENDS the stored citation (ticket
    // ac87ab80); on an open row it now 400s naming the rule. All three are loud
    // or a real write, so it always counts here — this pure leaf cannot read the
    // row, and the service owns the amend-or-refuse decision.
    // A BLANK string is the exception and still refuses: the service trims to
    // '' and treats that as "nothing supplied" (`if (evidenceText)`), so
    // `{evidence: ''}` would write nothing and return the row as a success —
    // exactly the silent no-op this guard exists to refuse (independent review
    // ac87ab80 finding 8; the pre-fix predicate caught it by accident).
    || (typeof a.evidence === 'string' && a.evidence.trim() !== ''),
  // platform-tools.ts goal_update forwarding list (~:5292-5312). goal_update has
  // no `evidence` field at all.
  goal_update: (a) =>
    a.title !== undefined                                                    // title
    || a.description !== undefined                                           // description
    || (a.status !== undefined && a.status !== null)                         // status
    || a.blockedReason !== undefined                                         // blockedReason
    || a.blockKind !== undefined                                             // blockKind
    || a.gateQuestionId !== undefined                                        // gateQuestionId
    || a.progressNote !== undefined                                          // progressNote
    || Array.isArray(a.dependsOnGoalIds)                                     // dependsOnGoalIds
    || a.priority !== undefined                                              // priority
    || a.dueAt !== undefined,                                                // dueAt
};

/** The fields named in the refusal's "you can write one of these" list. */
const WRITABLE_FIELDS: Record<WriteToolName, readonly string[]> = {
  todo_update: ['title', 'status', 'blockedReason', 'blockKind', 'gateQuestionId', 'assigneeChatId', 'progressNote', 'dependsOnTodoIds'],
  goal_update: ['title', 'description', 'status', 'blockedReason', 'blockKind', 'gateQuestionId', 'progressNote', 'dependsOnGoalIds', 'priority', 'dueAt'],
};

/**
 * The refusal text when a write tool was called with an id but NOTHING that
 * actually changes the row, else null.
 *
 * `undefined` is "not sent" and stays distinct from "sent as null":
 * `progressNote: null` is a real instruction (CLEAR the note) and IS forwarded,
 * so it counts as a write. `status: null`, by contrast, is NOT forwarded by the
 * executor, so it is correctly treated as no change here.
 *
 * Inspects only field PRESENCE/TYPE, never content — a note is user-authored
 * prose (and the same arguments may carry credentials) and must never be echoed
 * into a refusal.
 */
export function noOpWriteRefusal(tool: WriteToolName, args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  if (WRITES[tool](a)) return null;
  const idKey = tool === 'todo_update' ? 'todoId' : 'goalId';
  const id = typeof a[idKey] === 'string' ? a[idKey] : '';
  const fields = WRITABLE_FIELDS[tool].join(', ');
  const evidenceHint = tool === 'todo_update'
    ? ' `evidence` must be a NON-BLANK string: pass it WITH `status: "done"` (or "dropped") to close the row, or alone on a row that is ALREADY done/dropped to AMEND its citation (audited). A blank `evidence` writes nothing.'
    : '';
  return `[tool call rejected] Nothing was written — ${tool} received${
    id ? ` ${idKey} ${String(id).slice(0, 12)}` : ' an id'
  } but NOTHING that changes the row (writable: ${fields}). A call with only an id would have performed ZERO writes and then returned the unchanged row, which reads as a successful update — that silent no-op is refused instead.${evidenceHint} Re-issue with the field(s) you meant to write; \`progressNote: null\` explicitly CLEARS a note.`;
}

/**
 * NOTE — the progressNote STORAGE cap is deliberately NOT refused here.
 *
 * `goals.service` slices a note to `progressNoteMax()` (2,000), so a >2,000
 * note is stored as a prefix. That is ticket a8d6e514's INTENDED contract —
 * `platform-tools.progress-note.a8d6e514.test.ts` pins "a note past 2,000 chars
 * is stored at exactly 2,000" — so converting it into a hard refusal would
 * break every standing loop that stamps a long continuation ledger.
 *
 * What was NOT acceptable is the SILENCE (observed live 2026-10-30: a
 * 2,604-char note stored as exactly 2,000 chars with no error, so the caller
 * believed the whole note landed). The clip is now announced in the tool RESULT
 * by `progressNoteClipNotice` (progress-note.ts), wired into todo_update and
 * goal_update in platform-tools.ts — the write still succeeds, and the caller
 * is told how many chars did not land.
 */