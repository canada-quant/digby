/**
 * POST /api/crossmodel/feedback × compute-policy labels (cp/labels, 2026-09-26,
 * design §4 D2 "thumbs+reason"): an END-TO-END pass through the REAL controller
 * → the REAL hooks module (dynamic import) → the REAL adapters → Module A's REAL
 * writer → decision-gate's REAL recordDecisionOutcome, with prisma mocked and
 * recordLoopMetric captured — the rows asserted here are byte-for-byte what
 * prod writes. Also the Dig-deeper tap's revision_material label on an
 * 'updated' row and the `escalated_late` row for a tap after the window.
 * Harness: crossmodel.controller.dig-deeper.test.ts (same mocked import graph).
 */
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));

const mockFindUser = jest.fn();
const mockFindChat = jest.fn();
const mockFindFirstChat: jest.Mock = jest.fn(async () => ({ id: 'chat' }));
const mockFindMessage: jest.Mock = jest.fn(async () => null);
const mockFindFirstMessage: jest.Mock = jest.fn(async () => null);
const mockFeedbackCreate: jest.Mock = jest.fn(async (a: any) => ({ id: 'fb-1', ...a.data }));
const mockFeatureRequestCreate: jest.Mock = jest.fn(async () => ({ id: 'fr-1' }));
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    user: { findUnique: (...a: any[]) => mockFindUser(...a) },
    crossModelChat: { findUnique: (...a: any[]) => mockFindChat(...a), findFirst: (...a: any[]) => mockFindFirstChat(...a) },
    crossModelMessage: { findMany: jest.fn(async () => []), findUnique: (...a: any[]) => mockFindMessage(...a), findFirst: (...a: any[]) => mockFindFirstMessage(...a) },
    messageFeedback: { create: (...a: any[]) => mockFeedbackCreate(...a) },
    userFeatureRequest: { create: (...a: any[]) => mockFeatureRequestCreate(...a) },
  },
}));
jest.mock('./crossmodel.service', () => ({ __esModule: true, default: { getChatAccess: jest.fn(async () => ({ access: 'owner', exists: true })) } }));
jest.mock('./platform/platform.service', () => ({ __esModule: true }));
jest.mock('./context.service', () => ({ __esModule: true, default: {} }));
jest.mock('./integrations/moonshot.integration', () => ({ __esModule: true, default: {} }));
jest.mock('./upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn(), combineAttachments: jest.fn(() => null), persistChatUploads: jest.fn(async () => {}) }));
jest.mock('./feedback/feedback.service', () => ({ FEEDBACK_TYPES: ['positive', 'negative'] }));
jest.mock('./langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
jest.mock('./integrations/qwen-kid.integration', () => ({ streamKidResponse: jest.fn(async () => {}), generateKidStatus: jest.fn(async () => '') }));
jest.mock('./mcp-search', () => ({ searchWithBrightData: jest.fn(async () => []) }));
jest.mock('./browser-agent', () => ({ runBrowserAgentSession: jest.fn() }));
const mockDecideChatGate = jest.fn();
jest.mock('./chat-agent/chat-gate', () => ({
  decideChatGate: (...a: any[]) => mockDecideChatGate(...a),
  mapAttachmentForAgent: jest.fn(() => ({ userImages: [], documentText: '' })),
  chatWriteAccessGranted: jest.fn(() => true),
  chatReadAccessGranted: jest.fn(),
  streamAccessDeniedError: jest.fn(),
}));
jest.mock('./guest-location', () => ({ buildGuestLocationBlock: jest.fn(async () => undefined) }));
jest.mock('./integration-context', () => ({ buildIntegrationContext: jest.fn(async () => ({ additionalContext: '', imessagePairedAgentId: null })), buildIntegrationContextBounded: jest.fn(async (build) => build()) }));
const mockAutoOnly: jest.Mock = jest.fn(async () => false);
const mockAllowance: jest.Mock = jest.fn(async () => ({ allowed: true }));
const mockReserve: jest.Mock = jest.fn(async () => ({ allowed: true, used: 1, limit: 5, remaining: 4 }));
jest.mock('./rate-limit.service', () => ({
  checkDeepResearchQuota: jest.fn(),
  reserveDeepResearchQuota: (...a: any[]) => mockReserve(...a),
  reserveAnonDeepResearchQuota: jest.fn(async () => ({ allowed: true, used: 1, limit: 2, remaining: 1 })),
  getDeepResearchDailyLimit: jest.fn(), getAllDeepResearchUsageToday: jest.fn(), invalidateLimitCache: jest.fn(),
  getPatienceAutoOnly: (...a: any[]) => mockAutoOnly(...a),
  invalidatePatienceAutoOnlyCache: jest.fn(),
  deepResearchAllowance: (...a: any[]) => mockAllowance(...a),
  PATIENCE_AUTO_ONLY_KEY: 'patience_auto_only',
}));
jest.mock('./coding/coding-data.service', () => ({ getChatCapability: jest.fn(async () => ({ hasWorkspaceState: false, codeCapable: false })) }));
jest.mock('./chat-agent/chat-busy', () => ({ isChatBusy: jest.fn(async () => false) }));
jest.mock('./chat-agent/run-event-mirror', () => ({ attachRemoteChatRun: jest.fn(), replayFinishedRemoteRun: jest.fn(async () => false) }));
jest.mock('./coding/coding-stream.controller', () => ({ __esModule: true, default: { streamRun: jest.fn() } }));
const mockRecordMetric: jest.Mock = jest.fn();
jest.mock('./platform/loop-metrics.service', () => ({
  ...jest.requireActual('./platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordMetric(...a),
}));
jest.mock('./platform/auto-router-gate', () => ({
  ...jest.requireActual('./platform/auto-router-gate'),
  shadowAutoRouteAgainst: jest.fn(async () => {}),
  routeMessageAuto: jest.fn(async () => ({ level: 'thinking', reason: 'default ensemble', reasonKey: 'default_ensemble', suggestCode: false, needsWorkspace: false, source: 'heuristic', heuristicLevel: 'thinking' })),
}));
const mockStartDetachedChatRun: jest.Mock = jest.fn(async () => 'run-key-1');
jest.mock('./chat-agent/chat-agent.service', () => ({
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  chatAgentRunKey: jest.fn(() => 'agent-key'),
  preemptMachineRunForUserMessage: jest.fn(async () => ({ preempted: false, freed: false })),
  nudgeQueueDrainSoon: jest.fn(),
}));
jest.mock('./message-as-answer', () => ({ resolveParkedQuestionWithOwnerText: jest.fn(async () => ({ resolved: false })) }));
jest.mock('./coding/live-runs', () => ({ isRunActive: jest.fn(() => false), subscribeRun: jest.fn(() => null) }));
// NOT mocked on purpose: ./chat-agent/compute-policy-labels + ./chat-agent/compute-policy-label-hooks
// (the real adapters + writer run; the rows land on the captured recordLoopMetric).

import controller from './crossmodel.controller';

const CHAT = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const MSG = '9b2e7c1a-2d3f-4e5a-8b6c-1d2e3f4a5b6c';
const depthAnswers = { depth: { type: 'choice', choice: 'simple_lookup', confidence: 0.9, probabilities: { simple_lookup: 0.9, ordinary: 0.1 } }, research_request: { type: 'noul', noul: 0.05 } };
const revisionDecision = { id: 'rm-7', purpose: 'revision_material', mode: 'shadow', backend: 'TypeSafe Jev', answers: { material: { type: 'noul', noul: 0.3 } }, decidedAt: '2026-09-26T12:00:00Z' };
const updatedRow = (over: any = {}) => ({
  id: MSG, chatId: CHAT, role: 'assistant', createdAt: new Date(),
  metadata: {
    mode: 'thinking',
    depth: { plan: { preset: 'thinking', spawnChecker: true, checkerWaitMs: 0, council: 'none', source: 'gate_shadow' }, decision: { id: 'cp-7', answers: depthAnswers, mode: 'shadow' }, facts: { leadToolCalls: 0, webToolCalls: 0, finalChars: 300, checkerSpawned: true, checkerMerged: false } },
    check: { state: 'updated', changed: ['number: $30 → $35'], verdict: { material: true, source: 'gate', decisionId: 'rm-7', decision: revisionDecision } },
    ...over,
  },
});
const gateRows = () => mockRecordMetric.mock.calls.map((c: any) => c[0]).filter((m: any) => m.kind === 'decision_gate' && m.meta?.phase === 'outcome').map((m: any) => m.meta);
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
const mkRes = (): any => {
  const res: any = {
    frames: [] as string[], writableEnded: false,
    status: jest.fn(() => res), json: jest.fn(() => res), setHeader: jest.fn(), cookie: jest.fn(), flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => { res.frames.push(chunk); return true; }),
    end: jest.fn(() => { res.writableEnded = true; }),
  };
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DIG_DEEPER_DISABLED;
  mockDecideChatGate.mockImplementation(({ mode }: any) => ({ action: 'agent', councilMode: mode === 'deep_research' }));
  mockFindUser.mockResolvedValue({ isChild: false });
  mockFindChat.mockResolvedValue({ id: CHAT, userId: 'u1', projectId: null, title: 't', isSupervisor: false, isProjectSupervisor: false });
  mockFindFirstChat.mockResolvedValue({ id: CHAT, userId: 'u1' });
  mockFindMessage.mockResolvedValue(updatedRow());
  mockFindFirstMessage.mockResolvedValue({ content: 'How much does the plan cost per month?' });
});

describe('POST /feedback → compute-policy labels (end to end, mocked prisma)', () => {
  it('thumbs_down + reason "wrong" on an UPDATED answer: the feedback row is saved and 200 returned FIRST; then the compute_policy thumbs row (source feedback, the persisted facts, checkerMerged upgraded by the pill) and the revision_material row (thumbsDown ⇒ material true) land with the right ids', async () => {
    const res = mkRes();
    await controller.submitFeedback({ user: { id: 'u1' }, body: { messageId: MSG, chatId: CHAT, type: 'thumbs_down', reason: 'wrong', comment: 'the fee is off' } } as any, res, jest.fn());
    expect(mockFeedbackCreate).toHaveBeenCalledTimes(1);
    expect(mockFeedbackCreate.mock.calls[0][0].data).toMatchObject({ messageId: MSG, chatId: CHAT, userId: 'u1', type: 'thumbs_down', reason: 'wrong' });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, id: 'fb-1' }));
    await settle();
    expect(mockFindMessage).toHaveBeenCalledWith(expect.objectContaining({ where: { id: MSG } }));
    const rows = gateRows();
    expect(rows.map((r: any) => `${r.purpose}/${r.question}/${r.label ?? '-'}`)).toEqual(['compute_policy/depth/thumbs', 'revision_material/material/human']);
    expect(rows[0]).toMatchObject({ id: 'cp-7', purpose: 'compute_policy', question: 'depth', predicted: { choice: 'simple_lookup' }, actual: 'contestable', agreed: false, label: 'thumbs', source: 'feedback', checkerSpawned: true, checkerMerged: true, acted: false });
    expect(String(rows[0].note)).toContain('thumbs src:feedback; thumbs:down/wrong');
    expect(rows[1]).toMatchObject({ id: 'rm-7', purpose: 'revision_material', question: 'material', predicted: { noul: 0.3 }, actual: true, agreed: false, thumbsDown: true });
  });

  it('thumbs_up on a row whose pill reads "checked" because the GATE withheld the rewrite (act): the compute_policy row keeps the base depth and the revision_material row lands with acted:true / material false (audit 2026-09-26 — these are the in-band decisions the act-band window needs); type "report" and a row without a decision write nothing', async () => {
    mockFindMessage.mockResolvedValue(updatedRow({ check: { state: 'checked', verdict: { material: false, source: 'gate', decision: revisionDecision } } }));
    await controller.submitFeedback({ user: { id: 'u1' }, body: { messageId: MSG, chatId: CHAT, type: 'thumbs_up' } } as any, mkRes(), jest.fn());
    await settle();
    expect(gateRows().map((r: any) => `${r.purpose}/${r.label ?? '-'}/${r.actual}`)).toEqual(['compute_policy/thumbs/simple_lookup', 'revision_material/human/false']);
    // (The row's `inActBand` meta reflects the ANSWER band; the write-time act-band window admits an acted row through inActBand(purpose, answer, acted) regardless — pinned in decision-outcome-labels.compute-policy.test.ts.)
    expect(gateRows()[1]).toMatchObject({ id: 'rm-7', purpose: 'revision_material', actual: false, agreed: true, acted: true });
    expect(String(gateRows()[1].note)).toContain('pill:checked (rewrite withheld)');
    mockRecordMetric.mockClear();
    await controller.submitFeedback({ user: { id: 'u1' }, body: { messageId: MSG, chatId: CHAT, type: 'report', comment: 'x' } } as any, mkRes(), jest.fn());
    await settle();
    expect(gateRows()).toEqual([]);
    mockFindMessage.mockResolvedValue({ id: MSG, chatId: CHAT, role: 'assistant', metadata: { mode: 'thinking' } });
    await controller.submitFeedback({ user: { id: 'u1' }, body: { messageId: MSG, chatId: CHAT, type: 'thumbs_down', reason: 'slow' } } as any, mkRes(), jest.fn());
    await settle();
    expect(gateRows()).toEqual([]);
  });

  it('an anonymous thumbs (no user) still labels — the row is found by id within the chat; a row from ANOTHER chat never labels', async () => {
    await controller.submitFeedback({ body: { messageId: MSG, chatId: CHAT, type: 'thumbs_down', reason: 'incomplete' } } as any, mkRes(), jest.fn());
    await settle();
    expect(gateRows().map((r: any) => r.label ?? r.purpose)).toEqual(['thumbs', 'human']);
    mockRecordMetric.mockClear();
    mockFindMessage.mockResolvedValue({ ...updatedRow(), chatId: 'other' });
    await controller.submitFeedback({ user: { id: 'u1' }, body: { messageId: MSG, chatId: CHAT, type: 'thumbs_down' } } as any, mkRes(), jest.fn());
    await settle();
    expect(gateRows()).toEqual([]);
  });

  it('a prisma failure inside the hook never reaches the response (200 already sent, no throw)', async () => {
    mockFindMessage.mockRejectedValue(new Error('db down'));
    const res = mkRes();
    const next = jest.fn();
    await controller.submitFeedback({ user: { id: 'u1' }, body: { messageId: MSG, chatId: CHAT, type: 'thumbs_down' } } as any, res, next);
    await settle();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(next).not.toHaveBeenCalled();
    expect(gateRows()).toEqual([]);
  });
});

describe('POST /feedback — message link check (ticket bd5b95b5: coding-session answers send their row id)', () => {
  const CODING_MSG = '0d1e2f3a-4b5c-4d6e-8f70-112233445566';
  afterEach(() => { delete process.env.FEEDBACK_MESSAGE_LINK_CHECK_DISABLED; });

  it('a coding-session answer that IS a message row of the chat links like a plain answer (looked up by id AND chat)', async () => {
    mockFindFirstMessage.mockResolvedValue({ id: CODING_MSG });
    const res = mkRes();
    await controller.submitFeedback({ user: { id: 'u1' }, body: { messageId: CODING_MSG, chatId: CHAT, type: 'thumbs_down', reason: 'formatting' } } as any, res, jest.fn());
    expect(mockFindFirstMessage).toHaveBeenCalledWith({ where: { id: CODING_MSG, chatId: CHAT }, select: { id: true } });
    expect(mockFeedbackCreate.mock.calls[0][0].data).toMatchObject({ messageId: CODING_MSG, chatId: CHAT, type: 'thumbs_down', reason: 'formatting' });
    expect(String((mockFeatureRequestCreate.mock.calls[0] as any)[0].data.description)).not.toContain('Message ID:');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, featureRequestId: 'fr-1' }));
  });

  it('an id that is NOT a row of this chat (legacy coding_messages id, another chat) saves UNLINKED instead of 500ing on the FK; the ticket names it; no label lookup', async () => {
    mockFindFirstMessage.mockResolvedValue(null);
    const res = mkRes();
    await controller.submitFeedback({ user: { id: 'u1' }, body: { messageId: CODING_MSG, chatId: CHAT, type: 'thumbs_down', reason: 'wrong', comment: 'the diff is wrong' } } as any, res, jest.fn());
    await settle();
    expect(mockFeedbackCreate.mock.calls[0][0].data).toMatchObject({ messageId: null, chatId: CHAT, userId: 'u1', type: 'thumbs_down' });
    const desc = String((mockFeatureRequestCreate.mock.calls[0] as any)[0].data.description);
    expect(desc).toContain(`Chat ID: ${CHAT}`);
    expect(desc).toContain(`Message ID: ${CODING_MSG} (not a message row of this chat — feedback saved unlinked)`);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, id: 'fb-1' }));
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(mockFindMessage).not.toHaveBeenCalled();
    expect(gateRows()).toEqual([]);
  });

  it('a lookup error keeps the old behaviour (link as sent); FEEDBACK_MESSAGE_LINK_CHECK_DISABLED=1 skips the check entirely', async () => {
    mockFindFirstMessage.mockRejectedValueOnce(new Error('db blip'));
    await controller.submitFeedback({ user: { id: 'u1' }, body: { messageId: CODING_MSG, chatId: CHAT, type: 'report', comment: 'x' } } as any, mkRes(), jest.fn());
    expect(mockFeedbackCreate.mock.calls[0][0].data.messageId).toBe(CODING_MSG);
    mockFeedbackCreate.mockClear();
    mockFindFirstMessage.mockClear();
    mockFindFirstMessage.mockResolvedValue(null);
    process.env.FEEDBACK_MESSAGE_LINK_CHECK_DISABLED = '1';
    await controller.submitFeedback({ user: { id: 'u1' }, body: { messageId: CODING_MSG, chatId: CHAT, type: 'report', comment: 'x' } } as any, mkRes(), jest.fn());
    expect(mockFindFirstMessage).not.toHaveBeenCalled();
    expect(mockFeedbackCreate.mock.calls[0][0].data.messageId).toBe(CODING_MSG);
  });

  it('no messageId: no lookup, chat-scoped feedback as before', async () => {
    await controller.submitFeedback({ user: { id: 'u1' }, body: { chatId: CHAT, type: 'thumbs_up' } } as any, mkRes(), jest.fn());
    expect(mockFindFirstMessage).not.toHaveBeenCalled();
    expect(mockFeedbackCreate.mock.calls[0][0].data).toMatchObject({ messageId: null, chatId: CHAT, type: 'thumbs_up' });
  });
});

describe('Dig deeper tap → labels (end to end through streamQuery)', () => {
  const mkReq = (over: any = {}): any => ({ query: { message: 'Dig deeper', mode: 'thinking', chatId: CHAT, escalationOf: MSG }, headers: {}, on: jest.fn(), user: { id: 'u1' }, ...over });

  it('a tap ≤ 30 min on an UPDATED L1-class answer writes the PRIMARY escalated row (NO research_request row — the rung is the server\'s, audit 2026-09-26), carrying the persisted facts, AND the revision_material escalated row', async () => {
    mockFindMessage.mockResolvedValue(updatedRow({ depth: { plan: { preset: 'single_thinking', spawnChecker: false, checkerWaitMs: 0, council: 'none', source: 'gate_shadow' }, decision: { id: 'cp-7', answers: depthAnswers, mode: 'shadow' }, facts: { leadToolCalls: 0, webToolCalls: 0, finalChars: 300, checkerSpawned: false, checkerMerged: false } } }));
    await controller.streamQuery(mkReq(), mkRes(), jest.fn());
    await settle();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ escalation: { ofMessageId: MSG, rung: 'verify' } });
    const rows = gateRows();
    expect(rows.map((r: any) => `${r.purpose}/${r.question}/${r.label ?? '-'}`)).toEqual(['compute_policy/depth/escalated', 'revision_material/material/human']);
    expect(rows[0]).toMatchObject({ id: 'cp-7', actual: 'ordinary', escalated: true, escalatedTo: 'verify', rungChoice: 'forced', source: 'dig_deeper', finalChars: 300, checkerSpawned: false, checkerMerged: true });
    expect(rows[1]).toMatchObject({ id: 'rm-7', actual: true, escalated: true });
  });

  it('a tap 31 min later writes the SECONDARY escalated_late row instead of nothing (no research_request row; the fit ignores it), and the run still starts', async () => {
    mockFindMessage.mockResolvedValue({ ...updatedRow({ check: { state: 'checked' } }), createdAt: new Date(Date.now() - 31 * 60_000) });
    await controller.streamQuery(mkReq(), mkRes(), jest.fn());
    await settle();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    const rows = gateRows();
    expect(rows.map((r: any) => `${r.purpose}/${r.label}`)).toEqual(['compute_policy/escalated_late']);
    expect(rows[0]).toMatchObject({ id: 'cp-7', question: 'depth', source: 'dig_deeper_late', escalatedTo: 'research' });
    expect(String(rows[0].note)).toContain('late tap→research');
  });
});
