/**
 * FeedbackRequestRow render + memoization pins (ticket d578fed5 — the
 * feedback-UI typing-lag fix).
 *
 * The Account → Feedback tab kept its controlled title/description fields AND
 * the whole submissions list in one component, so every keystroke re-rendered
 * up to 500 rows, each re-running unpackDescription() — descriptions can pack
 * up to 3 base64 screenshots (the reporter's own list totals ~10 MB across 17
 * image-bearing rows, 658 tickets total) — plus per-row Intl timestamp
 * formatting. That was the multi-second lag between typing and text appearing.
 *
 * Fix: the row is now a module-level memo()ized component receiving only its
 * request object, two booleans, and STABLE (useCallback) callbacks, so form
 * keystrokes no longer re-render any row.
 *
 * Same idiom as plain-message-actions.test.tsx / expandable-data-image.test.tsx
 * (node-env vitest, renderToStaticMarkup — no jsdom, no reconciliation), so
 * the memo contract is pinned structurally: the export must BE a React.memo
 * component. If someone unwraps the memo (or passes unstable inline-arrow
 * callbacks from the parent), this file is the tripwire — the typing lag
 * returns exactly then.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, memo } from 'react';
import { FeedbackRequestRow, MAX_IMAGES } from './FeedbackTab';
import type { FeatureRequest } from '@/lib/api/crossmodel';

const IMG_A = 'data:image/png;base64,AAAA';
const IMG_B = 'data:image/png;base64,BBBB';

const withImages = (text: string, images: string[]) =>
  text + '\n\n---IMAGES---\n' + images.join('\n');

const noop = () => {};
type RowProps = Parameters<typeof FeedbackRequestRow>[0];

const makeReq = (over: Partial<FeatureRequest> = {}): FeatureRequest => ({
  id: 'req-1',
  userId: 'u1',
  type: 'bug_report',
  title: 'Typing is laggy',
  description: 'plain description text',
  status: 'open',
  priority: 0,
  createdAt: '2026-09-12T10:00:00Z',
  updatedAt: '2026-09-12T11:00:00Z',
  source: 'user',
  occurrences: 1,
  ...over,
});

const renderRow = (req: FeatureRequest, over: Partial<RowProps> = {}) =>
  renderToStaticMarkup(createElement(FeedbackRequestRow, {
    req,
    resolving: false,
    expanded: false,
    onToggleImages: noop,
    onResolve: noop,
    ...over,
  }));

describe('FeedbackRequestRow — memoization contract (d578fed5)', () => {
  it('is a React.memo component — the export must stay memo-wrapped', () => {
    // The whole fix. A plain function export here means every keystroke in the
    // feedback form re-renders every row again (the reported lag). memo() marks
    // its return with REACT_MEMO_TYPE; compare against a fresh reference memo
    // rather than hardcoding the symbol.
    const MEMO_TYPE = memo(function ReferenceMemo() { return null; }).$$typeof;
    expect(typeof FeedbackRequestRow).toBe('object');
    expect((FeedbackRequestRow as { $$typeof?: unknown }).$$typeof).toBe(MEMO_TYPE);
    // memo exposes the wrapped render fn as `.type` — it must be the row
    // component, not something else wearing the memo symbol.
    const wrapped = (FeedbackRequestRow as { type?: { name?: string } }).type;
    expect(typeof wrapped).toBe('function');
    expect(wrapped?.name).toBe('FeedbackRequestRow');
  });
});

describe('FeedbackRequestRow — SSR markup', () => {
  it('collapses image-bearing descriptions: toggle visible, no eager <img> decode', () => {
    const html = renderRow(makeReq({ description: withImages('the text part', [IMG_A, IMG_B]) }));
    expect(html).toContain('the text part');
    expect(html).toContain('2 images attached');
    expect(html).toContain('▼'); // collapsed chevron
    // The base64 payloads must NOT be in the collapsed DOM — that is what
    // keeps a 500-row list cheap to mount (no eager image elements).
    expect(html).not.toContain(IMG_A);
    expect(html).not.toContain(IMG_B);
    expect(html).not.toContain('<img');
  });

  it('expanded row renders the attached images as links to the data URLs', () => {
    const html = renderRow(
      makeReq({ description: withImages('text', [IMG_A, IMG_B]) }),
      { expanded: true },
    );
    expect(html).toContain('▲');
    expect(html).toContain(`src="${IMG_A}"`);
    expect(html).toContain(`src="${IMG_B}"`);
  });

  it('in_progress rows show the working-on-it strip and never the raw adminNote', () => {
    const html = renderRow(makeReq({
      status: 'in_progress',
      adminNote: 'Dispatched to the engineering lane — secret internal detail',
    }));
    expect(html).toContain('In progress — the Digby team is on this…');
    expect(html).toContain('Mark as Resolved');
    expect(html).not.toContain('secret internal detail');
  });

  it('internal adminNotes are filtered out of open/done rows', () => {
    const html = renderRow(makeReq({ status: 'done', adminNote: 'kanban_task: 1234' }));
    expect(html).not.toContain('kanban_task');
    expect(html).not.toContain('Digby&#x27;s Response');
  });

  it('a human-facing adminNote renders as Digby&#x27;s Response', () => {
    const html = renderRow(makeReq({ status: 'done', adminNote: 'Fixed and deployed!' }));
    expect(html).toContain('Digby&#x27;s Response');
    expect(html).toContain('Fixed and deployed!');
  });

  it('resolving=true disables the Mark as Resolved button', () => {
    const idle = renderRow(makeReq({ status: 'in_progress' }));
    const busy = renderRow(makeReq({ status: 'in_progress' }), { resolving: true });
    // SSR renders a disabled button as disabled="" — assert the attribute, not
    // the substring 'disabled' (the className always contains disabled:opacity-50,
    // which would make a substring check vacuous).
    expect(idle).not.toContain('disabled=""');
    expect(busy).toContain('disabled=""');
  });

  it('badges: type + status + recurring-sighting chip', () => {
    const html = renderRow(makeReq({ status: 'open', occurrences: 3 }));
    expect(html).toContain('>Bug<');       // TYPE_LABEL
    expect(html).toContain('>Open<');      // STATUS_BADGE
    expect(html).toContain('×3');          // occurrences chip
  });

  it('agent-filed and in-chat rows keep their provenance badges', () => {
    expect(renderRow(makeReq({ source: 'agent' }))).toContain('filed by Digby');
    expect(renderRow(makeReq({ title: 'In-chat feedback: wrong' }))).toContain('from chat');
  });
});

describe('FeedbackTab — screenshot cap (owner directive 2026-09-13)', () => {
  it('allows more than 3 screenshots per ticket', () => {
    // Owner verbatim: "we want to allow more than just 3 screenshots for
    // tickets". The backend carries no description cap and express json is
    // 75mb (8 × 5 MB raw ≈ 53 MB base64 fits) — the only cap is this frontend
    // constant, so pin it above 3.
    expect(MAX_IMAGES).toBeGreaterThan(3);
    expect(MAX_IMAGES).toBe(8);
  });
});

/**
 * Owner 2026-10-07 (screenshot): "weird floating submit button on feedback tab
 * … in dark mode can't see some badge texts". The sticky bar only appears while
 * the user is WRITING feedback, renders at the real screen bottom (portal), and
 * the agent badge / response stamp use the neutral tokens (no dark-mode
 * line-gray text on a gray tint).
 */
describe('FeedbackTab — sticky submit + dark-mode badges (2026-10-07)', () => {
  const SRC: string = require('node:fs').readFileSync(require('node:path').join(__dirname, 'FeedbackTab.tsx'), 'utf8');

  it('the sticky bar shows only while writing: keyboard over a focused field, or the button below the viewport with a draft', () => {
    expect(SRC).toContain('const showStickySubmit = !submitted && ((isKeyboardOpen && formFocused) || (submitBelow && hasDraft));');
    // "below", never "above" — scrolled past the form to the submissions ⇒ no bar
    expect(SRC).toContain('entry.boundingClientRect.top >= viewBottom - 1');
    expect(SRC).not.toContain('isSubmitVisible');
  });

  it('the sticky bar is portaled to <body> so it sits at the real screen bottom', () => {
    expect(SRC).toContain('createPortal(');
    expect(SRC).toContain('document.body,');
  });

  it('agent badge and the response stamp are readable in dark mode (no line-gray text tokens)', () => {
    expect(SRC).not.toMatch(/dark:text-brand-(ring|pale)/);
    expect(SRC).not.toMatch(/dark:bg-brand-dim/);
    const html = renderRow(makeReq({ source: 'agent' } as Partial<FeatureRequest>));
    expect(html).toContain('filed by Digby');
    expect(html).toContain('bg-active text-ink');
  });
});

describe('FeedbackTab — long paths wrap (2026-10-07)', () => {
  it('the description preview and Digby\'s Response break long unbroken tokens (file paths, shas)', () => {
    const SRC: string = require('node:fs').readFileSync(require('node:path').join(__dirname, 'FeedbackTab.tsx'), 'utf8');
    expect(SRC).toContain('line-clamp-2 [overflow-wrap:anywhere]');
    expect(SRC).toContain('whitespace-pre-line [overflow-wrap:anywhere]');
  });
});
