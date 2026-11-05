/**
 * Pure detectors for the hourly framework-signal sweep.
 *
 * Marker hits are judged on the text a chat renderer would still show.
 * `stripForStorage` and the SEND_EMAIL rule are copies of the frontend
 * (`plain-session.ts` stripForStorage, `code-transcript.tsx` parseEmailDraft /
 * extractEmailAttr). Saved parts always contain the raw block; a well-formed
 * closed draft is stripped before display and must not flag.
 *
 * MARKER ALLOWLIST (ticket d6fdc1df): only tags the chat renderer REALLY
 * handles are detected — SEND_EMAIL, CANVAS, FOLLOWUPS (frontend
 * `markdown-normalize.ts` + `plain-session.ts` strip exactly these three
 * families). A generic `[A-Z_]{4,}` scan flagged harness blocks ([HARNESS …]
 * evidence-guard), vault handles ([SECRET n]) and [REDACTED…] placeholders as
 * "survived markers" and flooded the feedback queue; a bracketed capitalised
 * word with no renderer is out of scope by definition — it cannot "survive
 * renderer cleaning" because no renderer was ever supposed to consume it.
 */

import { detectOwnerCardPayloadGaps } from '../platform/owner-card-gaps';
import { redactInboundSecrets } from '../platform/secret-scan';

export type MarkerReason = 'unclosed' | 'no valid to' | 'no renderer';

export interface MarkerHit {
  chatId: string;
  messageId: string;
  marker: string;
  reason: MarkerReason;
  high: boolean;
}

export interface IncompleteCardHit {
  questionId: string;
  contextLength: number;
}

export interface AdminTurn {
  id: string;
  chatId: string;
  content: string;
  createdAt: Date | string;
  /**
   * e7c533d3: persisted message metadata (CrossModelMessage.metadata). The
   * frustration detector reads the OWNER's words; a machine wake or an
   * inter-agent relay is not them even though both persist as role:'user'
   * rows. Optional so existing tests (plain AdminTurn literals) still type.
   */
  metadata?: unknown;
}

export interface FrustrationHit {
  chatId: string;
  userMessageId: string;
  assistantMessageId: string | null;
  excerpt: string;
}

interface SegmentHit {
  index: number;
  marker: string;
  raw: string;
  unclosedSpan: boolean;
}

/**
 * Frontend `stripForStorage` — preserves `[SEND_EMAIL]`.
 *
 * Ticket 868902f9: the CANVAS rules must mirror
 * `frontend/app/crossmodel/plain-session.ts` L33-L35 EXACTLY, all three of
 * them. The third rule — an UNTERMINATED `[CANVAS…]` opener strips to
 * end-of-string — was missing here, so the detector kept text the renderer
 * deletes and convicted a message whose only offense was tail prose reading
 * "…the draft contains no [CANVAS] or" (a truncated model turn). The renderer
 * shows `…the draft contains no `; nothing survives, nothing should fire.
 * A detector that is stricter than the renderer files a ticket for a marker
 * the user never sees — the exact "no renderer" flood class d6fdc1df removed
 * for other tags. Keep this list in sync with plain-session.ts; the
 * DETECTOR-RECALL REPLAY test replays it against the real renderer.
 *
 * Closed canvas keeps the inner text (so a nested marker is still scanned);
 * an unterminated opener deletes the tail, exactly like the renderer.
 */
export function stripForStorage(text: string): string {
  if (!text) return '';
  return text
    .replace(/\[CANVAS:[^\]]+\]([\s\S]*?)\[\/CANVAS\]/gi, '$1')
    .replace(/\[CANVAS\b[^\]]*\]([\s\S]*?)\[\/CANVAS\]/gi, '$1')
    .replace(/\[CANVAS[^\]]*\][\s\S]*/gi, '')
    .replace(/\[FOLLOWUPS\][\s\S]*?\[\/FOLLOWUPS\]/gi, '')
    .replace(/\[FOLLOWUPS\][\s\S]*$/gi, '')
    // Ticket 7af42393 — ORPHAN CLOSERS, mirrored from the renderer
    // (plain-session.ts stripForStorage/stripLiveTags). Every rule above keys
    // on the LITERAL opener, so a closer whose opener the model botched
    // survives to the reader. Specimen (chat 9430e12f, msg 6a8f46bc): a
    // misspelled, spaced opener `[ FOLOWUPS ]` (ONE L) followed by a correctly
    // spelled `[/FOLLOWUPS]` — no opener rule matched, the closer rendered
    // verbatim, and this detector was RIGHT to convict it. The renderer now
    // deletes the orphan token; this copy must delete it too, or the detector
    // stays stricter than the renderer and refills the queue with markers no
    // user can see (the d6fdc1df flood class). Keep the FOLLOWUPS rules
    // byte-identical with plain-session.ts — that pair IS the mirror contract.
    // (The CANVAS rules above are deliberately NOT identical: this copy keeps
    // the inner text via `$1` so a nested marker is still scanned, while the
    // renderer deletes it. See the doc block above.) Scope matches the
    // renderer exactly: FOLLOWUPS-only. A `[/CANVAS]` closer is the LAST
    // canvas shape that still reaches a reader, so stripping it would retire
    // canvas detection outright (its own decision, on its own evidence).
    .replace(/\[\/FOLLOWUPS\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Frontend `extractEmailAttr`: quoted value, then unquoted. */
export function extractEmailAttr(attrs: string, name: string): string {
  // `to = "..."` (spaces around =) is not a usable attribute — it survives
  // cleaning and is flagged. Only a glued `to="..."` strips.
  const quoted = new RegExp(`${name}=['"“‘]([\\s\\S]*?)['"”’]`, 'i').exec(attrs);
  if (quoted) return quoted[1];
  const unquoted = new RegExp(`${name}=([^\\s\\]'"“‘]+)`, 'i').exec(attrs);
  return unquoted ? unquoted[1] : '';
}

/**
 * Text after the renderer. A first closed `[SEND_EMAIL]` with a non-empty
 * `to` is stripped (closed blocks and an unterminated tail). An empty `to`
 * (including `to=""`) or no closed match leaves the stored text, so a
 * malformed block still survives.
 */
export function displayedAfterRenderer(text: string): string {
  const stored = stripForStorage(text);
  // Case-sensitive: a lowercase `[send_email …]` is not the tag the renderer
  // strips, so it survives and is flagged. A glued non-empty `to` strips.
  const match = stored.match(/\[SEND_EMAIL\b([^\]]*)\]([\s\S]*?)\[\/SEND_EMAIL\]/);
  if (!match) return stored;
  const to = extractEmailAttr(match[1] || '', 'to');
  if (!to) return stored;
  return stored
    .replace(/\[SEND_EMAIL\b[^\]]*\][\s\S]*?\[\/SEND_EMAIL\]/g, '')
    .replace(/\[SEND_EMAIL\b[\s\S]*$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function markerName(raw: string): string {
  const m = /^\[\/?([A-Za-z_]+)/.exec(raw);
  return (m?.[1] ?? '').toUpperCase();
}

/**
 * The only marker names the sweep flags (ticket d6fdc1df): a marker "survives
 * renderer cleaning" only when a renderer EXISTS for it. Frontend strip rules
 * (`markdown-normalize.ts` L72, `plain-session.ts` stripForStorage) handle
 * exactly these three families — anything else ([HARNESS …] evidence-guard
 * blocks, [SECRET n] vault handles, [REDACTED…] placeholders, [IMPORTANT] /
 * [TODO] prose) is ordinary bracketed text the renderer never consumes, so
 * flagging it files a ticket per chat per hour. Verified against the
 * renderer, not guessed.
 */
const RENDERER_MARKER_NAMES: ReadonlySet<string> = new Set(['SEND_EMAIL', 'CANVAS', 'FOLLOWUPS']);

function scanSegment(segment: string): SegmentHit[] {
  const hits: SegmentHit[] = [];
  const taken = new Set<number>();
  // d6fdc1df: named-only scan. The generic `/\[\/?([A-Z_]{4,})\b[^\]\[]*\]/`
  // pass (any bracketed capitalised word) produced the Raw-marker ticket
  // flood — it has no renderer contract to violate, so it is gone entirely.
  // RENDERER_MARKER_NAMES is the allowlist; keep the two in sync.
  const named = new RegExp(
    `\\[\\/?(${[...RENDERER_MARKER_NAMES].join('|')})\\b[^\\]\\[]*\\]`,
    'gi',
  );
  let m: RegExpExecArray | null;
  while ((m = named.exec(segment))) {
    taken.add(m.index);
    hits.push({
      index: m.index,
      marker: markerName(m[0]),
      raw: m[0],
      unclosedSpan: false,
    });
  }
  // `[CANVAS title[WIDGET]` never closes its own bracket — WIDGET's `]` is
  // the first one, so the outer opener eats it. SEND_EMAIL is not this path
  // (`[SEND_EMAIL to="x" [WIDGET]` stays WIDGET-only).
  const eaten = /\[CANVAS\b[^[\]]*\[/g;
  while ((m = eaten.exec(segment))) {
    const rest = segment.slice(m.index);
    const closeBracket = rest.indexOf(']');
    if (closeBracket < 0) continue;
    const end = m.index + closeBracket;
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i];
      if (h.index >= m.index && h.index <= end) {
        taken.delete(h.index);
        hits.splice(i, 1);
      }
    }
    taken.add(m.index);
    hits.push({
      index: m.index,
      marker: 'CANVAS',
      raw: rest.slice(0, closeBracket + 1),
      unclosedSpan: true,
    });
  }
  const unclosed = /\[SEND_EMAIL/gi;
  while ((m = unclosed.exec(segment))) {
    const rest = segment.slice(m.index);
    if (rest.includes(']')) continue;
    hits.push({
      index: m.index,
      marker: 'SEND_EMAIL',
      raw: rest,
      unclosedSpan: true,
    });
  }
  return hits;
}

const REASON_RANK: Record<MarkerReason, number> = {
  'no valid to': 3,
  unclosed: 2,
  'no renderer': 1,
};

function betterReason(a: MarkerReason, b: MarkerReason): MarkerReason {
  return REASON_RANK[a] >= REASON_RANK[b] ? a : b;
}

function classify(marker: string, raws: SegmentHit[]): { reason: MarkerReason; high: boolean } {
  if (marker !== 'SEND_EMAIL') return { reason: 'no renderer', high: false };
  const openings = raws.filter((r) => !r.unclosedSpan && r.raw.includes(']') && !r.raw.startsWith('[/'));
  const closes = raws.filter((r) => r.raw.startsWith('[/'));
  let reason: MarkerReason = 'unclosed';
  if (
    openings.length > 0 &&
    closes.length > 0 &&
    openings.some((r) => {
      // A lowercase closed block is not a stripped tag even when it contains to=.
      if (!r.raw.startsWith('[SEND_EMAIL')) return true;
      const attrs = (/^\[SEND_EMAIL\b([^\]]*)\]/.exec(r.raw)?.[1]) || '';
      return !extractEmailAttr(attrs, 'to');
    })
  ) {
    reason = 'no valid to';
  }
  const literalTo = raws.some((r) => r.raw.toLowerCase().includes('to='));
  // A closed block with no usable glued `to` is high (subject-only). Spaced
  // `to =` is not a surviving to= and stays ordinary.
  const high =
    literalTo ||
    (reason === 'no valid to' &&
      openings.some((r) => r.raw.startsWith('[SEND_EMAIL') && !/to\s+=/i.test(r.raw)));
  return { reason, high };
}

function groupHits(hits: SegmentHit[]): Map<string, SegmentHit[]> {
  const grouped = new Map<string, SegmentHit[]>();
  for (const hit of hits) {
    const list = grouped.get(hit.marker);
    if (list) list.push(hit);
    else grouped.set(hit.marker, [hit]);
  }
  return grouped;
}

function textParts(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  const out: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const row = part as { type?: unknown; text?: unknown };
    if (row.type === 'text' && typeof row.text === 'string') out.push(row.text);
  }
  return out;
}

export function findSurvivingMarkers(input: {
  chatId: string;
  messageId: string;
  content: string | null;
  parts: unknown;
}): MarkerHit[] {
  const texts = [input.content ?? '', ...textParts(input.parts)];
  const byMarker = new Map<string, MarkerHit>();
  for (const text of texts) {
    const displayed = displayedAfterRenderer(text);
    const segments = displayed.split('```');
    for (let i = 0; i < segments.length; i += 2) {
      for (const [marker, raws] of groupHits(scanSegment(segments[i] ?? ''))) {
        const { reason, high } = classify(marker, raws);
        const prev = byMarker.get(marker);
        if (!prev) {
          byMarker.set(marker, {
            chatId: input.chatId,
            messageId: input.messageId,
            marker,
            reason,
            high,
          });
        } else {
          prev.high = prev.high || high;
          prev.reason = betterReason(prev.reason, reason);
        }
      }
    }
  }
  return [...byMarker.values()];
}

/** Keyword in the question plus a short context. `consoleAction` is not the signal. Length is raw — not trimmed. */
const CARD_RE = /below|paste|steps|instructions/i;

export function findIncompleteCards(
  rows: Array<{ id: string; question: string; context: string | null; consoleAction?: unknown; options?: unknown; optionalAsk?: unknown; expectedAnswerType?: unknown }>,
): IncompleteCardHit[] {
  const out: IncompleteCardHit[] = [];
  for (const row of rows) {
    if (!CARD_RE.test(row.question ?? '')) continue;
    // Ticket 84b11946: a consoleAction card composes its four-element body
    // (ask + what/why-safe + "Paste exactly this" payload + click-by-click
    // steps) INTO the question column (owner-questions composeConsoleActionBody),
    // so its `context` column is empty BY DESIGN — the platform's own
    // completeness admission (detectOwnerCardPayloadGaps) rules the class
    // "complete by construction". Specimen oq_2dfb9e9a: the owner received
    // the full paste payload and click-through steps (dismissal echo quotes
    // them verbatim) and self-served the grant 25 min later. The CARD_RE cue
    // matched the composed body's own "Paste exactly this"/"Click by click"
    // headings — a pure false positive. `consoleAction` (the stored Json
    // spec) is not the incompleteness signal; a PRESENT spec is the skip.
    if (row.consoleAction !== undefined && row.consoleAction !== null) continue;
    // Ticket 65cfec1b (the sibling specimen 84b11946's replay test deferred
    // here): a NON-consoleAction card can still carry its full payload
    // inline — background, the exact move, typed options, even the fallback
    // "paste this output" commands — in the question body. Specimen
    // oq_6c37a254: a 1418-char self-contained ask (3 typed options,
    // expectedAnswerType 'choice') the owner ANSWERED via chosenOption
    // 'restarted' 35 minutes after filing; the cue matched the ask's own
    // fallback instructions and the context column was empty because
    // nothing needed it. The sweep now defers to the platform's OWN
    // write-time admission (detectOwnerCardPayloadGaps, moved to the shared
    // pure leaf owner-card-gaps.ts): a card that admission rules COMPLETE
    // never files a ticket — one definition of "complete", two enforcement
    // points. Cards the admission rules incomplete (background and/or
    // options missing) still flag under the old length rule.
    const gaps = detectOwnerCardPayloadGaps({
      question: row.question ?? '',
      context: row.context,
      options: row.options,
      // Ticket 90a5b127: the flagger's typed optional-ask declaration and
      // the declared answer type are STRUCTURE, not prose — the sweep
      // applies the same admission the write-time path does.
      optionalAsk: row.optionalAsk === true ? true : row.optionalAsk === false ? false : null,
      expectedAnswerType: typeof row.expectedAnswerType === 'string' ? row.expectedAnswerType : null,
    });
    if (gaps.length === 0) continue;
    const contextLength = (row.context ?? '').length;
    if (contextLength < 40) out.push({ questionId: row.id, contextLength });
  }
  return out;
}

/**
 * Secret-shaped spans only. Log normalization applies the rest afterwards.
 * 2026-10-19: runs the SHARED scanner first (platform/secret-scan — every
 * provider key shape, credential assignments, app passwords); the three
 * original patterns stay as a backstop. The owner-frustration excerpt this
 * cleans lands verbatim in a ticket description.
 */
export function lightRedact(text: string): string {
  return redactInboundSecrets(text)
    .replace(/sk-[A-Za-z0-9]+/g, 'sk-<redacted>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/(api_key|token|secret|password)\s*=\s*\S+/gi, '$1=<redacted>');
}

// d6fdc1df: the log-signature detectors (findRecurringLogSignatures,
// evaluateLogGroup, groupLogEvents, normalizeLogMessage, logFingerprint,
// parseWindowMs) were REMOVED from this module — the framework sweep no
// longer reads logs at all; log-signal-sweep.service.ts is the one owner of
// log signal detection. Do not re-wire log scanning here.

export function pairAdminTurns(
  users: AdminTurn[],
  assistants: AdminTurn[],
): Array<{ user: AdminTurn; assistant: AdminTurn | null }> {
  return users.map((user) => {
    const userAt = +new Date(user.createdAt);
    const candidates = assistants.filter(
      (assistant) => assistant.chatId === user.chatId && +new Date(assistant.createdAt) < userAt,
    );
    candidates.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    return { user, assistant: candidates[0] ?? null };
  });
}

const FRUSTRATION_SOURCE =
  "frustrat|annoying|you didn'?t give|doesn'?t give me|still broken|broken again|why do i have to";

/**
 * metadata.origin stamps that mark a role:'user' row as machine-sent —
 * byte-parity with the backend's canonical noise set (fleet.service.ts
 * MACHINE_ORIGINS: 'schedule' | 'hook' | 'machine' | 'agent' | 'webhook'),
 * which frontend/lib/machine-wake.ts MACHINE_STAMP_ORIGINS mirrors. If either
 * canonical set changes, this MUST change with it or the sweep and the fleet
 * thread diverge on the same row (the stripForStorage discipline above).
 */
const MACHINE_ORIGINS = new Set(['schedule', 'hook', 'machine', 'agent', 'webhook']);

/** Position-0 provenance header of an inter-agent relay (platform/agent-send-header.ts AGENT_SEND_PREFIX). */
const AGENT_SEND_PREFIX = '[AGENT-SENT MESSAGE';

/**
 * True iff a "user" turn was written by the platform or another agent, not the
 * human. Two independent signals, mirroring frontend isMachineWakeEnvelope /
 * isSystemRow (machine-wake.ts): a machine origin stamp on the row's metadata,
 * OR a content prefix no human message starts with (the machine wake envelope,
 * the agent-send header). Content-prefix alone is enough — the frontend's
 * mapStoredMessages historically DROPPED metadata.origin via a pick-list, so
 * rows exist with the stamp missing; the prefix survives any metadata loss.
 * Deliberately NOT matched: a prefix occurring mid-string (an owner quoting a
 * wake is still the owner), or absent metadata with plain text (always human).
 */
function isMachineSentTurn(turn: { content?: string | null; metadata?: unknown }): boolean {
  const meta = turn.metadata;
  if (meta && typeof meta === 'object' && MACHINE_ORIGINS.has((meta as { origin?: unknown }).origin as string)) {
    return true;
  }
  const content = typeof turn.content === 'string' ? turn.content : '';
  return content.startsWith('[MACHINE-TRIGGERED RUN') || content.startsWith(AGENT_SEND_PREFIX);
}

export function findOwnerFrustration(users: AdminTurn[], assistants: AdminTurn[]): FrustrationHit[] {
  const re = new RegExp(FRUSTRATION_SOURCE, 'i');
  const hits: FrustrationHit[] = [];
  for (const user of users) {
    if (isMachineSentTurn(user)) continue;
    if (!re.test(user.content ?? '')) continue;
    const paired = pairAdminTurns([user], assistants)[0];
    hits.push({
      chatId: user.chatId,
      userMessageId: user.id,
      assistantMessageId: paired?.assistant?.id ?? null,
      excerpt: lightRedact(user.content ?? '').slice(0, 200),
    });
  }
  return hits;
}
