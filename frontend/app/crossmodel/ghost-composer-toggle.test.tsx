/**
 * Ghost composer toggle (2026-10-22) — render pins for the ONE ghost button
 * and source pins for its wiring (owner, raised twice: a signed-in user had no
 * ghost control in the composer, so a new chat's first message always ran on
 * the normal lineup). The eligibility / create / flip behaviour itself is
 * pinned in lib/ghost-composer.test.ts; these pins prove the page and the view
 * actually route through it. Idioms: DepthPill.test.tsx (react-dom/server in
 * the node environment) + ghost-mode-send.test.ts (source pins).
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import GhostComposerToggle from './components/GhostComposerToggle';
import { GHOST_MODE_TOOLTIP } from '@/lib/ghost-mode';

const render = (props: Parameters<typeof GhostComposerToggle>[0]) => renderToStaticMarkup(createElement(GhostComposerToggle, props));
const attr = (s: string) => s.replace(/'/g, '&#x27;');
const readSrc = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const PAGE = readSrc('./page.tsx');
const VIEW = readSrc('./components/CodeSessionView.tsx');
const SETTINGS = readSrc('./components/SessionSettingsSection.tsx');
const LIB = readSrc('../../lib/ghost-composer.ts');

describe('GhostComposerToggle — one look for every ghost button', () => {
  it('the pressed state is the indicator; the tooltip is the honest one-liner', () => {
    const on = render({ on: true, onToggle: () => {} });
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('data-ghost-on="true"');
    expect(on).toContain('text-ink bg-hover');
    expect(on).toContain(`title="${attr(GHOST_MODE_TOOLTIP)}"`);
    expect(on).toContain('aria-label="Turn ghost mode off"');
    const off = render({ on: false, onToggle: () => {} });
    expect(off).toContain('aria-pressed="false"');
    expect(off).not.toContain('text-ink bg-hover');
    expect(off).toContain('aria-label="Turn ghost mode on"');
  });

  it('the home variant says it arms the NEW chat', () => {
    expect(render({ on: false, onToggle: () => {}, armsNewChat: true })).toContain('aria-label="Start this chat in ghost mode"');
    expect(render({ on: true, onToggle: () => {}, armsNewChat: true })).toContain('aria-label="Ghost mode on for the new chat — turn off"');
  });

  it('a save in flight dims it but never disables it (a disabled button swallows its tooltip)', () => {
    const busy = render({ on: false, onToggle: () => {}, busy: true });
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain('opacity-60');
    expect(busy).not.toContain('disabled=""');
  });
});

describe('page wiring — new chat arms, open chat flips (source pins)', () => {
  it('the home composer renders the arming toggle only for the "new" target', () => {
    expect(PAGE).toContain("{ghostTarget?.kind === 'new' && (");
    expect(PAGE).toContain('<GhostComposerToggle armsNewChat on={newChatGhost} onToggle={() => setNewChatGhost(!newChatGhostRef.current)} />');
  });

  it('the first send creates the chat WITH the armed posture, then the arm is consumed', () => {
    expect(PAGE).toContain('createChatWithGhost(crossModelApi.createChat, { title, projectId: currentProjectIdRef.current || undefined }, newChatGhostRef.current)');
    const create = PAGE.indexOf('createChatWithGhost(crossModelApi.createChat');
    const consumed = PAGE.indexOf('setNewChatGhost(false);', create);
    expect(consumed).toBeGreaterThan(create);
    // the createChat-failure fallback keeps the armed posture as a per-send flag
    expect(PAGE).toContain("setChatless({ guest: false, nonce: Date.now(), ...(newChatGhostRef.current ? { ghost: true } : {}) });");
    // integ/ghost-composer: the fallback's armed posture rides the ONE `ghost` prop (no second prop pair)
    expect(PAGE).toMatch(/ghost: chatlessActive\?\.guest\s*\? guestGhost\s*: chatlessActive\?\.ghost \? true : \(ghostTarget\?\.kind === 'chat' \? ghostTarget\.on : undefined\),/);
  });

  it('the eligibility is the ONE pure seam, fed the open chat\'s row (composer target + side-panel switch)', () => {
    expect(PAGE).toMatch(/const ghostInput: GhostToggleInput = \{\s*viewerId: user\?\.id \?\? null,\s*isKid,\s*chatId: codeChatId,\s*chatless: !!chatlessActive,\s*plain: codeChatPlain,\s*row: ghostRow,\s*\};/);
    expect(PAGE).toContain('const signedInGhostChatId = ghostEligibleChatId(ghostInput);');
    expect(PAGE).toContain('const ghostTarget = ghostToggleTarget(ghostInput);');
  });

  it('an open eligible chat flips through updateChat and patches the sidebar row (the header badge)', () => {
    expect(PAGE).toContain('const next = await flipChatGhost(crossModelApi.updateChat, chatId, current, (row) => { saved = row; });');
    expect(PAGE).toContain('setChats(prev => prev.map(c => c.id === chatId ? { ...c, ghostMode: next } : c));');
    // integ/ghost-composer: the flip rides the ONE onToggleGhost prop (#1897's), not a second onToggleChatGhost
    expect(PAGE).toMatch(/onToggleGhost: chatlessActive\?\.guest && activeGuestId\s*\? toggleGuestGhost\s*: ghostTarget\?\.kind === 'chat'/);
    expect(PAGE).toContain('? () => void toggleChatGhost(ghostTarget.chatId, ghostTarget.on)');
    expect(PAGE).toContain('ghostSaving: chatGhostSaving,');
    expect(PAGE).not.toContain('onToggleChatGhost');
  });
});

describe('view wiring — ONE toggle: guests as before, signed-in chat-gated (source pins)', () => {
  // integ/ghost-composer (2026-10-22): PR #1897 widened the guest button's gate
  // to `{plain?.onToggleGhost && (` (signed-in own plain chats too); the branch
  // had a SECOND signed-in button after + on its own prop pair. The merge keeps
  // ONE render site (after +; guests have no +, so theirs sits alone) on #1897's
  // prop pair, with the branch's transcript gate on the signed-in arm.
  it('exactly ONE ghost button in the composer, rendered through GhostComposerToggle', () => {
    expect(VIEW.match(/<GhostComposerToggle /g)?.length).toBe(1);
    expect(VIEW).toContain('<GhostComposerToggle on={!!plain.ghost} busy={!!plain.ghostSaving} onToggle={plain.onToggleGhost} />');
    // no inline ghost button and no second prop pair survive the merge
    expect(VIEW).not.toContain('GHOST_MODE_TOOLTIP');
    expect(VIEW).not.toMatch(/onToggleChatGhost|chatGhostSaving|plain\.chatGhost/);
  });

  it('the signed-in arm waits for the transcript read and never shows on a supervisor chat; guests are ungated', () => {
    expect(VIEW).toContain('{plain?.onToggleGhost && (plain.guest || (plainLoaded && !supervisorChat)) && (');
    // the second supervisor gate is the view's own transcript read (a row built outside the list may lack isProjectSupervisor)
    expect(VIEW).toContain('setSupervisorChat(!!(full.isSupervisor || full.isProjectSupervisor));');
  });

  it('the ONE toggle sits after + (the home composer\'s arming twin sits there too)', () => {
    const plus = VIEW.indexOf('aria-label="Attach files">');
    const toggle = VIEW.indexOf('<GhostComposerToggle on={!!plain.ghost}');
    expect(plus).toBeGreaterThan(0);
    expect(toggle).toBeGreaterThan(plus);
    const homePlus = PAGE.indexOf('aria-label="Attach files"');
    const homeToggle = PAGE.indexOf('<GhostComposerToggle armsNewChat');
    expect(homeToggle).toBeGreaterThan(homePlus);
  });

  it('the send keeps ONE ghost source; a signed-in chat-bound send is governed by the row server-side', () => {
    expect(VIEW).toContain('ghost: plainCfg.ghost');
    expect(VIEW).not.toMatch(/ghost: plainCfg\.chatGhost/);
  });
});

describe('integ/ghost-composer — the home arm keeps the ghost privacy invariant (docs/GHOST_MODE.md: flip it on BEFORE you start)', () => {
  // A ghost new chat's FIRST send must already be ghost — never one normal
  // turn first. The page only hands the message to the view AFTER the create
  // that carried the arm, the arm survives a failed attempt (it is consumed
  // only inside the successful try), and the createChat-failure fallback
  // carries it per send.
  const sendFn = PAGE.slice(PAGE.indexOf('const handleSendMessageInner = useCallback('), PAGE.indexOf('// Safety-net wrapper: ANY rejection in the send pipeline'));

  it('the hand-off (setCodeInitialMessage) comes only after the armed create — a failed create never hands off a coded chat', () => {
    const create = sendFn.indexOf('await createChatWithGhost(crossModelApi.createChat');
    const handOff = sendFn.indexOf('setCodeInitialMessage(messageText);');
    expect(create).toBeGreaterThan(0);
    expect(handOff).toBeGreaterThan(create);
    // the coded hand-off is guarded on the create having produced a chat id
    expect(sendFn.indexOf('if (newChatId) {')).toBeGreaterThan(create);
  });

  it('the arm is consumed only after a SUCCESSFUL create — the retry attempt re-reads it', () => {
    const tryStart = sendFn.indexOf('for (let attempt = 0; attempt < 2 && !newChatId; attempt++) {');
    const create = sendFn.indexOf('await createChatWithGhost(crossModelApi.createChat');
    const consumed = sendFn.indexOf('setNewChatGhost(false);', create);
    const catchAt = sendFn.indexOf('} catch {', create);
    expect(tryStart).toBeGreaterThan(0);
    expect(consumed).toBeGreaterThan(create);
    expect(consumed).toBeLessThan(catchAt); // inside the try, after the create — never before it, never in the catch
    expect(sendFn.slice(tryStart, create)).not.toContain('setNewChatGhost(false)');
  });

  it('the fallback mount takes the armed posture BEFORE the arm is cleared', () => {
    const fallback = sendFn.indexOf("setChatless({ guest: false, nonce: Date.now(), ...(newChatGhostRef.current ? { ghost: true } : {}) });");
    const cleared = sendFn.indexOf('setNewChatGhost(false);', fallback);
    expect(fallback).toBeGreaterThan(0);
    expect(cleared).toBeGreaterThan(fallback);
  });

  it('#1897\'s ghostToggles mirror is gone — the row is the one source (a panel flip can never be out-voted)', () => {
    expect(PAGE).not.toContain('setGhostToggles');
    expect(PAGE).not.toContain('ghostToggles[');
  });
});

describe('side-panel switch — the kill switch restores it, a stale read never resets it (review fix, source pins)', () => {
  it('the page passes the row posture as a hint ONLY while the composer toggle is on', () => {
    expect(PAGE).toContain('ghostMode={codeChatId && !ghostComposerToggleDisabled() ? chats.find(c => c.id === codeChatId)?.ghostMode : undefined}');
  });

  it('GhostModeRow runs on ghostRowReducer: open → read, the hint re-applied per chat, its own save settles', () => {
    expect(SETTINGS).toContain('const [row, dispatch] = useReducer(ghostRowReducer, GHOST_ROW_INITIAL);');
    expect(SETTINGS).toContain("dispatch({ type: 'loaded', ghostMode: !!full?.ghostMode, supervisor: !!(full?.isSupervisor || full?.isProjectSupervisor) });");
    expect(SETTINGS).toMatch(/dispatch\(\{ type: 'hint', hint \}\);\s*\}, \[chatId, hint\]\);/);
    expect(SETTINGS).toContain("if (chatIdRef.current === savingFor) dispatch({ type: 'saved', ghostMode: next });");
    // the hint effect is declared AFTER the self-load, so a new chat's 'open' never wipes it
    expect(SETTINGS.indexOf("dispatch({ type: 'hint', hint });")).toBeGreaterThan(SETTINGS.indexOf("dispatch({ type: 'open' });"));
    // never a bare setValue from the read any more
    expect(SETTINGS).not.toContain('setValue(!!full?.ghostMode)');
  });

  it('a supervisor chat (its own read says so) shows no switch — the save would 400', () => {
    expect(SETTINGS).toContain('if (row.supervisor) return null;');
  });

  it('the panel row reads the list row\'s isProjectSupervisor (the backend row select carries it)', () => {
    // integ/ghost-composer: the rule moved from a page closure into lib/ghost-composer.ts ghostEligibleChatId
    expect(LIB).toContain('if (row?.isSupervisor || row?.isProjectSupervisor) return null;');
    expect(PAGE).toContain('ghostChatId={signedInGhostChatId}');
  });
});

describe('review fixes (integ/ghost-composer, 2026-10-22) — the row stays the truth through refreshes (source pins)', () => {
  // The behaviour is unit-pinned in lib/ghost-composer.test.ts (holdPendingGhostFlips / withGhostFacts); these
  // pins prove every list writer and both savers route through it.
  it('finding 2: every list writer holds a pending flip — the delta merge, the full list, load-more', () => {
    expect(PAGE).toContain('const rows = holdGhostRows<CrossModelChat>(rawRows);');
    const delta = PAGE.indexOf('const rows = holdGhostRows<CrossModelChat>(rawRows);');
    expect(PAGE.indexOf('const m = mergeChatRows(prev, rows);', delta)).toBeGreaterThan(delta);
    expect(PAGE).toContain('const chatsArr = holdGhostRows<CrossModelChat>(Array.isArray(result?.chats)');
    expect(PAGE).toContain('const moreChats = holdGhostRows<CrossModelChat>(Array.isArray(result?.chats)');
    expect(PAGE).toContain('const held = holdPendingGhostFlips(rows, pendingGhostRef.current, Date.now());');
  });

  it('finding 2: BOTH savers record the flip with the PUT\'s answer — the composer toggle and the side-panel switch', () => {
    expect(PAGE).toContain('noteGhostFlip(chatId, next, saved);');
    expect(PAGE).toMatch(/onGhostChanged=\{\(chatId, ghostMode, saved\) => \{\s*noteGhostFlip\(chatId, ghostMode, saved\);/);
    expect(SETTINGS).toContain('const saved: unknown = await crossModelApi.updateChat(savingFor, { ghostMode: next });');
    expect(SETTINGS).toContain('onChanged?.(next, saved);');
    // recorded only while the composer toggle is on (=1 restores the pre-toggle page)
    expect(PAGE).toMatch(/const noteGhostFlip = useCallback\(\(chatId: string, value: boolean, saved\?: unknown\) => \{\s*if \(ghostComposerToggleDisabled\(\)\) return;/);
  });

  it('finding 3: an open chat with NO row reads its facts too, puts the row back only while still open, and a settled read can run again', () => {
    expect(PAGE).toContain("const ghostRowNeedsFacts = !ghostRow || typeof ghostRow.ghostMode !== 'boolean';");
    expect(PAGE).toContain('setChats(prev => withGhostFacts(prev, id, read, codeChatIdRef.current === id));');
    expect(PAGE).toContain('.finally(() => { ghostFactsReadRef.current.delete(id); });');
    // still behind the ONE switch
    expect(PAGE).toContain('if (!user || isKid || !codeChatId || !codeChatPlain || ghostComposerToggleDisabled()) return;');
  });
});
