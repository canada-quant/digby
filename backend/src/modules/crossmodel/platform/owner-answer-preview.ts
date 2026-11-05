/**
 * owner-answer-preview.ts — the honest answer preview for the
 * list_owner_questions listing (ticket f94e91eb, 2026-11-02).
 *
 * THE MISHAP: the supervisor-facing listing rendered an ANSWERED row as
 * `String(q.answer).slice(0, 500)` with no marker, no length field and no
 * pointer to the rest. A supervisor reading card oq_d07d9c44 (the owner's
 * Azure Trusted Signing paste, which carried Tenant ID, Subscription ID,
 * client ID and a secret) saw the row end mid-string at "…CMD+C to" and
 * concluded "the card carries no client ID or secret" — a CONFIDENT
 * false-negative that produced a NEW owner card asking the owner to re-paste
 * values they had already supplied (a duplicate decision card the owner had
 * to dismiss).
 *
 * THE RULE THIS MODULE ENFORCES: absence-by-truncation must never look like
 * real absence. A clipped preview always carries (a) a trailing sentinel
 * naming how many chars are missing and HOW to read them, and (b) the
 * machine-readable fields the caller branches on — `chars` (the FULL stored
 * length, so a caller can compare it against what it was shown), `omitted`,
 * `truncated`. `full: true` returns the stored text uncut (the escape hatch
 * behind the tool's `fullAnswer` argument).
 *
 * Counts are CODE POINTS (Array.from), never UTF-16 units: the repo paid for
 * that lesson twice (progress-note.ts, ticket f3e56567 — `.slice()` split
 * surrogate pairs and counted emoji double, so a cap and its guard disagreed
 * about the same string).
 *
 * Pure leaf (no imports) so it is unit-testable without the prisma graph —
 * same discipline as progress-note.ts / evidence-ledger.ts.
 */

/**
 * Default preview cap for one answer in the listing, in code points, chosen
 * so MOST real owner answers ride the listing whole (a supervisor then never
 * has to branch), while a handful of maximal answers cannot blow a
 * multi-row listing out of the model's context. A row past this cap is
 * flagged — never silently shortened.
 */
export const OWNER_ANSWER_PREVIEW_MAX = 1500;

/** The sentinel that opens a clipped preview's trailing marker. Exported so
 *  tests and callers can detect it without matching the whole sentence. */
export const OWNER_ANSWER_TRUNCATED_MARK = ' …[ANSWER TRUNCATED — ';

/**
 * The sentinel a clipped QUESTION carries (review finding D1, ticket
 * 9dff565f). Same shape, correct noun.
 *
 * WHY THIS IS NOT COSMETIC: the QUESTION column reaches
 * CONSOLE_ACTION_QUESTION_MAX (9000) and this module's default marker says
 * "this preview is NOT the whole answer". A lane reading a clipped
 * `question` would therefore be told the wrong column was cut — and this
 * whole module exists because a cut must never be mistakable for something
 * else. A marker that misnames its own field reintroduces exactly that
 * ambiguity, one field over.
 */
export const OWNER_QUESTION_TRUNCATED_MARK = ' …[QUESTION TRUNCATED — ';

export interface OwnerAnswerPreview {
  /** What the caller may show/read: the stored text, or its kept prefix
   *  followed by the truncation marker. */
  text: string;
  /** True when `text` is NOT the whole stored answer. */
  truncated: boolean;
  /** The FULL stored length in code points (never the preview's length). */
  chars: number;
  /** Code points the preview leaves out (0 when not truncated). */
  omitted: number;
}

/**
 * The trailing sentinel a clipped answer carries. Names the lost length AND
 * the two ways to read the rest, so the remedy is in context rather than in
 * a doctrine page the supervisor may not have loaded.
 */
export function ownerAnswerTruncatedMarker(omitted: number): string {
  return `${OWNER_ANSWER_TRUNCATED_MARK}${omitted} chars omitted; this preview is NOT the whole answer. `
    + 'Read the full text with list_owner_questions { ids: ["<this oq_ id>"], fullAnswer: true } '
    + 'or get_chat_messages on this row\'s chatId]';
}

/**
 * The trailing sentinel a clipped QUESTION carries — same remedy text, the
 * correct noun (review finding D1, ticket 9dff565f). The answer marker is
 * left byte-identical on purpose: it is pinned in 18 places by the f94e91eb
 * suite, and renaming it would churn those pins without changing behaviour.
 */
export function ownerQuestionTruncatedMarker(omitted: number): string {
  return `${OWNER_QUESTION_TRUNCATED_MARK}${omitted} chars omitted; this preview is NOT the whole question. `
    + 'Read the full text with list_owner_questions { ids: ["<this oq_ id>"], fullAnswer: true } '
    + 'or get_chat_messages on this row\'s chatId]';
}

/**
 * Build the listing's answer preview. `null` for a missing/empty answer (a
 * row with no answer text has nothing to preview — never a fake empty
 * preview that reads as "the owner said nothing").
 *
 * `opts.full` returns the stored text uncut with `truncated: false` — the
 * caller still gets `chars`, so it can tell a genuinely long answer from a
 * short one even when it asked for everything.
 *
 * `opts.field` picks the sentinel's NOUN so a clipped question is never
 * labelled a clipped answer (ticket 9dff565f review finding D1). Defaults to
 * 'answer', which keeps every existing call site's output byte-identical.
 */
export function ownerAnswerPreview(
  raw: unknown,
  opts: { cap?: number; full?: boolean; field?: 'answer' | 'question' } = {},
): OwnerAnswerPreview | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw);
  if (!s) return null;
  // Code points, so the cap and the marker agree on what a "char" is and no
  // surrogate pair is ever split (a split pair renders U+FFFD).
  const units = Array.from(s);
  const chars = units.length;
  // `cap: null/undefined` means "use the default" — Number(null) is 0, so the
  // old isFinite check silently turned a null cap into a zero-length preview.
  const rawCap = opts.cap;
  const cap = rawCap === null || rawCap === undefined || !Number.isFinite(Number(rawCap))
    ? OWNER_ANSWER_PREVIEW_MAX
    : Math.max(0, Math.floor(Number(rawCap)));
  if (opts.full || chars <= cap) return { text: s, truncated: false, chars, omitted: 0 };
  const omitted = chars - cap;
  const marker = opts.field === 'question'
    ? ownerQuestionTruncatedMarker(omitted)
    : ownerAnswerTruncatedMarker(omitted);
  return {
    text: `${units.slice(0, cap).join('')}${marker}`,
    truncated: true,
    chars,
    omitted,
  };
}

/**
 * The machine-readable fields that ride BESIDE a previewed answer, spread
 * into the row brief. Emitted BEFORE the text in the JSON so that a consumer
 * which only sees part of the envelope still sees whether the text it read
 * was complete.
 *
 * `answerTruncated` is ALWAYS present on a row that goes through here (true OR
 * false, including the no-answer case) — a caller must be able to write
 * `if (row.answerTruncated === false)` and mean it. The whole defect was an
 * ABSENT signal reading as "complete", so an `undefined` here would reproduce
 * it one branch over.
 */
export function ownerAnswerFields(p: OwnerAnswerPreview | null): Record<string, unknown> {
  if (!p) return { answerChars: 0, answerTruncated: false };
  return {
    answerChars: p.chars,
    answerTruncated: p.truncated,
    ...(p.truncated ? { answerOmitted: p.omitted } : {}),
  };
}