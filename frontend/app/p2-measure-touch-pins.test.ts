/**
 * Phase 2 (Measure & Touch) pins — UI overhaul, owner-approved.
 *
 * SOURCE-LEVEL pins (the p1-shell-pins idiom: stable identifiers, never line
 * numbers) for the seven Phase-2 items:
 *
 *   1. ONE reading measure — --measure-chat token (globals.css @theme);
 *      transcript AND composer share it on both surfaces (converged session
 *      view + home).
 *   2. Touch-target pass — the ONE hover-affordance idiom
 *      (`opacity-60 md:opacity-0 md:group-hover:opacity-100`) everywhere; a
 *      directory scan keeps the bare `opacity-0 group-hover:opacity-100`
 *      from creeping back. MessageNavigator: 44px mobile hit area + md-gated
 *      hover preview. Composer send/stop: chat 40px visual/44px hit area;
 *      code rides the row's 36px rhythm (size-9, 40px hit — 1b1d81f35).
 *   3. ONE mobile convention — show/hide-on-mobile intent rides md:.
 *   4. Composer convergence — one radius/border/shadow/send/stop across both
 *      variants (render test below).
 *   5. Duplicate-bubble fix — render-side id-dedup wired into the history
 *      memo + the terminal SSE fence (the backend resume fix is pinned in
 *      backend run-executor.test.ts (c2)/(c3)).
 *   6. Pill geometry — the fixed right pills offset by the OPEN panel's
 *      hoisted width (--panel-open-w) on md+, so they never overlap the
 *      panel's tab strip at any width (280–720).
 *   7. Stale model label — FloatingChrome + CodingTab read through the ONE
 *      alias helper (lib/model-alias.ts).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import ChatComposer, { type ChatComposerProps } from './crossmodel/components/ChatComposer';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const GLOBALS = read('./globals.css');
const PAGE = read('./crossmodel/page.tsx');
const VIEW = read('./crossmodel/components/CodeSessionView.tsx');
const CHROME = read('./crossmodel/components/FloatingChrome.tsx');
const NAV = read('./crossmodel/components/MessageNavigator.tsx');
const CODING_TAB = read('./crossmodel/account/CodingTab.tsx');

const MEASURE = 'max-w-(--measure-chat)';

// ── Item 1: ONE reading measure ──────────────────────────────────────────────
describe('P2.1 — one reading measure (--measure-chat)', () => {
  it('the token exists in the globals @theme', () => {
    // Digby Frontier (2026-10-06): the transcript + composer measure is 46rem.
    expect(GLOBALS).toContain('--measure-chat: 46rem');
  });

  it('converged session view: transcript content AND composer share the token', () => {
    // Transcript inner content wrapper (the pin ResizeObserver target).
    expect(VIEW).toContain(`'mx-auto w-full ${MEASURE} min-h-full'`);
    // Composer wrapper inside the bottom bar.
    expect(VIEW).toContain(`<div className="mx-auto w-full ${MEASURE}">`);
  });

  it('home: transcript content AND composer share the token (they were 128-384px misaligned)', () => {
    expect(PAGE).toContain(`mx-auto w-full ${MEASURE} px-6 pt-[13vh]`); // home hero
    expect(PAGE).toContain(`mx-auto w-full ${MEASURE} px-4 sm:px-6 space-y-2`); // home composer wrapper
    // The old divergent measures are gone from those slots.
    expect(PAGE).not.toContain('max-w-4xl lg:max-w-6xl');
    expect(PAGE).not.toContain('max-w-3xl mx-auto space-y-1');
  });
});

// ── Item 2: touch-target idiom scan ──────────────────────────────────────────
describe('P2.2 — touch idiom (opacity-60 md:opacity-0 md:group-hover:opacity-100)', () => {
  const appDir = fileURLToPath(new URL('.', import.meta.url));
  const offenders: string[] = [];
  const scan = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { scan(p); continue; }
      if (!/\.(tsx|ts)$/.test(name) || /\.test\./.test(name)) continue;
      const src = readFileSync(p, 'utf8');
      // The bare pointer-only affordance (invisible on touch) and the retired
      // sm:-tier variant — both must ride the ONE md: idiom now.
      if (src.includes('opacity-0 group-hover:opacity-100')) offenders.push(`${p} (bare)`);
      if (src.includes('sm:opacity-0 sm:group-hover:opacity-100')) offenders.push(`${p} (sm-tier)`);
    }
  };

  it('zero bare opacity-0 group-hover affordances anywhere under app/', () => {
    scan(appDir);
    expect(offenders).toEqual([]);
  });

  it('the converted sites carry the idiom (spot checks)', () => {
    const IDIOM = 'opacity-60 md:opacity-0 md:group-hover:opacity-100';
    for (const rel of [
      './crossmodel/files/page.tsx',
      './crossmodel/projects/[id]/page.tsx',
      './crossmodel/components/ConnectedInstancesSection.tsx',
      './crossmodel/components/ChatFilesSection.tsx',
      './crossmodel/profile/page.tsx',
      './crossmodel/components/code-transcript.tsx',
      './crossmodel/account/FeedbackTab.tsx',
      './crossmodel/components/GuestSidebar.tsx', // the original idiom source
    ]) {
      expect(read(rel), rel).toContain(IDIOM);
    }
  });
});

describe('P2.2 — MessageNavigator touch targets', () => {
  it('mobile tick buttons give a 44px hit area; md+ keeps the slim pointer target', () => {
    expect(NAV).toContain('size-11');
    expect(NAV).toContain('md:h-[22px] md:w-[10px]');
    // The inverted-size regression must not return (mobile smaller than desktop).
    expect(NAV).not.toContain('sm:h-[22px]');
    expect(NAV).not.toContain('h-[26px]');
  });

  it('the hover preview card is md-gated so a tap cannot latch it on touch', () => {
    expect(NAV).toContain('md:group-hover/nav:block');
    expect(NAV).not.toMatch(/hidden -translate-y-1\/2 group-hover\/nav:block/);
  });
});

// ── Item 3: one mobile convention (md:) ──────────────────────────────────────
describe('P2.3 — show/hide-on-mobile rides md:', () => {
  it('the audited mobile/desktop switch sites use md (spot checks)', () => {
    expect(read('./crossmodel/management/SupervisorChatTab.tsx')).toContain('shadow-md md:hidden');
    // User-row under-bubble stamps moved right-2 → right-10 (ticket 57542e64:
    // the copy button owns right-2 on the same line); still md-gated.
    expect(VIEW).toContain('hidden md:block absolute top-full right-10');
    expect(VIEW).toContain('md:hidden absolute top-full right-10');
    // PartTime's desktop variant (owner 2026-09-17: in-flow caption, no corner overlay).
    expect(read('./crossmodel/components/code-transcript.tsx')).toContain('hidden md:block text-[10px] leading-3');
    const feedback = read('./crossmodel/account/FeedbackTab.tsx');
    expect(feedback).toContain('flex gap-2 md:hidden');
    expect(feedback).toContain('hidden md:flex md:flex-col');
    expect(feedback).not.toContain('sm:hidden');
  });
});

// ── Item 4: composer convergence (render test) ───────────────────────────────
const renderComposer = (over: Partial<ChatComposerProps> = {}) =>
  renderToStaticMarkup(createElement(ChatComposer, {
    composerRef: { current: null },
    onSubmit: () => {},
    canSubmit: true,
    ...over,
  }));

describe('P2.4 — composer convergence (both variants, one visual language — Digby Frontier)', () => {
  it('one radius (24px) + one line border + the --shadow / --shadow-f focus treatment on both variants', () => {
    for (const html of [renderComposer({ variant: 'chat' }), renderComposer({ variant: 'code' })]) {
      expect(html).toContain('rounded-[24px]');
      expect(html).toContain('border-line');
      expect(html).toContain('shadow-(--shadow)');
      expect(html).toContain('focus-within:shadow-(--shadow-f)');
      expect(html).not.toContain('rounded-2xl border border-border/70');
    }
  });

  it('ONE send design: a 36px --send circle with ArrowUp and a 44px hit area — no gradient, no opacity fade when disabled', () => {
    for (const html of [renderComposer({ variant: 'chat' }), renderComposer({ variant: 'code' })]) {
      expect(html).toContain('bg-send');
      expect(html).toContain('size-9');
      expect(html).toContain('before:-inset-1'); // 36px + 4px/side = 44px hit area
      expect(html).toContain('disabled:bg-hover');
      expect(html).not.toContain('bg-brand-gradient');
      expect(html).not.toContain('disabled:opacity-30');
    }
  });

  it('streaming: an EMPTY draft turns the send circle into Stop; with a draft the circle queues (chat) / steers (code) and a ghost Stop sits beside it — no red, no amber', () => {
    const emptyChat = renderComposer({ variant: 'chat', isStreaming: true, onStop: () => {}, canSubmit: false });
    expect(emptyChat).toContain('title="Stop generating"');
    expect(emptyChat).not.toContain('type="submit"');
    const draftChat = renderComposer({ variant: 'chat', isStreaming: true, onStop: () => {} });
    expect(draftChat).toContain('title="Queue message"');
    expect(draftChat).toContain('title="Stop generating"');
    const draftCode = renderComposer({ variant: 'code', isStreaming: true, onStop: () => {} });
    expect(draftCode).toContain('Steer the run');
    expect(draftCode).toContain('title="Stop the run"');
    for (const html of [emptyChat, draftChat, draftCode]) {
      expect(html).not.toContain('bg-red-500');
      expect(html).not.toContain('bg-amber-500');
    }
  });
});

// ── Item 5: duplicate-bubble render safety ───────────────────────────────────
describe('P2.5 — id-dedup render safety (the backend resume fix is pinned in backend jest)', () => {
  it('the history memo dedups by id before partitioning', () => {
    // Minimal view (2026-10-16): the dedup now runs over the minimal-filtered list — still before partitioning.
    expect(VIEW).toContain('partitionQueuedEchoes(dedupById(minimal ? messages.filter(m => !isMinimalHidden(m.plainMeta)) : messages), pendingSteerIds)');
    expect(VIEW).toContain("from '@/lib/transcript-dedup'");
  });

  it('the SSE handler fences frames after a terminal event (no double complete-append)', () => {
    expect(VIEW).toContain('if (terminal) return;');
  });
});

// ── Item 6: pill geometry ────────────────────────────────────────────────────
describe('P2.6 — the chat header is in-flow (Digby Frontier replaced the floating pills)', () => {
  it('the header sits in the chat column — no fixed pills, no top fade overlay', () => {
    expect(CHROME).toContain('<header');
    expect(CHROME).toContain('data-chat-header');
    expect(CHROME).not.toContain('fixed top-0');
    expect(CHROME).not.toMatch(/\$\{PILL\} fixed /);
    // CodeSessionView mounts it above the transcript (the panel keeps its own header).
    expect(VIEW).toContain('{header}');
  });

  it('CodeSessionView hoists the OPEN panel width to the root var (0px when closed/unmounted)', () => {
    expect(VIEW).toContain("root.style.setProperty('--panel-open-w', panelRendered && panelOpen ? `${panelRail.width}px` : '0px')");
    expect(VIEW).toContain("root.style.removeProperty('--panel-open-w')");
  });
});

// ── Item 7: model label normalization ────────────────────────────────────────
describe('P2.7 — legacy model ids display-normalized through the ONE helper', () => {
  it('the workspace block (side panel Settings tab since 2026-10-06) reads through displayModelId', () => {
    const SETTINGS = read('./crossmodel/components/SessionSettingsSection.tsx');
    expect(SETTINGS).toContain('displayModelId(coding.model)');
    expect(SETTINGS).toContain("from '@/lib/model-alias'");
    expect(CHROME).not.toContain('displayModelId');
  });

  it('CodingTab reads through displayModelId (the inline ternary is gone)', () => {
    expect(CODING_TAB).toContain('displayModelId(');
    expect(CODING_TAB).not.toContain("stored === 'kimi-k2.6'");
  });
});
