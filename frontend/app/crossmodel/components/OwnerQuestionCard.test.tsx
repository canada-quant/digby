/**
 * OwnerQuestionCard (owner 2026-09-22: "it redirects to the proper chat but
 * there is no other action for me to take or understand what it needs from
 * me"). SSR pins: the flagger's typed options render as numbered buttons with
 * their consequence lines and the question text no longer repeats them; a
 * triaged question says the supervisor is answering first and still offers
 * the buttons; without options the Approve/Decline pair renders; the compact
 * rail variant shows the chat title as the open-chat control.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import OwnerQuestionCard, { splitOwnerQuestion } from './OwnerQuestionCard';
import type { PendingConfirmation } from '@/lib/api/crossmodel';

const Q: PendingConfirmation = {
  chatId: 'c1', title: 'Acceptance Criteria Verified', kind: 'owner_question', id: 'oq_1',
  question: "[canlegal-bench] The Digby Mac app's automation permission is OFF — synthetic input is being dropped. Which route?\n1. Re-enable Digby under Accessibility (30 seconds) — The relaunch can run unattended; the full re-scrape completes tonight.\n2. Stand down the Mac route for now — The re-scrape stays parked until another vantage opens.",
  options: ['Re-enable Digby under Accessibility (30 seconds)', 'Stand down the Mac route for now'],
  ts: Date.now(), triaged: true, triageUntil: Date.now() + 3600_000,
};

describe('splitOwnerQuestion', () => {
  it('pulls the numbered option lines out of the question and keeps their consequences', () => {
    const r = splitOwnerQuestion(Q.question, Q.options);
    expect(r.text).toContain('Which route?');
    expect(r.text).not.toContain('1. Re-enable');
    expect(r.options).toEqual([
      { label: 'Re-enable Digby under Accessibility (30 seconds)', consequence: 'The relaunch can run unattended; the full re-scrape completes tonight.' },
      { label: 'Stand down the Mac route for now', consequence: 'The re-scrape stays parked until another vantage opens.' },
    ]);
  });
  it('no options → the text is returned whole', () => {
    expect(splitOwnerQuestion('Approve the budget?', [])).toEqual({ text: 'Approve the budget?', options: [] });
  });
});

describe('OwnerQuestionCard', () => {
  it('renders the options as numbered buttons with consequences, the triage line, Dismiss and the free-text route', () => {
    const html = renderToStaticMarkup(createElement(OwnerQuestionCard, { p: Q, onAnswer: () => {}, onDismiss: () => {}, onOpenInbox: () => {} }));
    expect(html).toContain('data-owner-question');
    expect(html).toContain('data-triaged="true"');
    expect(html).toContain('Your supervisor is answering this first');
    expect(html).toContain('answer now to pre-empt');
    expect(html).toContain('1. Re-enable Digby under Accessibility (30 seconds)');
    expect(html).toContain('2. Stand down the Mac route for now');
    expect(html).toContain('completes tonight');
    expect(html).toContain('Dismiss');
    expect(html).toContain('Type a different answer');
    expect(html).not.toContain('Approve');
  });
  it('without typed options it offers Approve / Decline and says "Needs your decision"', () => {
    const p = { ...Q, question: 'Approve the GPU budget increase?', options: [], triaged: undefined };
    const html = renderToStaticMarkup(createElement(OwnerQuestionCard, { p, onAnswer: () => {} }));
    expect(html).toContain('Needs your decision');
    expect(html).toContain('Approve');
    expect(html).toContain('Decline');
    expect(html).not.toContain('supervisor is answering');
  });
  it('compact rail variant shows the chat title as the open-chat control', () => {
    const html = renderToStaticMarkup(createElement(OwnerQuestionCard, { p: Q, compact: true, onAnswer: () => {}, onOpenChat: () => {} }));
    expect(html).toContain('Acceptance Criteria Verified');
    expect(html).not.toContain('Show more'); // short text — no clamp toggle
    const long = { ...Q, question: `${'The harvest runner needs a decision about the Mac route and the CAPTCHA ladder. '.repeat(4)}Which route?`, options: [] };
    const longHtml = renderToStaticMarkup(createElement(OwnerQuestionCard, { p: long, compact: true, onAnswer: () => {} }));
    expect(longHtml).toContain('line-clamp-3');
    expect(longHtml).toContain('Show more');
  });
  it('ticket 1b1c41bc: a console-action card NEVER collapses — the payload stays whole in the compact rail', () => {
    // The harness-composed body (backend composeConsoleActionBody): the exact
    // paste-ready payload in a fenced block + click-by-click steps. The
    // collapsed preview strips markdown and clamps to 3 lines — it would hide
    // the payload, the exact summarize-first failure this ticket ends.
    const consoleQ: PendingConfirmation = {
      ...Q,
      question: "Save this ACL rule so the deploy can reach the controller.\n\n**What this does + why it's safe:** Grants the digby-dev tag SSH access to controllers only.\n\n**Do this in Tailscale admin console — https://login.tailscale.com/admin/acls**\n\n**Paste exactly this (Tailscale admin console):**\n\n```json\n{\n  \"action\": \"accept\",\n  \"src\": [\"tag:digby-dev\"],\n  \"dst\": [\"tag:controller:22\"]\n}\n```\n\n**Click by click:**\n1. Open https://login.tailscale.com/admin/acls (Access Controls tab).\n2. Select-all inside the editor and copy the JSON below over it.\n3. Click Save.\n4. Reply \"Saved\" on this card.",
      options: ['Saved', 'Error', 'Defer'],
      consoleAction: true,
      triaged: undefined,
      triageUntil: undefined,
    };
    const html = renderToStaticMarkup(createElement(OwnerQuestionCard, { p: consoleQ, compact: true, onAnswer: () => {} }));
    // Fully expanded: no plain-text clamp, no Show more toggle.
    expect(html).not.toContain('line-clamp-3');
    expect(html).not.toContain('Show more');
    // The four elements render: the payload block, the steps, the saved/error/defer options.
    expect(html).toContain('tag:digby-dev');
    expect(html).toContain('Click by click');
    expect(html).toContain('1. Saved');
    expect(html).toContain('2. Error');
    expect(html).toContain('3. Defer');
    // A non-console-action long card still collapses (the rail stays compact for ordinary asks).
    const plainLong = { ...Q, question: `${'Plain decision body. '.repeat(40)}`, options: [], consoleAction: undefined };
    const plainHtml = renderToStaticMarkup(createElement(OwnerQuestionCard, { p: plainLong, compact: true, onAnswer: () => {} }));
    expect(plainHtml).toContain('line-clamp-3');
    expect(plainHtml).toContain('Show more');
  });
});

// ── Ticket f3a69ed3 — owner replies must render ON the card ─────────────────
describe('OwnerQuestionCard — f3a69ed3 recorded reply + prior-reply fold', () => {
  const REPLY = 'try to remote use mbp-1 now i stopped othger screenshare';
  const FOLD_MARK = '\n\n↩ FROM YOUR EARLIER REPLY —';

  it('defect 1: a recorded (non-resolving) owner reply renders on the card with the reason it did not resolve', () => {
    const p: PendingConfirmation = {
      ...Q, triaged: undefined,
      question: 'Please provide the TAILSCALE_AUTH_KEY so the lane can fix the tailscale json.',
      options: [], needsCredential: true,
      recordedReply: {
        text: REPLY,
        receivedAt: '2026-10-21T16:43:12.000Z',
        reason: 'this card opens only when the key itself is stored — paste it in the key field on the card (or store it via store_secret / Account → Coding credentials), words alone cannot open it',
        delivered: 'sent into the asking chat and the agent was woken with it',
      },
    };
    const html = renderToStaticMarkup(createElement(OwnerQuestionCard, { p, onAnswer: () => {} }));
    // The owner's own words, rendered back on the card — never a silent bounce.
    expect(html).toContain('data-owner-recorded-reply');
    expect(html).toContain(REPLY);
    expect(html).toContain('Your reply');
    // The one-line reason + where it went.
    expect(html).toContain('It did not close this card');
    expect(html).toContain('words alone cannot open it');
    expect(html).toContain('the agent was woken with it');
    // Received timestamp rendered.
    expect(html).toContain('received');
  });

  it('defect 1 (legacy record): no receivedAt still renders "Your reply (received)"', () => {
    const p: PendingConfirmation = {
      ...Q, triaged: undefined,
      question: 'Which device should the lane drive?', options: [],
      recordedReply: { text: REPLY, receivedAt: null, reason: 'this card resolves by picking one of the typed options', delivered: 'sent into the asking chat as context', legacy: true },
    };
    const html = renderToStaticMarkup(createElement(OwnerQuestionCard, { p, onAnswer: () => {} }));
    expect(html).toContain('data-owner-recorded-reply');
    expect(html).toContain(REPLY);
    expect(html).toContain('It did not close this card');
  });

  it('defect 2: a replacement card renders the prior-reply fold and strips it from the question body', () => {
    const p: PendingConfirmation = {
      ...Q, triaged: undefined,
      question: `Re-ask: the key paste failed — provide the TAILSCALE_AUTH_KEY again.${FOLD_MARK} (card oq_510a512a-1234): "${REPLY}"`,
      options: [], needsCredential: true,
      priorReplyFold: { fromQuestionId: 'oq_510a512a-1234', text: REPLY },
    };
    const html = renderToStaticMarkup(createElement(OwnerQuestionCard, { p, onAnswer: () => {} }));
    // The fold block renders its own visual block …
    expect(html).toContain('data-owner-prior-reply-fold');
    expect(html).toContain('Folded in from your earlier reply');
    expect(html).toContain(REPLY);
    expect(html).toContain('oq_510a512a');
    // … and the raw fold mark does NOT leak into the question body.
    expect(html).not.toContain('FROM YOUR EARLIER REPLY — (card');
  });

  it('no recordedReply / no fold → neither block renders (unchanged card)', () => {
    const p: PendingConfirmation = { ...Q, triaged: undefined, question: 'Approve the GPU budget increase?', options: [] };
    const html = renderToStaticMarkup(createElement(OwnerQuestionCard, { p, onAnswer: () => {} }));
    expect(html).not.toContain('data-owner-recorded-reply');
    expect(html).not.toContain('data-owner-prior-reply-fold');
    expect(html).not.toContain('Your reply');
  });
});
