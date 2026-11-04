/**
 * C3 legacy-retirement pins — Session UI Convergence (ticket 71b1fec6;
 * docs/archive/SESSION_UI_CONVERGENCE_DESIGN.md §3 C3; SESSION_UI_CONVERGENCE_C2.md
 * §C3 remainder; SESSION_UI_CONVERGENCE_C0_AUDIT.md §5 blockers).
 *
 * C3 retires the legacy in-page transcript (~700 lines of page.tsx),
 * AgentSteps, and the page-level WorkspacePanel mount — the converged plain
 * path (CodeSessionView) is the ONLY session view — and resolves the C2
 * anonymous-route decision (owner directive "very limited features and push
 * cta to sign up for that access"): an anonymous send mounts the view's
 * chatId-less GUEST mode; a signed-in createChat failure mounts the
 * chatId-less FALLBACK (full features, ephemeral, no re-attach).
 *
 * Same two idioms as the C1 smoke matrix (no jsdom — client components
 * render initial state only): SSR for pure surfaces, and SOURCE-LEVEL pins
 * anchored on stable identifiers (never line numbers). VERIFICATION-ONLY:
 * a failing row is a BLOCKED finding to report, not a test to weaken.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { buildPlainDepthConfig, canvasEventToText } from './plain-session';

// ── Source-level pin inputs (read once at collection) ──────────────────────
const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const PAGE = readSrc('./page.tsx'); // the converged shell (was the legacy view)
const VIEW = readSrc('./components/CodeSessionView.tsx'); // the ONE session view
const PLAIN = readSrc('./plain-session.ts'); // plain-mode bridge (chatless transport)
const TRANSCRIPT = readSrc('./components/code-transcript.tsx'); // canonical transcript parts
const CHROME = readSrc('./components/FloatingChrome.tsx'); // floating sidebar toggle + ⋯ menu

/** Slice helper for region-anchored pins (fails loudly when an anchor drifts). */
function region(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to);
  expect(a, `region anchor ${JSON.stringify(from)} missing`).toBeGreaterThanOrEqual(0);
  expect(b, `region anchor ${JSON.stringify(to)} missing`).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('C3 retirement [page.tsx] — the legacy transcript + page-level panel are GONE', () => {
  it('no AgentSteps, no page-level WorkspacePanel mount, no Drawer panel', () => {
    expect(PAGE).not.toContain('AgentSteps');
    expect(PAGE).not.toContain('<WorkspacePanel');
    expect(PAGE).not.toContain('DrawerContent');
  });

  it('no legacy stream machinery: no EventSource, no stream state, no queue/drain watch', () => {
    expect(PAGE).not.toContain('new EventSource(');
    expect(PAGE).not.toContain('const [isStreaming');
    expect(PAGE).not.toContain('const [messages');
    expect(PAGE).not.toContain('queuedMessage');
    expect(PAGE).not.toContain('serverQueued');
    expect(PAGE).not.toContain('streamEndedNaturallyRef');
    expect(PAGE).not.toContain('statusCycleRef');
    expect(PAGE).not.toContain('handleStop');
  });

  it('no legacy attach/recovery plumbing or strip/map helpers', () => {
    expect(PAGE).not.toContain('attachAgentRunIfLive');
    expect(PAGE).not.toContain('stripCanvasTags');
    expect(PAGE).not.toContain('mapStoredMessages');
  });

  it('no transcript chrome: no canvasWidth drag, no timestamp swipe handlers', () => {
    expect(PAGE).not.toContain('canvasWidth');
    expect(PAGE).not.toContain('handleTimeSwipe');
  });
});

describe('C3 render fork [page.tsx] — every session mounts the converged view', () => {
  it('the fork mounts CodeSessionView for coded AND chatless sessions', () => {
    expect(PAGE).toContain('{(codeChatId || chatlessActive) ? (');
    expect(PAGE).toContain('plain={(codeChatPlain || chatlessActive) ? {');
    expect(PAGE).toContain('const chatlessActive = codeChatId ? null : chatless;');
    expect(PAGE).toContain('key={codeChatId ? `${codeChatId}:${codeChatPlain ? \'plain\' : \'coding\'}` : `chatless-${chatlessActive!.nonce}`}');
  });

  it('the mount keeps kid gating + passes guest through the plain bundle', () => {
    const mount = region(PAGE, '<CodeSessionView key=', '} : undefined} />');
    expect(mount).toContain('isKid={isKid}');
    expect(mount).toContain('guest: chatlessActive?.guest ?? false,');
    expect(mount).toContain('attachOnLoad: codeChatId ? effectiveGeneratingIds.has(codeChatId) : false,');
  });

  it('signed-in sends get create-then-hand-off with ONE inline retry, then the fallback', () => {
    expect(PAGE).toContain('for (let attempt = 0; attempt < 2 && !newChatId; attempt++)');
    // Ghost composer toggle (2026-10-22): the fallback mount also carries the home toggle's ARMED posture.
    expect(PAGE).toContain('setChatless({ guest: false, nonce: Date.now(), ...(newChatGhostRef.current ? { ghost: true } : {}) });');
  });

  it('anonymous sends mount the guest mode', () => {
    expect(PAGE).toContain('setChatless({ guest: true, nonce: Date.now() });');
  });

  it('startNewChat clears the chatless mount (home is reachable again)', () => {
    const snc = region(PAGE, 'const startNewChat = useCallback(() => {', 'const handleNewsExpand');
    expect(snc).toContain('setChatless(null);');
    expect(snc).not.toContain('isStreaming');
  });
});

describe('C3 guest mode [anonymous-route decision] — limited features + sign-up CTAs', () => {
  it('guests ride the forced Ensemble (whatever the stored pref); signed-in mounts send Auto (roster 2026-10-06 B-3: Digby picks depth per message)', () => {
    // The wire is decided by the pure seam buildPlainDepthConfig (plain-session.ts;
    // tests-gaps-10, 2026-09-26) — the page only wires it with the guest flag.
    expect(PAGE).toContain('...buildPlainDepthConfig({');
    expect(PAGE).toContain('guest: !!chatlessActive?.guest,');
    const base = { isKid: false, deepResearchQuota: null };
    for (const pref of ['auto', 'single_thinking', 'deep_research'] as const) {
      expect(buildPlainDepthConfig({ ...base, guest: true, pref }).mode).toBe('thinking');
      expect(buildPlainDepthConfig({ ...base, guest: false, pref }).mode).toBe('auto');
    }
  });

  it('guests get no workspace panel — the fork passes an empty section list', () => {
    expect(PAGE).toContain('panelSections: chatlessActive?.guest ? [] : chatlessActive ? pagePanelSectionsChatless : pagePanelSections,');
    expect(PAGE).toContain('showWorkspaceToggle={(!!codeChatId || !!chatlessActive) && !chatlessActive?.guest}');
  });

  // Ticket 625773b5 (owner report, supersedes the C3 guest posture): the
  // attachment surface is NOT user-gated any more — guests attach exactly like
  // signed-in users. The open /crossmodel/upload route always accepted
  // anonymous callers (optionalAuthenticate → ownerUserId null) and the
  // chatless /stream send carries uploadId params, so the C3 gate was purely
  // cosmetic; these pins now assert the surface renders for everyone.
  it('guests GET the attachment surface — bar, hidden input and gestures are not user-gated (ticket 625773b5)', () => {
    expect(PAGE).toContain('hasAttachments: attachments.length > 0,');
    expect(PAGE).not.toContain('hasAttachments: !chatlessActive?.guest');
    expect(PAGE).not.toContain('hiddenFileInput={user ? (');
    expect(PAGE).not.toContain('{!!user && attachments.length > 0 && (');
  });

  it('guests can stage attachments — drop/paste ungated, takeAttachments always wired (ticket 625773b5, supersedes review F2)', () => {
    // The F2 concern was a guest staging an INVISIBLE upload (no bar to show
    // it). Now the bar renders for guests too, so the gesture chain is open
    // and every staged upload is visible + removable before the send.
    expect(PAGE).toContain('onPaste={handlePaste}');
    expect(PAGE).not.toContain('onPaste={user ? handlePaste : undefined}');
    expect(PAGE).not.toContain('dragHandlers={user ? {');
    expect(PAGE).toContain('onAttachFiles: (files: File[]) => { void processFiles(files); },');
    expect(PAGE).not.toContain('takeAttachments: chatlessActive?.guest ? undefined');
  });

  it('chatless mounts get no Report-issue control — feedback needs a saved chat (review F3)', () => {
    // Adversarial-review F3: PlainMessageActions received chatId:'' on
    // guest/fallback mounts — a guaranteed-failure button. Gated on !!chatId.
    // Digby Frontier (2026-10-06): the 👍 control joins 👎 + its form — all
    // three ride the same gate.
    const gates = TRANSCRIPT.match(/\{!isKid && !!chatId && /g) || [];
    expect(gates.length).toBe(3);
  });

  it('no composer carries a patience picker for anyone — guests included (roster 2026-10-06 B-3; the picker existed only behind the never-forwarded legacy switch)', () => {
    expect(PAGE).not.toContain('Auto ✨ · sign in for more');
    expect(PAGE).not.toContain('<PatiencePicker');
    expect(PAGE).not.toContain('REVERSE_MAP');
    expect(PAGE).not.toContain('guestMode');
  });

  it('the top-of-transcript GuestBanner is gone — the guest sidebar card carries the sign-up CTA (owner 2026-09-23)', () => {
    expect(VIEW).not.toContain('function GuestBanner()');
    expect(VIEW).not.toContain('<GuestBanner />');
  });

  it('the view renders the paperclip for guests too (ticket 625773b5)', () => {
    expect(VIEW).not.toContain('{!plain?.guest && (');
    expect(VIEW).toContain('aria-label="Attach files">');
  });
});

describe('C3 fallback mount [signed-in createChat failure] — full features, ephemeral', () => {
  it('the fallback panel derives from the registry-composed page sections (kid withholding composes)', () => {
    // rm9: the chatless cap comes from the REGISTRY's own chatless answer
    // (files + schedules are both chat-keyed) — an intersection, never a
    // hand-maintained id list that could drift from the capability table.
    expect(PAGE).toContain("const chatlessSectionIds = new Set<string>(workspaceSectionIds({ kind: 'plain', isKid, chatless: true }));");
    expect(PAGE).toContain('const pagePanelSectionsChatless: WorkspaceSection[] = pagePanelSections.filter(s => chatlessSectionIds.has(s.id));');
  });

  it('chatless mounts never claim a page-level stream pipe', () => {
    expect(PAGE).toContain('onStreamClaim: chatlessActive ? undefined : (cid: string) => {');
  });
});

describe('C3 chatless view guards [CodeSessionView] — null chatId is fully handled', () => {
  it('the component accepts a nullable chatId (chatless plain mounts)', () => {
    expect(VIEW).toContain('chatId: string | null;');
  });

  it('PlainSessionProps carries the guest flag', () => {
    expect(VIEW).toContain('guest?: boolean;');
  });

  it('session-only calls are guarded chatless (files create, plan/session loads)', () => {
    const guards = VIEW.match(/if \(!chatId\) return;/g) || [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
    expect(VIEW).toContain('if (!chatId) return null;');
  });

  it('guest canvas events convert to inline text (no panel to receive them)', () => {
    expect(VIEW).toContain('canvasEventToText');
  });
});

describe('C3 chatless transport [plain-session.ts] — /crossmodel/stream omits chatId chatless', () => {
  it('PlainSendParams.chatId is optional (guest + fallback sends)', () => {
    expect(PLAIN).toContain('chatId?: string | null;');
  });

  it('every stream-URL path sets chatId only when present (register body + both GET fallbacks)', () => {
    expect(PLAIN).toContain('if (p.chatId) regBody.chatId = p.chatId;');
    const getGuards = PLAIN.match(/if \(p\.chatId\) q\.set\('chatId', p\.chatId\);/g) || [];
    expect(getGuards.length).toBe(2);
  });

  it('canvasEventToText: titled canvas content becomes an inline markdown delta', () => {
    expect(canvasEventToText({ title: 'Report', content: 'Hello world' })).toBe('\n\n**Report**\n\nHello world');
  });

  it('canvasEventToText: Untitled drops the heading; empty/missing content drops the event', () => {
    expect(canvasEventToText({ title: 'Untitled', content: 'x' })).toBe('\n\nx');
    expect(canvasEventToText({ content: '' })).toBe('');
    expect(canvasEventToText({ title: 'T' })).toBe('');
    expect(canvasEventToText(null)).toBe('');
    expect(canvasEventToText({ content: '   ' })).toBe('');
  });
});

describe('C3 AgentSteps retirement [code-transcript.tsx]', () => {
  it('AgentSteps is no longer exported (the canonical copies own step rendering)', () => {
    expect(TRANSCRIPT).not.toMatch(/export\s+(function|const)\s+AgentSteps/);
  });
});

describe('Guest sessions (63bb607f) — the anonymous rail + browser-local history', () => {
  it('page.tsx renders the GuestSidebar for !user inside the Body flex (same sidebarOpen state)', () => {
    const gate = region(PAGE, 'Guest sidebar (anonymous only', 'Main chat area + Canvas panel');
    expect(gate).toContain('{!user && (');
    expect(gate).toContain('<GuestSidebar');
    expect(gate).toContain('open={sidebarOpen}');
    expect(gate).toContain('sessions={guestSessions}');
    expect(gate).toContain('activeId={activeGuestId}');
    expect(gate).toContain('onSelect={selectGuestSession}');
    expect(gate).toContain('onDelete={deleteGuestSession}');
    expect(gate).toContain('onNewChat={startNewGuestChat}');
  });

  it('the guest conversation id is allocated on BOTH mount paths (rail New chat + home send)', () => {
    const allocs = PAGE.match(/setActiveGuestId\(crypto\.randomUUID\(\)\);/g) || [];
    expect(allocs.length).toBe(2);
  });

  it('the converged view mount threads the guest session props through the plain bag', () => {
    const mount = region(PAGE, '<CodeSessionView key=', '} : undefined} />');
    expect(mount).toContain('guestSessionId: chatlessActive?.guest');
    expect(mount).toContain('initialTranscript: chatlessActive?.guest && activeGuestId');
    expect(mount).toContain('onTranscriptChange: chatlessActive?.guest && activeGuestId');
  });

  it('the FloatingChrome sidebar toggle is no longer gated on isLoggedIn (⋯ menu items stay gated)', () => {
    expect(CHROME).not.toContain('{isLoggedIn && !sidebarOpen && (');
    expect(CHROME).toContain('{!sidebarOpen && (');
    // The authed-only ⋯-menu items keep their gate (only the toggle opened up).
    // User Space P3: the merged one-menu gates compose (showPatience, !isKid,
    // showWorkspaceToggle…), so pin the isLoggedIn gate itself, not one shape.
    expect(CHROME).toMatch(/\{isLoggedIn && /);
  });

  it('the chatless load branch seeds from plain.initialTranscript (reopened guest sessions)', () => {
    // 2026-09-26 (guest resume): the seed is held in a local so the mid-response
    // check (guestResumeNeeded) reads the SAME transcript the view mounted.
    expect(VIEW).toContain('const seed = plainRef.current?.initialTranscript ?? [];');
    expect(VIEW).toContain('setMessages(seed);');
    expect(VIEW).toContain('initialTranscript?: CodingMessage[];');
    expect(VIEW).toContain('onTranscriptChange?: (messages: CodingMessage[]) => void;');
  });

  it('the guest session id is threaded into the stream URL builder (params + both GET paths + register body)', () => {
    expect(PLAIN).toContain('sessionId?: string;');
    const getGuards = PLAIN.match(/if \(p\.sessionId\) q\.set\('sessionId', p\.sessionId\);/g) || [];
    expect(getGuards.length).toBe(2);
    expect(PLAIN).toContain('if (p.sessionId) regBody.sessionId = p.sessionId;');
    expect(VIEW).toContain('sessionId: plainCfg.guestSessionId');
    expect(VIEW).toContain('guestSessionId?: string;');
  });
});
