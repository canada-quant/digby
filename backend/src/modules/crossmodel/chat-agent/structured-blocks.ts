/**
 * Ticket 2ce29c32 (2026-08-31): a chat-agent run's intermediate turn text is
 * never persisted as transcript rows — the one durable assistant row's
 * `content` carries only the FINAL turn's text (coding/agent.ts overwrites
 * finalText per turn), and every machine-facing surface reads `content` only:
 * get_chat_messages (platform.service.ts), the next-run history loader
 * (context.service.ts), and the run_completed hook summary
 * (chat-agent.service.ts). A [DISPATCH-NEEDED] block posted mid-run is
 * therefore invisible to every machine reader — 2026-08-31: a CanLaw
 * cross-lane dispatch sat ~1h unseen until the lane re-posted it in its final
 * message. The blocks DO survive in the row's `parts` JSON, but only the
 * transcript UI renders those.
 *
 * collectStructuredBlocks scans a run's text parts for tagged machine-
 * actionable blocks missing from finalText and returns them verbatim (capped)
 * so the persisted content can carry them forward. Pure, leaf module (no
 * imports) so it is unit-testable without the service's import graph.
 */

/** Tags whose blocks must survive into the durable content column. Keep this
 * list narrow — only cross-lane, machine-actionable markers; promoting prose
 * would flood the history loader's context budget. */
const STRUCTURED_BLOCK_TAGS = ['DISPATCH-NEEDED'] as const;

/**
 * The label line of the carried-forward section the finalize appends to a persisted note (ticket 835595b7):
 * the section is the row's LAST paragraph — get_chat_messages keeps a long row's tail for it — so the stored
 * note's other trailers (the supervisor harness appendix) sit in front of it.
 */
export const CARRIED_FORWARD_LABEL = "_Carried forward from this run's mid-turn output (machine-actionable blocks):_";

/** One malformed/oversized block must not flood the durable row. */
const MAX_BLOCK_CHARS = 1500;
/** Total carried-forward cap — keeps the history-loader context budget bounded. */
const MAX_CARRIED_CHARS = 3000;

const collapseWs = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Extract every tagged block from one text part. A block runs from its
 * header line (`[TAG]` or `[TAG — …]`, optionally bold-wrapped) to the first
 * horizontal rule (the fleet convention wraps dispatch sections in `---`
 * rules) or the end of the part, whichever first.
 *
 * Fence/indent state is tracked across the part (F1, ticket 835595b7): a
 * header line inside a ``` fenced block or 4-space/tab-indented code is the
 * model QUOTING a block, not posting one — promoting it would inject a fake
 * dispatch into durable machine-readable content. The same state guards
 * hr-termination: a `---` inside quoted code does not end a real block.
 * `***`/`___` rules deliberately do NOT terminate (F3, by design — `---` is
 * the fleet convention; the per-block cap bounds the overrun). CRLF line
 * endings are tolerated on the rule line (F2 — `---\r` terminates).
 *
 * Accepted residuals (adversarial review of the fix, non-blocking): (a) an
 * UNCLOSED fence before a real header suppresses the carry for the rest of
 * the part — CommonMark-defensible, and quote protection beats the rare
 * unclosed-fence false negative; (b) ~~~ tilde fences are not tracked (the
 * fleet convention is backtick fences) — a tilde-quoted header is still
 * promoted. */
function extractBlocks(text: string, tag: string): string[] {
  const header = new RegExp(`^[ \\t]*(?:\\*\\*)?\\[${tag}(?:[\\]\\s—-]|$)`);
  const rule = /^[ \t]*-{3,}[ \t]*\r?$/;
  const fence = /^[ \t]*```/;
  const indent = /^(?: {4}|\t)/;
  const out: string[] = [];
  let inFence = false;
  let buf: string[] | null = null;
  const flush = () => {
    if (!buf) return;
    const block = buf.join('\n').trim();
    if (block) out.push(block);
    buf = null;
  };
  for (const line of text.split('\n')) {
    if (fence.test(line)) {
      inFence = !inFence;
      if (buf) buf.push(line); // fence markers inside a real block stay verbatim
      continue;
    }
    const quoted = inFence || indent.test(line);
    if (!quoted && buf && rule.test(line)) { flush(); continue; }
    if (!quoted && !buf && header.test(line)) { buf = [line]; continue; }
    if (buf) buf.push(line);
  }
  flush();
  return out;
}

/**
 * Return the tagged blocks present in `parts` but absent from `finalText`,
 * joined by a blank line (verbatim, order of appearance). '' when there is
 * nothing to carry. A block already in finalText (the self-audit re-post
 * pattern) or already captured from an earlier part is never duplicated.
 */
export function collectStructuredBlocks(
  parts: ReadonlyArray<{ type?: string; text?: unknown }> | null | undefined,
  finalText: string,
): string {
  if (!parts?.length) return '';
  const finalNorm = collapseWs(finalText || '');
  const seen = new Set<string>();
  const carried: string[] = [];
  let total = 0;
  for (const part of parts) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    for (const tag of STRUCTURED_BLOCK_TAGS) {
      for (const raw of extractBlocks(part.text, tag)) {
        const norm = collapseWs(raw);
        if (!norm || finalNorm.includes(norm) || seen.has(norm)) continue;
        seen.add(norm);
        const block = raw.length > MAX_BLOCK_CHARS
          ? `${raw.slice(0, MAX_BLOCK_CHARS)}\n…[truncated]`
          : raw;
        if (total + block.length > MAX_CARRIED_CHARS) return carried.join('\n\n');
        carried.push(block);
        total += block.length;
      }
    }
  }
  return carried.join('\n\n');
}
