/**
 * C1 smoke-verification matrix — Session UI Convergence (ticket 71b1fec6;
 * docs/archive/SESSION_UI_CONVERGENCE_DESIGN.md §3 C1.2, C0_AUDIT.md §5). One describe
 * per matrix row; every name carries the drift sha + design-doc section.
 *
 * VERIFICATION-ONLY: this file pins behavior that already landed ON the
 * converged view (plain chats render unconditionally through CodeSessionView —
 * page.tsx mounts it for any codeChatId; the PLAIN_SESSION_VIEW flag is gone).
 * It must never be edited to paper over a genuine absence — a failing row is
 * a BLOCKED finding to report, not a test to weaken.
 *
 * Two idioms, per the repo's node-environment vitest constraints (no jsdom,
 * no effects — client components render INITIAL STATE ONLY):
 *   1. SSR render via react-dom/server for pure/initial-state surfaces (same
 *      as assistant-parts.test.tsx / ChatFilesSection.test.tsx).
 *   2. SOURCE-LEVEL pins for mount/wiring inside the ~2500-line
 *      CodeSessionView (EventSource/effects make a full render infeasible):
 *      readFileSync of the component source + toContain/indexOf-ordering,
 *      anchored on stable identifiers (import lines, distinctive JSX strings,
 *      function names) — never line numbers.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { isPlainTeammateMessage, mapPlainMessages } from './plain-session';
import { displayModelName, MODEL_PERSONAS } from './model-display';
import { PlainMoreInfo, AssistantParts } from './components/code-transcript';
import MachineWakeBlock from './components/MachineWakeBlock';
import MachineTurnGroup from './components/MachineTurnGroup';
import { ChatFilesSectionView } from './components/ChatFilesSection';
import { classifySystemRow } from '@/lib/machine-wake';
import { partitionQueuedEchoes } from '@/lib/queued-echoes';
import { groupProseParts, proseGroupText, type ProseGroupItem } from '@/lib/prose-grouping';
import { formatMessageTime } from '@/lib/format-message-time';
import { routeSend, classifySteerFailure } from '@/lib/composer-guard';
import { workspaceSectionIds } from '@/lib/workspace-sections';
import type { CodingMessage, MessagePart, PlainMessageMeta } from '@/lib/api/coding';
import type { ChatFileMeta } from '@/lib/api/crossmodel';

// ── Source-level pin inputs (read once at collection) ──────────────────────
const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const VIEW = readSrc('./components/CodeSessionView.tsx'); // the converged view
const TRANSCRIPT = readSrc('./components/code-transcript.tsx');
const PAGE = readSrc('./page.tsx'); // mounts CodeSessionView for plain chats
const PLAIN_SESSION = readSrc('./plain-session.ts'); // the plain-mode bridge
const CODING_API = readSrc('../../lib/api/coding.ts');
const FILES_SECTION_SRC = readSrc('./components/ChatFilesSection.tsx');
const PREVIEW_MODAL_SRC = readSrc('./components/file-preview-modal.tsx'); // in-panel preview + the B1 preview gate (2026-08-31)
const CHIPS = readSrc('../../components/ui/custom/prompt/transcript-attachment-chips.tsx'); // shared chip row (c6e8edda)
const SUPERVISOR_TAB = readSrc('./management/SupervisorChatTab.tsx'); // the management-tab fleet thread (machine-turn grouping + nav rail)

/** Persona naming rule (owner ticket 7bdbe40c): raw vendor strings never render. */
const VENDOR_RE = /kimi|glm|deepseek|openai|xai|gemini|anthropic|alibaba|fireworks|cohere/i;

const t = (text: string): MessagePart => ({ type: 'text', text } as MessagePart);
const r = (text: string): MessagePart => ({ type: 'reasoning', text } as MessagePart);

/** Slice helper for region-anchored pins (fails loudly when an anchor drifts). */
function region(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to);
  expect(a, `region anchor ${JSON.stringify(from)} missing`).toBeGreaterThanOrEqual(0);
  expect(b, `region anchor ${JSON.stringify(to)} missing`).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('C1 smoke [1b1ce2af] persona display names (design D3, §3 C1.2)', () => {
  // The plain More-info surface: PlainMoreInfo IS exported from
  // code-transcript.tsx (PlainModelCard is module-private). SSR renders its
  // INITIAL (collapsed) state — the per-model cards open behind a click — so
  // the rendered-label pipeline is pinned at source level + exercised
  // executably through displayModelName on the same fixture inputs.
  const meta = {
    mode: 'thinking',
    modelSet: 'frontier',
    // Backend-sent labels are vendor-ish by design — the render must personas them.
    modelLabels: { openai: 'GPT-5.6', grok: 'Grok 4.5', gemini: 'Gemini 3 Pro (thinking)' },
    models: {
      openai: { response: 'veteran answer', time: 1200 },
      grok: { response: 'maverick answer', time: 900 },
      gemini: { response: 'scholar answer', time: 1500 },
    },
  } as PlainMessageMeta;

  it('SSR: PlainMoreInfo mounts in the converged bundle and its initial markup leaks no raw vendor label', () => {
    const html = renderToStaticMarkup(createElement(PlainMoreInfo, { meta }));
    expect(html).toContain('More info');
    // Collapsed initial state: the vendor-ish source labels stay behind the toggle.
    expect(html).not.toContain('GPT-5.6');
    expect(html).not.toContain('Grok 4.5');
    expect(html).not.toContain('Gemini 3 Pro');
    expect(html).not.toMatch(VENDOR_RE);
  });

  it('the label pipeline yields persona names for the fixture labels — and never a vendor string', () => {
    for (const key of Object.keys(meta.models!)) {
      const label = displayModelName(meta.modelLabels?.[key] || key);
      expect(label).toBe(MODEL_PERSONAS[key].name);
      expect(label).not.toMatch(VENDOR_RE);
    }
    // Unknown future ids fall back to 'AI Agent' — never leak a raw id.
    expect(displayModelName('vendor-x9-ultra')).toBe('AI Agent');
    expect(displayModelName('accounts/fireworks/models/some-new-thing')).toBe('AI Agent');
  });

  it('source pin: code-transcript.tsx routes every More-info label through displayModelName (../model-display)', () => {
    expect(TRANSCRIPT).toContain("import { displayModelName, SEAT_LABELS } from '../model-display';");
    // Summary row + per-card label take the seat/persona path…
    expect(TRANSCRIPT).toContain('displayModelName(meta.modelLabels?.[m] || PLAIN_MODEL_LABELS[m] || m)');
    expect(TRANSCRIPT).toContain('displayModelName(meta.modelLabels?.[k] || PLAIN_MODEL_LABELS[k] || k)');
    // …while the modelUsed badge on the ADMIN-only More-info card shows the id
    // that actually served the seat, verbatim (owner 2026-09-15: the panel
    // exists to check that the configured seats are what ran).
    expect(TRANSCRIPT).toContain('{response.modelUsed}');
    expect(TRANSCRIPT).toContain("digby: SEAT_LABELS.digby,");
  });

  it('source pin: the per-model response cards stay admin-only — reachable from each "How Digby answered" row (Digby Frontier)', () => {
    expect(VIEW).toContain('renderDetail={plain.isAdmin ? (r) => <PlainModelCard label={r.name}');
    expect(VIEW).toContain('<HowDigbyAnswered');
  });
});

describe('C1 smoke [edf3e247] collapse inter-agent + system rows (design D3)', () => {
  it('mapPlainMessages carries metadata.origin through to row.plainMeta', () => {
    const rows = mapPlainMessages({
      messages: [
        { id: 'm1', role: 'user', content: 'Nightly digest wake payload', metadata: { origin: 'schedule' }, createdAt: '2026-08-29T10:00:00.000Z' },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].plainMeta?.origin).toBe('schedule');
    // …and that bridged stamp is exactly what classifySystemRow keys on.
    expect(classifySystemRow({ role: rows[0].role, content: rows[0].content, metadata: rows[0].plainMeta })).toBe('wake');
  });

  it('classifySystemRow returns a kind for machine-origin content', () => {
    expect(classifySystemRow({ role: 'user', content: 'nudge', metadata: { origin: 'agent' } })).toBe('agent');
    expect(classifySystemRow({ role: 'user', content: 'watchdog note', metadata: { origin: 'attention-watchdog' } })).toBe('system');
    expect(classifySystemRow({ role: 'user', content: 'webhook fire', metadata: { origin: 'webhook' } })).toBe('wake');
  });

  it('a human row NEVER collapses: absent/unknown/user origin + normal content → null', () => {
    expect(classifySystemRow({ role: 'user', content: 'hello from the owner', metadata: undefined })).toBeNull();
    expect(classifySystemRow({ role: 'user', content: 'hello again', metadata: { origin: 'user' } })).toBeNull();
    expect(classifySystemRow({ role: 'user', content: 'mystery', metadata: { origin: 'something-new' } })).toBeNull();
    // Assistant rows are out of scope even with a machine-looking stamp.
    expect(classifySystemRow({ role: 'assistant', content: 'x', metadata: { origin: 'agent' } })).toBeNull();
  });
});

describe('C1 smoke [1bd184ae] MachineWakeBlock one-line rows (design D3)', () => {
  it('SSR collapsed: a one-line summary row with an expand control (full payload hidden)', () => {
    const html = renderToStaticMarkup(createElement(MachineWakeBlock, {
      content: "[MACHINE-TRIGGERED RUN — event: run_completed]\nresult from 'Nightly digest'\n[full payload lines]",
      kind: 'wake',
      origin: 'schedule',
      timeLabel: '3:05 PM',
    }));
    expect(html).toContain('⚙ Machine wake'); // kind label
    expect(html).toContain('fleet event (run_completed)'); // summarized event
    expect(html).toContain('Nightly digest'); // summarized source title
    expect(html).toContain('3:05 PM'); // inline time label
    // Single-row expand control: one <button aria-expanded="false">, truncated variables.
    expect(html).toContain('<button');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('truncate');
    // The verbatim payload renders ONLY in the expanded <pre> — hidden initially.
    expect(html).not.toContain('[full payload lines]');
    expect(html).not.toContain('<pre');
  });

  it('SSR collapsed: a system row shows its origin stamp + one-line preview', () => {
    const html = renderToStaticMarkup(createElement(MachineWakeBlock, {
      content: 'Attention watchdog: chat idle 6h\nsecond line',
      kind: 'system',
      origin: 'attention-watchdog',
    }));
    expect(html).toContain('⚙ System message');
    expect(html).toContain('(attention-watchdog)');
    expect(html).toContain('— Attention watchdog: chat idle'); // summarizeSystemRow preview
    expect(html).not.toContain('second line'); // one-line only until expanded
  });

  it('source pin: the message loop classifies + mounts MachineWakeBlock with origin and timeLabel', () => {
    expect(VIEW).toContain("import MachineWakeBlock from './MachineWakeBlock';");
    expect(VIEW).toContain("import { classifyAssistantCard, classifySystemRow } from '@/lib/machine-wake';");
    // classifySystemRow call site keys on the bridged plainMeta stamp.
    expect(VIEW).toContain('classifySystemRow({ role: m.role, content: m.content, metadata: m.plainMeta })');
    expect(VIEW).toContain(
      '<MachineWakeBlock key={m.id} kind={sysKind} origin={m.plainMeta?.origin} content={m.content} timeLabel={timeLabel ?? undefined} />',
    );
  });
});

describe('C1 smoke [platform 2026-09-03] MachineTurnGroup per-wake accordion (mega-accordion fix)', () => {
  it('SSR collapsed: header renders time, summary-note headline, hidden count — rows hidden', () => {
    const html = renderToStaticMarkup(createElement(MachineTurnGroup, {
      count: 14,
      summary: "run_completed from 'Nightly Engineer'",
      headline: 'Fleet wake — 2 lane completions, both no-ops',
      timeLabel: '10:05 PM',
    }, createElement('div', null, 'RAW-ROW-CONTENT')));
    // The owner's scannable label: time — headline · +N detail rows (the
    // truthful name for what the fold holds — envelope + chrome + the note;
    // owner polish pass 2026-09-03, replacing the vague "items hidden").
    expect(html).toContain('10:05 PM');
    expect(html).toContain('Fleet wake — 2 lane completions, both no-ops'); // the run's OWN headline
    expect(html).toContain('+14 detail rows');
    expect(html).toContain('aria-expanded="false"');
    // Collapse, never filter: the raw rows render only behind the click.
    expect(html).not.toContain('RAW-ROW-CONTENT');
  });

  it('SSR collapsed: semantic tone tint from the SHARED classifier (owner polish 2026-09-03)', () => {
    // 'quiet' headline → dimmed, no accent border.
    const quiet = renderToStaticMarkup(createElement(MachineTurnGroup, {
      count: 2, summary: 'machine wake', headline: 'Fleet sweep — all lanes idle, no owner action', timeLabel: '4:05 AM',
    }, createElement('div')));
    expect(quiet).toContain('text-muted-foreground/70');
    expect(quiet).not.toContain('border-l-indigo-500/60');
    // 'attention' headline (inflected "interrupted" must classify) → warm left border.
    const attention = renderToStaticMarkup(createElement(MachineTurnGroup, {
      count: 2, summary: 'machine wake', headline: '⚠ This turn was interrupted', timeLabel: '4:05 AM',
    }, createElement('div')));
    expect(attention).toContain('border-l-warn/70'); // Frontier sweep: the --warn token, not raw amber
    // 'action' headline → the Fleet-summary card's indigo left border.
    const action = renderToStaticMarkup(createElement(MachineTurnGroup, {
      count: 2, summary: 'machine wake', headline: 'Fleet sweep — merged PR #612, relayed digest', timeLabel: '4:05 AM',
    }, createElement('div')));
    expect(action).toContain('border-l-line-2/60'); // Frontier sweep: neutral, not indigo
  });

  it('SSR collapsed: a chrome-only run falls back to the wake event summary, singular count, NEUTRAL tint', () => {
    const html = renderToStaticMarkup(createElement(MachineTurnGroup, {
      count: 1, summary: 'machine wake', headline: '', timeLabel: '3:41 AM',
    }, createElement('div')));
    expect(html).toContain('machine wake');
    expect(html).toContain('+1 detail row');
    expect(html).not.toContain('+1 detail rows');
    // No headline ⇒ no verdict ⇒ no semantic accent.
    expect(html).not.toContain('border-l-amber-500/70');
    expect(html).not.toContain('border-l-indigo-500/60');
  });

  it('source pin: CodeSessionView groups the windowed history slice and mounts MachineTurnGroup', () => {
    expect(VIEW).toContain("import MachineTurnGroup from './MachineTurnGroup';");
    expect(VIEW).toContain("import { bundleMachineGroups, groupMachineRows, type MachineTurnGroup as MachineTurnGroupItem } from '@/lib/machine-turn-grouping';");
    // The grouping wraps the SAME windowed slice the loop always rendered.
    expect(VIEW).toContain('groupMachineRows(slice, {');
    expect(VIEW).toContain('origin: m.plainMeta?.origin');
    expect(VIEW).toContain('<MachineTurnGroup key={item.key}');
    // Groups and singles share ONE row renderer (no second render path) —
    // grouped rows (incl. the run's final note) flow through renderHistoryRow.
    expect(VIEW).toContain('{item.rows.map(r => renderHistoryRow(r))}');
    expect(VIEW).toContain('renderHistoryRow(item.row)');
    // The summary-note headline feeds the group label.
    expect(VIEW).toContain('headline={item.headline}');
  });

  it('source pin: owner-armed digest wiring (ticket 6ef770a1) — probe + expanded mount', () => {
    // The probe threads metadata.scheduleOwnerArmed off the plain-chat row.
    expect(VIEW).toContain('ownerArmed: m.plainMeta?.scheduleOwnerArmed === true');
    // The mount passes the group's anchor flag so owner-armed digests render
    // EXPANDED and marked (MachineTurnGroup expands on ownerArmed itself).
    expect(VIEW).toContain('ownerArmed={item.ownerArmed}');
  });

  it('SSR (ticket 6ef770a1): an owner-armed machine group renders EXPANDED with the requested marker — rows visible', () => {
    const html = renderToStaticMarkup(createElement(MachineTurnGroup, {
      count: 3,
      summary: 'machine wake',
      headline: 'Latest AI trends and releases on X — daily digest',
      timeLabel: '7:30 AM',
      ownerArmed: true,
    }, createElement('div', null, 'RAW-DIGEST-CONTENT')));
    // Expanded at mount: no collapsed state, the rows render in the initial
    // HTML (the owner reads the digest with ZERO clicks — the ticket's ask).
    expect(html).not.toContain('aria-expanded="false"');
    expect(html).toContain('RAW-DIGEST-CONTENT');
    // The "requested" marker distinguishes owner-armed content from internal
    // wake noise (the ticket's second ask).
    expect(html).toContain('requested');
    expect(html).toContain('data-owner-armed');
    // The owner-armed accent rule (Digby Frontier: neutral ink-3, no violet),
    // not the internal-noise row.
    expect(html).toContain('border-l-ink-3/60');
  });

  it('SSR (ticket 6ef770a1): a normal machine group still renders COLLAPSED with no marker — legacy behavior untouched', () => {
    const html = renderToStaticMarkup(createElement(MachineTurnGroup, {
      count: 3,
      summary: 'machine wake',
      headline: 'Fleet sweep — all lanes idle',
      timeLabel: '4:05 AM',
    }, createElement('div', null, 'RAW-WAKE-CONTENT')));
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('RAW-WAKE-CONTENT');
    expect(html).not.toContain('requested');
    expect(html).not.toContain('data-owner-armed');
    expect(html).not.toContain('border-l-ink-3/60');
  });

  it('source pin (ticket 390b6767): image-bearing group wiring — probe flags + expanded mount', () => {
    // The probe threads the content-invisible image signals (image parts,
    // resolved attachment chips) so the grouping can flag the group.
    expect(VIEW).toContain("!!m.parts?.some(p => p.type === 'image')");
    expect(VIEW).toContain('hasImage={item.hasImage}');
  });

  it('SSR (ticket 390b6767): an image-bearing machine group renders EXPANDED with the image chip — rows visible', () => {
    const html = renderToStaticMarkup(createElement(MachineTurnGroup, {
      count: 2,
      summary: 'machine wake',
      headline: 'Test image delivered — qwen_v1_test.png',
      timeLabel: '10:05 AM',
      hasImage: true,
    }, createElement('div', null, 'RAW-DELIVERED-IMAGE')));
    // Expanded at mount: the delivered image is visible with ZERO clicks
    // (the owner's invisible-test-image report).
    expect(html).not.toContain('aria-expanded="false"');
    expect(html).toContain('RAW-DELIVERED-IMAGE');
    // The pill's image chip — the collapsed hint that this turn carries one.
    expect(html).toContain('data-group-image');
    expect(html).toContain('image');
  });

  it('SSR (ticket 390b6767): an image-free machine group stays collapsed with NO image chip (regression pin)', () => {
    const html = renderToStaticMarkup(createElement(MachineTurnGroup, {
      count: 2,
      summary: 'machine wake',
      headline: 'Fleet sweep — quiet',
      timeLabel: '4:05 AM',
    }, createElement('div', null, 'RAW-WAKE-CONTENT')));
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('RAW-WAKE-CONTENT');
    expect(html).not.toContain('data-group-image');
  });

  it('source pin (fixer 2026-09-27, upward-chatter-1): owner-ask wake wiring — probe flag + expanded mount on BOTH surfaces', () => {
    expect(VIEW).toContain('ownerAskReply: m.plainMeta?.ownerAskReply === true');
    expect(VIEW).toContain('ownerAskReply={item.ownerAskReply}');
    expect(SUPERVISOR_TAB).toContain('ownerAskReply: m.ownerAskReply === true');
    expect(SUPERVISOR_TAB).toContain('ownerAskReply={item.ownerAskReply}');
  });

  it('SSR (fixer 2026-09-27): an owner-ask machine group renders EXPANDED with the answer chip — the reply is visible with zero clicks', () => {
    const html = renderToStaticMarkup(createElement(MachineTurnGroup, {
      count: 2,
      summary: 'machine wake',
      headline: 'We are at 5.08 tok/s of record; the bisect is on rung zf.',
      timeLabel: '7:16 PM',
      ownerAskReply: true,
    }, createElement('div', null, 'RAW-OWNER-ASK-ANSWER')));
    expect(html).not.toContain('aria-expanded="false"');
    expect(html).toContain('RAW-OWNER-ASK-ANSWER');
    expect(html).toContain('data-owner-ask-reply');
    expect(html).toContain('answer');
  });

  it('source pin (ticket 56d6b204): child-result wake wiring — probe flag + expanded mount on BOTH surfaces', () => {
    // The plain-chat probe threads metadata.childResult off the row.
    expect(VIEW).toContain('childResult: m.plainMeta?.childResult === true');
    expect(VIEW).toContain('childResult={item.childResult}');
    // The fleet SupervisorChatTab probe reads the flattened field.
    expect(SUPERVISOR_TAB).toContain('childResult: m.childResult === true');
    expect(SUPERVISOR_TAB).toContain('childResult={item.childResult}');
  });

  it('SSR (ticket 56d6b204): a child-result machine group renders EXPANDED with the results chip — rows visible', () => {
    const html = renderToStaticMarkup(createElement(MachineTurnGroup, {
      count: 2,
      summary: 'machine wake',
      headline: 'DB audit results: three admin accounts found',
      timeLabel: '2:05 PM',
      childResult: true,
    }, createElement('div', null, 'RAW-SUBSESSION-RESULTS')));
    // Expanded at mount: the sub-session's delivered verdict is visible with
    // ZERO clicks — the ticket's ask ("hidden in a machine accordion").
    expect(html).not.toContain('aria-expanded="false"');
    expect(html).toContain('RAW-SUBSESSION-RESULTS');
    // The "results" chip distinguishes delivered sub-session work from
    // internal wake noise.
    expect(html).toContain('results');
    expect(html).toContain('data-child-result');
  });

  it('SSR (ticket 56d6b204): a normal hook-wake group still renders COLLAPSED with no results chip (regression pin)', () => {
    const html = renderToStaticMarkup(createElement(MachineTurnGroup, {
      count: 2,
      summary: 'machine wake',
      headline: 'Fleet sweep — quiet',
      timeLabel: '4:05 AM',
    }, createElement('div', null, 'RAW-WAKE-CONTENT')));
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('RAW-WAKE-CONTENT');
    expect(html).not.toContain('data-child-result');
  });

  it('source pin: SupervisorChatTab groups the thread, stamps owner rows, mounts the nav rail', () => {
    expect(SUPERVISOR_TAB).toContain("import MachineTurnGroup from '../components/MachineTurnGroup';");
    expect(SUPERVISOR_TAB).toContain("import { bundleMachineGroups, groupMachineRows, type MachineTurnGroup as MachineTurnGroupItem } from '@/lib/machine-turn-grouping';");
    expect(SUPERVISOR_TAB).toContain('groupMachineRows(thread, {');
    expect(SUPERVISOR_TAB).toContain('headline={item.headline}');
    // The jump-to-your-message control (the main chat's rail): owner rows are
    // stamped and the shared MessageNavigator mounts on the thread scroller.
    expect(SUPERVISOR_TAB).toContain("'data-nav-msg': m.id");
    expect(SUPERVISOR_TAB).toContain('<MessageNavigator scrollerRef={threadRef} contentRef={threadContentRef} />');
    // Ticket 390b6767 (review follow-up): the probe flags content-invisible
    // image signals AND the mount passes hasImage — a probe line without the
    // mount prop is exactly how the supervisor surface shipped broken while
    // the CodeSessionView pin passed.
    expect(SUPERVISOR_TAB).toContain('!!m.attachments?.some(a => !!a.fileId');
    expect(SUPERVISOR_TAB).toContain('hasImage={item.hasImage}');
  });

  it('source pin: queued attachments are never refused client-side (owner regression 2026-09-03)', () => {
    // The old busy+attachments block ("queued messages can't carry
    // attachments yet") WAS the attachments-stuck-queued bug: the backend has
    // carried queued uploads since ac65d51e (TTL stretch + drain resolve), so
    // a client-side refusal just lets the 15-min blobs expire.
    expect(SUPERVISOR_TAB).not.toContain('queued messages can’t carry attachments');
    expect(SUPERVISOR_TAB).not.toContain("attachments.length > 0 && (running || queuedCount > 0)");
    // …and the send still hands every staged uploadId to the fleet endpoint.
    expect(SUPERVISOR_TAB).toContain('fleetApi.sendSupervisorMessage(content, uploadIds)');
  });

  it('source pin: mobile jump-to-your-message floating button (owner report 2026-09-03)', () => {
    // The rail's 2px ticks are untappable on a phone — a real button, mobile
    // only (md:hidden — the app's ONE mobile breakpoint, P2 item 3), scrolling
    // the latest owner row into view.
    expect(SUPERVISOR_TAB).toContain('jumpToLastOwnerMessage');
    expect(SUPERVISOR_TAB).toContain("querySelectorAll('[data-nav-msg]')");
    expect(SUPERVISOR_TAB).toContain("scrollIntoView({ behavior: 'smooth', block: 'center' })");
    expect(SUPERVISOR_TAB).toContain('Your last message');
    expect(SUPERVISOR_TAB).toContain('md:hidden');
  });

  it('source pin: the live/thinking region is INLINE in the scroller and collapses on completion (owner report 2026-09-03)', () => {
    // The sticky half-height panel bug: the live region rendered as a
    // shrink-0 sibling OUTSIDE the thread scroller. It must mount INSIDE the
    // scroller (before its closing tag, after the content div)…
    const scroller = SUPERVISOR_TAB.indexOf('overflow-y-auto rounded-md border border-border bg-muted/20');
    const liveRegion = SUPERVISOR_TAB.indexOf('INLINE at the end of the message flow');
    const rail = SUPERVISOR_TAB.indexOf('<MessageNavigator scrollerRef={threadRef}');
    expect(scroller).toBeGreaterThan(-1);
    expect(liveRegion).toBeGreaterThan(scroller);
    expect(liveRegion).toBeLessThan(rail);
    // …and on completion the parts collapse to the one-line status indicator
    // (AssistantParts only renders while actually running).
    expect(SUPERVISOR_TAB).toContain('running && liveParts.length > 0 && (');
    expect(SUPERVISOR_TAB).toContain('Finishing up…');
  });
});

describe('C1 smoke [590031fb] queued steer echoes below the live block (design §3 C1.2)', () => {
  const mk = (id: string, extra?: Partial<CodingMessage>): CodingMessage => ({
    id, role: 'user', content: `msg ${id}`, createdAt: '2026-08-29T10:00:00.000Z', ...extra,
  });

  it('partitionQueuedEchoes splits steer-*/tmp-* echo rows out of history (plain-mode shapes intact)', () => {
    const older = mk('srv-0');
    const latest = mk('srv-1');
    const plainQueueEcho = mk('tmp-1788042547000', {
      plainMeta: { attachments: [{ filename: 'notes.txt', type: 'document' }] },
    });
    const steerEcho = mk('steer-1788042547001', { parts: [t('msg steer-1788042547001')] });
    const source = [older, plainQueueEcho, latest, steerEcho];
    const { history, queuedEchoes } = partitionQueuedEchoes(source, new Set([plainQueueEcho.id, steerEcho.id]));
    expect(history.map(m => m.id)).toEqual(['srv-0', 'srv-1']); // relative order preserved
    expect(queuedEchoes.map(m => m.id)).toEqual([plainQueueEcho.id, steerEcho.id]);
    // Plain-mode shape survives the partition (attachment chips ride the echo row).
    expect(queuedEchoes[0].plainMeta?.attachments?.[0].filename).toBe('notes.txt');
    // Inputs are not mutated; an empty pending set is the identity partition.
    expect(source).toHaveLength(4);
    expect(partitionQueuedEchoes(source, new Set()).queuedEchoes).toHaveLength(0);
  });

  it('source pin ORDERING: the queued-echo render block appears AFTER the live run block', () => {
    // Anchors: the live block opens with the `{/* Live run */}` JSX comment; the
    // echo block opens with `{queuedEchoes.map(m => {`. Both are distinctive and
    // stable (the alternative — an index into line numbers — is not).
    const liveAnchor = VIEW.indexOf('{/* Live run */}');
    const echoAnchor = VIEW.indexOf('{queuedEchoes.map(m => {');
    expect(liveAnchor).toBeGreaterThanOrEqual(0);
    expect(echoAnchor).toBeGreaterThan(liveAnchor);
  });

  it('source pin: the "Queued" caption + per-echo send-time label render in the echo block', () => {
    const block = region(VIEW, '{queuedEchoes.map(m => {', '{showJumpToEnd');
    expect(block).toContain('label="Queued"');
    // Ticket fb3cb4e2: the caption text moved INTO queuedCaption (lib/
    // queue-controls.ts, pinned by its own tests) because the bubble now also
    // carries the queue POSITION the removed container used to show. The block
    // must still pick the right TRUTH per surface — plain vs coding — via the
    // `coding` flag, so pin that wiring rather than a literal that now lives in
    // the helper.
    expect(block).toContain('queuedCaption({');
    expect(block).toContain('coding: !plain');
    expect(block).toContain('formatMessageTime(m.createdAt)'); // per-echo send time
    expect(block).toContain('`· ${timeLabel}`'); // caption · time composition
  });
});

describe('migration display audit: message fragment ids (#msg-<id>)', () => {
  // Owner-question "Open in chat" deep links need a real fragment target.
  // data-msg-id is the in-page scroll handle; id="msg-<id>" is the URL fragment.
  it('history rows carry id="msg-<id>" next to data-msg-id', () => {
    for (const src of [VIEW, SUPERVISOR_TAB]) {
      const needle = 'id={`msg-${m.id}`}';
      const at = src.indexOf(needle);
      expect(at).toBeGreaterThan(-1);
      expect(src.slice(at, at + 120)).toContain('data-msg-id={m.id}');
    }
  });
});

describe('C1 smoke [42aeabf3] queued messages carry attachments (design §3 C1.2)', () => {
  it('source pin: NO refusal gate remains for queued-with-attachments in the plain path', () => {
    for (const refusal of ["can't carry attachments", 'cannot carry attachments', 'can’t carry attachments']) {
      expect(VIEW.includes(refusal), `refusal gate ${JSON.stringify(refusal)} must be gone from CodeSessionView`).toBe(false);
      expect(PLAIN_SESSION.includes(refusal), `refusal gate ${JSON.stringify(refusal)} must be gone from plain-session`).toBe(false);
    }
  });

  it('source pin: the echo bubble renders plainMeta.attachments chips', () => {
    expect(VIEW).toContain('m.plainMeta?.attachments && m.plainMeta.attachments.length > 0');
    // c6e8edda: the chip row is the SHARED TranscriptAttachmentChips (extracted
    // so CodeSessionView + SupervisorChatTab can never diverge) — the view hands
    // it the echo's attachments; the per-chip map + filename label live in the
    // shared component's own source (pinned below, behavior-tested in
    // transcript-attachment-chips.test.tsx).
    expect(VIEW).toContain('<TranscriptAttachmentChips');
    expect(VIEW).toContain('attachments={m.plainMeta.attachments}');
    expect(CHIPS).toContain('attachments.map((a, i) => (');
    expect(CHIPS).toContain('{a.filename}'); // chip label
  });

  it('source pin: the queue/send path carries uploadIds (echo → busy-queue → SSE URL)', () => {
    // send() snapshots the page's staged attachments into uploadIds…
    expect(VIEW).toContain('const uploadIds = atts.map(a => a.uploadId);');
    // …hands them to the busy-queue passthrough while a turn is live…
    // (ea04454c: the call also carries an onQueued callback so "Send now" can
    // promote exactly this row — the uploadIds argument is unchanged.)
    expect(VIEW).toContain('void queuePlainBehindLive(sid, effectiveMessage, plainCfg, uploadIds, {');
    // …and to the direct send URL otherwise (63bb607f: the guest session's
    // named context key rides the same call site; 2026-09-26: so does the
    // patience-plan label-window modeSource — label-window-mode-source.test.ts).
    // 2026-09-26 depth UX: the same call also carries the Dig-deeper escalationOf (depth-ux-wiring.test.ts).
    expect(VIEW).toContain('buildPlainStreamUrl({ chatId: sid, message: effectiveMessage, mode: plainCfg.mode, modeSource: plainCfg.modeSource, webSearch: plainCfg.webSearch, uploadIds, sessionId: plainCfg.guestSessionId, userLocation: plainCfg.guest ? plainCfg.guestLocation?.() : undefined, escalationOf, ghost: plainCfg.ghost })');
    // plain-session.ts puts them on the wire (GET param + >1500-char register body).
    expect(PLAIN_SESSION).toContain("p.uploadIds?.forEach(id => q.append('uploadId', id));");
    expect(PLAIN_SESSION).toContain('regBody.uploadId = p.uploadIds');
  });

  it('backend drain-side resolve-on-drain coverage EXISTS (cited — no new test added)', () => {
    // backend/src/modules/crossmodel/chat-agent/message-queue.test.ts already
    // covers drainChatQueue resolving staged uploadIds like an immediate send:
    //   - L350 'queued attachments (ac65d51e): the drain resolves staged ids
    //     into the run — documentText + chip metadata'
    //   - L367 'queued attachments (ac65d51e): an expired blob annotates the
    //     drained message — never a silent drop'
    // Per the matrix this row CITES the coverage instead of adding a backend
    // test; the readFileSync below is a tripwire so the citation can't rot.
    const backendMqTest = readSrc('../../../backend/src/modules/crossmodel/chat-agent/message-queue.test.ts');
    expect(backendMqTest).toContain('the drain resolves staged ids into the run');
    expect(backendMqTest).toContain('an expired blob annotates the drained message');
  });
});

describe('C1 smoke [10199291] prose-fragment grouping + Hide-thinking (design §3 C0 acceptance)', () => {
  it('groupProseParts: T,R,T,R interleave → ONE flowing block + thoughts (byte-lossless join)', () => {
    const groups = groupProseParts([t('Hello '), r('thinking one'), t('world.'), r('thinking two'), t(' Tail')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('prose');
    const g = groups[0] as ProseGroupItem;
    expect(proseGroupText(g)).toBe('Hello world. Tail'); // exact text-channel join
    expect(g.thoughts.map(th => th.text)).toEqual(['thinking one', 'thinking two']);
  });

  it('SSR AssistantParts with hideThinking: joined prose stays, thought rows/chips collapse', () => {
    const html = renderToStaticMarkup(createElement(AssistantParts, {
      parts: [t('Hello '), r('thinking one'), t('world.'), r('thinking two'), t(' Tail')],
      hideThinking: true,
    }));
    expect(html).toContain('Hello world. Tail');
    expect(html).not.toContain('thinking one'); // reasoning content hidden
    expect(html).not.toContain('thought'); // no thoughts chip
    expect(html).not.toContain('Thinking…');
  });

  it('source pin: CodeSessionView passes hideThinking to AssistantParts and the Hide-thinking pill exists', () => {
    // History rows AND the live block both honor the toggle.
    expect(VIEW.split('hideThinking={hideThinking}').length - 1).toBeGreaterThanOrEqual(2);
    expect(VIEW).toContain("{hideThinking ? 'Show thinking' : 'Hide thinking'}");
    expect(VIEW).toContain("'Collapse all thought rows and join the surrounding prose'");
    // The grouping transform itself is imported by the shared transcript renderer.
    expect(TRANSCRIPT).toContain("import { groupProseParts, proseGroupText, type ProseGroupItem } from '@/lib/prose-grouping';");
  });
});

describe('C1 smoke [96b0da27] per-message timestamps (design D3)', () => {
  it('formatMessageTime: valid ISO → label; null/empty/invalid → null', () => {
    expect(formatMessageTime(new Date().toISOString())).toBeTypeOf('string'); // today → time-only
    const old = formatMessageTime('2020-01-15T10:30:00.000Z');
    expect(old).toBeTypeOf('string');
    expect(old).toContain('2020'); // previous-day stamp prefixes the date
    expect(formatMessageTime(undefined)).toBeNull();
    expect(formatMessageTime('')).toBeNull();
    expect(formatMessageTime('not-a-date')).toBeNull();
  });

  it('source pin: user row has desktop hover span + mobile span, assistant row mirrors', () => {
    // The row wrapper opts into group-hover, and the stamp is gated on timeLabel.
    expect(VIEW).toContain('group/msg relative flex');
    expect(VIEW).toContain("{timeLabel && (m.role === 'user' ? (");
    // User row: desktop hover-revealed corner stamp + mobile always-visible
    // span (md: — the app's ONE mobile breakpoint, P2 item 3). The stamps sit
    // at right-10 (ticket 57542e64): right-2 is the copy button's slot on the
    // same under-bubble line.
    expect(VIEW).toContain('hidden md:block absolute top-full right-10 mt-0.5 z-10 text-[10px] text-muted-foreground/70 whitespace-nowrap opacity-0 group-hover/msg:opacity-100');
    expect(VIEW).toContain('md:hidden absolute top-full right-10 mt-0.5 text-[10px] text-muted-foreground whitespace-nowrap');
    // Copy shortcut on the user's own bubble (ticket 57542e64): one-click copy
    // mirroring the assistant row, rendered for user rows with text.
    expect(VIEW).toContain('<UserMessageCopyButton content={m.content} />');
    // Assistant rows (owner 2026-09-17 "all time stamps … underneath"): NO
    // corner overlay — the stamp renders under the message, in the plain
    // action row (PlainMessageActions timeLabel) or the coding footer line.
    expect(VIEW).not.toContain('hidden md:block absolute top-1 right-2 z-10 text-[10px]');
    expect(VIEW).not.toContain('md:hidden absolute top-full left-2 mt-0.5 text-[10px]');
    expect(VIEW).toContain('timeLabel={timeLabel ?? undefined} />');
    // Coding rows (ticket bd5b95b5): a persisted answer's stamp rides the shared
    // action row; every other coding row keeps the bare footer line.
    expect(VIEW).toContain('{!plain && !codingRow && timeLabel && (');
    expect(VIEW).toContain('{!plain && codingRow && (');
  });

  it('source pin: the LIVE block renders no per-message timestamp', () => {
    // Region anchor: the live block spans `{/* Live run */}` … `{queuedEchoes.map`.
    // Its only timing affordance is the run-level ElapsedTimer (inside the
    // LiveRunStatus leaf since 2026-09-27) — formatMessageTime (the per-message
    // stamp helper) must not appear inside it.
    const liveBlock = region(VIEW, '{/* Live run */}', '{queuedEchoes.map(m => {');
    expect(liveBlock).not.toContain('formatMessageTime');
    expect(liveBlock).toContain('<LiveRunStatus stopping={live.stopping} status={live.status} since={runStart} />'); // sanity: the region is the live block
  });
});

describe('C1 smoke [d181b391] per-chat Files panel section (design D1)', () => {
  it('source pin: the workspace section registry mounts ChatFilesSection', () => {
    expect(VIEW).toContain("import ChatFilesSection from './ChatFilesSection';");
    // Region: the registry's files case, up to the next case (schedules).
    const filesCase = region(VIEW, "case 'files':", "case 'schedules':");
    // 2026-10-07 ("not artifacts it should just all be files"): the list is
    // multi-line and carries the session's documents as rows (docs=).
    expect(filesCase).toMatch(/<ChatFilesSection\s+chatId=\{chatId\}\s+refreshKey=\{filesRefreshKey\}\s+docs=\{chatFiles\}/);
    expect(filesCase).toContain('<FilesPane');
  });

  it('source pin: the html/svg Download-only XSS gate lives in the preview kind gate', () => {
    // View-level re-pin of the B1 gate (exhaustively pinned in
    // ChatFilesSection.test.tsx — describe 'scripting-capable essences get NO
    // Preview' — and in file-preview-modal.test.tsx): scripting-capable
    // essences mirror the backend's needsInlineSandbox and never get a Preview
    // action. The gate moved into previewKindForMime (2026-08-31) when Preview
    // became the in-panel FilePreviewModal.
    expect(PREVIEW_MODAL_SRC).toContain("if (m === 'text/html' || m === 'image/svg+xml') return null;");
    // …and the row-level gate routes through it (no parallel mime logic).
    expect(FILES_SECTION_SRC).toContain('previewKindForMime');
  });

  it('SSR minimal re-pin at the view level: an html upload renders Download but NO Preview', () => {
    const htmlUpload: ChatFileMeta = {
      id: 's1', filename: 'payload.html', mimeType: 'text/html', sizeBytes: 128,
      createdAt: new Date(Date.now() - 86_400_000).toISOString(), uploadId: null,
    };
    const html = renderToStaticMarkup(createElement(ChatFilesSectionView, {
      uploads: [htmlUpload], generated: [], status: 'ready',
    }));
    expect(html).toContain('payload.html');
    expect(html).toContain('Download file');
    expect(html).not.toContain('Preview');
  });
});

describe('C1 smoke [2cb3018d] composer status truth lives BELOW the pill (design D4; owner 2026-09-17 "no text in the placeholder")', () => {
  it('source pin: the placeholder is the invitation only; every per-status line is the footer note', () => {
    // Region anchor: the ChatComposer placeholder prop expression, from
    // `placeholder={voice.isRecording` to the next prop (`dragOver={dragOver}`).
    const ph = region(VIEW, 'placeholder={voice.isRecording', 'dragOver={dragOver}');
    // Frontier redesign (2026-10-06): the plain invitation is the design's
    // "How can I help today?" on an empty chat, "Reply to Digby…" after.
    expect(ph).toContain('How can I help today?');
    expect(ph).toContain('Reply to Digby…');
    expect(ph).toContain('Describe what to build or fix…');
    expect(ph).not.toContain('Digby is replying');
    expect(ph).not.toContain('Steer the run');
    expect(ph).not.toContain('Setting up the workspace');
    // The footer note carries the per-status truth chain (one place, one voice):
    // since 2026-09-27 the view renders composerRunAffordance(...).note and the
    // sentences live in depth-ux-seams.ts RUN_NOTE (behaviour-pinned in
    // resumed-run-composer.test.tsx — "Stop ends it." only on a live stream).
    // 7acaa7ba: memberViewOnly (read-only view of another owner's session) takes
    // the note first; the affordance note renders otherwise — same one-line slot.
    expect(VIEW).toContain('footerNote={');
    expect(VIEW).toContain('memberViewOnly');
    expect(VIEW).toContain('? <p data-composer-note');
    const fn = region(readSrc('./depth-ux-seams.ts'), 'export const RUN_NOTE = {', '} as const;');
    expect(fn).toContain('Digby is replying — your message queues and sends next. Stop ends it.');
    expect(fn).toContain('Digby is working — your message steers this run live. Stop ends it.');
    expect(fn).toContain('Run in progress — attaching… your message steers it.');
    expect(fn).toContain('Workspace setup hit an error — send a message to retry.');
    expect(fn).toContain('Setting up the workspace');
  });
});

describe('C1 smoke [97af2895] steer to running-but-detached (design D4, §1)', () => {
  it('routeSend: running-detached (no live stream, session row says running) routes to steer', () => {
    expect(routeSend({
      hasSession: true, hasContent: true, liveRunning: false, sessionStatus: 'running',
    })).toBe('steer-reroute');
    // The full decision table is pinned in lib/composer-guard.test.ts; this row
    // adds the converged-view pin below.
  });

  it('source pin: the steer guard is widened to live.running || status === running', () => {
    expect(VIEW).toContain("(!live.running && activeSession.status !== 'running')");
  });

  it('source pin: the steer-reroute branch resyncs AND steers immediately', () => {
    const branch = region(VIEW, "if (sendRoute === 'steer-reroute')", "if (sendRoute === 'blocked-toast')");
    const resyncAt = branch.indexOf('void resyncActive();');
    const steerAt = branch.indexOf('void steer();');
    expect(resyncAt).toBeGreaterThanOrEqual(0);
    expect(steerAt).toBeGreaterThan(resyncAt); // reconcile first, steer NOW
  });
});

describe('C1 smoke [20ca951e] steer-409 bypass (design D4, §1)', () => {
  it('classifySteerFailure(409) === fallback-send; anything else toasts', () => {
    expect(classifySteerFailure(409)).toBe('fallback-send');
    expect(classifySteerFailure(500)).toBe('toast');
    expect(classifySteerFailure(undefined)).toBe('toast');
  });

  it('source pin: the bypassed re-send + finite steer timeout are wired', () => {
    // The one-time escape: after a server-authoritative 409 the stale running
    // flag is bypassed exactly once.
    expect(VIEW).toContain('void send(message, undefined, { bypassRunningGuard: true });');
    // STEER_TIMEOUT_MS rides the steer POST (finite — a hung POST can't re-wedge).
    expect(CODING_API).toContain('export const STEER_TIMEOUT_MS = 30_000;');
    expect(CODING_API).toContain('{ timeout: STEER_TIMEOUT_MS }');
  });
});

describe('C1 smoke [ae3ef713 + a6b87d69] — the patience picker + its copy are RETIRED (roster 2026-10-06 B-3: Digby picks depth and models per message)', () => {
  it('source pin: page.tsx passes no composer picker slot; the CodeSessionView right slot carries the mic only; the picker component and patience.ts are deleted', () => {
    expect(PAGE).not.toContain('PatiencePicker');
    expect(PAGE).not.toContain('composerRightActions');
    expect(VIEW).not.toContain('composerRightActions');
    // Digby Frontier: the mic keeps the right slot.
    expect(VIEW).toContain('rightActions={(<>');
    for (const gone of ['./components/PatiencePicker.tsx', './patience.ts']) {
      expect(existsSync(fileURLToPath(new URL(gone, import.meta.url))), `${gone} must be deleted`).toBe(false);
    }
  });
});

describe('UI0907 [owner scoping principle 2026-09-07] side panel pertains to ITS session — no global Fleet tab', () => {
  // Owner (verbatim intent, 2026-09-07): "the sidepanel should only pertain to
  // that chat or project or session — not everything." The Fleet tab (75b7c548
  // Phase D, ported in C2) was a GLOBAL fleet surface inside the per-session
  // panel — removed; /management owns the account-wide fleet views. The
  // Project Pulse block the tab carried (owner 2026-09-04) moved to the TOP of
  // the coding Overview section, still keyed to the session's own project.
  it("executable: the capability registry emits NO 'fleet' section for any kind", () => {
    expect(workspaceSectionIds({ kind: 'coding' })).not.toContain('fleet');
    expect(workspaceSectionIds({ kind: 'plain' })).not.toContain('fleet');
    expect(workspaceSectionIds({ kind: 'coding', isKid: true })).not.toContain('fleet');
    expect(workspaceSectionIds({ kind: 'plain', isKid: true })).not.toContain('fleet');
  });

  it('source pin: FleetPanel is gone from BOTH panel mounts (view registry + page plain sections)', () => {
    expect(VIEW).not.toContain('FleetPanel');
    expect(VIEW).not.toContain("case 'fleet'");
    expect(PAGE).not.toContain('FleetPanel');
    expect(PAGE).not.toContain("case 'fleet'");
  });

  it('source pin: Project Pulse renders at the TOP of the coding Overview section, fed the session project', () => {
    // The connected block mounts inside OverviewPanel, keyed to session.projectId…
    expect(VIEW).toContain('<SessionProjectPulse projectId={session.projectId}');
    // …ABOVE the Folder card (the section that previously opened Overview).
    const overviewBody = region(VIEW, 'export function OverviewPanel', '>Folder</h3>');
    expect(overviewBody).toContain('SessionProjectPulse');
  });

  it('source pin: plain chats carry NO in-panel pulse (dashboard + project page are the owner-approved surfaces)', () => {
    expect(PAGE).not.toContain('ProjectPulse');
  });
});

describe('C1 smoke [58ffcf86] shared-chat author attribution — C2 PORT LANDED (design §5)', () => {
  // The C2 port (ticket 71b1fec6) replaced this row's gap pins (b)/(c) with
  // the render-level pins the C1 lane prescribed: PlainMessageMeta DECLARES
  // authorId/authorName, mapPlainMessages resolves the display name from the
  // payload's additive messageAuthors map at map time (mirroring the legacy
  // view's mapStoredMessages — user rows only), and the converged user-bubble
  // branch renders the legacy teammate treatment (violet tint + "From: <name>"
  // footnote) via isPlainTeammateMessage + plain.viewerId.
  it('(a) executable: mapPlainMessages carries the authorId stamp and resolves authorName from messageAuthors', () => {
    const rows = mapPlainMessages({
      messages: [
        { id: 'm1', role: 'user', content: 'teammate says hi', metadata: { authorId: 'u-teammate' }, createdAt: '2026-08-29T10:00:00.000Z' },
      ],
      messageAuthors: { 'u-teammate': 'Paul Cozzolino' },
    });
    expect(rows[0].plainMeta?.authorId).toBe('u-teammate');
    expect(rows[0].plainMeta?.authorName).toBe('Paul Cozzolino');
  });

  it('(a2) executable: an unresolvable author keeps authorId but no authorName (the footnote falls back to teammate)', () => {
    const rows = mapPlainMessages({
      messages: [
        { id: 'm1', role: 'user', content: 'hi', metadata: { authorId: 'u-gone' }, createdAt: '2026-08-29T10:00:00.000Z' },
      ],
      messageAuthors: {},
    });
    expect(rows[0].plainMeta?.authorId).toBe('u-gone');
    expect(rows[0].plainMeta?.authorName).toBeUndefined();
  });

  it('(a3) executable: only USER rows resolve attribution — stamped assistant rows and unstamped legacy rows pass through untouched', () => {
    const rows = mapPlainMessages({
      messages: [
        { id: 'm1', role: 'assistant', content: 'answer', metadata: { authorId: 'u-x' }, createdAt: '2026-08-29T10:00:00.000Z' },
        { id: 'm2', role: 'user', content: 'legacy row', createdAt: '2026-08-29T10:01:00.000Z' },
      ],
      messageAuthors: { 'u-x': 'Should Not Resolve' },
    });
    expect(rows[0].plainMeta?.authorName).toBeUndefined();
    expect(rows[1].plainMeta).toBeUndefined();
  });

  it('(a4) executable: isPlainTeammateMessage — a DIFFERENT stamped author is a teammate; own/unstamped/no-viewer are not', () => {
    expect(isPlainTeammateMessage({ authorId: 'u-other' }, 'u-me')).toBe(true);
    expect(isPlainTeammateMessage({ authorId: 'u-me' }, 'u-me')).toBe(false);
    expect(isPlainTeammateMessage({}, 'u-me')).toBe(false);
    expect(isPlainTeammateMessage(undefined, 'u-me')).toBe(false);
    expect(isPlainTeammateMessage({ authorId: 'u-other' }, null)).toBe(false);
    expect(isPlainTeammateMessage({ authorId: 'u-other' }, undefined)).toBe(false);
  });

  it('(b) type pin: PlainMessageMeta DECLARES authorId + authorName', () => {
    const start = CODING_API.indexOf('export interface PlainMessageMeta {');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = CODING_API.indexOf('\n}', start);
    expect(end).toBeGreaterThan(start);
    const block = CODING_API.slice(start, end);
    expect(block).toContain('authorId');
    expect(block).toContain('authorName');
  });

  it('(c) render pins: the converged user branch carries the teammate treatment, wired to the page viewer id', () => {
    // The bridge resolves names from the getChat payload's additive map.
    expect(PLAIN_SESSION).toContain('full?.messageAuthors?.[');
    // The converged user-bubble branch: teammate tint vs own solid violet,
    // plus the "From: <name>" footnote with the 'teammate' fallback.
    const userBranch = region(
      VIEW,
      'isPlainTeammateMessage(m.plainMeta, plain?.viewerId)',
      '"Queued" caption after the live run block',
    );
    // Digby Frontier (2026-10-06): neutral bubbles — a teammate's reads as
    // hover bg + a 1px line, the viewer's own as the --bubble fill.
    expect(userBranch).toContain("'bg-hover border border-line'");
    expect(userBranch).toContain("'bg-bubble'");
    expect(userBranch).not.toContain('bg-brand text-white');
    expect(userBranch).toContain("From: {m.plainMeta?.authorName || 'teammate'}");
    // Wiring: the page hands the signed-in viewer's id through PlainSessionProps.
    expect(VIEW).toContain('viewerId?: string | null;');
    expect(PAGE).toContain('viewerId: user?.id');
  });
});
