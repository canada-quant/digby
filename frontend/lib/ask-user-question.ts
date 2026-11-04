/**
 * The ask_user question card's data (2026-10-20 — clarify / creative-direction asks).
 *
 * The run emits `ask_user` (coding stream) / `ask-user` (chat stream, normalized to `ask_user` by plain-session.ts)
 * with `{questionId, question, options: string[], expiresAt?, optionDetails?, multiSelect?}`. `options` stays the
 * label list every older surface reads; `optionDetails` adds a one-line description per label and `multiSelect`
 * lets the user pick several. Pure.
 */

export interface PendingQuestionOption { label: string; description?: string }

export interface PendingQuestion {
  questionId: string;
  question: string;
  options: string[];
  /** One entry per label, same order — only when the run sent descriptions. */
  optionDetails?: PendingQuestionOption[];
  /** The user may pick several options (the answer is the picks joined by ", "). */
  multiSelect?: boolean;
  /** Soft answer deadline (ms epoch) — the card shows a countdown and clears at zero; the server grace window beyond
   *  it still absorbs in-flight answers. */
  expiresAt?: number;
}

/** An `ask_user` event payload → the card's PendingQuestion. `now` is injectable for tests. */
export function pendingQuestionFromEvent(data: any, now: number = Date.now()): PendingQuestion {
  const options: string[] = Array.isArray(data?.options) ? data.options.map((o: unknown) => String(o)) : [];
  const byLabel = new Map<string, string>();
  if (Array.isArray(data?.optionDetails)) {
    for (const d of data.optionDetails) {
      const label = String(d?.label ?? '');
      const description = typeof d?.description === 'string' ? d.description.trim() : '';
      if (label && description) byLabel.set(label, description);
    }
  }
  const optionDetails = byLabel.size ? options.map(label => (byLabel.has(label) ? { label, description: byLabel.get(label) } : { label })) : undefined;
  return {
    questionId: String(data?.questionId ?? ''),
    question: String(data?.question ?? ''),
    options,
    ...(optionDetails ? { optionDetails } : {}),
    ...(data?.multiSelect === true && options.length > 1 ? { multiSelect: true } : {}),
    expiresAt: Number(data?.expiresAt) > 0 ? Number(data.expiresAt) : now + 3_600_000,
  };
}

/**
 * The answer a multi-select card sends: the picked labels in option order, plus the typed note when there is one
 * ("Playful, Minimal — and keep it teal"). '' when nothing was picked or typed.
 */
export function composeMultiSelectAnswer(options: readonly string[], picked: ReadonlySet<string>, note: string): string {
  const picks = options.filter(o => picked.has(o)).join(', ');
  const extra = note.trim();
  if (picks && extra) return `${picks} — ${extra}`;
  return picks || extra;
}
