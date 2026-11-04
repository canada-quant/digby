/**
 * Sidebar attention blocks — collapse pins (ticket 1101e72c).
 *
 * SOURCE-LEVEL pins (the p1-shell-pins idiom: stable identifiers, never line
 * numbers). The owner report: "when a response or decision is needed… if the
 * text is really big it blocks the entire sidebar." The "Decisions needed"
 * queue (ticket 43212128) rendered every flagged owner question as a card
 * pinned above the chat list with NO collapse — one long question ate the
 * rail. It now mirrors the "Needs your input" block (P1.6):
 *
 *   1. Collapsed by default — ONE compact count row (pulse dot + Bell + "N
 *      decisions needed" + chevron), cards only behind an aria-expanded
 *      toggle; the queue keeps its own max-h-56 capped scroll track.
 *   2. Per-card long-question clamp — long questions stay clamped in the rail
 *      with a subtle amber "Show more"/"Show less" toggle (per-card state;
 *      since 2026-09-22 inside the shared OwnerQuestionCard).
 *   3. The card TITLE is a link that opens the flagged chat inline
 *      (handleOpenPendingConfirmation — same as the "Needs your input"
 *      question rows); Approve/Decline/Inbox are unchanged.
 *
 * The P1.6 pin in app/p1-shell-pins.test.ts stays authoritative for the
 * "Needs your input" block — this file pins Block A's convergence onto it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const PAGE = read('./page.tsx');

/** Slice helper for region-anchored pins (fails loudly when an anchor drifts).
 *  `to` is resolved AFTER `from`, so an earlier stray occurrence can't shrink
 *  the region to nothing. */
function region(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a, `region anchor ${JSON.stringify(from)} missing`).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b, `region anchor ${JSON.stringify(to)} missing after ${JSON.stringify(from)}`).toBeGreaterThan(a);
  return src.slice(a, b);
}

/** The whole "Decisions needed" block — from its banner comment to the
 *  "Pending confirmations" banner below it (the sibling Block B). */
const DECISIONS = region(PAGE, '── Decisions needed', '── Pending confirmations');
/** The shared owner-question card (2026-09-22): options as buttons, clamp/show-more, title opens the chat. */
const CARD = read('./components/OwnerQuestionCard.tsx');

describe('1101e72c — "Decisions needed" rail block collapsed by default', () => {
  it('default-collapsed state + aria-expanded toggle row (P1.6 pattern)', () => {
    expect(PAGE).toContain('const [decisionsExpanded, setDecisionsExpanded] = useState(false);');
    expect(DECISIONS).toContain('aria-expanded={decisionsExpanded}');
    expect(DECISIONS).toContain('onClick={() => setDecisionsExpanded(v => !v)}');
  });

  it('the compact row is the warn dot + "{n} decisions need you" + a rotating chevron; the cards render only behind the toggle', () => {
    // Digby Frontier (2026-10-06): the amber banner block became ONE quiet
    // primary-action row — a 7px --warn dot with its halo, the sentence-case
    // count, a ChevronRight that turns when expanded.
    expect(DECISIONS).toContain('icon={<WarnDot />}');
    expect(DECISIONS).toContain("decision${pendingOwnerDecisions.length === 1 ? ' needs' : 's need'} you");
    expect(DECISIONS).toContain("decisionsExpanded && 'rotate-90'");
    expect(DECISIONS).toContain('{decisionsExpanded && (');
    // Cards live ONLY inside the expanded state — collapsed shows zero question
    // text. Since 2026-09-22 (owner: "no other action for me to take") each
    // card is the shared OwnerQuestionCard: the flagger's options as buttons,
    // Approve/Decline when there are none, Inbox free-text route, Dismiss.
    const expanded = region(DECISIONS, '{decisionsExpanded && (', '</div>\n                    )}');
    expect(expanded).toContain('{pendingOwnerDecisions.map((p) => (');
    expect(expanded).toContain('<OwnerQuestionCard');
    expect(expanded).toContain('onAnswer={handleAnswerOwnerQuestion}');
    expect(expanded).toContain('onDismiss={handleDismissOwnerQuestion}');
    expect(expanded).toContain("onOpenInbox={() => router.push('/management?tab=inbox')}");
    // The queue keeps its own capped scroll track (never pushes the chat list).
    expect(expanded).toContain('max-h-72 overflow-y-auto');
    expect(CARD).toContain('Approve');
    expect(CARD).toContain('Decline');
    expect(CARD).toContain('Type a different answer');
    expect(CARD).toContain("onAnswer(p, o.label)"); // a typed option posts its label
  });
});

describe('1101e72c — per-card long-question show more/less (lives in OwnerQuestionCard since 2026-09-22)', () => {
  it('a per-card expanded state toggles the clamp off for one card', () => {
    expect(CARD).toContain('const [expanded, setExpanded] = useState(false);');
    // Ticket 1b1c41bc: a console-action card NEVER clamps — the collapsed
    // preview strips markdown (the paste-ready payload would vanish).
    expect(CARD).toContain('const clamped = compact && !expanded && text.length > 160 && p.consoleAction !== true;');
  });

  it('the clamp stays the default (3 lines + hover title in the rail); the toggle only appears for long questions', () => {
    // Frontier sweep (2026-10-06): the clamped branch is a plain-text preview
    // (markdown marks stripped) with the full text as the hover title; the
    // expanded branch renders markdown.
    expect(CARD).toContain('{clamped ? (');
    expect(CARD).toContain("line-clamp-3");
    expect(CARD).toContain('title={stripMarkdown(text)}');
    expect(CARD).toContain('<MarkdownContent');
    expect(CARD).toContain("{expanded ? 'Show less' : 'Show more'}");
    expect(CARD).toContain('aria-expanded={!clamped}');
    expect(CARD).toContain('{clamped && (');
  });
});

describe('1101e72c — the card title opens the flagged chat', () => {
  it('the rail hands the shared loader to the card; the card title calls it (same as Block B rows)', () => {
    const expanded = region(DECISIONS, '{decisionsExpanded && (', '</div>\n                    )}');
    expect(expanded).toContain('onOpenChat={handleOpenPendingConfirmation}');
    expect(CARD).toContain('onClick={() => onOpenChat(p)}');
    expect(CARD).toContain('title={`Open chat: ${p.title}`}');
  });

  it('handleOpenPendingConfirmation is still the ONE chat-opening path (no ad-hoc router push in the card)', () => {
    expect(CARD).not.toContain('router.push');
  });
});
