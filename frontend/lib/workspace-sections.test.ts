/**
 * Section-registry pins (Session UI Convergence C2, ticket 71b1fec6,
 * design D1): the capability table decides WHICH WorkspacePanel sections a
 * session mounts. Both mounts (CodeSessionView's in-view panel; the
 * page-level panel serving plain chats until C3) build through this — a
 * change here changes every panel, so the table is pinned exactly.
 */

import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_SECTION_LABELS,
  workspaceSectionIds,
  type WorkspaceSectionId,
} from './workspace-sections';

describe('workspaceSectionIds (design D1 capability table)', () => {
  it('coding session: overview + files + schedules + settings (artifacts folded into Files)', () => {
    expect(workspaceSectionIds({ kind: 'coding' })).toEqual(['overview', 'files', 'schedules', 'browser', 'settings']);
  });

  it('plain session: files (hosting Artifacts, 2026-09-23) + schedules + settings (no overview — codingApi-only data)', () => {
    expect(workspaceSectionIds({ kind: 'plain' })).toEqual(['files', 'schedules', 'browser', 'settings']);
  });

  it('kid accounts never get Schedules — either session kind (owner surface)', () => {
    expect(workspaceSectionIds({ kind: 'coding', isKid: true })).toEqual(['overview', 'files', 'browser', 'settings']);
    expect(workspaceSectionIds({ kind: 'plain', isKid: true })).toEqual(['files', 'browser', 'settings']);
  });

  it('settings (2026-09-09): the ⋯ menu\'s controls as the LAST tab for every non-guest mount, chatless included', () => {
    expect(workspaceSectionIds({ kind: 'plain', chatless: true })).toEqual(['files', 'browser', 'settings']);
    expect(workspaceSectionIds({ kind: 'coding' }).at(-1)).toBe('settings');
    expect(workspaceSectionIds({ kind: 'plain', hasBrowserActivity: true }).at(-1)).toBe('settings');
    expect(workspaceSectionIds({ kind: 'plain', guest: true })).toEqual([]);
  });

  it('isKid: false behaves like omitted (non-kid)', () => {
    expect(workspaceSectionIds({ kind: 'plain', isKid: false })).toEqual(workspaceSectionIds({ kind: 'plain' }));
    expect(workspaceSectionIds({ kind: 'coding', isKid: false })).toEqual(workspaceSectionIds({ kind: 'coding' }));
  });

  it('fleet is emitted for NO session kind — owner scoping principle 2026-09-07', () => {
    // Owner (verbatim intent): "the sidepanel should only pertain to that chat
    // or project or session — not everything." The Fleet tab (C2 port of Phase
    // D, 75b7c548) was a GLOBAL surface in the per-session panel — removed;
    // /management owns the account-wide fleet views, and the Project Pulse
    // block moved into the coding Overview section.
    expect(workspaceSectionIds({ kind: 'coding' })).not.toContain('fleet');
    expect(workspaceSectionIds({ kind: 'plain' })).not.toContain('fleet');
  });

  it('schedules mounts for BOTH session kinds (rm9 — chats have schedules too, not just coding sessions)', () => {
    expect(workspaceSectionIds({ kind: 'coding' })).toContain('schedules');
    expect(workspaceSectionIds({ kind: 'plain' })).toContain('schedules');
  });

  it('schedules is chat-keyed: a chatless plain mount drops it — but keeps Files, which hosts Artifacts (2026-09-23)', () => {
    const ids = workspaceSectionIds({ kind: 'plain', chatless: true });
    expect(ids).not.toContain('schedules');
    expect(ids).toContain('files');
    expect(ids).not.toContain('artifacts');
    // Coding sessions always have a chat — chatless never removes their sections.
    expect(workspaceSectionIds({ kind: 'coding', chatless: true })).toContain('schedules');
  });

  it('every emitted id has a label', () => {
    const all: WorkspaceSectionId[] = [
      ...workspaceSectionIds({ kind: 'coding' }),
      ...workspaceSectionIds({ kind: 'plain' }),
      ...workspaceSectionIds({ kind: 'coding', hasBrowserActivity: true }),
      ...workspaceSectionIds({ kind: 'plain', hasBrowserActivity: true }),
    ];
    for (const id of all) {
      expect(WORKSPACE_SECTION_LABELS[id]).toBeTruthy();
    }
  });
});

describe('workspaceSectionIds × browser section (permanent since 2026-09-23 — owner: "I don\'t see where the browser tab is")', () => {
  it('always present for both kinds, before Settings — the cap no longer gates it', () => {
    expect(workspaceSectionIds({ kind: 'coding' })).toEqual(['overview', 'files', 'schedules', 'browser', 'settings']);
    expect(workspaceSectionIds({ kind: 'plain' })).toEqual(['files', 'schedules', 'browser', 'settings']);
    expect(workspaceSectionIds({ kind: 'plain', hasBrowserActivity: false })).toContain('browser');
    expect(workspaceSectionIds({ kind: 'plain', hasBrowserActivity: true })).toEqual(workspaceSectionIds({ kind: 'plain' }));
  });

  it('composes with the other caps: kids and chatless mounts get it too', () => {
    expect(workspaceSectionIds({ kind: 'coding', isKid: true })).toEqual(['overview', 'files', 'browser', 'settings']);
    expect(workspaceSectionIds({ kind: 'plain', chatless: true })).toEqual(['files', 'browser', 'settings']);
  });

  it('guests keep NO panel at all', () => {
    expect(workspaceSectionIds({ kind: 'plain', guest: true, hasBrowserActivity: true })).toEqual([]);
  });
});

describe('workspaceSectionIds × C3 chatless fallback (files-cap composition)', () => {
  // C3 (ticket 71b1fec6): the page-level panel mount is retired; the ONLY
  // chatless fallback (signed-in createChat failure) derives its panel by
  // intersecting pagePanelSections with the registry's OWN chatless ids
  // ({ kind: 'plain', isKid, chatless: true }) — see page.tsx
  // pagePanelSectionsChatless. Guests get [] (pinned in
  // app/crossmodel/c3-legacy-retirement.test.tsx). Pin the composition
  // executably: kid withholding must survive the chat-keyed cap, and the
  // chatless answer must be a subset of the chatted one (intersection-safe).
  const fallbackIds = (isKid: boolean) => workspaceSectionIds({ kind: 'plain', isKid, chatless: true });

  it('non-kid fallback: Files (Artifacts only) + browser + settings (uploads AND schedules capped — no chat to scope to; fleet removed 2026-09-07)', () => {
    expect(fallbackIds(false)).toEqual(['files', 'browser', 'settings']);
  });

  it('kid fallback: Files (Artifacts only) (kid withholding composes with the chat-keyed cap)', () => {
    expect(fallbackIds(true)).toEqual(['files', 'browser', 'settings']);
  });

  it('the chatless set is a strict subset of the chatted set (the page intersects, never adds)', () => {
    for (const isKid of [false, true]) {
      const chatted = workspaceSectionIds({ kind: 'plain', isKid });
      for (const id of fallbackIds(isKid)) expect(chatted).toContain(id);
    }
  });
});
