/**
 * Session/chat interlinks (feedback b8e1b0a3) — render-time linkification of
 * bare chat/session UUIDs in assistant markdown into clickable deep links to
 * the canonical chat route (/crossmodel?chatId=<uuid>, consumed at
 * app/crossmodel/page.tsx — a coding session and a plain chat are the same
 * entity). The supervisor cites sessions constantly; the owner reads its notes
 * on a phone and wants to tap through.
 *
 * Render-time only (wired in markdown-content.tsx next to
 * normalizeMarkdownForRender): stored content is never mutated, and notes
 * persisted BEFORE this shipped heal at render.
 *
 * ARCHITECTURE (adversarial-review rounds R1–R10): the first cut protected
 * embedding contexts with regexes (code spans, links, autolinks, URLs, emails)
 * — four rounds of whack-a-mole. The R4 redesign inverted to a
 * standalone-token boundary with a hand-rolled fence tracker — SIX more
 * rounds found fence-tracker/parser divergences (info-string closes, run
 * lengths, CRLF, blockquote depth/spelling/spacing, tab column arithmetic,
 * shallower-fence transitions). CommonMark's tab partial-consumption and
 * container grammar are beyond any hand-rolled tracker, so protection is now
 * computed BY THE PARSER THE RENDERER ITSELF USES (remark-parse + remark-gfm
 * — the exact micromark react-markdown runs at markdown-content.tsx):
 * anything the parser puts inside a code / inlineCode / html / link / image /
 * linkReference / imageReference / definition node is a protected range —
 * parser-parity BY CONSTRUCTION, so a UUID inside fenced/indented code, code
 * spans, URLs, autolinks, emails, link titles/destinations, reference
 * definitions or raw HTML is never rewritten. Outside those ranges a UUID is
 * linkified ONLY as a standalone token (left: start-of-line/whitespace/'|';
 * right: end-of-line/whitespace/'|'/trail punctuation .,;:!? followed by
 * whitespace/EOL — the GFM trail-strip set, review B9) — the failure
 * direction everywhere is a conservative miss, never corruption.
 *
 * Deliberately FULL-UUID only: a bare 8-hex short id collides with git SHAs
 * and cannot be resolved client-side. The supervisor prompt rule (same
 * ticket) makes the model emit titled links with full ids; this pass is the
 * deterministic backstop for bare full UUIDs wherever they appear.
 */

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';

/** Canonical chat deep-link route (app/crossmodel/page.tsx reads ?chatId=;
 *  served at the root since 2026-10-14 — proxy.ts rewrites / → /crossmodel and
 *  308s a document load of the legacy /crossmodel URL to its clean twin). */
export const CHAT_DEEP_LINK = '/?chatId=';

/** In-app routes a transcript link may point at: the clean paths (2026-10-14)
 *  AND the legacy /crossmodel… form older stored messages and agent doctrine
 *  still emit. Same-tab navigation targets — never /api/… downloads. */
const INTERNAL_APP_LINK_RE = /^\/(?:crossmodel(?:[/?#]|$)|\?|(?:account|files|management|profile|projects|instances|shared)(?:[/?#]|$))/;
export function isInternalAppLink(href: unknown): href is string {
  return typeof href === 'string' && INTERNAL_APP_LINK_RE.test(href);
}

/** Standalone-token UUID: whitespace/pipe/line-edge bounded; trail punctuation
 *  counts only when followed by whitespace/EOL (review B9: '<uuid>.csv' and
 *  '<uuid>:8080' are plain tokens, not sentence punctuation). */
const UUID_TOKEN_RE =
  /(?<=^|[\s|])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=$|[\s|]|[.,;:!?](?=$|[\s|]))/gim;

/** mdast node types whose entire span is protected from linkification — the
 *  parser's own code/link/HTML grammar does what ten rounds of regex review
 *  proved a hand-rolled tracker cannot. */
const PROTECTED_TYPES = new Set([
  'code', // fenced AND indented code blocks (every R5–R10 fence shape)
  'inlineCode', // code spans incl. multi-word and double-backtick
  'html', // raw HTML blocks/inline
  'link',
  'image',
  'linkReference',
  'imageReference',
  'definition', // reference-style link definitions (R4-B7 refdef surface)
]);

export type OffsetRange = readonly [number, number];

/** Parse `text` with the renderer's own parser and collect protected ranges
 *  (code, links, images, raw HTML, refdefs). Shared with the worktree-path
 *  linkifier (lib/worktree-links.ts) so both rewrite outside the same spans. */
export function protectedRanges(text: string): OffsetRange[] {
  const tree = fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const ranges: OffsetRange[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (
      PROTECTED_TYPES.has(node.type) &&
      node.position?.start?.offset != null &&
      node.position?.end?.offset != null
    ) {
      ranges.push([node.position.start.offset, node.position.end.offset]);
      return; // children of a protected node are inside its span
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return ranges;
}

/**
 * Rewrite standalone-token full UUIDs into [short-id](/crossmodel?chatId=<uuid>)
 * links. Idempotent (the generated link is itself a protected link node on the
 * next pass). Embedded UUIDs never match: the boundary rule rejects them, and
 * anything the parser calls code/link/HTML is protected outright.
 */
export function linkifySessionRefs(text: string): string {
  UUID_TOKEN_RE.lastIndex = 0;
  if (!text || !UUID_TOKEN_RE.test(text)) return text;
  UUID_TOKEN_RE.lastIndex = 0;
  const ranges = protectedRanges(text);
  return text.replace(UUID_TOKEN_RE, (match: string, _id: string, offset: number) => {
    if (ranges.some(([s, e]) => offset >= s && offset < e)) return match;
    const id = match.toLowerCase();
    return `[${id.slice(0, 8)}](${CHAT_DEEP_LINK}${id})`;
  });
}
