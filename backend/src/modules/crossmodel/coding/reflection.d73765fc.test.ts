/**
 * Ticket d73765fc — reflection filing/consult shape rendering (unit side).
 *
 * The sibling agent-loop replay (agent-derail-break.d73765fc.test.ts) pins
 * that the loop THREADS shape:'success_intent' into the attribution payload
 * on a success-side trip; THIS file pins the RENDERING bytes of the two
 * reflection surfaces the incident mislabeled:
 *
 *   · fileStreakInvestigation — a success-side trip now titles
 *     "5× success-side wrong-tool loop: <tool> on …" with a
 *     "Recent tool results (newest first — every call SUCCEEDED)" header,
 *     instead of the fixed "3× tool-failure streak" title +
 *     "Failure texts (newest first)" header (the d73765fc artifact: its
 *     description said "kept SUCCEEDING" while its title said
 *     "tool-failure streak").
 *   · consultCrossCheckerOnStreak — the system prompt tells the
 *     independent cross-checker the calls are SUCCEEDING (not "stuck in a
 *     tool-failure loop") so the diagnosis targets the actual pathology.
 *   · The classic failure shape (shape unset or 'failure') keeps the legacy
 *     bytes EXACTLY — every other filing site (narrated-tool-emit loop,
 *     verify-stop, final-text) files through that default.
 *
 * Scaffold mirrors breaker-lane-notice.78f32515.test.ts (reflection-only
 * unit mocks: database/redis/coding-model/helper-completion).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFindUnique: jest.Mock = jest.fn();
const mockCreate: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelChat: { findUnique: (...a: any[]) => mockFindUnique(...a) },
    userFeatureRequest: { create: (...a: any[]) => mockCreate(...a) },
  },
}));

const mockRedisSet: jest.Mock = jest.fn();
const mockRedisGet: jest.Mock = jest.fn();
const mockRedisDel: jest.Mock = jest.fn();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: (...a: any[]) => mockRedisSet(...a),
    get: (...a: any[]) => mockRedisGet(...a),
    del: (...a: any[]) => mockRedisDel(...a),
  },
}));

const mockResolveRole: jest.Mock = jest.fn();
const mockProviderFor: jest.Mock = jest.fn();
jest.mock('./coding-model', () => ({
  __esModule: true,
  resolveRoleModelForRun: (...a: any[]) => mockResolveRole(...a),
  resolveProviderForRun: (...a: any[]) => mockProviderFor(...a),
}));

const mockPost: jest.Mock = jest.fn();
const mockExtract: jest.Mock = jest.fn();
jest.mock('./helper-completion', () => ({
  __esModule: true,
  postNonStreamingCompletion: (...a: any[]) => mockPost(...a),
  extractNonStreamingAnswer: (...a: any[]) => mockExtract(...a),
}));

import { fileStreakInvestigation, consultCrossCheckerOnStreak } from './reflection';
import type { StreakEvidence } from './reflection';

const SUCC_EVIDENCE: StreakEvidence = {
  sessionId: '9e6e1712', runId: 'run-d73765fc', tool: 'search_memory', perma: false,
  intended: 'web_pipe',
  recentFailures: [
    `search_memory kept SUCCEEDING while the run's own reasoning named web_pipe — wrong-tool derailment on successful calls (search_memory→web_pipe ×5 consecutive, ticket 2c98b460).`,
  ],
  goalHint: 'where do the llama-bench results live',
  shape: 'success_intent',
};

const FAIL_EVIDENCE: StreakEvidence = {
  sessionId: 'sess-fail', runId: 'run-2', tool: 'update_feedback', perma: false,
  intended: null,
  recentFailures: ['Tool update_feedback failed: no such ticket "noop"'],
  goalHint: 'close the ticket',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFindUnique.mockResolvedValue({ userId: 'u1', title: 'spark-cluster Supervisor' });
  mockCreate.mockResolvedValue({ id: 'ticket-d73765fc-1' });
  mockRedisSet.mockResolvedValue('OK');
  mockRedisGet.mockResolvedValue(null);
  mockResolveRole.mockResolvedValue('deepseek-flash');
  mockProviderFor.mockResolvedValue({ apiKey: 'k', model: 'deepseek-flash', extra: {} });
  mockPost.mockResolvedValue({ data: { choices: [{ message: { content: 'Call the tool you named.' } }] } });
  mockExtract.mockImplementation((c: any) => ({ text: c?.message?.content ?? '' }));
});

describe('ticket d73765fc — fileStreakInvestigation renders the trip shape truthfully', () => {
  it('success_intent: the ticket is titled a 5× success-side wrong-tool loop, never a "3× tool-failure streak", and the results header says SUCCEEDED', async () => {
    await fileStreakInvestigation(SUCC_EVIDENCE);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const data = mockCreate.mock.calls[0][0].data;
    expect(data.type).toBe('mishap');
    expect(data.source).toBe('agent-harness');
    expect(data.title).toBe('5× success-side wrong-tool loop: search_memory on "spark-cluster Supervisor" — framework or model?');
    expect(data.title).not.toContain('tool-failure streak');
    // The description names the shape AND the intended tool.
    expect(data.description).toContain('5 consecutive SUCCEEDING calls whose reasoning named a different tool');
    expect(data.description).toContain(`lane's reasoning named web_pipe`);
    expect(data.description).toContain('Recent tool results (newest first — every call SUCCEEDED)');
    expect(data.description).not.toContain('Failure texts (newest first)');
    // The verbatim success-side evidence text rides through unmodified.
    expect(data.description).toContain('wrong-tool derailment on successful calls');
    // The framework-vs-model mandate is unchanged.
    expect(data.description).toContain('INVESTIGATE: determine whether a DETERMINISTIC framework/schema/preflight/guard issue');
  });

  it('failure shape (explicit): legacy bytes preserved — "3× tool-failure streak" title + "Failure texts" header', async () => {
    await fileStreakInvestigation({ ...FAIL_EVIDENCE, shape: 'failure' });

    const data = mockCreate.mock.calls[0][0].data;
    expect(data.title).toBe('3× tool-failure streak: update_feedback on "spark-cluster Supervisor" — framework or model?');
    expect(data.description).toContain('Failure texts (newest first)');
    expect(data.description).not.toContain('SUCCEEDED');
  });

  it('shape UNSET (every other filing site — narrated loop, verify-stop, final-text): default failure rendering byte-identical', async () => {
    await fileStreakInvestigation(FAIL_EVIDENCE); // no shape field at all

    const data = mockCreate.mock.calls[0][0].data;
    expect(data.title).toBe('3× tool-failure streak: update_feedback on "spark-cluster Supervisor" — framework or model?');
    expect(data.description).toContain('Failure texts (newest first)');
    expect(data.description).toContain('first streak this run');
  });
});

describe('ticket d73765fc — consultCrossCheckerOnStreak frames the trip by its shape', () => {
  it('success_intent: the system prompt says the calls SUCCEED while reasoning names a different tool (never "tool-failure loop")', async () => {
    await consultCrossCheckerOnStreak(SUCC_EVIDENCE);

    expect(mockPost).toHaveBeenCalledTimes(1);
    const req = mockPost.mock.calls[0][1];
    const system = req.messages[0].content as string;
    expect(system).toContain('calls are SUCCEEDING while its own reasoning names a DIFFERENT tool');
    expect(system).not.toContain('tool-failure loop');
    const user = req.messages[1].content as string;
    expect(user).toContain('calls SUCCEEDED while the reasoning named a different tool');
    expect(user).toContain('recent tool results (newest first — all successes)');
    expect(user).toContain('reasoning named a different tool: web_pipe');
  });

  it('failure shape (default): the consult keeps the legacy "tool-failure loop" framing byte-exactly', async () => {
    await consultCrossCheckerOnStreak(FAIL_EVIDENCE);

    const req = mockPost.mock.calls[0][1];
    expect(req.messages[0].content).toContain('stuck in a tool-failure loop');
    expect(req.messages[1].content).toContain('recent failure results (newest first)');
  });
});
