/**
 * Clickable references in answers (owner 2026-10-08: "interlink more … always having session goals or ids linked so
 * user can just click session fbb5c9ca and it brings them there").
 *
 * Supervisor and lane answers cite things by an 8-char id prefix — "session fbb5c9ca", "goal 534c37aa",
 * "todos 536d5d52, 23014278, 63a8404a", "receipt b3649334". A bare 8-hex token is ambiguous (git shas look the
 * same — lib/session-links.ts stays full-UUID only), so this pass links an id ONLY when a noun names what it is:
 * the noun stays prose, each id after it becomes `[id](#ref:<kind>:<id>)`, which markdown-content renders as an
 * EntityRefChip. On click the chip asks the server where that id lives (GET /api/crossmodel/refs/:kind/:id —
 * owner-scoped, backend entity-refs.ts) and opens it. Code spans, links and raw HTML are never rewritten
 * (protectedRanges — the renderer's own parser, shared with session-links).
 *
 * The NEXT_PUBLIC_ENTITY_REFS_DISABLED release switch was deleted 2026-10-30 (RSW-1
 * delete-with-ledger: two release lifetimes baked and inert in prod — the build arg never
 * reached a prod image): the always-on behavior is the only one.
 */

import { protectedRanges } from './session-links';

export type EntityRefKind = 'chat' | 'session' | 'goal' | 'todo' | 'receipt';

export const ENTITY_REF_HREF_PREFIX = '#ref:';

/** Noun → kind. Plurals and the lane / sub-session spellings the fleet uses all open a chat. */
function kindFor(noun: string): EntityRefKind | null {
  const n = noun.toLowerCase().replace(/-/g, '');
  if (/^(sessions?|subsessions?|lanes?)$/.test(n)) return 'session';
  if (/^chats?$/.test(n)) return 'chat';
  if (/^goals?$/.test(n)) return 'goal';
  if (/^todos?$/.test(n)) return 'todo';
  if (/^receipts?$/.test(n)) return 'receipt';
  return null;
}

const ID = '[0-9a-f]{8}';
const SEP = String.raw`(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*\/\s*|\s*&\s*)`;
/** noun [id(s)] [:] id (sep id)* — the id is a whole 8-hex token (not the head of a uuid / longer hex / word). */
const REF_RE = new RegExp(
  String.raw`(?<![\w-])(sub-?sessions?|sessions?|lanes?|chats?|goals?|todos?|receipts?)((?:\s+ids?)?\s*:?\s+)(${ID}(?:${SEP}${ID})*)(?![0-9a-z_-])`,
  'gi',
);
const ID_IN_LIST_RE = new RegExp(`${ID}(?![0-9a-z_-])`, 'gi');

/** Rewrite "noun <8-hex>[, <8-hex>…]" outside code/links into `#ref:` links. Idempotent (a link is protected). */
export function linkifyEntityRefs(text: string): string {
  if (!text) return text;
  REF_RE.lastIndex = 0;
  if (!REF_RE.test(text)) return text;
  REF_RE.lastIndex = 0;
  const ranges = protectedRanges(text);
  return text.replace(REF_RE, (match: string, noun: string, gap: string, ids: string, offset: number) => {
    if (ranges.some(([s, e]) => offset >= s && offset < e)) return match;
    const kind = kindFor(noun);
    if (!kind) return match;
    const linked = ids.replace(ID_IN_LIST_RE, (id: string) => `[${id.toLowerCase()}](${ENTITY_REF_HREF_PREFIX}${kind}:${id.toLowerCase()})`);
    return `${noun}${gap}${linked}`;
  });
}

/** `#ref:<kind>:<id>` → its parts, or null. */
export function parseEntityRefHref(href: unknown): { kind: EntityRefKind; id: string } | null {
  if (typeof href !== 'string' || !href.startsWith(ENTITY_REF_HREF_PREFIX)) return null;
  const m = /^#ref:(chat|session|goal|todo|receipt):([0-9a-f]{8,36})$/.exec(href);
  return m ? { kind: m[1] as EntityRefKind, id: m[2] } : null;
}

/** A full chat deep link (/?chatId=<uuid>, or the legacy /crossmodel?chatId=<uuid>) → the uuid, or null. */
export function chatIdFromDeepLink(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const m = /^\/(?:crossmodel)?\?chatId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(href);
  return m ? m[1].toLowerCase() : null;
}
