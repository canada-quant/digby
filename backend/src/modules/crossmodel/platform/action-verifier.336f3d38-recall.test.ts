/**
 * DETECTOR-RECALL REPLAY (PR #1789 — ticket 336f3d38 cross-review residuals).
 *
 * This PR changes a framework detector (platform/action-verifier.ts): the
 * PRE-DELIVERY warn's delivery phrase is now scoped to the verdict class the
 * machine-wake seam actually delivers (citation-class → annotated;
 * ACTION-class under ACTION_VERIFIER_ENFORCE unset → UNMODIFIED). The merge
 * gate requires the detector's PRIOR TRUE POSITIVES — the convicting cases
 * this detector's enforcement rests on — to be replayed against the change
 * and asserted to STILL FIRE. The incident's own true positives are the three
 * fabricated-citation ids from ticket 336f3d38 (d12f21f1 / d031a112 /
 * 2b3cf15b — chat 99e63f86's 16:31:43Z note) plus the reviewer's 16469005
 * mixed-strike replay shape (a fabricated-id dispatch claim). None of them
 * may regress to non-conviction because of the warn phrasing branch.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  ownerQuestion: { findFirst: jest.fn(async () => null) },
  runToolReceipt: { findFirst: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockUtilityChat = jest.fn(async (..._a: any[]) => '');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));
const mockFileFeedbackTicket = jest.fn(async (..._a: any[]) => ({ deduped: false, ticket: { id: 't-1' } }));
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, fileFeedbackTicket: (...a: any[]) => (mockFileFeedbackTicket as any)(...a) }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: jest.fn(async () => {}),
  getSupervisorState: jest.fn(async () => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] })),
}));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));

import { guardMachineWakeFinalAnswer, isCitationClassClaim } from './action-verifier';

const CHAT = '99e63f86-ecd3-4d6d-b5fb-a3e199a1ebfa';
const USER = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';

describe('DETECTOR-RECALL REPLAY — ticket 336f3d38 residuals (PR #1789): the prior true positives still fire', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OWNER_NOTE_NO_EDIT_DISABLED;
    delete process.env.ACTION_VERIFIER_ENFORCE;
  });

  it('DETECTOR-RECALL REPLAY: the incident\'s three fabricated ids (d12f21f1 / d031a112 / 2b3cf15b) still convict citation-class under the scoped warn phrase', async () => {
    const note = [
      '**Peer re-grant request verified and answered — grant dispatched, window-watch armed, triggers banked As of 09:31 AM PDT (16:31Z).**',
      `**Lane 24f1950e reactivated + dispatched** (receipt d12f21f1) with the established append lifecycle`,
      `**Ack to the requester** (receipt d031a112): grant in flight, close-trigger protocol banked`,
      `**Window-watch armed on my own chat** (one-shot, fires 16:45Z — sched 2b3cf15b)`,
      'ACTIONS TAKEN',
      `- Lane 24f1950e unarchived + briefed — receipt d12f21f1`,
      `- Close-trigger protocol + grant ack sent to spark-cluster 69fb25fc — receipt d031a112`,
      `- One-shot window-watch armed on this chat (next fire 16:45Z) — sched 2b3cf15b`,
    ].join('\n');
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: USER, finalText: note, parts: [] as any[], receipts: [] as any[],
      runStartedAt: new Date(Date.now() - 60_000), supervisor: true, supervisorScope: 'project' as const,
      machineTriggered: true, consequenceScope: 'citation-only' as const,
      now: new Date('2026-10-19T16:31:43Z'),
    });
    expect(res.struck).toBe(true);
    const convicted = res.phantoms.filter((p) => ['d12f21f1', 'd031a112', '2b3cf15b'].includes(String(p.id)));
    expect(convicted.length).toBeGreaterThanOrEqual(3);
    for (const p of convicted) {
      expect(isCitationClassClaim(p)).toBe(true); // still enforcement-eligible — the citation lanes' conviction is untouched by the warn phrasing branch
    }
  });

  it('DETECTOR-RECALL REPLAY: a fabricated-id dispatch claim (the 16469005 mixed-strike shape) still convicts with fabricatedId — the id-existence true positive', async () => {
    // The id-bearing action claim whose id exists NOWHERE: markFabricatedIds
    // stamps fabricatedId ⇒ citation-class ⇒ still enforced by the
    // always-on citation lane. This is the exact class the 16469005 replay
    // pinned (an ACTION-kind claim whose id is invented), and it must NOT
    // be demoted by the residuals' ACTION-class warn branch.
    const note = [
      '**ctrl.cql.ca wake — gap matrix follow-up.**',
      'ACTIONS TAKEN',
      '- Dispatched a fresh lane for the gap matrix (receipt 77aabbcc)',
    ].join('\n');
    mockUtilityChat.mockResolvedValue(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'Dispatched a fresh lane for the gap matrix (receipt 77aabbcc)', id: '77aabbcc' }],
    }));
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: USER, finalText: note, parts: [] as any[], receipts: [] as any[],
      runStartedAt: new Date(Date.now() - 60_000), supervisor: true, supervisorScope: 'project' as const,
      machineTriggered: true, consequenceScope: 'citation-only' as const,
      now: new Date('2026-10-19T16:31:43Z'),
    });
    expect(res.struck).toBe(true);
    const fab = res.phantoms.find((p) => String(p.id) === '77aabbcc');
    expect(fab).toBeDefined();
    expect(fab!.fabricatedId).toBe(true);        // the id-existence true positive still stamps
    expect(isCitationClassClaim(fab!)).toBe(true); // and still rides the enforcement-eligible class
  });
});
