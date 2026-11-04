/**
 * Sidebar-folder session summary row (2026-09-28): the pure reducer behind
 * the one-line summary at the top of an expanded sidebar folder.
 */
import { describe, it, expect } from 'vitest';
import { summarizeFolderSessions, isSummaryLane, FOLDER_SESSION_SUMMARY_TTL_MS } from './folder-session-summary';
import type { ProjectSessionRow } from './api/crossmodel';

const row = (over: Partial<ProjectSessionRow> = {}): ProjectSessionRow => ({
  chatId: 'c1', title: 'Goal · step', goalHalf: 'Goal', stepHalf: 'step', pinned: false, status: 'idle',
  lastReceiptAgeSec: null, spendTodayUsd: null, goalId: null, goalTitle: null, todoCounts: { open: 0 },
  runs14d: 0, enabledSchedules: 0, isSupervisor: false, hasWorkspaceState: true, updatedAt: '2026-09-28T00:00:00Z', archivedAt: null,
  ...over,
});

describe('summarizeFolderSessions', () => {
  it('renders running / scheduled counts, the freshest receipt age and the summed spend', () => {
    const s = summarizeFolderSessions([
      row({ chatId: 'a', status: 'running', lastReceiptAgeSec: 12 * 60, spendTodayUsd: 3.1 }),
      row({ chatId: 'b', status: 'running', lastReceiptAgeSec: 4 * 3600, spendTodayUsd: 1 }),
      row({ chatId: 'c', status: 'scheduled', lastReceiptAgeSec: null, spendTodayUsd: null }),
    ]);
    expect(s).toMatchObject({ running: 2, scheduled: 1, idle: 0, lastReceiptAgeSec: 720, spendTodayUsd: 4.1 });
    expect(s?.text).toBe('2 running · 1 scheduled · last receipt 12 m · $4.10 today');
  });

  it('an all-idle folder says "N idle"; archived rows and plain chats are ignored; no lanes ⇒ null', () => {
    expect(summarizeFolderSessions([row({ status: 'idle', lastReceiptAgeSec: 3 * 86400 })])?.text).toBe('1 idle · last receipt 3 d');
    expect(summarizeFolderSessions([row({ status: 'archived' }), row({ hasWorkspaceState: false, status: 'idle' })])).toBeNull();
    expect(summarizeFolderSessions([])).toBeNull();
    expect(summarizeFolderSessions(null)).toBeNull();
    // a supervisor chat is a lane even without a workspace state
    expect(summarizeFolderSessions([row({ hasWorkspaceState: false, isSupervisor: true, status: 'scheduled' })])?.text).toBe('1 scheduled');
  });

  it('zero spend is not rendered and a missing receipt age is not rendered', () => {
    expect(summarizeFolderSessions([row({ status: 'running', spendTodayUsd: 0 })])?.text).toBe('1 running');
  });

  it('isSummaryLane / TTL', () => {
    expect(isSummaryLane({ hasWorkspaceState: false, isSupervisor: false, status: 'idle' })).toBe(false);
    expect(isSummaryLane({ hasWorkspaceState: false, isSupervisor: false, status: 'running' })).toBe(true);
    expect(FOLDER_SESSION_SUMMARY_TTL_MS).toBe(60_000);
  });
});
