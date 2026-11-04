/**
 * Message-as-answer (ticket 356d21bb) — an inbound owner/user message arriving
 * at a chat with a LIVE ask_user wait (a confirm-pending entry of kind
 * 'question') IS the answer to the parked card.
 *
 * The gaps this closes (all three lanes previously LOST the text as an answer):
 *   - chat lane, MACHINE run parked on ask_user: the inbound message preempted
 *     and force-resolved the wait with NULL (preemptMachineRunForUserMessage →
 *     resolvePendingForSession), so the durable record read 'expired' and the
 *     flagged ownerQuestion rows for the same decision stayed OPEN forever.
 *   - chat lane, USER run parked: the message queued behind the parked run
 *     (pending_chat_messages) while the card sat unanswered for up to 60 min.
 *   - coding lane parked in awaitAnswer: the message rode the steer mailbox,
 *     drained only at a step boundary the parked run never reached.
 *
 * One shared helper, used by every inbound-message classification point
 * (streamQuery's busy branch, platform.service sendChatMessage's busy branch,
 * and the coding steer path): when the chat shows a live question wait,
 *   1. stamp the DURABLE record 'answered' with the text FIRST —
 *      markDurableResolved is first-writer-wins (pending-durable.ts), so a
 *      later cancel writing 'expired' can never clobber the owner's answer;
 *   2. resolve the live wait with the FULL text — in-process (resolveAnswer)
 *      when the run lives in THIS process, else the Redis resolution mailbox
 *      (publishQuestionResolution) the run's heartbeat/cancelPoll drains
 *      (~2s for a parked coding run — run-executor.ts);
 *   3. close the matching flagged owner-question rows via
 *      resolveOwnerQuestionsForChatAnswer — which (ticket 356d21bb) now also
 *      unblocks every todo/goal gated on them.
 *
 * NO content heuristics: any inbound text while a card is live is treated as
 * the answer — the parked agent receives the full text either way and can
 * re-ask if it was off-topic. Best-effort like the rest of the owner-question
 * machinery: every step degrades independently, never throws, and a false
 * return means "no live question wait was resolved — fall back to the normal
 * queue/preempt/steer path".
 *
 * ZERO static imports (the lazy-import discipline of owner-questions.ts): this
 * module is reachable from controllers and services whose jest graphs mock
 * config/database + config/redis at the boundary.
 */

export interface MessageAsAnswerResult {
  resolved: boolean;
  /** The resolved wait's questionId / question text (for ack events + logs). */
  questionId?: string;
  question?: string;
  /** How the wait was resolved: in-process registry or the cross-process mailbox. */
  via?: 'local' | 'mailbox';
}

export async function resolveParkedQuestionWithOwnerText(input: {
  chatId: string;
  userId: string;
  /** The inbound message text — treated AS the answer to the live card. */
  text: string;
}): Promise<MessageAsAnswerResult> {
  const none: MessageAsAnswerResult = { resolved: false };
  try {
    const answer = String(input.text ?? '').trim().slice(0, 8000);
    if (!answer || !input.chatId || !input.userId) return none;
    // The confirm-pending presence key is the cross-surface truth for "this
    // chat is parked on a human decision" (written by whichever tier runs the
    // agent — WEB for chat runs, WORKER for coding runs).
    const { readConfirmPendingForChats } = await import('./confirm-pending');
    const entry = (await readConfirmPendingForChats([input.chatId])).get(input.chatId);
    if (!entry || entry.kind !== 'question') return none;

    // 1. Durable FIRST (first-writer-wins): the record must read 'answered'
    //    with the owner's text BEFORE any cancel/stop path can write
    //    'expired' (a preempt cancels the machine run right after this in the
    //    chat lane — the answer must survive it).
    try {
      const { markDurableResolved } = await import('./coding/pending-durable');
      await markDurableResolved('question', entry.id, 'answered', answer);
    } catch { /* the live-wait resolve below still lands the answer */ }

    // 2. Resolve the live wait: the in-process registry when the run executes
    //    HERE (chat runs and this-instance coding runs), else the mailbox the
    //    owning process drains (run-executor cancelPoll / chat-agent heartbeat).
    let via: 'local' | 'mailbox' | null = null;
    try {
      const { questionSession, resolveAnswer } = await import('./coding/question-registry');
      if (questionSession(entry.id) === input.chatId) {
        if (resolveAnswer(entry.id, answer)) via = 'local';
      }
    } catch { /* fall through to the mailbox */ }
    if (!via) {
      try {
        const { publishQuestionResolution } = await import('./coding/session-run-lock');
        await publishQuestionResolution(input.chatId, entry.id, answer);
        via = 'mailbox';
      } catch { via = null; }
    }
    if (!via) return none;

    // 3. Close the flagged owner-question rows for the same decision (the
    //    992c8374 machinery — which, ticket 356d21bb, also unblocks every
    //    todo/goal gated on them through goals.service's choke point).
    try {
      const { resolveOwnerQuestionsForChatAnswer } = await import('./platform/owner-questions');
      await resolveOwnerQuestionsForChatAnswer({
        chatId: input.chatId, userId: input.userId, askedQuestion: entry.question, answer,
      });
    } catch { /* the wait is resolved — the inbox sync must never fail it */ }

    return { resolved: true, questionId: entry.id, question: entry.question, via };
  } catch {
    return none;
  }
}
