/**
 * parent-context-block.ts — the [PARENT SESSION CONTEXT] digest block: shared
 * header + STRICT grammar stripper (ticket 161d39e9).
 *
 * Zero-import LEAF (the agent-send-header.ts / run-outcome-line.ts pattern) so
 * every consumer can use it statically with no cycle risk, and so test files
 * that whole-module-mock run-journal.service (its writer functions reach
 * prisma + the utility LLM) still get the REAL parser — the executor's title
 * seed depends on it.
 *
 * The digest block is what platform-tools' start_coding_session prepends to a
 * spawned child's first prompt as `${block}\n\n${prompt}`
 * (run-journal.service buildParentContextBlock): the PARENT's newest
 * run-journal entries — goal → OUTCOME lines. Two consumers:
 *   1. pending-confirmations' staged-prompt moot check (ticket ba41858d):
 *      the staged prompt is the exact SUFFIX of the delivered first message,
 *      verified by STRICTLY stripping the digest — never a bare endsWith
 *      (adversarial-reviewer finding D-F1: a staged 'continue' matched a child
 *      whose real first prompt was 'Review the migration first.\n\ncontinue').
 *   2. the coding executor's title-seed derivation (ticket 161d39e9): a
 *      spawned child's first prompt opens with the parent's run OUTCOMES, so a
 *      title seeded from the raw message names the parent's last verdict
 *      ("post-sweep acceptance criteria verified", session 11449a0a) instead of
 *      the child's TASK. The seed strips the digest first.
 */

/** Position-0 header literal of the digest block. */
export const PARENT_CONTEXT_BLOCK_HEADER =
  '[PARENT SESSION CONTEXT — what the session that spawned you recently did, decided, and learned; newest first]';

/**
 * Strictly strip a leading [PARENT SESSION CONTEXT] digest block by its own
 * line grammar — the header line, then entry lines ('- <date>: …' with
 * optional '  Decisions: …' / '  Failures: …' continuations, the last one
 * possibly '…'-cap-truncated), then exactly one blank separator line — and
 * return the prompt that follows. null when the shape doesn't parse (caller
 * keeps the text untouched — the moot check fails OPEN, the title seed falls
 * back to the header-stripped text).
 */
/** True iff lines[i] is a digest ENTRY line: an entry ('- '), a continuation
 * ('  Decisions: ' / '  Failures: '), the end of the array — or (reviewer N1,
 * ticket 161d39e9) a line '…'-cut SHORT by buildParentContextBlock's
 * PARENT_CONTEXT_BLOCK_CAP trim: the cap slices mid-line, so the truncated
 * tail reads e.g. '  Decisio…' or 'd criteria verified across 371 cases…' and
 * a prefix-matching grammar would never close — the parent's OUTCOME line then
 * led every title seed. Any trailing-'…' line inside the block therefore
 * closes the scan (it can only be the cap-cut tail of the LAST entry). */
function isDigestEntryLine(lines: string[], i: number): boolean {
  if (i >= lines.length) return false;
  const l = lines[i];
  return l.startsWith('- ') || l.startsWith('  Decisions: ') || l.startsWith('  Failures: ') || l.endsWith('…');
}

export function stripParentContextBlock(body: string): string | null {
  if (!body.startsWith(PARENT_CONTEXT_BLOCK_HEADER)) return null;
  const lines = body.split('\n');
  let i = 1; // lines[0] is the header
  while (isDigestEntryLine(lines, i)) i++;
  if (i >= lines.length || lines[i] !== '') return null; // no blank separator → not chrome-shaped
  return lines.slice(i + 1).join('\n');
}

/**
 * Lenient digest strip for TITLE SEEDS (ticket 161d39e9): locate the digest
 * header ANYWHERE in the leading chrome region and cut through its blank
 * separator, returning the remainder. The delivered first message can be
 * `${digest}\n\n${task}` (spawned child), `[firing-header]\n\n${digest}\n\n${task}`
 * (schedule-delivered), or `[agent-send-header]\n\n${digest}\n\n${task}` — and
 * a position-0-only parse misses the last two (the firing/agent-send header
 * sits first, and a headers-first strip would eat the digest's own header
 * line and strand its OUTCOME body in the seed). Not grammar-shaped → the
 * text is returned UNCHANGED (a task brief that merely resembles the digest
 * is never mangled).
 */
export function stripParentContextDigest(body: string): string {
  const text = typeof body === 'string' ? body : '';
  const lines = text.split('\n');
  // Locate the digest header LINE anywhere (the strict position-0 stripper
  // misses firing/agent-send-header-delivered prompts). startsWith, not
  // equality: the header line could theoretically carry trailing text.
  const h = lines.findIndex(l => l.startsWith(PARENT_CONTEXT_BLOCK_HEADER));
  if (h === -1) return text;
  let i = h + 1;
  while (isDigestEntryLine(lines, i)) i++;
  // Grammar must close (entry lines then exactly one blank separator); text
  // BEFORE the digest header line is kept (leading chrome is stripped by the
  // caller's header pass afterwards). A non-matching shape returns the text
  // UNCHANGED — a task brief that merely resembles the digest is never mangled.
  if (i >= lines.length || lines[i] !== '') return text;
  return [...lines.slice(0, h), ...lines.slice(i + 1)].join('\n');
}
