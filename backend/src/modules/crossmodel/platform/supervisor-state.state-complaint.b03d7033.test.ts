/**
 * REPLAY — ticket b03d7033 (mishap, 2026-10-20): the owner asked, twice hours
 * apart, why an expected gateway endpoint was missing while stale routes were
 * still listed; the project supervisor's reply was explanation-only ("the bare
 * name is deliberate"), the harness stamped the ask 'answered' on that reply,
 * and the order the question carried died in the lane's transcript — no
 * action, no report-up, invisible to the tier above. The owner escalated:
 * "clearly my directives or something is being lost… figure out why it didnt
 * listen… why you didnt catch it."
 *
 * This suite pins BOTH halves of the fix:
 *  1. CAPTURE (supervisor-state.service): the interrogative state-complaint
 *     frame ("why do i still see no X? … i still see Y", "how come i dont see
 *     X?") classifies 'ask_directive' — the ask row closes on the reply, the
 *     ORDER TWIN (same messageId, no kind) survives until typed evidence. The
 *     03:28Z specimen is the replay case.
 *  2. FOLLOW-THROUGH (fleet/follow-through.service detector 3b): an ANSWERED
 *     ask whose order twin is still open is nudged at 4h and escalated to the
 *     Fleet Supervisor at 8h — the reply answered the question, not the order.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let stored: any = null;
const mockPrisma: any = {
  supervisorState: {
    findUnique: jest.fn(async () => (stored ? { state: stored } : null)),
    upsert: jest.fn(async ({ create, update }: any) => { stored = (update?.state ?? create?.state); return { state: stored }; }),
    findMany: jest.fn(async () => []),
  },
  crossModelChat: { findUnique: jest.fn(async () => ({ project: { name: 'LiteLLM' } })), findFirst: jest.fn(async () => null) },
  projectTodo: { findMany: jest.fn(async () => []) },
  codingSchedule: { findMany: jest.fn(async () => []) },
  ownerQuestion: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  agentRun: { groupBy: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));

import {
  classifyOwnerMessage, appendDirective, closeAskOnReply, getSupervisorState,
  listAnsweredAsksWithOpenTwin, listOpenOwnerAsks, isStateComplaintAsk,
} from './supervisor-state.service';

const CHAT = 'c6941c11-0000-4000-8000-000000000000';
// The 03:28:44Z specimen, verbatim (chat c6941c11, msg a9dfa3fb).
const SPECIMEN_0328 =
  "how come i dont see spark-deepseek-v4.1-flash-1017 as an endpoint avialble?? all i see is 'deepseek-v4.1-flash' …is that actually the correct 1017 model running on the sparks?";
// The 00:13Z fleet-chat specimen (msg prefix 00:13:26Z, user row): the
// leading connective shape the opener register also admits.
const SPECIMEN_0013 =
  'and why do i still see no spark-deepseek-v4.1-10-17 flash endpoint on the llm? and i still see spark qwen4b helper and other spark models that arent existent?';
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('b03d7033 capture: state-complaint asks ledger an ORDER TWIN', () => {
  beforeEach(() => { stored = null; mockRecordLoopMetric.mockClear(); });

  it('the specimen messages are state-complaint asks (isStateComplaintAsk)', () => {
    expect(isStateComplaintAsk(SPECIMEN_0328)).toBe(true);
    expect(isStateComplaintAsk(SPECIMEN_0013)).toBe(true);
  });

  it('the 03:28Z specimen classifies ask_directive — BOTH rows, same owner messageId', async () => {
    expect(classifyOwnerMessage(SPECIMEN_0328)).toBe('ask_directive');
    await appendDirective(CHAT, 'u1', SPECIMEN_0328, { messageId: 'a9dfa3fb-0000-4000-8000-000000000001' });
    const doc = await getSupervisorState(CHAT);
    expect(doc.directives).toHaveLength(2);
    expect(doc.directives[0]).toMatchObject({ kind: 'ask', status: 'open', messageId: 'a9dfa3fb-0000-4000-8000-000000000001' });
    expect(doc.directives[1]).toMatchObject({ status: 'open', messageId: 'a9dfa3fb-0000-4000-8000-000000000001' });
    expect(doc.directives[1].kind).toBeUndefined();
    expect(doc.directives[0].text).toBe(doc.directives[1].text);
  });

  it('REPLAY of the mishap: an explanation-only reply stamps the ask ANSWERED but the order twin SURVIVES — and the pair is now visible to the sweep', async () => {
    await appendDirective(CHAT, 'u1', SPECIMEN_0328, { messageId: 'a9dfa3fb-0000-4000-8000-000000000001' });
    // The 03:29:37Z reply (msg 3d142b27): explanation-only, no action, no report-up.
    expect(await closeAskOnReply(CHAT, 'u1', { askMessageId: 'a9dfa3fb-0000-4000-8000-000000000001', replyMessageId: '3d142b27-0000-4000-8000-000000000002' })).toBe(true);
    const doc = await getSupervisorState(CHAT);
    // Pre-fix end state: the ask row is answered and INVISIBLE to every open-ask scan.
    expect(doc.directives[0]).toMatchObject({ kind: 'ask', status: 'answered', evidence: 'msg 3d142b27' });
    expect(await listOpenOwnerAsks(CHAT)).toEqual([]);
    // Post-fix: the order twin is still open …
    expect(doc.directives[1]).toMatchObject({ status: 'open' });
    // … and the answered-ask-with-open-twin read names the pair — the input the
    // 4h nudge / 8h escalation (detector 3b) keys on.
    const pairs = await listAnsweredAsksWithOpenTwin(CHAT);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ askId: doc.directives[0].id, twinId: doc.directives[1].id, messageId: 'a9dfa3fb-0000-4000-8000-000000000001' });
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'directive_ask_autoclose', meta: expect.objectContaining({ askMessageId: 'a9dfa3fb', replyMessageId: '3d142b27', status: 'answered' }) }));
  });

  it('the twin closes only on evidence: a done close without evidence is still rejected (the anti-phantom rule holds for the twin)', async () => {
    await appendDirective(CHAT, 'u1', SPECIMEN_0328, { messageId: 'a9dfa3fb-0000-4000-8000-000000000001' });
    await closeAskOnReply(CHAT, 'u1', { askMessageId: 'a9dfa3fb-0000-4000-8000-000000000001', replyMessageId: '3d142b27-0000-4000-8000-000000000002' });
    // applyStateUpdate is exercised in the owner-asks suite; here the invariant
    // under test is the READ: with the twin closed (done + evidence) the pair
    // disappears from the sweep input.
    const doc = await getSupervisorState(CHAT);
    doc.directives[1].status = 'done';
    doc.directives[1].evidence = 'PR #1234';
    stored = { ...stored, directives: doc.directives };
    expect(await listAnsweredAsksWithOpenTwin(CHAT)).toEqual([]);
  });

  it('NEGATIVE register: ordinary why-questions without a complaint verb stay pure asks (no twin)', async () => {
    for (const t of [
      'is that actually the correct model running on the sparks?',
      'why did the roster go from 51 to 49 names?',
      'why is the context cap pinned to 262144?',
      'how come the gateway advertises one canonical route per engine?',
    ]) {
      expect([t, isStateComplaintAsk(t)]).toEqual([t, false]);
      expect([t, classifyOwnerMessage(t)]).toEqual([t, 'ask']);
    }
    // none of these ledger a twin
    await appendDirective(CHAT, 'u1', 'is that actually the correct model running on the sparks?', { messageId: 'msg-plain-00000001' });
    const doc = await getSupervisorState(CHAT);
    expect(doc.directives).toHaveLength(1);
    expect(doc.directives[0].kind).toBe('ask');
  });

  // Review finding 2 (dead branch): OWNER_ASK_OPENER_RE's "why is|are … still"
  // band matched "why is it still not showing X" first, so the ask_directive
  // branch underneath never ran — the mishap class survived for exactly this
  // phrasing. The opener return now consults isStateComplaintAsk too.
  it('opener-matched state complaints still reach the twin (review finding 2 regression pin)', () => {
    for (const t of [
      'why is it still not showing the new endpoint?',
      'why are you still not showing the routes?',
      'why is it still not showing?',
      'why is this still listed under the old name?',
    ]) {
      expect([t, classifyOwnerMessage(t)]).toEqual([t, 'ask_directive']);
    }
    // an opener-matched NON-complaint stays a pure ask
    for (const t of [
      'why is it taking so long to finish the soak?',
      'why are you still working on the rebase?',
    ]) {
      expect([t, classifyOwnerMessage(t)]).toEqual([t, 'ask']);
    }
  });

  // Review finding 1 (false escalation): doctrine's documented clear path is
  // recording a blocker as evidence on the OPEN twin; the sweep must stay
  // silent on a cleared twin, never nudge it and never tell the Fleet
  // Supervisor it has "no evidence on record".
  it('a twin carrying recorded evidence (a documented blocker) is EXCLUDED from the sweep read (review finding 1 regression pin)', async () => {
    await appendDirective(CHAT, 'u1', SPECIMEN_0328, { messageId: 'a9dfa3fb-0000-4000-8000-000000000001' });
    await closeAskOnReply(CHAT, 'u1', { askMessageId: 'a9dfa3fb-0000-4000-8000-000000000001', replyMessageId: '3d142b27-0000-4000-8000-000000000002' });
    // the supervisor recorded a blocker on the open twin — the documented clear path
    const doc = await getSupervisorState(CHAT);
    doc.directives[1].evidence = 'blocked: amd-1 soak ends 17:06Z (msg 462f348e)';
    stored = { ...stored, directives: doc.directives };
    expect(await listAnsweredAsksWithOpenTwin(CHAT)).toEqual([]);
  });

  it('NEGATIVE register: W1-5 remarks stay asks — the twin never widens to non-complaint remarks', () => {
    for (const t of [
      "i don't see that issue at all",
      'you said you dismissed the owner card but it is still showing',
      'what is going on with the speed mission, it has been two days and I see nothing',
    ]) {
      expect([t, classifyOwnerMessage(t)]).toEqual([t, 'ask']);
    }
  });

  it('an answered ask with NO twin (a pure ask, the pre-b03d7033 majority) never appears in the twin read', async () => {
    await appendDirective(CHAT, 'u1', 'any progress ?', { messageId: 'msg-ask-00000002' });
    await closeAskOnReply(CHAT, 'u1', { askMessageId: 'msg-ask-00000002', replyMessageId: 'reply-00000003' });
    expect(await listAnsweredAsksWithOpenTwin(CHAT)).toEqual([]);
  });
});
