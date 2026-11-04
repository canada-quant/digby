/**
 * audit 2026-10-06 — team T4 pins for platform/supervisor-state.service.ts:
 *   T4-3/4 countOpenOwnerDirectives — open OWNER-origin rows (≤7 d) only;
 *          supervisor-written rows never count.
 *   T4-4   the DORMANT [PROJECT SCHEDULES] banner never says "re-arm NOTHING"
 *          to a supervisor running its own follow-up one-shot chain; kill
 *          switch DORMANT_BANNER_FOLLOWUP_DISABLED=1.
 *   T4-9   closeAskOnReply never closes an owner ask on a bare "WAKE: no-op"
 *          reply (isNoopOnlyReply — fleet/supervisor-reply-row); kill switch
 *          OWNER_ASK_NOOP_REPLY_DISABLED=1.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let stored: any = null;
const mockMsgFindUnique = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockChatFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockSchedFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockSchedGroupBy = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockPrisma: any = {
  supervisorState: {
    findUnique: jest.fn(async () => (stored ? { state: stored } : null)),
    upsert: jest.fn(async ({ create, update }: any) => { stored = (update?.state ?? create?.state); return { state: stored }; }),
    findMany: jest.fn(async () => []),
  },
  crossModelChat: { findUnique: jest.fn(async () => ({ project: { name: 'CanLaw' } })), findFirst: jest.fn(async () => null), findMany: (...a: any[]) => mockChatFindMany(...a) },
  crossModelMessage: { findUnique: (...a: any[]) => mockMsgFindUnique(...a), findMany: jest.fn(async () => []) },
  codingSchedule: { findMany: (...a: any[]) => mockSchedFindMany(...a), groupBy: (...a: any[]) => mockSchedGroupBy(...a) },
  agentRun: { groupBy: jest.fn(async () => []), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));

const mockDormancy = jest.fn(async (..._a: any[]): Promise<any> => ({ dormant: true, projectId: 'p1', reason: 'dormant', signals: {} }));
jest.mock('../coding/dormancy-gate.service', () => ({ __esModule: true, evaluateProjectDormancy: (...a: any[]) => mockDormancy(...a) }));

import {
  closeAskOnReply, countOpenOwnerDirectives, buildProjectScheduleBlock, parseSupervisorStateDoc,
} from './supervisor-state.service';
import { isNoopOnlyReply, isSupervisorReplyRow } from '../fleet/supervisor-reply-row';
import { HARNESS_NOOP_LINE, HARNESS_RECORD_ZERO_LINE } from './harness-receipts';

const CHAT = 'a89291b4-0000-4000-8000-000000000000';
const flush = () => new Promise((r) => setTimeout(r, 0));
const ENV = ['OWNER_ASK_NOOP_REPLY_DISABLED', 'DORMANT_BANNER_FOLLOWUP_DISABLED', 'SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  jest.clearAllMocks();
  stored = null;
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('countOpenOwnerDirectives (T4-3 / T4-4)', () => {
  const now = new Date('2026-10-06T01:00:00Z');
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  it('counts open OWNER-origin rows inside 7 days (asks and orders, standing too); never supervisor-written, done or stale rows', () => {
    const doc = parseSupervisorStateDoc({
      directives: [
        { id: 'own-fresh-1', text: 'hmm now on the ui everything is down', at: ago(1), status: 'open', origin: 'owner' },
        { id: 'own-ask-22', text: 'any update?', at: ago(2), status: 'open', origin: 'owner', kind: 'ask', messageId: 'm1' },
        { id: 'own-stand3', text: 'update me every hour on progress and eta', at: ago(45), status: 'open', origin: 'owner', standing: true },
        { id: 'own-stale4', text: 'old order', at: ago(24 * 8), status: 'open', origin: 'owner' },
        { id: 'sup-hold-5', text: 'HOLD until AGX green signal', at: ago(1), status: 'open' },
        { id: 'own-done-6', text: 'closed', at: ago(1), status: 'done', evidence: 'pr 12', origin: 'owner' },
      ],
    });
    const c = countOpenOwnerDirectives(doc, now, { sinceMs: now.getTime() - 90 * 60_000 });
    expect(c.open).toBe(3);
    expect(c.newSince).toBe(1);
    expect(c.ids).toEqual(['own-fres', 'own-ask-', 'own-stan']);
  });
});

describe('T4-9 — a bare no-op close never answers an owner ask', () => {
  it('isNoopOnlyReply: the marker-led short close only; a real answer that mentions it is a reply', () => {
    expect(isNoopOnlyReply('WAKE: no-op — nothing moved in CanLaw Data Scrape since the previous wake')).toBe(true);
    expect(isNoopOnlyReply('**SWEEP: no-op** — ledger unchanged.')).toBe(true);
    expect(isNoopOnlyReply('Progress: lane 3 is at 74 % (receipt 1a2b3c4d), ETA 2 h.\nWAKE: no-op otherwise.')).toBe(false);
    expect(isNoopOnlyReply(`WAKE: no-op\n${'details '.repeat(100)}`)).toBe(false);
    expect(isSupervisorReplyRow({ content: 'WAKE: no-op — nothing moved', metadata: { engine: 'agent' } })).toBe(false);
    expect(isSupervisorReplyRow({ content: 'Lane 3 is at 74 %.', metadata: { engine: 'agent' } })).toBe(true);
    process.env.OWNER_ASK_NOOP_REPLY_DISABLED = '1';
    expect(isNoopOnlyReply('WAKE: no-op — nothing moved')).toBe(false);
    expect(isSupervisorReplyRow({ content: 'WAKE: no-op — nothing moved', metadata: { engine: 'agent' } })).toBe(true);
  });

  const seedAsk = () => {
    stored = { directives: [{ id: 'd-ask-1', text: 'current progress?', at: new Date().toISOString(), status: 'open', origin: 'owner', kind: 'ask', messageId: 'ask-msg-1' }], archived: [], dispatches: [], projects: [], notes: '', refutations: [] };
  };

  it('closeAskOnReply refuses a no-op-only reply (ask stays open + metric); a real reply closes it', async () => {
    seedAsk();
    mockMsgFindUnique.mockResolvedValueOnce({ content: 'WAKE: no-op — nothing moved in CanLaw Data Scrape since the previous wake' });
    expect(await closeAskOnReply(CHAT, 'u1', { askMessageId: 'ask-msg-1', replyMessageId: 'reply-noop-1' })).toBe(false);
    await flush();
    expect(stored.directives[0].status).toBe('open');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'owner_ask_noop_reply', sessionId: CHAT }));

    mockMsgFindUnique.mockResolvedValueOnce({ content: 'Lane 3 is at 74 % (receipt 1a2b3c4d); ETA ~2 h.' });
    expect(await closeAskOnReply(CHAT, 'u1', { askMessageId: 'ask-msg-1', replyMessageId: 'reply-real-1' })).toBe(true);
    // audit 96fb2f25: a real reply lands the ANSWERED stamp — done is reserved for typed evidence
    expect(stored.directives[0]).toMatchObject({ status: 'answered', evidence: 'msg reply-re' });
  });

  it('kill switch OWNER_ASK_NOOP_REPLY_DISABLED=1 closes on the no-op reply as before', async () => {
    process.env.OWNER_ASK_NOOP_REPLY_DISABLED = '1';
    seedAsk();
    mockMsgFindUnique.mockResolvedValue({ content: 'WAKE: no-op — nothing moved' });
    expect(await closeAskOnReply(CHAT, 'u1', { askMessageId: 'ask-msg-1', replyMessageId: 'reply-noop-1' })).toBe(true);
    expect(mockMsgFindUnique).not.toHaveBeenCalled();
  });

  // Follow-through minors review fix (2026-10-22): a reply made ONLY of the harness's zero-action record lines carries
  // no word of the model's — an answer-first follow-through round reduced to it closed the owner ask with a
  // content-free bubble. Same switch as the follow-through wave (SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED=1).
  it("a reply made ONLY of harness zero-action record lines is a no-op reply — closeAskOnReply refuses it; prose beside it is a reply", async () => {
    expect(isNoopOnlyReply(HARNESS_RECORD_ZERO_LINE)).toBe(true);
    expect(isNoopOnlyReply(`${HARNESS_RECORD_ZERO_LINE}\nNot executed (harness): send_chat_message → chat 9e39ec5c (staged on a confirmation card)`)).toBe(true);
    expect(isNoopOnlyReply(HARNESS_NOOP_LINE)).toBe(true);
    expect(isNoopOnlyReply('Harness record: 0 mutating calls this wake.')).toBe(true); // rows before the 2026-10-20 rewording
    expect(isNoopOnlyReply(`The tt-rd supervisor has not replied yet\n\n${HARNESS_RECORD_ZERO_LINE}`)).toBe(false);
    expect(isSupervisorReplyRow({ content: HARNESS_RECORD_ZERO_LINE, metadata: { engine: 'agent', kind: 'continuation_result' } })).toBe(false);
    expect(isSupervisorReplyRow({ content: `The tt-rd supervisor has not replied yet\n\n${HARNESS_RECORD_ZERO_LINE}`, metadata: { engine: 'agent', kind: 'continuation_result' } })).toBe(true);
    seedAsk();
    mockMsgFindUnique.mockResolvedValueOnce({ content: HARNESS_RECORD_ZERO_LINE });
    expect(await closeAskOnReply(CHAT, 'u1', { askMessageId: 'ask-msg-1', replyMessageId: 'reply-rec-1', source: 'continuation' })).toBe(false);
    await flush();
    expect(stored.directives[0].status).toBe('open');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'owner_ask_noop_reply', meta: expect.objectContaining({ source: 'continuation' }) }));
    process.env.SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED = '1';
    expect(isNoopOnlyReply(HARNESS_RECORD_ZERO_LINE)).toBe(false);
  });

  it('a reply-row read failure closes as before (fail-open)', async () => {
    seedAsk();
    mockMsgFindUnique.mockRejectedValueOnce(new Error('db blip'));
    expect(await closeAskOnReply(CHAT, 'u1', { askMessageId: 'ask-msg-1', replyMessageId: 'reply-x' })).toBe(true);
  });
});

describe('T4-4 — the DORMANT banner respects the supervisor\'s own follow-up chain', () => {
  const SUP = '590d604e-0000-4000-8000-00000000a5a5';
  const LANE = 'c90fed41-0000-4000-8000-00000000b6b6';
  const NOW = new Date('2026-10-05T20:12:00Z');
  beforeEach(() => {
    mockChatFindMany.mockResolvedValue([
      { id: SUP, title: 'spark-cluster Supervisor', isProjectSupervisor: true },
      { id: LANE, title: 'watchdog lane' },
    ]);
    mockSchedGroupBy.mockResolvedValue([
      { sessionId: SUP, enabled: false, _count: { _all: 3 }, _max: { lastFiredAt: null } },
      { sessionId: LANE, enabled: false, _count: { _all: 1 }, _max: { lastFiredAt: null } },
    ]);
    mockSchedFindMany.mockImplementation(async (args: any) => {
      if (args?.where?.kind === 'once') {
        // link 3 of the chain fired 3 min ago (a fired one-shot is disabled at fire time)
        return [{ id: '40618495-0000-4000-8000-000000000000', enabled: false, lastFiredAt: new Date(NOW.getTime() - 3 * 60_000), kind: 'once' }];
      }
      return [];
    });
  });

  it('own chain live → the header names the dormant LEDGER and keeps the follow-ups in the supervisor\'s hands; the supervisor line asks for a real re-arm', async () => {
    const block = await buildProjectScheduleBlock('p1', NOW);
    expect(block).toContain('LEDGER is DORMANT');
    expect(block).toContain('your OWN follow-up one-shot chain');
    expect(block).not.toContain('heartbeat-less lanes are dormant-by-design: re-arm NOTHING');
    const supLine = block.split('\n').find((l) => l.includes(SUP.slice(-8)))!;
    expect(supLine).toContain('your own follow-up chain');
    const laneLine = block.split('\n').find((l) => l.includes(LANE.slice(-8)))!;
    expect(laneLine).toContain('re-arm NOTHING here');
  });

  it('no own chain → the plain dormant banner', async () => {
    mockSchedFindMany.mockResolvedValue([]);
    const block = await buildProjectScheduleBlock('p1', NOW);
    expect(block).toContain('heartbeat-less lanes are dormant-by-design: re-arm NOTHING');
  });

  it('kill switch DORMANT_BANNER_FOLLOWUP_DISABLED=1 → the plain dormant banner', async () => {
    process.env.DORMANT_BANNER_FOLLOWUP_DISABLED = '1';
    const block = await buildProjectScheduleBlock('p1', NOW);
    expect(block).toContain('heartbeat-less lanes are dormant-by-design: re-arm NOTHING');
    expect(block).not.toContain('your own follow-up chain');
  });
});
