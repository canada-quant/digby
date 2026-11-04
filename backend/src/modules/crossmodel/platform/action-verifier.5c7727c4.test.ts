/**
 * Ticket 5c7727c4 (mishap, av-mishap family, 2026-10-27T04:22Z): the
 * action-verifier convicted the HARNESS's own continuation line as a model
 * phantom claim.
 *
 * The incident (chat 590d604e, the spark-cluster project supervisor, owner
 * turn 04:20:16Z "what the hell are you doing what happen to red snow…"):
 * the answer-first machinery split the owner turn at the soft deadline, the
 * model answered from what it held, and the harness rewrote the closing with
 * its template line (owner-answer-first.ts followThroughContinuationLine):
 *   "Still working on this in the background — <items>. I will post the result here."
 * A follow-through round was genuinely armed and executed the dispatch
 * minutes later (receipts: goal_create 2bcc6f79 04:25:05Z → todo_create
 * 95499211 04:26:20Z → start_coding_session b6b1e0e1 04:28:01Z). The
 * post-delivery verifier then audited the DELIVERED text, the LLM extractor
 * quoted the harness line's items ("[dispatch] dispatch a probe lane to
 * check RED-SNOW health directly on S1:8000 + the llm.example.com route, restart
 * zero-drift per ONCALLRUNBOOK.md if down, and post the verdict with
 * receipts in this chat") — platform-authored promise text, no in-run
 * receipt — and the mishap ticket fired ("Supervisor phantom claim:
 * narrated action(s) never executed").
 *
 * THE FIX (this ticket): PhantomClaimAuditInput.harnessContinuationLine —
 * the seam passes the EXACT template line the harness appended
 * (continuationRewrote ⇒ continuationLine), and the matcher strips it from
 * the ACTION extraction window (LLM extractor input, the 587e9d64 grounding
 * window, the receipt-idiom miner, the N5 gate candidates) BEFORE they see
 * the note. `out.note` (the ticket excerpt) and every deterministic
 * CITATION lane keep the full note as delivered.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  codingSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  ownerQuestion: { findFirst: jest.fn(async () => null) },
  runToolReceipt: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
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

import { computePhantomClaims, guardMachineWakeFinalAnswer } from './action-verifier';

const CHAT = '590d604e-22ce-4085-8b12-589a7010c8ff';
const USER = 'u-1';

/** owner-answer-first.ts followThroughContinuationLine output for the
 * incident's Follow-through items — the harness-appended line verbatim. */
const INCIDENT_LINE = 'Still working on this in the background — dispatch a probe lane to check RED-SNOW health directly on S1:8000 + the llm.example.com route, restart zero-drift per ONCALLRUNBOOK.md if down, and post the verdict with receipts in this chat. I will post the result here.';
/** The model's honest prose the answer actually delivered (04:22:26Z, msg
 * 50cb0628): the "Not done" section is the model's OWN admission — no
 * completed-action claim anywhere in it. (The live note's goal-id citation
 * is elided here: the citation lanes read the FULL note and a null-mocked
 * DB would convict it — this suite pins the ACTION lane, not the citation
 * lanes, which this change deliberately does not touch.) */
const MODEL_PROSE = [
  '**Straight answer: RED-SNOW was never a TP=4 mesh — it serves TP=2 on S1+S2.**',
  'What the ledger shows, verified fresh this turn: RED-SNOW (the standing goal, done) serving TP=2 since Oct 22; last hard proof of life Oct 23; no teardown on the books.',
  '**Not done:** a direct probe of S1:8000 and the gateway route — dispatching that now.',
].join('\n');
const INCIDENT_NOTE = `${MODEL_PROSE}\n\n${INCIDENT_LINE}`;

/** The extractor's coin flip on the incident note, as the ticket records it
 * (the [dispatch] claim quoting the harness line's items). */
const INCIDENT_EXTRACTION = JSON.stringify({
  claims: [{ kind: 'dispatch', detail: 'dispatch a probe lane to check RED-SNOW health directly on S1:8000 + the llm.example.com route, restart zero-drift per ONCALLRUNBOOK.md if down, and post the verdict with receipts in this chat', id: '' }],
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ACTION_VERIFIER_CONTINUATION_EXEMPT_DISABLED;
  mockUtilityChat.mockReset();
  mockUtilityChat.mockResolvedValue('');
});

describe('ticket 5c7727c4 — the harness continuation line is platform text, not a model claim', () => {
  it('THE INCIDENT REPLAY: with the anchor, the extraction sees the model prose only — the harness-line claim convicts NOBODY (phantoms: 0)', async () => {
    // The extractor quotes ONLY text it can see: with the line stripped from
    // its window, a real extractor on this note returns model-prose claims
    // only. Simulate the honest extractor.
    mockUtilityChat.mockImplementation(async (messages: any[]) => {
      const user = String(messages?.[1]?.content ?? '');
      if (user.includes('Still working on this in the background')) throw new Error('extraction window must not contain the harness line');
      return JSON.stringify({ claims: [] }); // the model prose makes no completed-action claim
    });
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: USER, finalText: INCIDENT_NOTE, parts: [] as any[], receipts: [] as any[],
      runStartedAt: new Date('2026-10-27T04:21:00Z'),
      supervisor: true, supervisorScope: 'project', machineTriggered: false,
      harnessContinuationLine: INCIDENT_LINE,
    });
    expect(comp.phantoms).toHaveLength(0);
  });

  it('THE INCIDENT REPLAY (pre-fix shape): WITHOUT the anchor the same note convicts 1 phantom [dispatch] — the incident pinned', async () => {
    mockUtilityChat.mockResolvedValue(INCIDENT_EXTRACTION);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: USER, finalText: INCIDENT_NOTE, parts: [] as any[], receipts: [] as any[],
      runStartedAt: new Date('2026-10-27T04:21:00Z'),
      supervisor: true, supervisorScope: 'project', machineTriggered: false,
      // no harnessContinuationLine — every pre-2026-10-27 caller
    });
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0].kind).toBe('dispatch');
  });

  it('out.note stays the note AS DELIVERED — the ticket excerpt quotes the harness line too', async () => {
    mockUtilityChat.mockResolvedValue(JSON.stringify({ claims: [] }));
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: USER, finalText: INCIDENT_NOTE, parts: [] as any[], receipts: [] as any[],
      supervisor: true, supervisorScope: 'project', machineTriggered: false,
      harnessContinuationLine: INCIDENT_LINE,
    });
    expect(comp.note).toContain('Still working on this in the background');
  });

  it('an anchored line ABSENT from the note is a no-op (byte-identical path — the seam may pass a stale template)', async () => {
    mockUtilityChat.mockResolvedValue(INCIDENT_EXTRACTION);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: USER, finalText: INCIDENT_NOTE, parts: [] as any[], receipts: [] as any[],
      supervisor: true, supervisorScope: 'project', machineTriggered: false,
      harnessContinuationLine: 'Still working on this — I will post the result here.', // the bare CONTINUATION_LINE — not in this note
    });
    expect(comp.phantoms).toHaveLength(1); // the incident conviction stands: the anchor matched nothing
  });

  it('ANTI-LAUNDERING (frontier review) — completed-action items are MINED and still convict, extractor-independently (the label-restore would be cosmetic)', async () => {
    // The model wrote its phantom as a "Follow-through:" item ("pushed the
    // hotfix and confirmed prod green"); the harness reframed it into the
    // template. A pure strip would delete the model's words from every
    // audit window; a label-restore ("Follow-through: …") would be cosmetic
    // — the extractor's prompt ignores intent labels and non-first-person
    // prose. The mining path puts the verbatim clauses into the claim set
    // deterministically. Pin it with a REALISTIC extractor: it extracts
    // NOTHING from the stripped window (the mock's default '' — an honest
    // miss) — the mined claims are the only ones, and they convict.
    const launderingNote = `${MODEL_PROSE}\n\nStill working on this in the background — pushed the hotfix and confirmed prod green. I will post the result here.`;
    mockUtilityChat.mockResolvedValue(JSON.stringify({ claims: [] })); // extractor miss — no rescue from the LLM lane
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: USER, finalText: launderingNote, parts: [] as any[], receipts: [] as any[],
      supervisor: true, supervisorScope: 'project', machineTriggered: false,
      harnessContinuationLine: 'Still working on this in the background — pushed the hotfix and confirmed prod green. I will post the result here.',
    });
    // The mined claim is in the claim set and convicts (no matching
    // execution): the model's completed-action words were never unaudited.
    expect(comp.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: expect.any(String), detail: 'pushed the hotfix and confirmed prod green' }),
    ]));
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0].detail).toContain('pushed the hotfix');
  });

  it('ANTI-LAUNDERING exonerates TRUTHFUL mined items (own-run receipts) — the mining adds claims, never auto-convicts', async () => {
    // Same shape, but this run REALLY executed the dispatch (a
    // start_coding_session receipt rides the executed pool): the mined
    // [dispatch] claim matches its kind slot and never convicts.
    const truthfulNote = `${MODEL_PROSE}\n\nStill working on this in the background — dispatched the probe lane on the RED-SNOW goal. I will post the result here.`;
    mockUtilityChat.mockResolvedValue(JSON.stringify({ claims: [] }));
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: USER, finalText: truthfulNote, parts: [] as any[], receipts: [
        { id: 'aa11bb22', chatId: CHAT, runId: 'run-1', tool: 'start_coding_session', ok: true, ids: { sessionId: 'b6b1e0e1-ea32-4dcc-a604-925fca12bd91' }, inputHash: null, outputHash: null, createdAt: new Date('2026-10-27T04:20:30Z') },
      ] as any[],
      runStartedAt: new Date('2026-10-27T04:21:00Z'),
      supervisor: true, supervisorScope: 'project', machineTriggered: false,
      harnessContinuationLine: 'Still working on this in the background — dispatched the probe lane on the RED-SNOW goal. I will post the result here.',
    });
    expect(comp.phantoms).toHaveLength(0);
  });

  it('STALE ANCHOR (frontier review) — an anchor that does not match the note as a full closing line is a no-op (fail-closed, logged)', async () => {
    mockUtilityChat.mockResolvedValue(INCIDENT_EXTRACTION);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: USER, finalText: INCIDENT_NOTE, parts: [] as any[], receipts: [] as any[],
      supervisor: true, supervisorScope: 'project', machineTriggered: false,
      harnessContinuationLine: 'Still working on this — I will post the result here.', // the bare CONTINUATION_LINE — not in this note
    });
    expect(comp.phantoms).toHaveLength(1); // the incident conviction stands: the anchor matched nothing
  });

  it('kill switch ACTION_VERIFIER_CONTINUATION_EXEMPT_DISABLED=1 restores the conviction', async () => {
    process.env.ACTION_VERIFIER_CONTINUATION_EXEMPT_DISABLED = '1';
    mockUtilityChat.mockResolvedValue(INCIDENT_EXTRACTION);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: USER, finalText: INCIDENT_NOTE, parts: [] as any[], receipts: [] as any[],
      supervisor: true, supervisorScope: 'project', machineTriggered: false,
      harnessContinuationLine: INCIDENT_LINE,
    });
    expect(comp.phantoms).toHaveLength(1);
  });

  it('SCOPE GUARD — a GENUINE model phantom in the same note still convicts with the anchor on', async () => {
    // The model's own completed-action claim ("I dispatched a probe lane
    // already — receipt 3f0c1a2b") rides the same note; the anchored line is
    // stripped but this claim is model prose and must convict.
    mockUtilityChat.mockResolvedValue(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'I dispatched a probe lane already — receipt 3f0c1a2b', id: '3f0c1a2b' }],
    }));
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: USER, finalText: `${MODEL_PROSE}\n\nI dispatched a probe lane already — receipt 3f0c1a2b\n\n${INCIDENT_LINE}`, parts: [] as any[], receipts: [] as any[],
      supervisor: true, supervisorScope: 'project', machineTriggered: false,
      harnessContinuationLine: INCIDENT_LINE,
    });
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0].detail).toContain('I dispatched a probe lane already');
  });

  it('DETECTOR-RECALL REPLAY — ticket 336f3d38 true positive: the three fabricated citation ids (d12f21f1 / d031a112 / 2b3cf15b) still convict with the anchor on', async () => {
    // The 336f3d38 incident note (chat 99e63f86) carries the SAME
    // continuation envelope in its body — this is the collision the recall
    // bar exists for: the strip must not demote its convictions.
    const note = [
      '**Peer re-grant request verified and answered — grant dispatched, window-watch armed, triggers banked As of 09:31 AM PDT (16:31Z).**',
      `**Lane 24f1950e reactivated + dispatched** (receipt d12f21f1) with the established append lifecycle`,
      `**Ack to the requester** (receipt d031a112): grant in flight, close-trigger protocol banked`,
      `**Window-watch armed on my own chat** (one-shot, fires 16:45Z — sched 2b3cf15b)`,
      'ACTIONS TAKEN',
      `- Lane 24f1950e unarchived + briefed — receipt d12f21f1`,
      `- Close-trigger protocol + grant ack sent to spark-cluster 69fb25fc — receipt d031a112`,
      `- One-shot window-watch armed on this chat (next fire 16:45Z) — sched 2b3cf15b`,
      'Still working on this in the background — create the sim-hardening goal (intent journal/rewind, life-trigger ordering fix, rule text for 63 refusal sites), decompose into todos, dispatch the lane, then charter the in-game assistant build goal blocked behind it. I will post the result here.',
    ].join('\n');
    const res = await guardMachineWakeFinalAnswer({
      chatId: '99e63f86-ecd3-4d6d-b5fb-a3e199a1ebfa', userId: USER, finalText: note, parts: [] as any[], receipts: [] as any[],
      runStartedAt: new Date(Date.now() - 60_000), supervisor: true, supervisorScope: 'project' as const,
      machineTriggered: true, consequenceScope: 'citation-only' as const,
      now: new Date('2026-10-19T16:31:43Z'),
      harnessContinuationLine: 'Still working on this in the background — create the sim-hardening goal (intent journal/rewind, life-trigger ordering fix, rule text for 63 refusal sites), decompose into todos, dispatch the lane, then charter the in-game assistant build goal blocked behind it. I will post the result here.',
    });
    expect(res.struck).toBe(true);
    const convicted = res.phantoms.filter((p) => ['d12f21f1', 'd031a112', '2b3cf15b'].includes(String(p.id)));
    expect(convicted.length).toBeGreaterThanOrEqual(3);
  });

  it('DETECTOR-RECALL REPLAY — ticket 16469005 true positive: the fabricated-id dispatch claim still convicts with the anchor on', async () => {
    const note = [
      '**ctrl.example.com wake — gap matrix follow-up.**',
      'ACTIONS TAKEN',
      '- Dispatched a fresh lane for the gap matrix (receipt 77aabbcc)',
    ].join('\n');
    mockUtilityChat.mockResolvedValue(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'Dispatched a fresh lane for the gap matrix (receipt 77aabbcc)', id: '77aabbcc' }],
    }));
    const res = await guardMachineWakeFinalAnswer({
      chatId: '99e63f86-ecd3-4d6d-b5fb-a3e199a1ebfa', userId: USER, finalText: note, parts: [] as any[], receipts: [] as any[],
      runStartedAt: new Date(Date.now() - 60_000), supervisor: true, supervisorScope: 'project' as const,
      machineTriggered: true, consequenceScope: 'citation-only' as const,
      now: new Date('2026-10-19T16:31:43Z'),
      // The anchor set (a rewritten closing elsewhere in the fleet) must not
      // acquit a fabricated id in THIS note's model prose.
      harnessContinuationLine: INCIDENT_LINE,
    });
    expect(res.struck).toBe(true);
    const fab = res.phantoms.find((p) => String(p.id) === '77aabbcc');
    expect(fab).toBeDefined();
    expect(fab!.fabricatedId).toBe(true);
  });

  it('DETECTOR-RECALL REPLAY — ticket 5c7727c4\'s own second-false-positive class is NOT reintroduced: the model prose "Not done" admission never convicts', async () => {
    // The model's own words in the incident note make no completed-action
    // claim; an extractor that invents one from the harness-line-free window
    // must be dropped by the 587e9d64 grounding lane (the window is the
    // model prose only). Pin that grounding holds on the stripped window.
    mockUtilityChat.mockResolvedValue(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'dispatch a probe lane to check RED-SNOW health directly on S1:8000 + the llm.example.com route, restart zero-drift per ONCALLRUNBOOK.md if down, and post the verdict with receipts in this chat', id: '' }],
    }));
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: USER, finalText: INCIDENT_NOTE, parts: [] as any[], receipts: [] as any[],
      supervisor: true, supervisorScope: 'project', machineTriggered: false,
      harnessContinuationLine: INCIDENT_LINE,
    });
    // The claim's detail is verbatim from the STRIPPED harness line — it has
    // no verbatim support in the model-prose window, so the grounding lane
    // drops it BEFORE conviction.
    expect(comp.phantoms).toHaveLength(0);
  });
});
