/**
 * Renderer tests for AssistantParts prose grouping (ticket 0b4575dd).
 *
 * Node-environment vitest idiom (no jsdom, no effects — same as
 * ChatFilesSection.test.tsx / markdown-content.test.tsx): render the pure
 * component via react-dom/server and assert on the static markup. Interactive
 * toggles (chip expand, raw order) are state-driven and verified by the
 * presence of their affordances; the grouping decisions themselves are pinned
 * exhaustively in lib/prose-grouping.test.ts.
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { AssistantParts } from './code-transcript';
import type { MessagePart } from '@/lib/api/coding';

const t = (text: string, uid?: string): MessagePart => ({ type: 'text', text, ...(uid ? { uid } : {}) } as MessagePart);
const r = (text: string, uid?: string): MessagePart => ({ type: 'reasoning', text, ...(uid ? { uid } : {}) } as MessagePart);
const toolCall = (name = 'run_command'): MessagePart => ({ type: 'tool_call', name, args: {} } as MessagePart);
const toolResult = (name = 'run_command'): MessagePart => ({ type: 'tool_result', name, result: 'ok' } as MessagePart);
const img = (name?: string): MessagePart => ({ type: 'image', data: 'aGVsbG8=', mediaType: 'image/png', ...(name ? { name } : {}) } as MessagePart);

const html = (parts: MessagePart[], opts?: { hideThinking?: boolean; disableGrouping?: boolean }) =>
  renderToStaticMarkup(createElement(AssistantParts, { parts, ...opts }));

describe('AssistantParts prose grouping (0b4575dd)', () => {
  // Thinking is hidden by default since 2026-10-04 (lib/reasoning-visibility.ts); these pin the visible mode
  // (NEXT_PUBLIC_HIDE_REASONING_DISABLED=1).
  beforeEach(() => { process.env.NEXT_PUBLIC_HIDE_REASONING_DISABLED = '1'; });
  afterEach(() => { delete process.env.NEXT_PUBLIC_HIDE_REASONING_DISABLED; });
  it('joins fragments separated only by reasoning into ONE block with a thought chip (no Thought-process row)', () => {
    const out = html([t('Hello '), r('hmm'), t('world')]);
    expect(out).toContain('Hello world');
    expect(out).toContain('1 thought');
    expect(out).not.toContain('Thought process');
    expect(out).toContain('raw order');
  });

  it('counts multiple interleaved thoughts on the chip', () => {
    const out = html([t('A'), r('r1'), t('B'), r('r2'), t('C')]);
    expect(out).toContain('ABC');
    expect(out).toContain('2 thoughts');
  });

  it('does NOT group across a tool call — fragments render separately with the tool row between', () => {
    const out = html([t('before-tools'), toolCall(), t('after-tools')]);
    expect(out).toContain('before-tools');
    expect(out).toContain('after-tools');
    expect(out).toContain('Ran a command'); // ToolCard summary
    expect(out).not.toContain('thought</');
  });

  it('tool_call merges its following tool_result exactly once (no double card)', () => {
    const out = html([t('A'), r('r'), t('B'), toolCall(), toolResult()]);
    // One card: the summary line appears exactly once.
    expect(out.split('Ran a command').length - 1).toBe(1);
  });

  it('[text, reasoning] stays legacy: live Thinking row, no grouping chip', () => {
    const out = html([t('answer'), r('still going')]);
    expect(out).toContain('answer');
    expect(out).toContain('Thinking…');
    expect(out).not.toContain('1 thought');
  });

  it('hideThinking drops reasoning rows and chips but keeps the joined prose', () => {
    const grouped = html([t('Hello '), r('hmm'), t('world')], { hideThinking: true });
    expect(grouped).toContain('Hello world');
    expect(grouped).not.toContain('thought');
    const passthrough = html([t('answer'), r('still going')], { hideThinking: true });
    expect(passthrough).toContain('answer');
    expect(passthrough).not.toContain('Thinking…');
  });

  it('empty reasoning groups without a chip (prose only)', () => {
    const out = html([t('A'), r('   '), t('B')]);
    expect(out).toContain('AB');
    expect(out).not.toContain('thought');
  });

  it('disableGrouping renders the legacy fragmented view (raw-order expansion path)', () => {
    const out = html([t('Hello '), r('hmm'), t('world')], { disableGrouping: true });
    expect(out).toContain('Hello');
    expect(out).toContain('world');
    expect(out).toContain('Thought process');
    expect(out).not.toContain('1 thought');
  });
});

describe('AssistantParts image parts — click-to-expand (c6e8edda follow-up)', () => {
  it('an assistant image part renders the expandable thumbnail, not a bare <img>', () => {
    const out = html([img('photo.png')]);
    // The shared ExpandableDataImage zoom trigger wraps the thumbnail…
    expect(out).toContain('cursor-zoom-in');
    expect(out).toContain('aria-label="Expand image: photo.png"');
    // …the thumbnail keeps its data URL + capped max-h-48 sizing…
    expect(out).toContain('src="data:image/png;base64,aGVsbG8="');
    expect(out).toContain('max-h-48');
    // …and no lightbox dialog mounts before a click.
    expect(out).not.toContain('role="dialog"');
  });

  it('a name-less image part falls back to the generic attached-image label', () => {
    const out = html([img()]);
    expect(out).toContain('aria-label="Expand image: attached image"');
    expect(out).toContain('src="data:image/png;base64,aGVsbG8="');
  });

  it('an image part interleaves with prose without disturbing the grouping', () => {
    const out = html([t('before'), img('shot.png'), t('after')]);
    expect(out).toContain('before');
    expect(out).toContain('after');
    expect(out).toContain('aria-label="Expand image: shot.png"');
  });
});

describe('AssistantParts per-block timestamps (owner report 2026-08-31; underneath-only rule 2026-09-17)', () => {
  const TS = new Date().toISOString(); // today → label is hours:minutes, no date prefix

  it('a SINGLE text part renders NO per-block stamp — the one message-level stamp underneath covers it', () => {
    const out = html([{ type: 'text', text: 'block one', ts: TS } as MessagePart]);
    expect(out).toContain('group/part');
    expect(out).not.toContain('group-hover/part');
    expect(out).not.toContain('bg-background/80');
  });

  it('a MULTI-part message (a loop) stamps each block IN-FLOW, right-aligned above the block — never an absolute overlay on the prose', () => {
    const out = html([{ type: 'text', text: 'block one', ts: TS } as MessagePart, { type: 'text', text: 'block two', ts: TS } as MessagePart]);
    expect(out).toContain('group-hover/part:opacity-100');
    expect(out).toContain('bg-background/80');
    expect(out).toMatch(/bg-background\/80 px-1">[^<]+<\/span>/);
    expect(out).toContain('flex justify-end h-3');
    expect(out).not.toContain('absolute top-1 right-2');
  });

  it('a text part WITHOUT ts renders no stamp (pre-2026-08 persisted rows)', () => {
    const out = html([t('old block'), t('second block')]);
    expect(out).not.toContain('group-hover/part');
    expect(out).not.toContain('bg-background/80');
  });

  it('a prose group stamps from its first ts-carrying fragment', () => {
    const out = html([{ type: 'text', text: 'A ', ts: TS } as MessagePart, r('hmm'), t('B')]);
    expect(out).toContain('A B'); // joined prose still intact
    expect(out).toContain('group/part');
    expect(out).toContain('group-hover/part:opacity-100');
  });

  it('an invalid ts string renders no stamp (formatMessageTime null path)', () => {
    const out = html([{ type: 'text', text: 'block', ts: 'not-a-date' } as MessagePart, { type: 'text', text: 'two', ts: 'not-a-date' } as MessagePart]);
    expect(out).not.toContain('group-hover/part');
  });
});

// ── Harness guard markers + struck drafts (owner transcript 2026-09-08) ──────
describe('AssistantParts — guard markers and struck drafts (2026-09-08)', () => {
  const marker = (text: string): MessagePart => ({ type: 'text', text, marker: 'guard' } as MessagePart);
  const struck = (text: string): MessagePart => ({ type: 'text', text, struck: true } as MessagePart);

  it('a guard marker renders as a callout (role=note), not as markdown prose, and never joins a prose group', () => {
    const out = html([t('Fresh probe: '), r('hmm'), t('all healthy.'), marker('⚠︎ Zero-tool finalize — the drafted answer was discarded before acceptance.')]);
    expect(out).toContain('data-guard-marker');
    expect(out).toContain('role="note"');
    expect(out).toContain('the drafted answer was discarded before acceptance');
    expect(out).not.toContain('⚠︎'); // the glyph is replaced by the icon
    expect(out).toContain('Fresh probe: all healthy.'); // the prose group before it still joins
    expect(out).not.toContain('all healthy.⚠︎');
  });

  it('a struck draft is collapsed by default behind "Rejected draft — not submitted" (its text is NOT in the static markup)', () => {
    const out = html([struck('Fold landed: PR #520 merged (merge sha 759e5ebf…) — all seven criteria verified.'), marker('⚠︎ Final answer rejected by the evidence guard'), t('Understood — redoing for real.')]);
    expect(out).toContain('data-struck-draft');
    expect(out).toMatch(/Rejected draft — not submitted \(\d+ words\)/);
    expect(out).not.toContain('PR #520 merged');
    expect(out).toContain('Final answer rejected by the evidence guard');
    expect(out).toContain('Understood — redoing for real.');
  });

  it('struck drafts and markers break prose grouping instead of being joined into it', () => {
    const out = html([t('A '), r('r1'), struck('BAD'), marker('⚠︎ m'), t('C')]);
    expect(out).not.toContain('A BAD');
    expect(out).not.toContain('BADC');
    expect(out).toContain('Rejected draft — not submitted (1 word)');
  });

  it('disableGrouping (raw order) renders the same callout + collapsed draft', () => {
    const out = html([struck('secret draft'), marker('⚠︎ m')], { disableGrouping: true });
    expect(out).toContain('data-struck-draft');
    expect(out).not.toContain('secret draft');
    expect(out).toContain('data-guard-marker');
  });
});

describe('AssistantParts call↔result pairing across interleaved seats (owner 2026-09-15)', () => {
  const lc = (name: string, label: string, uid: string): MessagePart => ({ type: 'tool_call', name, args: { query: `q-${uid}` }, label, uid } as MessagePart);
  const lr = (name: string, label: string): MessagePart => ({ type: 'tool_result', name, result: '8070 B', label } as MessagePart);

  it('a late result never renders as a second card — one summary per call', () => {
    // Digby's call, the Double Checker's call, then both results arrive later.
    const parts = [lc('search_engine', 'Digby', 'a'), lc('search_engine', 'Double Checker', 'b'), lr('search_engine', 'Digby'), lr('search_engine', 'Double Checker')];
    const out = html(parts);
    expect(out.split('Searched the web').length - 1).toBe(2);
    // The checker's row is attributed; Digby's is not prefixed.
    expect(out).toContain('Double Checker · ');
    expect(out.split('Digby · ').length - 1).toBe(0);
  });

  it('a genuinely orphan result still renders (nothing is filtered)', () => {
    const out = html([lr('search_engine', 'Digby')]);
    expect(out).toContain('Searched the web');
  });
});

describe('AssistantParts — thinking stays hidden by default (owner 2026-10-04)', () => {
  it('a saved reasoning part never renders; the answer text does', () => {
    const out = html([{ type: 'text', text: 'The answer.' } as MessagePart, { type: 'reasoning', text: 'secret chain of thought' } as MessagePart]);
    expect(out).toContain('The answer.');
    expect(out).not.toContain('secret chain of thought');
    expect(out).not.toMatch(/Thinking|Thought process/);
  });
});
