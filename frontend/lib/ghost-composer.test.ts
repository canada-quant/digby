/**
 * Ghost composer toggle (2026-10-22) — the signed-in ghost control's pure
 * seam (lib/ghost-composer.ts): who gets a toggle, what the home toggle sends
 * on create, what the open-chat toggle sends on flip, and the kill switch.
 * Same idiom as ghost-mode.test.ts (pure module, process.env per test).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createChatWithGhost,
  flipChatGhost,
  ghostComposerToggleDisabled,
  ghostFactsFromChat,
  ghostToggleTarget,
  ghostEligibleChatId,
  ghostRowReducer,
  ghostRowFromChat,
  withGhostFacts,
  holdPendingGhostFlips,
  GHOST_PENDING_FLIP_TTL_MS,
  GHOST_ROW_INITIAL,
  type GhostRowEvent,
  type PendingGhostFlip,
  type GhostRowState,
  type GhostToggleInput,
} from './ghost-composer';

const OWNER = 'u-owner';
const CHAT = 'c-1';
const ownRow = { userId: OWNER, ghostMode: false };

/** An open, owned, plain chat with a known posture — the eligible baseline. */
const openChat = (over: Partial<GhostToggleInput> = {}): GhostToggleInput => ({
  viewerId: OWNER, isKid: false, chatId: CHAT, chatless: false, plain: true, row: ownRow, ...over,
});
/** Home: signed-in, nothing mounted. */
const home = (over: Partial<GhostToggleInput> = {}): GhostToggleInput => ({
  viewerId: OWNER, isKid: false, chatId: null, chatless: false, plain: false, row: undefined, ...over,
});

afterEach(() => { delete process.env.NEXT_PUBLIC_GHOST_COMPOSER_TOGGLE_DISABLED; });

describe('ghostToggleTarget — who gets the signed-in toggle', () => {
  it('home (no chat row yet): the toggle ARMS the next new chat', () => {
    expect(ghostToggleTarget(home())).toEqual({ kind: 'new' });
  });

  it("the owner's own plain chat: the toggle flips it, carrying the stored posture", () => {
    expect(ghostToggleTarget(openChat())).toEqual({ kind: 'chat', chatId: CHAT, on: false });
    expect(ghostToggleTarget(openChat({ row: { userId: OWNER, ghostMode: true } }))).toEqual({ kind: 'chat', chatId: CHAT, on: true });
  });

  it('a row without an owner id (a chat the viewer created) is still the owner\'s', () => {
    expect(ghostToggleTarget(openChat({ row: { ghostMode: false } }))).toEqual({ kind: 'chat', chatId: CHAT, on: false });
  });

  it('ineligible chats get NO toggle: coding sessions, supervisors, other people\'s chats', () => {
    expect(ghostToggleTarget(openChat({ plain: false }))).toBeNull(); // coding session
    expect(ghostToggleTarget(openChat({ row: { ...ownRow, isSupervisor: true } }))).toBeNull(); // Fleet Supervisor
    expect(ghostToggleTarget(openChat({ row: { ...ownRow, isProjectSupervisor: true } }))).toBeNull(); // project supervisor lane
    expect(ghostToggleTarget(openChat({ row: { userId: 'someone-else', ghostMode: false } }))).toBeNull(); // shared folder
  });

  it('ineligible viewers get NO toggle: guests (their own toggle) and kids', () => {
    expect(ghostToggleTarget(home({ viewerId: null }))).toBeNull();
    expect(ghostToggleTarget(openChat({ viewerId: undefined }))).toBeNull();
    expect(ghostToggleTarget(home({ isKid: true }))).toBeNull();
    expect(ghostToggleTarget(openChat({ isKid: true }))).toBeNull();
  });

  it('an unknown posture (minimal row / no row) never guesses "off"', () => {
    expect(ghostToggleTarget(openChat({ row: { userId: OWNER } }))).toBeNull();
    expect(ghostToggleTarget(openChat({ row: undefined }))).toBeNull();
  });

  it('a chatless mount (the createChat-failure fallback) gets no toggle — it already carries its posture', () => {
    expect(ghostToggleTarget(home({ chatless: true }))).toBeNull();
  });

  it('NEXT_PUBLIC_GHOST_COMPOSER_TOGGLE_DISABLED=1 ⇒ no toggle anywhere', () => {
    process.env.NEXT_PUBLIC_GHOST_COMPOSER_TOGGLE_DISABLED = '1';
    expect(ghostComposerToggleDisabled()).toBe(true);
    expect(ghostToggleTarget(home())).toBeNull();
    expect(ghostToggleTarget(openChat())).toBeNull();
    process.env.NEXT_PUBLIC_GHOST_COMPOSER_TOGGLE_DISABLED = '0';
    expect(ghostToggleTarget(home())).toEqual({ kind: 'new' }); // only '1' disables
  });
});

// integ/ghost-composer (2026-10-22): PR #1897's page-local signedInGhostChatId
// rule moved here so the side-panel switch and the composer toggle read ONE
// function. These pin #1897's semantics exactly (an unknown row is eligible —
// the panel switch self-loads and hides on a supervisor read).
describe('ghostEligibleChatId — THE signed-in ghost eligibility rule (shared by the panel switch and the composer)', () => {
  it("the owner's own plain chat is eligible — a row without the facts (minimal / none) too", () => {
    expect(ghostEligibleChatId(openChat())).toBe(CHAT);
    expect(ghostEligibleChatId(openChat({ row: { ghostMode: true } }))).toBe(CHAT);
    expect(ghostEligibleChatId(openChat({ row: { userId: OWNER } }))).toBe(CHAT); // posture unknown — the PANEL still offers it
    expect(ghostEligibleChatId(openChat({ row: undefined }))).toBe(CHAT);
    expect(ghostEligibleChatId(openChat({ row: null }))).toBe(CHAT);
  });

  it('never kids, guests, home, coding sessions, supervisors or other people\'s chats', () => {
    expect(ghostEligibleChatId(openChat({ isKid: true }))).toBeNull();
    expect(ghostEligibleChatId(openChat({ viewerId: null }))).toBeNull();
    expect(ghostEligibleChatId(home())).toBeNull();
    expect(ghostEligibleChatId(openChat({ plain: false }))).toBeNull();
    expect(ghostEligibleChatId(openChat({ row: { ...ownRow, isSupervisor: true } }))).toBeNull();
    expect(ghostEligibleChatId(openChat({ row: { ...ownRow, isProjectSupervisor: true } }))).toBeNull();
    expect(ghostEligibleChatId(openChat({ row: { userId: 'someone-else', ghostMode: false } }))).toBeNull();
  });

  it('is NOT kill-switched (the side-panel switch predates the composer toggle) — the composer target is', () => {
    process.env.NEXT_PUBLIC_GHOST_COMPOSER_TOGGLE_DISABLED = '1';
    expect(ghostEligibleChatId(openChat())).toBe(CHAT);
    expect(ghostToggleTarget(openChat())).toBeNull();
  });

  it('the composer target is the eligibility rule PLUS a known posture — never wider', () => {
    const inputs: GhostToggleInput[] = [
      openChat(), openChat({ row: { ghostMode: true } }), openChat({ row: { userId: OWNER } }), openChat({ row: undefined }),
      openChat({ isKid: true }), openChat({ plain: false }), openChat({ row: { ...ownRow, isProjectSupervisor: true } }),
      openChat({ row: { userId: 'someone-else', ghostMode: true } }),
    ];
    for (const i of inputs) {
      const t = ghostToggleTarget(i);
      if (t) {
        expect(t.kind).toBe('chat');
        expect(ghostEligibleChatId(i)).toBe(t.kind === 'chat' ? t.chatId : null);
        expect(typeof i.row?.ghostMode).toBe('boolean');
      }
    }
  });
});

describe('the composer reads the ROW — a side-panel flip can never be out-voted (integ/ghost-composer)', () => {
  // #1897 kept a separate ghostToggles mirror that the composer button and the
  // header badge read BEFORE the row; a side-panel flip patched only the row,
  // so after "composer on → panel off" the mirror still said on. The merged
  // toggle reads the row alone (the page patches it on every flip).
  it('composer on, then the side panel off: the composer shows OFF', () => {
    let row = { userId: OWNER, ghostMode: false };
    const t1 = ghostToggleTarget(openChat({ row }));
    expect(t1).toEqual({ kind: 'chat', chatId: CHAT, on: false });
    row = { ...row, ghostMode: true }; // composer flip → the page's setChats patch
    expect(ghostToggleTarget(openChat({ row }))).toEqual({ kind: 'chat', chatId: CHAT, on: true });
    row = { ...row, ghostMode: false }; // side panel flip → onGhostChanged's setChats patch
    expect(ghostToggleTarget(openChat({ row }))).toEqual({ kind: 'chat', chatId: CHAT, on: false });
  });
});

describe('createChatWithGhost — the home toggle reaches POST /chats', () => {
  it('armed: create is called with ghostMode:true, so the FIRST message runs private', async () => {
    const createChat = vi.fn(async (data: unknown) => ({ data: { id: 'new', ...(data as object) } }));
    const res = await createChatWithGhost(createChat, { title: 'hi', projectId: 'p1' }, true);
    expect(createChat).toHaveBeenCalledTimes(1);
    expect(createChat).toHaveBeenCalledWith({ title: 'hi', projectId: 'p1', ghostMode: true });
    expect(res.data).toMatchObject({ ghostMode: true });
  });

  it('unarmed: the create body is byte-identical to before (no ghostMode key)', async () => {
    const createChat = vi.fn(async (_data: unknown) => ({ data: { id: 'new' } }));
    await createChatWithGhost(createChat, { title: 'hi', projectId: undefined }, false);
    const body = createChat.mock.calls[0][0] as Record<string, unknown>;
    expect(body).toEqual({ title: 'hi', projectId: undefined });
    expect('ghostMode' in body).toBe(false);
  });
});

describe('flipChatGhost — the open-chat toggle is the side panel save', () => {
  it('flips ghostMode through updateChat and resolves to the new value', async () => {
    const updateChat = vi.fn(async () => ({}));
    expect(await flipChatGhost(updateChat, CHAT, false)).toBe(true);
    expect(updateChat).toHaveBeenLastCalledWith(CHAT, { ghostMode: true });
    expect(await flipChatGhost(updateChat, CHAT, true)).toBe(false);
    expect(updateChat).toHaveBeenLastCalledWith(CHAT, { ghostMode: false });
  });

  it('a server refusal (supervisor / coding row) rejects for the caller\'s toast', async () => {
    const updateChat = vi.fn(async () => { throw Object.assign(new Error('refused'), { response: { status: 400 } }); });
    await expect(flipChatGhost(updateChat, CHAT, false)).rejects.toThrow('refused');
  });

  it('review fix: onSaved gets the PUT\'s answer (its updatedAt orders the pending-flip hold); never on a refusal', async () => {
    const saved = { id: CHAT, ghostMode: true, updatedAt: '2026-10-22T12:00:05.000Z' };
    const onSaved = vi.fn();
    expect(await flipChatGhost(vi.fn(async () => saved), CHAT, false, onSaved)).toBe(true);
    expect(onSaved).toHaveBeenCalledWith(saved);
    const refused = vi.fn();
    await expect(flipChatGhost(vi.fn(async () => { throw new Error('refused'); }), CHAT, false, refused)).rejects.toThrow('refused');
    expect(refused).not.toHaveBeenCalled();
  });
});

describe('ghostFactsFromChat — a minimal row learns its posture once', () => {
  it('reads the posture and fills only the owner / supervisor facts the row lacks', () => {
    const full = { ghostMode: true, userId: OWNER, isSupervisor: false, isProjectSupervisor: true };
    expect(ghostFactsFromChat({}, full)).toEqual({ ghostMode: true, userId: OWNER, isSupervisor: false, isProjectSupervisor: true });
    // never overwrites what the list already said
    expect(ghostFactsFromChat({ userId: 'list-owner', isSupervisor: true }, full)).toEqual({ ghostMode: true, isProjectSupervisor: true });
  });

  it('an older backend (no ghostMode field) or a junk body reads off — the posture becomes KNOWN', () => {
    expect(ghostFactsFromChat({}, { userId: OWNER })).toEqual({ ghostMode: false, userId: OWNER });
    expect(ghostFactsFromChat({}, null)).toEqual({ ghostMode: false });
    // …so a fetched minimal row becomes eligible (the toggle appears)
    const patched = { ...ghostFactsFromChat({}, { userId: OWNER, ghostMode: true }) };
    expect(ghostToggleTarget(openChat({ row: patched }))).toEqual({ kind: 'chat', chatId: CHAT, on: true });
  });
});

describe('ghostRowReducer — the side-panel switch never lets a stale read win (review fix)', () => {
  const run = (...events: GhostRowEvent[]): GhostRowState => events.reduce(ghostRowReducer, GHOST_ROW_INITIAL);

  it('REPRO: flipped from the hinted value while the mount-time read is in flight — the late read no longer resets it', () => {
    // hint false → the user flips on → the PUT lands → THEN the GET (taken before the PUT) answers false
    const s = run({ type: 'open' }, { type: 'hint', hint: false }, { type: 'saved', ghostMode: true }, { type: 'loaded', ghostMode: false, supervisor: false });
    expect(s.value).toBe(true);
  });

  it('a composer flip (the host row patch) also settles the value against the in-flight read', () => {
    const s = run({ type: 'open' }, { type: 'hint', hint: false }, { type: 'hint', hint: true }, { type: 'loaded', ghostMode: false, supervisor: false });
    expect(s.value).toBe(true);
    expect(run({ type: 'open' }, { type: 'hint', hint: true }, { type: 'load_failed' }).value).toBe(true);
  });

  it('no hint (the kill switch passes none) is the pre-toggle row: loading until the read answers, then the read', () => {
    expect(run({ type: 'open' }, { type: 'hint', hint: undefined })).toEqual({ value: null, settled: false, supervisor: false });
    expect(run({ type: 'open' }, { type: 'hint', hint: undefined }, { type: 'loaded', ghostMode: true, supervisor: false }).value).toBe(true);
    expect(run({ type: 'open' }, { type: 'load_failed' }).value).toBe(false); // an older backend: off
  });

  it('a new chat starts over (loading, unsettled) — the previous chat\'s value never carries across', () => {
    const s = run({ type: 'hint', hint: true }, { type: 'saved', ghostMode: true }, { type: 'open' });
    expect(s).toEqual(GHOST_ROW_INITIAL);
    expect(ghostRowReducer(s, { type: 'loaded', ghostMode: false, supervisor: false }).value).toBe(false);
  });

  it('the read\'s supervisor facts hide the row even when its posture is dropped (a minimal row may lack them)', () => {
    expect(run({ type: 'open' }, { type: 'hint', hint: false }, { type: 'loaded', ghostMode: false, supervisor: true }).supervisor).toBe(true);
    expect(run({ type: 'open' }, { type: 'loaded', ghostMode: false, supervisor: false }).supervisor).toBe(false);
  });
});

// ── integ/ghost-composer review fixes (2026-10-22) ─────────────────────────
describe('withGhostFacts — finding 3: an open chat with NO row gets it back from the facts read', () => {
  const full = { id: CHAT, title: 'Old chat', projectId: null, mode: 'auto', hasWorkspaceState: false, updatedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', ghostMode: true, userId: OWNER, isSupervisor: false, isProjectSupervisor: false };
  const other = { id: 'c-other', title: 'x', ghostMode: false };

  it('REPRO: a full list refresh dropped the open chat\'s minimal row — the read puts it back, so the toggle shows again', () => {
    const prev = [other];
    // before the fix the row stayed gone ⇒ ghostToggleTarget had no posture ⇒ null (no toggle)
    expect(ghostToggleTarget(openChat({ row: prev.find((c) => c.id === CHAT) }))).toBeNull();
    const next = withGhostFacts(prev, CHAT, full, true);
    expect(next.map((c) => c.id)).toEqual([CHAT, 'c-other']);
    const row = next.find((c) => c.id === CHAT) as Record<string, unknown>;
    expect(row).toMatchObject({ id: CHAT, title: 'Old chat', ghostMode: true, userId: OWNER, isSupervisor: false, isProjectSupervisor: false, messages: [] });
    expect(ghostToggleTarget(openChat({ row: row as never }))).toEqual({ kind: 'chat', chatId: CHAT, on: true });
  });

  it('a row that exists is patched in place (the list facts win), never duplicated', () => {
    const prev = [{ id: CHAT, title: 'Old chat', userId: 'list-owner' }, other];
    const next = withGhostFacts(prev, CHAT, full, true);
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ id: CHAT, ghostMode: true, userId: 'list-owner' });
  });

  it('a late read for a chat that is no longer open plants nothing; a junk / mismatched body plants nothing', () => {
    const prev = [other];
    expect(withGhostFacts(prev, CHAT, full, false)).toBe(prev);
    expect(withGhostFacts(prev, CHAT, null, true)).toBe(prev);
    expect(withGhostFacts(prev, CHAT, { ...full, id: 'c-else' }, true)).toBe(prev);
  });

  it('ghostRowFromChat: the open-by-id row shape + the ghost facts; an archived chat stays archived (out of the visible list)', () => {
    expect(ghostRowFromChat({ id: CHAT, archivedAt: '2026-10-20T00:00:00.000Z' }, 'NOW')).toMatchObject({ id: CHAT, archivedAt: '2026-10-20T00:00:00.000Z', createdAt: 'NOW', ghostMode: false, messages: [] });
    expect(ghostRowFromChat({ title: 'no id' })).toBeNull();
    expect(ghostRowFromChat('nope')).toBeNull();
  });
});

describe('holdPendingGhostFlips — finding 2: a refresh the server built BEFORE the PUT never undoes a flip', () => {
  const PUT_AT = '2026-10-22T12:00:05.000Z';
  const T0 = 1_000_000;
  const pend = (value: boolean, updatedAt: string | null = PUT_AT, at = T0): Map<string, PendingGhostFlip> => new Map([[CHAT, { value, updatedAt, at }]]);

  it('REPRO: ghost turned OFF; a delta built before the PUT says ON — the row keeps OFF (the hold stays)', () => {
    const stale = [{ id: CHAT, ghostMode: true, updatedAt: '2026-10-22T12:00:01.000Z', title: 't' }];
    const r = holdPendingGhostFlips(stale, pend(false), T0 + 5_000);
    expect(r.rows[0]).toMatchObject({ id: CHAT, ghostMode: false, title: 't' });
    expect(r.settled).toEqual([]);
    expect(stale[0].ghostMode).toBe(true); // never mutates the input
  });

  it('a confirming row (same value) ends the hold', () => {
    const r = holdPendingGhostFlips([{ id: CHAT, ghostMode: false, updatedAt: PUT_AT }], pend(false), T0 + 5_000);
    expect(r.rows[0].ghostMode).toBe(false);
    expect(r.settled).toEqual([CHAT]);
  });

  it('a row NEWER than the PUT is the truth (flipped again elsewhere) — accepted, the hold ends', () => {
    const r = holdPendingGhostFlips([{ id: CHAT, ghostMode: true, updatedAt: '2026-10-22T12:00:09.000Z' }], pend(false), T0 + 5_000);
    expect(r.rows[0].ghostMode).toBe(true);
    expect(r.settled).toEqual([CHAT]);
  });

  it('without the PUT\'s updatedAt a mismatched row is held until it agrees or the TTL ends', () => {
    expect(holdPendingGhostFlips([{ id: CHAT, ghostMode: true, updatedAt: '2026-10-22T12:00:09.000Z' }], pend(false, null), T0 + 5_000).rows[0].ghostMode).toBe(false);
    const late = holdPendingGhostFlips([{ id: CHAT, ghostMode: true, updatedAt: '2026-10-22T12:00:09.000Z' }], pend(false, null), T0 + GHOST_PENDING_FLIP_TTL_MS + 1);
    expect(late.rows[0].ghostMode).toBe(true);
    expect(late.settled).toEqual([CHAT]);
  });

  it('other chats, rows that do not say, and an empty hold pass through untouched (same array)', () => {
    const rows = [{ id: 'c-other', ghostMode: true, updatedAt: '2026-10-22T12:00:01.000Z' }, { id: CHAT, updatedAt: '2026-10-22T12:00:01.000Z' }];
    const r = holdPendingGhostFlips(rows, pend(false), T0 + 5_000);
    expect(r.rows).toBe(rows);
    expect(r.settled).toEqual([]);
    expect(holdPendingGhostFlips(rows, new Map(), T0).rows).toBe(rows);
  });
});
