/**
 * Digby Frontier redesign (2026-10-06) — SSR render pins for the new chat
 * chrome: the transparency pill + "How Digby answered", the inline canvas
 * card, the Thinking block, the effort pill, the rail parts and the in-flow
 * header. Same react-dom/server idiom as DepthPill.test.tsx (node vitest, no
 * jsdom). Pure label/row logic is pinned in lib/answer-transparency.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { HowDigbyAnswered, TransparencyPill } from './DepthPill';
import CanvasInlineCard from './CanvasInlineCard';
import { StreamingDot, THINKING_STEPS_MAX, ThinkingBlock, appendThinkingStep, isHeartbeatStatus, liveHasText } from './LiveRunStatus';
import { RailActionRow, RailBrandRow, RailFooter, RailSectionLabel, railRowClass } from './rail-parts';
import FloatingChrome from './FloatingChrome';
import { buildHowRows } from '@/lib/answer-transparency';
import { TEXT_SIZE_MAP } from '@/lib/preferences';
import { AssistantParts } from './code-transcript';

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe('TransparencyPill', () => {
  it('a checked answer reads "Checked by n models" with the ok check and a collapsed chevron', () => {
    const out = html(createElement(TransparencyPill, { state: { kind: 'checked' }, seats: 2, open: false, onToggle: () => {} }));
    expect(out).toContain('Checked by 2 models');
    expect(out).toContain('text-ok');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('h-[30px]');
  });

  it('open swaps the label and rotates the chevron', () => {
    const out = html(createElement(TransparencyPill, { state: { kind: 'checked' }, seats: 2, open: true, onToggle: () => {} }));
    expect(out).toContain('Hide how Digby answered');
    expect(out).toContain('rotate-180');
  });

  it('interrupted + a retry handler reads "Check didn’t finish · Retry" and is the retry button (no disclosure)', () => {
    const out = html(createElement(TransparencyPill, { state: { kind: 'interrupted' }, seats: 2, open: false, onToggle: () => {}, onRetry: () => {} }));
    expect(out).toContain("Check didn&#x27;t finish · Retry");
    expect(out).not.toContain('aria-expanded');
  });

  it('renders nothing with nothing to say', () => {
    expect(html(createElement(TransparencyPill, { state: null, seats: 0, open: false, onToggle: () => {} }))).toBe('');
  });
});

describe('HowDigbyAnswered', () => {
  it('admin: one numbered row per seat with role, note, the model id in mono and the time', () => {
    const rows = buildHowRows({ models: { digby: { modelUsed: 'kimi-k3', time: 8400, webSearchUsed: true }, double_checker: { modelUsed: 'deepseek-flash', time: 11200 } } }, { kind: 'checked' }, { showModels: true });
    const out = html(createElement(HowDigbyAnswered, { rows, state: { kind: 'checked' } }));
    expect(out).toContain('data-how-digby-answered');
    expect(out).toContain('Digby');
    expect(out).toContain(' · wrote the answer');
    expect(out).toContain('Double Checker');
    expect(out).toContain(' · reviewed it');
    expect(out).toContain('kimi-k3 · web search');
    expect(out).toContain('font-mono');
    expect(out).toContain('8.4s');
    expect(out).toContain('11.2s');
    // no admin drill-down without renderDetail
    expect(out).not.toContain('Full response');
  });

  it('non-admin: no model name anywhere in the rendered panel', () => {
    const rows = buildHowRows({ models: { digby: { modelUsed: 'kimi-k3', time: 8400, webSearchUsed: true }, double_checker: { modelUsed: 'deepseek-flash', time: 11200 } } }, { kind: 'checked' });
    const out = html(createElement(HowDigbyAnswered, { rows, state: { kind: 'checked' } }));
    expect(out).toContain('Double Checker');
    expect(out).not.toMatch(/kimi|deepseek|glm/i);
    expect(out).not.toContain('font-mono');
  });

  it('an updated answer lists what changed', () => {
    const rows = buildHowRows({}, { kind: 'updated', changed: ['price 12 → 14'] });
    const out = html(createElement(HowDigbyAnswered, { rows, state: { kind: 'updated', changed: ['price 12 → 14'] } }));
    expect(out).toContain('data-depth-diff');
    expect(out).toContain('price 12 → 14');
  });
});

describe('CanvasInlineCard', () => {
  it('title, "Document · Open", the 40px tile, hover lift', () => {
    const out = html(createElement(CanvasInlineCard, { title: 'Heat pump vs furnace', type: 'document', onOpen: () => {} }));
    expect(out).toContain('Heat pump vs furnace');
    expect(out).toContain('Document · Open');
    expect(out).toContain('max-w-[440px]');
    expect(out).toContain('hover:-translate-y-px');
  });
});

describe('Thinking + streaming', () => {
  it('the Thinking block: shimmer label + clock + ONE current-step line; earlier steps behind a collapsed toggle', () => {
    const out = html(createElement(ThinkingBlock, { steps: ['Reading your question', 'Searching the web'] }));
    expect(out).toContain('dg-shimmer');
    expect(out).toContain('Thinking');
    // owner 2026-10-07 ("a lot going on"): only the CURRENT step shows …
    expect(out).toContain('data-thinking-current');
    expect(out).toContain('Searching the web');
    expect(out).not.toContain('Reading your question');
    // … the rest is one quiet, collapsed toggle
    expect(out).toContain('data-thinking-toggle');
    expect(out).toContain('2 steps');
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain('data-thinking-steps');
    // owner 2026-10-06: the ANIMATED propeller hat (DigbyLoader gif), never the static png
    expect(out).toContain('/digbyspin.gif');
    expect(out).not.toContain('src="/digbyhat.png"');
  });

  it('heartbeat pulses ("Still digging — 1:32 so far…") are never a step or the shown line', () => {
    expect(isHeartbeatStatus('Still digging — 1:32 so far…')).toBe(true);
    expect(isHeartbeatStatus('Still thinking it through — 0:12 so far…')).toBe(true);
    expect(isHeartbeatStatus('Digby is searching the web for "x"…')).toBe(false);
    expect(appendThinkingStep(['a'], 'Still writing — 0:48 so far…')).toEqual(['a']);
    const one = html(createElement(ThinkingBlock, { steps: ['Digby is getting oriented…'], status: 'Still digging — 0:36 so far…' }));
    expect(one).toContain('Digby is getting oriented');
    expect(one).not.toContain('so far');
    expect(one).not.toContain('data-thinking-toggle'); // one step ⇒ no toggle
    expect(html(createElement(StreamingDot, { status: 'Still writing — 0:48 so far…' }))).not.toContain('so far');
  });

  it('appendThinkingStep keeps distinct lines, capped; liveHasText waits for real prose', () => {
    expect(appendThinkingStep(undefined, 'a')).toEqual(['a']);
    expect(appendThinkingStep(['a'], 'a')).toEqual(['a']);
    const twelve = Array.from({ length: THINKING_STEPS_MAX }, (_, i) => `s${i}`);
    expect(appendThinkingStep(twelve, 'new')).toEqual([...twelve.slice(1), 'new']);
    expect(liveHasText([{ type: 'tool_call' }, { type: 'text', text: '  ' }])).toBe(false);
    expect(liveHasText([{ type: 'text', text: 'Hi' }])).toBe(true);
  });

  it('plain live turns draw no tool run above the Thinking block (quietLiveTail); settled rows keep the fold', () => {
    const parts = [
      { type: 'tool_call', name: 'web_search', args: { query: 'a' }, uid: 'a' },
      { type: 'tool_call', name: 'web_search', args: { query: 'b' }, uid: 'b' },
      { type: 'tool_call', name: 'web_search', args: { query: 'c' }, uid: 'c' },
    ] as any;
    const quiet = html(createElement(AssistantParts, { parts, foldTail: true, quietLiveTail: true }));
    expect(quiet).not.toContain('data-tool-activity');
    expect(quiet).not.toContain('Working');
    const loud = html(createElement(AssistantParts, { parts, foldTail: true }));
    expect(loud).toContain('data-tool-activity="live"');
    // text before the tail still renders; only the trailing tool run hides
    const mixed = html(createElement(AssistantParts, { parts: [{ type: 'text', text: 'Here is the answer', uid: 't' }, ...parts] as any, foldTail: true, quietLiveTail: true }));
    expect(mixed).toContain('Here is the answer');
    expect(mixed).not.toContain('data-tool-activity');
  });

  it('while words stream the propeller hat keeps spinning (not a pulsing dot)', () => {
    const out = html(createElement(StreamingDot, {}));
    expect(out).toContain('/digbyspin.gif');
    expect(out).toContain('digby-loader');
  });

  it('the home hero and the empty chat use the animated hat too', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    const PAGE = fs.readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');
    const VIEW = fs.readFileSync(new URL('./CodeSessionView.tsx', import.meta.url), 'utf8');
    // The hero spinners go through the shared branding core (2026-11-05, todo
    // d2d32b57): an operator's spinner + its reduced-motion static twin replace
    // the hard-coded /digbyspin.gif, so the pin is "two BrandSpinners, no
    // literal asset path". The animated-asset behaviour itself is unchanged and
    // is pinned in components/ui/custom/BrandSpinner.tsx + lib/branding tests.
    expect((PAGE.match(/<BrandSpinner size=\{40\}/g) || []).length).toBe(2);
    expect(PAGE).not.toContain('src="/digbyspin.gif"');
    expect(PAGE).not.toContain('src="/digbyhat.png" alt="Digby" width={34}');
    expect(VIEW).toContain('<DigbyLoader size={40} label={branding.name} />');
  });
});

describe('rail parts', () => {
  it('brand row: hat, serif "Digby", a named collapse button', () => {
    const out = html(createElement(RailBrandRow, { onCollapse: () => {} }));
    expect(out).toContain('digbyhat.png');
    expect(out).toContain('font-serif');
    expect(out).toContain('aria-label="Close sidebar"');
  });

  it('action row + section label + row skin + footer', () => {
    expect(html(createElement(RailActionRow, { icon: null, label: 'New chat', hint: '⌘⇧O', primary: true }))).toContain('⌘⇧O');
    const label = html(createElement(RailSectionLabel, null, 'Today'));
    expect(label).toContain('Today');
    expect(label).toContain('text-[12px]');
    expect(label).not.toContain('uppercase');
    expect(railRowClass(true)).toContain('bg-active');
    expect(railRowClass(false)).toContain('hover:bg-hover');
    const footer = html(createElement(RailFooter, { name: 'Paul', email: 'paul@example.com', onOpenSettings: () => {} }));
    expect(footer).toContain('>P<');
    expect(footer).toContain('paul@example.com');
    expect(footer).toContain('aria-label="Settings"');
  });
});

describe('FloatingChrome — the in-flow header (no menus — owner 2026-10-06)', () => {
  const base = { isLoggedIn: true, sidebarOpen: false, onToggleSidebar: () => {}, onNewChat: () => {} };

  it('sidebar closed: open-sidebar + new-chat buttons; in a chat: the plain title + Share pill; NO ⋯ / title menu', () => {
    const out = html(createElement(FloatingChrome, { ...base, chatTitle: 'Heat pump vs furnace', onShare: () => {}, showWorkspaceToggle: true }));
    expect(out).toContain('data-chat-header');
    expect(out).toContain('aria-label="Open sidebar"');
    expect(out).toContain('aria-label="New chat"');
    expect(out).toContain('Heat pump vs furnace');
    expect(out).toContain('Share');
    expect(out).toContain('aria-label="Show side panel"');
    expect(out).not.toContain('aria-label="Menu"');
    expect(out).not.toContain('aria-haspopup');
  });

  it('home (no title): no title, no Share pill; sidebar open: no left buttons', () => {
    const out = html(createElement(FloatingChrome, { ...base, sidebarOpen: true }));
    expect(out).not.toContain('aria-label="Open sidebar"');
    expect(out).not.toContain('Share');
    expect(out).not.toContain('aria-label="Menu"');
  });

  it('guests with the rail closed get Log in / Sign up in the header (none while the guest rail is open)', () => {
    const guest = { ...base, isLoggedIn: false, onLogin: () => {}, onSignup: () => {} };
    const closed = html(createElement(FloatingChrome, guest));
    expect(closed).toContain('Log in');
    expect(closed).toContain('Sign up');
    const open = html(createElement(FloatingChrome, { ...guest, sidebarOpen: true }));
    expect(open).not.toContain('Log in');
  });
});

describe('chat answer typeface (owner 2026-10-06: match the coding fonts)', () => {
  it('no chat text size renders serif — answers use the coding sans; small = the coding measure', () => {
    for (const size of Object.values(TEXT_SIZE_MAP)) {
      expect(Object.values(size).join(' ')).not.toContain('font-serif');
    }
    expect(TEXT_SIZE_MAP.small.p).toBe('text-sm leading-6');
  });
});

describe('Q&A — ask_user card + owner questions (Frontier sweep 2026-10-06, owner: "did you not fix the Q&A?")', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  const VIEW = fs.readFileSync(new URL('./CodeSessionView.tsx', import.meta.url), 'utf8');
  const card = VIEW.slice(VIEW.indexOf('<div data-question-card'), VIEW.indexOf('{/* Sponsored slot'));

  it('the live question renders as markdown in the chat typography, not a pre-wrapped wall of text', () => {
    expect(card).toContain('<CodeTranscriptMarkdown text={live.pendingQuestion.question} sizes={plainSizes} />');
    expect(card).not.toContain('whitespace-pre-wrap');
  });

  it('the countdown is quiet ink-3 (destructive only in the last minute) — no raw amber/red', () => {
    expect(card).toContain("questionRemainMs <= 60_000 ? 'text-destructive' : 'text-ink-3'");
    expect(card).not.toMatch(/amber|red-\d/);
  });

  it('the answer box is the composer language: a growing textarea + the send circle, Enter sends / Shift+Enter breaks', () => {
    expect(card).toContain('<textarea');
    expect(card).toContain("e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing");
    expect(card).toContain("className={cn(SEND_BTN, 'size-8')}");
    expect(card).toContain('aria-label="Send answer"');
  });

  it('owner-question previews strip markdown marks; the expanded body renders markdown', async () => {
    const { stripMarkdown } = await import('./OwnerQuestionCard');
    expect(stripMarkdown('**Could you** sign in?\n- `-no-window` mode\n## Heads up\n[docs](https://x.y)')).toBe('Could you sign in?\n• -no-window mode\nHeads up\ndocs');
  });
});

describe('legacy colour tokens follow the Frontier palette (sweep 2026-10-06)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  const CSS = fs.readFileSync(new URL('../../globals.css', import.meta.url), 'utf8');
  it('brand → the ink primary, success → --ok, warning → --warn-ink, info → ink-2', () => {
    expect(CSS).toContain('--brand: var(--send);');
    expect(CSS).toContain('--brand-text: var(--ink);');
    expect(CSS).toContain('--success: var(--ok);');
    expect(CSS).toContain('--warning: var(--warn-ink);');
    expect(CSS).toContain('--info: var(--ink-2);');
    expect(CSS).not.toMatch(/--brand: oklch\(0\.541/);
  });
});

describe('walkthrough fixes (2026-10-06)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  const PAGE = fs.readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');

  it('the account footer shows the email once when there is no display name', () => {
    const same = html(createElement(RailFooter, { name: 'bot@digby.ai', email: 'bot@digby.ai' }));
    expect(same.match(/bot@digby\.ai/g)?.length).toBe(1);
  });

  it('How Digby answered never echoes the role line as the note', () => {
    const rows = buildHowRows({ models: { digby: { time: 5000 } } }, null);
    expect(rows[0].role).toBe('wrote the answer');
    expect(rows[0].note).toBe('Answered without a web search.');
  });

  it('each sidebar chat row has ONE menu — Delete lives inside it, no separate trash button', () => {
    expect(PAGE).not.toMatch(/title="Delete"\s*>\s*<Trash2 className="size-3\.5 md:h-3 md:w-3"/);
    expect((PAGE.match(/<DropdownMenuItem variant="destructive" onClick=\{\(\) => setDeletingChatId\(chat\.id\)\}>/g) || []).length).toBe(2);
  });
});
