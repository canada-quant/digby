/**
 * Session status service — unit tests with mocked Prisma + store readers (the
 * project-status.service.test idiom). Covers: the pure renderers (headline,
 * relative clocks, body shape, volatile-fact hash), renderSessionStatus from
 * ledger facts (wording rules: no ids, "waiting on you" only for owner items,
 * failures are "blocked"), and the sweep (idle sessions skipped, 60-min gate,
 * unchanged ⇒ no write, appendCodingMessage never crossModelMessage.create,
 * kill switch, per-session isolation).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelChat: { findMany: jest.fn() },
  crossModelMessage: { findFirst: jest.fn(), create: jest.fn() },
  agentRun: { findMany: jest.fn() },
  chatSchedule: { findMany: jest.fn() },
  ownerQuestion: { count: jest.fn(async () => 0) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

const mockAppend: jest.Mock = jest.fn(async (d: any) => ({ id: 'msg-new', ...d }));
const mockTouch: jest.Mock = jest.fn(async () => {});
jest.mock('./coding-data.service', () => ({
  __esModule: true,
  appendCodingMessage: (...a: any[]) => mockAppend(...a),
  touchChat: (...a: any[]) => mockTouch(...a),
}));
const mockGetPlan: jest.Mock = jest.fn(async () => null);
jest.mock('./plan.service', () => ({ __esModule: true, getPlan: (...a: any[]) => mockGetPlan(...a) }));
const mockReceipts: jest.Mock = jest.fn(async () => []);
jest.mock('./run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: (...a: any[]) => mockReceipts(...a) }));
const mockUsage: jest.Mock = jest.fn(async () => ({ costUsd: 0 }));
jest.mock('./usage-store', () => ({ __esModule: true, loadSessionUsage: (...a: any[]) => mockUsage(...a) }));
const mockVerify: jest.Mock = jest.fn(async () => null);
const mockVerifyAbsent: jest.Mock = jest.fn(async () => null);
jest.mock('./verify-state', () => ({ __esModule: true, getVerifyState: (...a: any[]) => mockVerify(...a), getVerifyAbsent: (...a: any[]) => mockVerifyAbsent(...a) }));
const mockAttention: jest.Mock = jest.fn(async () => new Map());
jest.mock('./session-run-lock', () => ({ __esModule: true, getPendingAttentionMap: (...a: any[]) => mockAttention(...a) }));
// Deliverable hand-off record (cohesive chat wave, 2026-09-27): the Result line.
const mockHandoff: jest.Mock = jest.fn(async () => null);
jest.mock('./deliverable-handoff', () => ({
  __esModule: true,
  ...jest.requireActual('./deliverable-handoff'),
  latestDeliverableHandoff: (...a: any[]) => mockHandoff(...a),
}));

// audit 2026-10-06 T7-8: the run-end unpushed-commits stamp (default: none).
const mockUnpushed: jest.Mock = jest.fn(async (): Promise<any> => null);
jest.mock('./unpushed-commits', () => ({
  __esModule: true,
  readUnpushedStamp: (...a: any[]) => mockUnpushed(...a),
  unpushedCommitsNoteDisabled: () => process.env.UNPUSHED_COMMITS_NOTE_DISABLED === '1',
}));

import {
  renderSessionStatus,
  emitSessionStatusUpdates,
  buildSessionHeadline,
  buildSessionStatusBody,
  hashSessionStatus,
  relativeSoon,
  SESSION_STATUS_ORIGIN,
  VERIFY_ABSENT_LINE,
  VERIFY_UNVERIFIED_LINE,
  SESSION_STATUS_INTERVAL_MS,
  SESSION_STATUS_BODY_MAX_CHARS,
  SESSION_STATUS_DISABLED_ENV,
} from './session-status.service';
import type { SessionStatus } from './session-status.service';

const NOW = new Date('2026-09-15T04:00:00.000Z');
const SINCE = new Date(NOW.getTime() - 60 * 60_000);
const S1 = 'sess-0001-aaaa-bbbb-cccc-000000000001';
const ID_RE = /\b[0-9a-f]{8,}\b/i;

function baseStatus(over: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionTitle: 'Re-Send Path C', projectName: 'CanLaw', headline: 'h',
    workingOn: [], doneSince: [], blocked: [], next: [],
    plan: { done: 5, total: 9, blocked: 0 }, runs: { completed: 3, failed: 0, running: 0 }, prs: { opened: 0, merged: 0, docsOnly: 0 },
    ownerItems: 0, spendUsd: null, ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env[SESSION_STATUS_DISABLED_ENV];
  mockGetPlan.mockResolvedValue(null);
  mockReceipts.mockResolvedValue([]);
  mockUsage.mockResolvedValue({ costUsd: 0 });
  mockVerify.mockResolvedValue(null);
  mockAttention.mockResolvedValue(new Map());
  mockPrisma.ownerQuestion.count.mockResolvedValue(0);
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
  mockHandoff.mockResolvedValue(null);
});

describe('pure renderers', () => {
  it('relativeSoon never prints a clock', () => {
    const now = NOW.getTime();
    expect(relativeSoon(now + 30_000, now)).toBe('any moment now');
    expect(relativeSoon(now + 25 * 60_000, now)).toBe('in about 25 minutes');
    expect(relativeSoon(now + 3 * 3600_000, now)).toBe('in about 3 hours');
    expect(relativeSoon(now + 3 * 86_400_000, now)).toBe('in about 3 days');
  });

  it('headline: plan position, runs since the last update (never "in the last hour"), and "waiting on you" ONLY for owner items', () => {
    expect(buildSessionHeadline({ sessionTitle: 'Re-Send Path C', plan: { done: 5, total: 9, blocked: 0 }, currentStepIndex: 5, runs: { completed: 3, failed: 1, running: 1 }, ownerItems: 0 }))
      .toBe('Re-Send Path C: on step 6 of 9; 3 runs finished, 1 run hit an error, one running now');
    expect(buildSessionHeadline({ sessionTitle: 'Doc sweep', plan: null, currentStepIndex: null, runs: { completed: 0, failed: 0, running: 0 }, ownerItems: 2 }))
      .toBe('Doc sweep: no plan recorded; no runs finished since the last update; 2 items waiting on you');
    expect(buildSessionHeadline({ sessionTitle: 'X', plan: { done: 4, total: 4, blocked: 0 }, currentStepIndex: null, runs: { completed: 1, failed: 0, running: 0 }, ownerItems: 0 }))
      .toBe('X: all 4 steps done; 1 run finished');
  });

  it('body: same four sections as the project card; "needs you" title only with owner items; ≤ 900 chars', () => {
    const s = baseStatus({ headline: 'h', workingOn: ['Validate shard C'], doneSince: ['3 runs finished'], blocked: ['A run hit an error: OOM'], next: ['Publish'] });
    const body = buildSessionStatusBody(s);
    expect(body.startsWith('**h**')).toBe(true);
    for (const h of ['**Working on**', '**Done since the last update**', '**Blocked**', '**Next**']) expect(body).toContain(h);
    expect(body).not.toContain('needs you');
    expect(buildSessionStatusBody({ ...s, ownerItems: 1, blocked: [...s.blocked, '1 question is waiting for your answer'] })).toContain('**Blocked or needs you**');
    const huge = baseStatus({ headline: 'h', workingOn: Array.from({ length: 12 }, (_, i) => `item ${i} ${'x'.repeat(80)}`) });
    expect(Array.from(buildSessionStatusBody(huge)).length).toBeLessThanOrEqual(SESSION_STATUS_BODY_MAX_CHARS);
  });

  it('hash is STATE only: window arithmetic (run counts, a run in flight, next-fire minutes, spend, headline text) never forces a card; plan/blocked/owner/PR/failure changes do', () => {
    const a = baseStatus({ headline: 'Re-Send Path C: on step 6 of 9; 3 runs finished', workingOn: ['A run is in progress'], next: ['Publish', 'Next scheduled run in about 25 minutes'] });
    const same = hashSessionStatus(a);
    expect(hashSessionStatus({ ...a, runs: { ...a.runs, running: 2 }, spendUsd: 9.99 })).toBe(same);
    expect(hashSessionStatus({ ...a, runs: { ...a.runs, completed: 4 }, headline: 'Re-Send Path C: on step 6 of 9; 4 runs finished', doneSince: ['4 runs finished'] })).toBe(same);
    expect(hashSessionStatus({ ...a, workingOn: [], next: ['Publish', 'Next scheduled run in about 10 minutes'] })).toBe(same);
    expect(hashSessionStatus({ ...a, blocked: ['A run hit an error: OOM'], runs: { ...a.runs, failed: 1 } })).not.toBe(same);
    expect(hashSessionStatus({ ...a, plan: { done: 6, total: 9, blocked: 0 } })).not.toBe(same);
    expect(hashSessionStatus({ ...a, ownerItems: 1 })).not.toBe(same);
    expect(hashSessionStatus({ ...a, prs: { opened: 1, merged: 0, docsOnly: 0 } })).not.toBe(same);
    expect(hashSessionStatus({ ...a, prs: { opened: 0, merged: 1, docsOnly: 0 } })).not.toBe(same);
    expect(hashSessionStatus({ ...a, next: ['Ship it'] })).not.toBe(same);
  });
});

describe('renderSessionStatus — ledger in, plain language out', () => {
  it('derives the contract from runs, plan, receipts, schedules and attention; no ids anywhere', async () => {
    mockGetPlan.mockResolvedValue({
      goal: 'Rebuild the SFT-2 dataset', acceptanceCriteria: [], version: 3, updatedAt: NOW.toISOString(),
      steps: [
        { id: 1, text: 'Pull the source shards', status: 'completed' },
        { id: 2, text: 'Validate shard C (run 9f8e7d6c5b4a3210)', status: 'in_progress', note: 'checksum pass 2/3' },
        { id: 3, text: 'Publish the pack', status: 'pending' },
        { id: 4, text: 'Notify the bench lane', status: 'blocked', note: 'waiting on shard C' },
      ],
    });
    mockReceipts.mockResolvedValue([
      { tool: 'open_pull_request', ok: true, ids: { prNumber: 42 } },
      { tool: 'git_commit', ok: true, ids: { sha: 'deadbeefcafe1234' } },
      { tool: 'git_push', ok: true, ids: {} },
      { tool: 'verify', ok: true, ids: { passed: true } },
      { tool: 'file_feedback', ok: true, ids: { ticketId: 'cffaa701-eaea-449c-874d-91f989f1eddc' } },
    ]);
    mockUsage.mockResolvedValue({ costUsd: 2.1049 });
    mockPrisma.ownerQuestion.count.mockResolvedValue(1);
    const r = await renderSessionStatus({
      chatId: S1, sessionTitle: 'Re-Send Path C', projectName: 'CanLaw',
      runs: [
        { sessionId: S1, status: 'completed', error: null, startedAt: SINCE, finishedAt: NOW },
        { sessionId: S1, status: 'completed', error: null, startedAt: SINCE, finishedAt: NOW },
        { sessionId: S1, status: 'failed', error: 'verify stage exit 137 (run 3c2d1e0f9a8b7c6d)', startedAt: SINCE, finishedAt: NOW },
        { sessionId: S1, status: 'running', error: null, startedAt: NOW, finishedAt: null },
      ],
      schedules: [{ sessionId: S1, nextRunAt: new Date(NOW.getTime() + 25 * 60_000) }],
      attention: { approvals: ['ap-1'], questions: [] },
      since: SINCE, now: NOW,
    });
    const { status, body } = r;
    expect(status.plan).toEqual({ done: 1, total: 4, blocked: 1 });
    expect(status.runs).toEqual({ completed: 2, failed: 1, running: 1 });
    expect(status.prs).toEqual({ opened: 1, merged: 0, docsOnly: 0 });
    expect(status.ownerItems).toBe(2); // 1 approval + 1 open owner question
    expect(status.spendUsd).toBe(2.1);
    expect(status.headline).toBe('Re-Send Path C: on step 2 of 4; 2 runs finished, 1 run hit an error, one running now; 2 items waiting on you');
    expect(status.workingOn).toEqual(['Validate shard C — checksum pass 2/3']);
    expect(status.doneSince).toEqual(['2 runs finished', 'Opened 1 pull request', 'Made 1 commit and pushed them', 'Verification passed', 'Filed 1 ticket']);
    expect(status.blocked).toEqual([
      'Step blocked: Notify the bench lane — waiting on shard C',
      'A run hit an error: verify stage exit 137',
      '1 action is waiting for your approval',
      '1 decision is waiting on you in the inbox',
    ]);
    expect(status.next).toEqual(['Publish the pack', 'Next scheduled run in about 25 minutes']);
    for (const item of [status.headline, ...status.workingOn, ...status.doneSince, ...status.blocked, ...status.next]) expect(item).not.toMatch(ID_RE);
    expect(body).not.toMatch(ID_RE);
    expect(body).toContain('**Blocked or needs you**');
  });

  it('a failed run or blocked step alone is "blocked", never an owner ask; no plan → goal-less wording', async () => {
    const r = await renderSessionStatus({
      chatId: S1, sessionTitle: 'Doc and Repo Management Update', projectName: null,
      runs: [{ sessionId: S1, status: 'failed', error: 'git add -A: audit-pack12/ does not have a commit checked out', startedAt: SINCE, finishedAt: NOW }],
      schedules: [], attention: undefined, since: SINCE, now: NOW,
    });
    expect(r.status.ownerItems).toBe(0);
    expect(r.status.headline).toBe('Doc and Repo Management Update: no plan recorded; 1 run hit an error');
    expect(r.body).toContain('**Blocked**');
    expect(r.body).not.toMatch(/needs you|waiting on you|waiting for your/i);
  });

  it('a verify receipt without a failing stage ("no chain configured" / UNVERIFIED) is not a failure', async () => {
    mockReceipts.mockResolvedValue([
      { tool: 'verify', ok: true, ids: { passed: false } },
      { tool: 'verify', ok: true, ids: { passed: false, failedStage: 'test' } },
    ]);
    const r = await renderSessionStatus({ chatId: S1, sessionTitle: 'X', projectName: null, runs: [{ sessionId: S1, status: 'completed', error: null, startedAt: SINCE, finishedAt: NOW }], schedules: [], attention: undefined, since: SINCE, now: NOW });
    expect(r.status.blocked).toEqual(['Verification failed once']);
  });

  // audit 2026-10-06 T8-5 (litellm F10): a missing chain is not a block — it rides Next as the action it is.
  it('T8-5: NO verify chain renders under Next as "Unverified (no verify chain) …", never under Blocked; a later real verify run removes it', async () => {
    mockVerifyAbsent.mockResolvedValue({ reason: 'no_chain', seam: 'auto', configPresent: false, at: new Date(NOW.getTime() - 26 * 60 * 60_000).toISOString(), count: 3 });
    const base = { chatId: S1, sessionTitle: 'Sweep shard C', projectName: 'spark-cluster', runs: [{ sessionId: S1, status: 'completed', error: null, startedAt: SINCE, finishedAt: NOW }], schedules: [], attention: undefined, since: SINCE, now: NOW };
    const r = await renderSessionStatus(base);
    expect(r.status.blocked).toEqual([]);
    expect(r.status.next).toEqual([VERIFY_UNVERIFIED_LINE]);
    expect(r.body).not.toContain('**Blocked**');
    expect(r.body).toContain('Unverified (no verify chain)');
    expect(r.status.ownerItems).toBe(0);
    const without = await (async () => { mockVerifyAbsent.mockResolvedValueOnce(null); return renderSessionStatus(base); })();
    expect(without.hash).not.toBe(r.hash); // still STATE: the line moves the card hash once
    mockVerify.mockResolvedValueOnce({ passed: true, at: NOW.toISOString(), sha: 'abc', tree: 'def' });
    expect((await renderSessionStatus(base)).status.next).toEqual([]);
  });

  it('A4 (2026-09-27, under VERIFY_ABSENT_NOT_BLOCKED_DISABLED=1 since T8-5): a session whose project has NO verify chain says so — the line is state (outlives the window) and a LATER real verify run replaces it', async () => {
    process.env.VERIFY_ABSENT_NOT_BLOCKED_DISABLED = '1';
    try {
      mockVerifyAbsent.mockResolvedValue({ reason: 'no_chain', seam: 'auto', configPresent: false, at: new Date(NOW.getTime() - 26 * 60 * 60_000).toISOString(), count: 3 });
      const base = { chatId: S1, sessionTitle: 'Sweep shard C', projectName: 'spark-cluster', runs: [{ sessionId: S1, status: 'completed', error: null, startedAt: SINCE, finishedAt: NOW }], schedules: [], attention: undefined, since: SINCE, now: NOW };
      const r = await renderSessionStatus(base);
      expect(r.status.blocked).toEqual([VERIFY_ABSENT_LINE]);
      expect(r.body).toContain('**Blocked**');
      expect(r.body).toContain("No verify chain — every \"verified\" is the lane's own probe");
      expect(r.body).not.toMatch(ID_RE);
      // Never an owner ask.
      expect(r.status.ownerItems).toBe(0);
      expect(r.body).not.toMatch(/needs you|waiting on you|waiting for your/i);
      // The marker is STATE: it changes the card hash exactly once (a hidden line
      // would defeat the point), and a later real chain run wins over it.
      const without = await (async () => { mockVerifyAbsent.mockResolvedValueOnce(null); return renderSessionStatus(base); })();
      expect(without.hash).not.toBe(r.hash);
      mockVerify.mockResolvedValueOnce({ passed: true, at: NOW.toISOString(), sha: 'abc', tree: 'def' });
      const after = await renderSessionStatus(base);
      expect(after.status.blocked).toEqual([]);
      // An OLDER real verify (before the marker) does not hide it.
      mockVerify.mockResolvedValueOnce({ passed: true, at: new Date(NOW.getTime() - 48 * 60 * 60_000).toISOString(), sha: 'abc', tree: 'def' });
      expect((await renderSessionStatus(base)).status.blocked).toEqual([VERIFY_ABSENT_LINE]);
    } finally {
      delete process.env.VERIFY_ABSENT_NOT_BLOCKED_DISABLED;
    }
  });

  it('A4: a failed getVerifyAbsent read degrades to "no line" (the card still renders)', async () => {
    mockVerifyAbsent.mockRejectedValueOnce(new Error('pg down'));
    const r = await renderSessionStatus({ chatId: S1, sessionTitle: 'X', projectName: null, runs: [], schedules: [], attention: undefined, since: SINCE, now: NOW });
    expect(r.status.blocked).toEqual([]);
  });

  it('deliverable hand-off in the window ⇒ a Result line under Done (names, counts, where) + status.result; outside the window ⇒ nothing', async () => {
    const record = {
      runId: 'run-1', sessionId: S1, targetChatId: 'parent-1', parentChatId: 'parent-1',
      postedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), resultMessageId: 'msg-9',
      artifacts: [
        { name: 'deck/cql-dgx-b300-deck.pdf', bytes: 1000, url: '/api/crossmodel/files/f1/download', kind: 'file' },
        { name: 'deck/cql-dgx-b300-deck.pptx', bytes: 2000, url: '/api/crossmodel/files/f2/download', kind: 'file' },
        { name: 'PR #12', bytes: 0, url: 'https://github.com/o/r/pull/12', kind: 'pr' },
      ],
      files: 2, prs: 1, canvases: 0, bytes: 3000, skippedTooLarge: 0, truncated: 0,
    };
    mockHandoff.mockResolvedValueOnce(record);
    const r = await renderSessionStatus({ chatId: S1, sessionTitle: 'Deck', projectName: null, runs: [], schedules: [], attention: undefined, since: SINCE, now: NOW });
    expect(r.status.doneSince).toEqual(['Delivered 2 files and 1 pull request to the parent chat: deck/cql-dgx-b300-deck.pdf, deck/cql-dgx-b300-deck.pptx']);
    expect(r.status.result).toEqual({ files: 2, prs: 1, canvases: 0, target: 'parent', line: r.status.doneSince[0] });
    expect(r.body).toContain('Delivered 2 files and 1 pull request to the parent chat');

    mockHandoff.mockResolvedValueOnce({ ...record, postedAt: new Date(SINCE.getTime() - 60_000).toISOString() });
    const r2 = await renderSessionStatus({ chatId: S1, sessionTitle: 'Deck', projectName: null, runs: [], schedules: [], attention: undefined, since: SINCE, now: NOW });
    expect(r2.status.doneSince).toEqual([]);
    expect(r2.status.result).toBeUndefined();

    // A failed record read degrades to "no line" — the card still renders.
    mockHandoff.mockRejectedValueOnce(new Error('store down'));
    const r3 = await renderSessionStatus({ chatId: S1, sessionTitle: 'Deck', projectName: null, runs: [], schedules: [], attention: undefined, since: SINCE, now: NOW });
    expect(r3.status.doneSince).toEqual([]);
  });
});

describe('emitSessionStatusUpdates — hourly, changed-only, appendCodingMessage', () => {
  const chatRow = { id: S1, title: 'Re-Send Path C', userId: 'u1', projectId: 'p1', project: { name: 'CanLaw' } };

  function seed(opts: { runs?: any[]; prev?: any } = {}) {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([chatRow]);
    mockPrisma.agentRun.findMany.mockResolvedValue(opts.runs ?? [{ sessionId: S1, status: 'completed', error: null, startedAt: SINCE, finishedAt: new Date(NOW.getTime() - 10 * 60_000) }]);
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(opts.prev ?? null);
  }

  it('first card: writes via appendCodingMessage with the contract metadata, bumps the chat, records the metric — never prisma.crossModelMessage.create', async () => {
    seed();
    const r = await emitSessionStatusUpdates({ now: NOW });
    expect(r).toEqual({ candidates: 1, emitted: 1, gated: 0, unchanged: 0, busy: 0, idle: 0, failed: 0 });
    expect(mockAppend).toHaveBeenCalledTimes(1);
    const row = mockAppend.mock.calls[0][0];
    expect(row.chatId).toBe(S1);
    expect(row.role).toBe('assistant');
    expect(row.metadata).toEqual(expect.objectContaining({ origin: SESSION_STATUS_ORIGIN, kind: SESSION_STATUS_ORIGIN, unchanged: false, since: SINCE.toISOString(), generatedAt: NOW.toISOString() }));
    expect(row.metadata.statusHash).toMatch(/^[0-9a-f]{32}$/);
    expect(row.metadata.status.headline).toBe('Re-Send Path C: no plan recorded; 1 run finished');
    expect(row.content.startsWith(`**${row.metadata.status.headline}**`)).toBe(true);
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    // No sidebar bump / unread re-arm for a session card (review 2026-09-15).
    expect(mockTouch).not.toHaveBeenCalled();
  });

  it('a run in flight defers the card (busy) — it never lands mid-run', async () => {
    seed({ runs: [
      { sessionId: S1, status: 'completed', error: null, startedAt: SINCE, finishedAt: NOW },
      { sessionId: S1, status: 'running', error: null, startedAt: NOW, finishedAt: null },
    ] });
    expect(await emitSessionStatusUpdates({ now: NOW })).toEqual(expect.objectContaining({ candidates: 1, busy: 1, emitted: 0 }));
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('idle sessions (no run touching the hour) get nothing; the 60-min gate suppresses; an unchanged status writes nothing', async () => {
    seed({ runs: [{ sessionId: S1, status: 'completed', error: null, startedAt: new Date(NOW.getTime() - 5 * 3600_000), finishedAt: new Date(NOW.getTime() - 4 * 3600_000) }] });
    expect(await emitSessionStatusUpdates({ now: NOW })).toEqual(expect.objectContaining({ idle: 1, emitted: 0 }));

    seed({ prev: { createdAt: new Date(NOW.getTime() - 20 * 60_000), metadata: { statusHash: 'x' } } });
    expect(await emitSessionStatusUpdates({ now: NOW })).toEqual(expect.objectContaining({ gated: 1, emitted: 0 }));

    // Compute the hash the sweep will produce, then plant it as the previous card's hash.
    seed();
    await emitSessionStatusUpdates({ now: NOW });
    const hash = mockAppend.mock.calls[0][0].metadata.statusHash;
    mockAppend.mockClear();
    seed({ prev: { createdAt: new Date(NOW.getTime() - 2 * SESSION_STATUS_INTERVAL_MS), metadata: { statusHash: hash } } });
    expect(await emitSessionStatusUpdates({ now: NOW })).toEqual(expect.objectContaining({ unchanged: 1, emitted: 0 }));
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it(`kill switch ${SESSION_STATUS_DISABLED_ENV}=1: no reads, no writes`, async () => {
    process.env[SESSION_STATUS_DISABLED_ENV] = '1';
    seed();
    expect(await emitSessionStatusUpdates({ now: NOW })).toEqual({ candidates: 0, emitted: 0, gated: 0, unchanged: 0, busy: 0, idle: 0, failed: 0 });
    expect(mockPrisma.crossModelChat.findMany).not.toHaveBeenCalled();
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('per-session isolation: one failing session never blocks the others', async () => {
    const S2 = 'sess-0002-aaaa-bbbb-cccc-000000000002';
    mockPrisma.crossModelChat.findMany.mockResolvedValue([chatRow, { ...chatRow, id: S2, title: 'Other lane' }]);
    mockPrisma.agentRun.findMany.mockResolvedValue([
      { sessionId: S1, status: 'completed', error: null, startedAt: SINCE, finishedAt: NOW },
      { sessionId: S2, status: 'completed', error: null, startedAt: SINCE, finishedAt: NOW },
    ]);
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
    mockAppend.mockImplementation(async (d: any) => { if (d.chatId === S1) throw new Error('boom'); return { id: 'ok', ...d }; });
    const r = await emitSessionStatusUpdates({ now: NOW });
    expect(r).toEqual(expect.objectContaining({ candidates: 2, emitted: 1, failed: 1 }));
  });

  it('discovers only live coding sessions touched in the last hour (never supervisors or archived satellites)', async () => {
    seed();
    await emitSessionStatusUpdates({ now: NOW });
    const where = mockPrisma.crossModelChat.findMany.mock.calls[0][0].where;
    expect(where).toEqual(expect.objectContaining({ archivedAt: null, isSupervisor: false, isProjectSupervisor: false }));
    expect(where.codingState).toEqual({ is: { status: { not: 'archived' } } });
    expect(where.updatedAt.gte.toISOString()).toBe(SINCE.toISOString());
  });
});

describe('status card — merged and docs-only PR counts (tt-rd audit 2026-09-27)', () => {
  it('counts merges from merge_pull_request receipts and docs-only opens from the receipt flag; "all docs-only" when every open was one', async () => {
    mockReceipts.mockResolvedValue([
      { tool: 'open_pull_request', ok: true, ids: { prNumber: 841, filesOnlyMd: true } },
      { tool: 'open_pull_request', ok: true, ids: { prNumber: 842, filesOnlyMd: true } },
      { tool: 'merge_pull_request', ok: true, ids: { prNumber: 841, mergeSha: 'abc' } },
    ]);
    const r = await renderSessionStatus({
      chatId: S1, sessionTitle: 'node-a Speed Mission Successor', projectName: 'tt-rd',
      runs: [{ sessionId: S1, status: 'completed', error: null, startedAt: SINCE, finishedAt: NOW }],
      schedules: [], attention: { approvals: [], questions: [] }, since: SINCE, now: NOW,
    });
    expect(r.status.prs).toEqual({ opened: 2, merged: 1, docsOnly: 2 });
    expect(r.status.doneSince).toEqual(['1 run finished', 'Opened 2 pull requests (all docs-only)', 'Merged 1 pull request']);
    mockReceipts.mockResolvedValue([
      { tool: 'open_pull_request', ok: true, ids: { prNumber: 1, filesOnlyMd: true } },
      { tool: 'open_pull_request', ok: true, ids: { prNumber: 2 } },
    ]);
    const r2 = await renderSessionStatus({
      chatId: S1, sessionTitle: 'x', projectName: null, runs: [], schedules: [], attention: { approvals: [], questions: [] }, since: SINCE, now: NOW,
    });
    expect(r2.status.doneSince).toEqual(['Opened 2 pull requests (1 docs-only)']);
  });
});

describe('T7-8 (audit 2026-10-06): local-only commits on the card', () => {
  afterEach(() => { mockUnpushed.mockResolvedValue(null); delete process.env.UNPUSHED_COMMITS_NOTE_DISABLED; });
  const render = () => renderSessionStatus({
    chatId: S1, sessionTitle: 'S4 incident', projectName: 'spark',
    runs: [{ sessionId: S1, status: 'completed', error: null, startedAt: SINCE, finishedAt: NOW }],
    schedules: [], attention: undefined, since: SINCE, now: NOW,
  });
  it('"Made 1 commit" says the commit is NOT pushed, and Next leads with the push', async () => {
    mockReceipts.mockResolvedValue([{ tool: 'git_commit', ok: true, ids: { sha: '07d91d2fabcdef00' } }]);
    mockUnpushed.mockResolvedValue({ count: 1, headSha: '07d91d2f', branch: 'digby/session-x', at: NOW.toISOString() });
    const { status, body } = await render();
    expect(status.doneSince).toContain('Made 1 commit — 1 local commit NOT pushed');
    expect(status.next[0]).toBe('Push 1 local commit — not on origin yet');
    expect(body).not.toMatch(ID_RE);
  });
  it('no stamp / pushed (count 0) / the kill switch => the original wording', async () => {
    mockReceipts.mockResolvedValue([{ tool: 'git_commit', ok: true, ids: {} }]);
    expect((await render()).status.doneSince).toContain('Made 1 commit');
    mockUnpushed.mockResolvedValue({ count: 0, headSha: 'aaaaaaaa', branch: null, at: '' });
    expect((await render()).status.next.some((l) => l.startsWith('Push '))).toBe(false);
    process.env.UNPUSHED_COMMITS_NOTE_DISABLED = '1';
    mockUnpushed.mockResolvedValue({ count: 3, headSha: 'aaaaaaaa', branch: null, at: '' });
    const r = await render();
    expect(r.status.doneSince).toContain('Made 1 commit');
    expect(mockUnpushed).toHaveBeenCalledTimes(2);
  });
});
