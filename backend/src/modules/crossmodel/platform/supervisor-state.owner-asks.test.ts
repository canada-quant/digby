/**
 * Owner ASKS in the directive ledger (tt-rd audit 2026-09-27, finding
 * upward-chatter-directives-3): the ten "progress?" pings captured as OPEN
 * DIRECTIVES that only a typed artifact could close.
 *
 *  - classifyOwnerMessage: acks skip; the narrow status set AND the broadened
 *    openers ('any progress ?', 'any new progress', 'where are we at', 'what
 *    are you doing', 'any successes recently…', 'how are we looking?…') read
 *    'ask' (no length limit on the openers); orders read 'directive';
 *  - isAckOrStatusQuestion keeps its byte-identical narrow contract (the
 *    project brief pins it);
 *  - appendDirective ledgers an ask as kind:'ask' + messageId (never
 *    standing), a directive as before;
 *  - closeAskOnReply closes ONLY the kind:'ask' row keyed on the owner row id
 *    with evidence `msg <replyId8>` (harness-written), never an imperative
 *    directive; telemetry lands;
 *  - listOpenOwnerAsks / formatStateForWake: asks render under OPEN OWNER
 *    ASKS, directives under OPEN DIRECTIVES; parseDoc keeps kind + messageId.
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
  crossModelChat: { findUnique: jest.fn(async () => ({ project: { name: 'tt-rd' } })), findFirst: jest.fn(async () => null) },
  projectTodo: { findMany: jest.fn(async () => []) },
  chatSchedule: { findMany: jest.fn(async () => []) },
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
  classifyOwnerMessage, isAckOrStatusQuestion, hasOwnerOrderCue, OWNER_ASK_OPENER_RE, isImperativeOwnerMessage,
  appendDirective, closeAskOnReply, listOpenOwnerAsks, getSupervisorState, formatStateForWake,
} from './supervisor-state.service';

const CHAT = '810c924d-0000-4000-8000-000000000000';
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('classifyOwnerMessage', () => {
  // audit 2026-10-08 W1-5 (supervisors F8): REPLAY — the remarks and questions the window
  // ledgered as closable DIRECTIVES (0ba4d476, d897eaef, 43a458ed, the CanLaw "progress now ?" /
  // "??" / "done?" rows) are asks now; the real owner orders stay directives.
  it('W1-5: remarks and questions without an imperative are asks, never directives', () => {
    for (const t of [
      "i don't see that issue at all",
      'you said you dismissed the owner card but it is still showing',
      'are you able to get the transcriptions from today?',
      'progress now ?', '??', 'done?', 'what are you waiting for', 'progress and eta?', 'do you need me to do something',
      'Lol…tt-rd is a project supervisor chat in the tt-rd in digby not a imessage contact',
    ]) {
      expect([t, isImperativeOwnerMessage(t)]).toEqual([t, false]);
      expect([t, classifyOwnerMessage(t)]).toEqual([t, 'ask']);
    }
  });
  it('W1-5: imperative orders, standing rules and long statements stay directives', () => {
    for (const t of [
      'archive any completed sessions',
      "verify a Mac is signed into the owner's Apple account before using Apple-backed services",
      'make sure the recorder opens all four interior cameras during school hours',
      'can you restart the recorder lane',
      "don't merge anything until I look",
      'Swap the bench lane to Machete and run the cutover tonight',
      'The recorder has been capturing the wrong room all morning. The teacher and the student are in learning room 2, not the main room, and every capture so far has been dead air because of that choice.',
    ]) {
      expect([t, classifyOwnerMessage(t)]).toEqual([t, 'directive']);
    }
  });
  it('W1-5: kill switch SUPERVISOR_DIRECTIVE_IMPERATIVE_ONLY_DISABLED=1 restores remarks-as-directives', () => {
    process.env.SUPERVISOR_DIRECTIVE_IMPERATIVE_ONLY_DISABLED = '1';
    try {
      expect(classifyOwnerMessage("i don't see that issue at all")).toBe('directive');
      expect(classifyOwnerMessage('are you able to get the transcriptions from today?')).toBe('directive');
    } finally { delete process.env.SUPERVISOR_DIRECTIVE_IMPERATIVE_ONLY_DISABLED; }
  });
  it('the tt-rd owner pings read as asks (the audit\'s 9/10 that were captured as directives, plus the one that was skipped)', () => {
    for (const t of [
      'progress?', 'any progress ?', 'any new progress', 'where are we at', 'what are you doing',
      'any successes recently on the speed mission?', 'whats the newest tok/s number', 'how are we looking? still stuck on the bisect?',
      'what is going on with the speed mission, it has been two days and I see nothing', 'why are you taking so long on this',
      'status', 'any update?', 'is it done yet', 'did it land',
    ]) {
      expect([t, classifyOwnerMessage(t)]).toEqual([t, 'ask']);
    }
  });
  it('acks skip; orders are directives', () => {
    expect(classifyOwnerMessage('ok thanks!')).toBe('ack');
    expect(classifyOwnerMessage('👍')).toBe('ack');
    expect(classifyOwnerMessage('')).toBe('ack');
    expect(classifyOwnerMessage('Swap the bench lane to Machete and run the cutover tonight')).toBe('directive');
    expect(classifyOwnerMessage('ok, but also re-run the failing suite before merging')).toBe('directive');
    expect(classifyOwnerMessage('1% is not acceptable, rebase onto v0.78.0 now and re-measure')).toBe('directive');
    expect(classifyOwnerMessage('we need to stay up to date with upstream — subscribe to the tt-metal repo')).toBe('directive');
  });
  // fixer 2026-09-27 (finding upward-chatter-2): an opener-led message that
  // ALSO carries an order is 'ask_directive' — the ask row closes on reply,
  // the order row survives until typed evidence. Pre-fix every one of these
  // read 'ask' and closeAskOnReply retired the order on the first reply.
  it('opener-led ORDERS are ask_directive (both rows), never a bare ask', () => {
    for (const t of [
      'what are you doing about the truncated results log — restore it from git history and stop appending, use one PR per day',
      'any update — if the ladder still has 0 adoptions kill it and start the rebase today',
      'is it done? if so merge to main and archive the lane',
      'did it merge? if not, merge it now',
      'why is this taking so long — cut the self-audit passes to one per day',
      'how far are we from 7 tok/s — report the client-visible probe number, not the internal one',
      'why are you taking so long cant you spawn more sessions to acheve goals faster?',
      'any progress? please post the probe number every day',
      'where are we at, you need to stop appending to the log',
    ]) {
      expect([t, hasOwnerOrderCue(t)]).toEqual([t, true]);
      expect([t, classifyOwnerMessage(t)]).toEqual([t, 'ask_directive']);
    }
    // opener-led pure asks carry no cue — question auxiliaries are neutralised, past-tense / gerund verbs are not orders
    for (const t of [
      'any progress ?', 'where are we at with the rebase, it has been two days', 'how are we looking? still stuck on the bisect?',
      'what is going on with the speed mission, it has been two days and I see nothing', 'why are you taking so long on this',
      'any luck with the run the lane started', 'is it done yet',
    ]) {
      expect([t, hasOwnerOrderCue(t)]).toEqual([t, false]);
      expect([t, classifyOwnerMessage(t)]).toEqual([t, 'ask']);
    }
    // questions with an auxiliary + an order verb are NOT cues either ("did you check" is a question, "check the" alone would be)
    for (const t of ['did you check the probe?', 'are you stuck on the merge?', 'have you merged it', 'do you need more sessions']) {
      expect([t, hasOwnerOrderCue(t)]).toEqual([t, false]);
    }
    expect(hasOwnerOrderCue('check the probe')).toBe(true);
  });

  it('the broadened openers have no length limit; the narrow contract of isAckOrStatusQuestion is unchanged', () => {
    const long = 'where are we at with the rebase — it has been two days and the results log still shows 5.08, is the vendor engine loop the blocker or not';
    expect(OWNER_ASK_OPENER_RE.test(long)).toBe(true);
    expect(classifyOwnerMessage(long)).toBe('ask');
    expect(isAckOrStatusQuestion(long)).toBe(false);
    expect(isAckOrStatusQuestion('where are you at?')).toBe(false); // project-brief pin (review C7) — untouched
    expect(isAckOrStatusQuestion('any update?')).toBe(true);
    expect(isAckOrStatusQuestion('ok')).toBe(true);
  });
});

describe('appendDirective ask capture', () => {
  beforeEach(() => { stored = null; mockRecordLoopMetric.mockClear(); });

  it('a status question is ledgered as kind:"ask" with the owner row id and never as standing; an order stays a plain directive', async () => {
    await appendDirective(CHAT, 'u1', 'any progress ?', { messageId: 'msg-1111aaaa-0000' });
    await appendDirective(CHAT, 'u1', 'from now on always rebase before measuring', { messageId: 'msg-2222bbbb-0000' });
    const doc = await getSupervisorState(CHAT);
    expect(doc.directives).toHaveLength(2);
    expect(doc.directives[0]).toMatchObject({ text: 'any progress ?', status: 'open', kind: 'ask', messageId: 'msg-1111aaaa-0000', scope: 'tt-rd' });
    expect(doc.directives[0].standing).toBeUndefined();
    expect(doc.directives[1]).toMatchObject({ text: 'from now on always rebase before measuring', status: 'open', standing: true, messageId: 'msg-2222bbbb-0000' });
    expect(doc.directives[1].kind).toBeUndefined();
    // a pure ack is never ledgered
    await appendDirective(CHAT, 'u1', 'thanks!', { messageId: 'msg-3333' });
    expect((await getSupervisorState(CHAT)).directives).toHaveLength(2);
  });

  it('an opener-led ORDER ledgers BOTH rows: the ask (kind ask, msg id) and the plain directive (no kind, standing per the regex) — the reply closes only the ask', async () => {
    await appendDirective(CHAT, 'u1', 'any update — from now on if the ladder still has 0 adoptions kill it and start the rebase', { messageId: 'msg-both-11111111' });
    const doc = await getSupervisorState(CHAT);
    expect(doc.directives).toHaveLength(2);
    expect(doc.directives[0]).toMatchObject({ kind: 'ask', status: 'open', messageId: 'msg-both-11111111', scope: 'tt-rd' });
    expect(doc.directives[0].standing).toBeUndefined();
    expect(doc.directives[1]).toMatchObject({ status: 'open', standing: true, messageId: 'msg-both-11111111', scope: 'tt-rd' });
    expect(doc.directives[1].kind).toBeUndefined();
    expect(doc.directives[0].text).toBe(doc.directives[1].text);
    expect(await closeAskOnReply(CHAT, 'u1', { askMessageId: 'msg-both-11111111', replyMessageId: 'reply-abcdefgh' })).toBe(true);
    const after = await getSupervisorState(CHAT);
    expect(after.directives[0]).toMatchObject({ kind: 'ask', status: 'answered', evidence: 'msg reply-ab' });
    expect(after.directives[1]).toMatchObject({ status: 'open' }); // the order survives the reply
    expect(await listOpenOwnerAsks(CHAT)).toEqual([]);
  });
});

describe('closeAskOnReply + listOpenOwnerAsks + wake render', () => {
  beforeEach(() => { stored = null; mockRecordLoopMetric.mockClear(); });

  it('closes the ask keyed on the owner row with harness evidence msg <replyId8>; the directive stays open; telemetry lands', async () => {
    await appendDirective(CHAT, 'u1', 'any new progress', { messageId: 'msg-ask-11111111' });
    await appendDirective(CHAT, 'u1', 'rebase onto v0.78.0 and re-measure', { messageId: 'msg-order-2222' });
    expect((await listOpenOwnerAsks(CHAT)).map((a) => a.text)).toEqual(['any new progress']);
    expect(await closeAskOnReply(CHAT, 'u1', { askMessageId: 'msg-ask-11111111', replyMessageId: 'reply-abcdefgh-9' })).toBe(true);
    const doc = await getSupervisorState(CHAT);
    expect(doc.directives[0]).toMatchObject({ kind: 'ask', status: 'answered', evidence: 'msg reply-ab' });
    expect(doc.directives[1]).toMatchObject({ status: 'open' });
    expect(await listOpenOwnerAsks(CHAT)).toEqual([]);
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'directive_ask_autoclose', sessionId: CHAT, meta: expect.objectContaining({ askMessageId: 'msg-ask-', replyMessageId: 'reply-ab', source: 'owner_turn', status: 'answered' }) }));
    // a second close of the same ask is a no-op
    expect(await closeAskOnReply(CHAT, 'u1', { askMessageId: 'msg-ask-11111111', replyMessageId: 'reply-2' })).toBe(false);
  });

  // Audit 96fb2f25 — REPLAY, specimen raspi e571edf5 (2026-10-15 22:09Z): the owner
  // asked "seems doorbell doesn't work now and the weather isn't displaying either
  // maybe the tailscale changes broke everything?" (msg 3cf01522); the supervisor's
  // FIRST reply said "NOT done yet … repair lane has NOT been dispatched" and the
  // harness still stamped the ask DONE at 22:13:25Z — the board then rendered
  // "→ done: Ledger records it as done" while the fix lane was still running (the
  // card at 22:15:34Z contradicted itself). A reply landing says NOTHING about the
  // outcome: the stamp is 'answered' now, and 'done' survives ONLY via typed
  // evidence (update_supervisor_state) — never from a reply existing.
  it('96fb2f25 replay: a reply that says NOT-done-yet stamps ANSWERED, never done — the board cannot show the request fulfilled while unresolved', async () => {
    await appendDirective(CHAT, 'u1', 'seems doorbell doesn\'t work now and the weather isn\'t displaying either maybe the tailscale changes broke everything?', { messageId: '3cf01522-0000-4000-8000-000000000001' });
    expect(await closeAskOnReply(CHAT, 'u1', { askMessageId: '3cf01522-0000-4000-8000-000000000001', replyMessageId: '879175d0-0000-4000-8000-000000000002' })).toBe(true);
    const doc = await getSupervisorState(CHAT);
    expect(doc.directives[0]).toMatchObject({ kind: 'ask', status: 'answered', evidence: 'msg 879175d0' });
    expect(doc.directives[0].status).not.toBe('done');
    // answered drops out of the open-ask scans (no re-nudge, no re-wake block)
    expect(await listOpenOwnerAsks(CHAT)).toEqual([]);
    // the round trip preserves 'answered' (parseDoc) — a read can neither re-open nor fulfill it
    const reread = await getSupervisorState(CHAT);
    expect(reread.directives[0].status).toBe('answered');
  });

  it('96fb2f25: parseDoc preserves answered ONLY on kind:ask rows — an imperative directive carrying it reads open', async () => {
    stored = {
      version: 2,
      directives: [
        { id: 'd1', text: 'fix the doorbell', at: '2026-10-15T22:09:00.000Z', status: 'answered', kind: 'ask', messageId: 'm1', evidence: 'msg 879175d0' },
        { id: 'd2', text: 'archive completed sessions', at: '2026-10-15T22:10:00.000Z', status: 'answered', standing: true, messageId: 'm2' },
      ],
      asks: {}, notes: [],
    };
    const doc = await getSupervisorState(CHAT);
    expect(doc.directives[0].status).toBe('answered');
    expect(doc.directives[1].status).toBe('open'); // answered is a harness-only ask semantic
  });

  it('96fb2f25: kill switch OWNER_ASK_DONE_TRUTH_DISABLED=1 restores the legacy done stamp', async () => {
    await appendDirective(CHAT, 'u1', 'any progress ?', { messageId: 'msg-ask-33333333' });
    process.env.OWNER_ASK_DONE_TRUTH_DISABLED = '1';
    try {
      expect(await closeAskOnReply(CHAT, 'u1', { askMessageId: 'msg-ask-33333333', replyMessageId: 'reply-legacy-0' })).toBe(true);
      const doc = await getSupervisorState(CHAT);
      expect(doc.directives[0]).toMatchObject({ kind: 'ask', status: 'done', evidence: 'msg reply-le' });
    } finally { delete process.env.OWNER_ASK_DONE_TRUTH_DISABLED; }
  });

  it('fixer 2026-09-27: the close records WHICH seam closed it (machine_wake / reconcile) for the calibration readout', async () => {
    await appendDirective(CHAT, 'u1', 'any new progress', { messageId: 'msg-ask-11111111' });
    expect(await closeAskOnReply(CHAT, 'u1', { askMessageId: 'msg-ask-11111111', replyMessageId: 'reply-abcdefgh-9', source: 'machine_wake' })).toBe(true);
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'directive_ask_autoclose', meta: expect.objectContaining({ source: 'machine_wake' }) }));
  });

  it('formatStateForWake omits the asks in hideAskIds (listed once by the wake block / already answered) and keeps the rest', () => {
    const now = new Date('2026-09-27T16:00:00Z');
    const doc = {
      directives: [
        { id: 'ask-shown', text: 'any progress ?', at: new Date(now.getTime() - 2 * 3600_000).toISOString(), status: 'open' as const, kind: 'ask' as const, messageId: 'msg-abcdefgh-1' },
        { id: 'ask-answered', text: 'where are we at', at: new Date(now.getTime() - 3 * 3600_000).toISOString(), status: 'open' as const, kind: 'ask' as const, messageId: 'msg-abcdefgh-2' },
        { id: 'ask-stale', text: 'how are we looking?', at: new Date(now.getTime() - 100 * 3600_000).toISOString(), status: 'open' as const, kind: 'ask' as const },
        { id: 'dir-1', text: 'rebase first', at: new Date(now.getTime() - 3600_000).toISOString(), status: 'open' as const },
      ],
      archived: [], dispatches: [], projects: [], notes: '', refutations: [], inflightPreemptAt: '',
    };
    const block = formatStateForWake(doc, now, { hideAskIds: ['ask-shown', 'ask-answered'] });
    expect(block).toContain('OPEN OWNER ASKS (unanswered');
    expect(block).toContain('- [ask-stale]');
    expect(block).not.toContain('[ask-shown]');
    expect(block).not.toContain('[ask-answered]');
    expect(block).toContain('- [dir-1] (1h ago) rebase first');
    // everything hidden → the section disappears entirely
    expect(formatStateForWake(doc, now, { hideAskIds: ['ask-shown', 'ask-answered', 'ask-stale'] })).not.toContain('OPEN OWNER ASKS');
    // no opts → byte-identical to the old render
    expect(formatStateForWake(doc, now)).toBe(formatStateForWake(doc, now, {}));
  });

  it('a reply never closes an imperative directive or an unknown ask id', async () => {
    await appendDirective(CHAT, 'u1', 'rebase onto v0.78.0 and re-measure', { messageId: 'msg-order-2222' });
    expect(await closeAskOnReply(CHAT, 'u1', { askMessageId: 'msg-order-2222', replyMessageId: 'r1' })).toBe(false);
    expect(await closeAskOnReply(CHAT, 'u1', { askMessageId: 'nope', replyMessageId: 'r1' })).toBe(false);
    expect((await getSupervisorState(CHAT)).directives.every((d) => d.status === 'open')).toBe(true);
  });

  it('listOpenOwnerAsks honours maxAgeMs and sorts oldest first; parseDoc keeps kind + messageId across a round trip', async () => {
    const now = new Date('2026-09-27T16:00:00Z');
    stored = {
      directives: [
        { id: 'new', text: 'any progress ?', at: new Date(now.getTime() - 3600_000).toISOString(), status: 'open', kind: 'ask', messageId: 'm-new' },
        { id: 'old', text: 'where are we at', at: new Date(now.getTime() - 100 * 3600_000).toISOString(), status: 'open', kind: 'ask', messageId: 'm-old' },
        { id: 'mid', text: 'how are we looking?', at: new Date(now.getTime() - 5 * 3600_000).toISOString(), status: 'open', kind: 'ask' },
        { id: 'ord', text: 'rebase first', at: new Date(now.getTime() - 5 * 3600_000).toISOString(), status: 'open' },
      ],
      archived: [], dispatches: [], projects: [], notes: '', refutations: [], inflightPreemptAt: '',
    };
    expect((await listOpenOwnerAsks(CHAT, { now })).map((a) => a.id)).toEqual(['old', 'mid', 'new']);
    expect((await listOpenOwnerAsks(CHAT, { now, maxAgeMs: 72 * 3600_000 })).map((a) => a.id)).toEqual(['mid', 'new']);
    const doc = await getSupervisorState(CHAT);
    expect(doc.directives.find((d) => d.id === 'old')).toMatchObject({ kind: 'ask', messageId: 'm-old' });
    expect(doc.directives.find((d) => d.id === 'ord')!.kind).toBeUndefined();
  });

  it('formatStateForWake renders asks under OPEN OWNER ASKS (with msg id) and directives under OPEN DIRECTIVES', () => {
    const now = new Date('2026-09-27T16:00:00Z');
    const block = formatStateForWake({
      directives: [
        { id: 'ask-1', text: 'any progress ?', at: new Date(now.getTime() - 2 * 3600_000).toISOString(), status: 'open', kind: 'ask', messageId: 'msg-abcdefgh-1' },
        { id: 'dir-1', text: 'rebase first', at: new Date(now.getTime() - 3600_000).toISOString(), status: 'open' },
      ],
      archived: [], dispatches: [], projects: [], notes: '', refutations: [], inflightPreemptAt: '',
    }, now);
    const asksIdx = block.indexOf('OPEN OWNER ASKS (unanswered');
    const dirIdx = block.indexOf('OPEN DIRECTIVES:');
    expect(asksIdx).toBeGreaterThan(0);
    expect(dirIdx).toBeGreaterThan(asksIdx);
    expect(block).toContain('- [ask-1] (2h ago, msg msg-abcd) [scope: tt-rd]'.replace(' [scope: tt-rd]', '') + ' "any progress ?"');
    expect(block.slice(dirIdx)).toContain('- [dir-1] (1h ago) rebase first');
    expect(block.slice(dirIdx)).not.toContain('any progress ?');
  });
});
