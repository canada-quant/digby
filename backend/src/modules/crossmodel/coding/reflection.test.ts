/**
 * In-session failure reflection (owner doctrine 2026-09-10) — consult a
 * DIFFERENT decoder on a 3× streak + auto-file attribution work, instead of
 * escalating a model swap to the owner.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockChatFindUnique = jest.fn(async (..._a: any[]): Promise<any> => ({ userId: 'u1', title: 'Test Lane' }));
const mockTicketCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 't1' }));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a) },
    userFeatureRequest: { create: (...a: any[]) => mockTicketCreate(...a) },
  },
}));

const mockRedisSet = jest.fn(async (..._a: any[]): Promise<any> => 'OK');
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: (...a: any[]) => mockRedisSet(...a) },
}));

const mockResolveRole = jest.fn(async (..._a: any[]): Promise<any> => 'deepseek-flash');
const mockProviderFor = jest.fn(async (..._a: any[]): Promise<any> => ({
  url: 'https://api.deepseek.com/chat/completions', apiKey: 'k', model: 'deepseek-flash',
  envKey: 'DEEPSEEK_API_KEY', label: 'DeepSeek direct', extra: { reasoning_effort: 'max', thinking: { type: 'enabled' } },
}));
jest.mock('./coding-model', () => ({
  __esModule: true,
  resolveRoleModelForRun: (...a: any[]) => mockResolveRole(...a),
  resolveProviderForRun: (...a: any[]) => mockProviderFor(...a),
}));

const mockPost = jest.fn(async (..._a: any[]): Promise<any> => ({ data: { choices: [{ message: { content: 'Call read_file with the real path.' } }] } }));
const mockExtract = jest.fn((...a: any[]): any => ({ text: a[0]?.message?.content ?? '' }));
jest.mock('./helper-completion', () => ({
  __esModule: true,
  postNonStreamingCompletion: (...a: any[]) => mockPost(...a),
  extractNonStreamingAnswer: (...a: any[]) => mockExtract(...a),
}));

import { consultCrossCheckerOnStreak, fileStreakInvestigation, REFLECTION_MAX_PER_RUN } from './reflection';

const EV = {
  sessionId: 's1', runId: 'r1', tool: 'update_feedback', perma: false,
  intended: 'run_command', recentFailures: ['Tool update_feedback failed: no such ticket "noop"'],
  goalHint: 'fix the flaky test',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockChatFindUnique.mockResolvedValue({ userId: 'u1', title: 'Test Lane' });
  mockTicketCreate.mockResolvedValue({ id: 't1' });
  mockRedisSet.mockResolvedValue('OK');
  mockPost.mockResolvedValue({ data: { choices: [{ message: { content: 'Call read_file with the real path.' } }] } });
});

describe('consultCrossCheckerOnStreak', () => {
  it('consults the CROSS-CHECKER seat and returns its advice; evidence rides the prompt', async () => {
    const advice = await consultCrossCheckerOnStreak(EV);
    expect(advice).toBe('Call read_file with the real path.');
    expect(mockResolveRole).toHaveBeenCalledWith('double_checker', 'deepseek-flash');
    const payload = mockPost.mock.calls[0][1];
    // The consult keeps the seat's reasoning: helper-completion's fast-seat
    // default would switch DeepSeek thinking off, so reflection opts out.
    expect(mockPost.mock.calls[0][2]).toMatchObject({ keepThinking: true });
    expect(payload).toMatchObject({ reasoning_effort: 'max', thinking: { type: 'enabled' } });
    expect(payload.messages[1].content).toContain('update_feedback');
    expect(payload.messages[1].content).toContain('run_command'); // the intended tool
    expect(payload.messages[1].content).toContain('no such ticket');
    expect(payload.messages[0].content).toMatch(/DETERMINISTIC/); // framework-vs-model framing
  });

  it('keyless seat → honest null (no call)', async () => {
    mockProviderFor.mockResolvedValueOnce({ url: 'x', apiKey: undefined, model: 'm', envKey: 'K', label: 'L' });
    await expect(consultCrossCheckerOnStreak(EV)).resolves.toBeNull();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('a consult failure is fail-open null, never a throw', async () => {
    mockPost.mockRejectedValueOnce(new Error('timeout'));
    await expect(consultCrossCheckerOnStreak(EV)).resolves.toBeNull();
  });

  it('per-run cap constant is exported for the agent loop', () => {
    expect(REFLECTION_MAX_PER_RUN).toBe(2);
  });
});

describe('fileStreakInvestigation', () => {
  it('files ONE attribution ticket with the framework-vs-model mandate', async () => {
    await fileStreakInvestigation(EV);
    expect(mockTicketCreate).toHaveBeenCalledTimes(1);
    const data = mockTicketCreate.mock.calls[0][0].data;
    expect(data.title).toContain('framework or model?');
    expect(data.description).toMatch(/DETERMINISTIC framework/);
    expect(data.description).toMatch(/known no-op/); // forbids the generic re-steer
    expect(data.source).toBe('agent-harness');
  });

  it('NX dedupe: a second trip inside 24h files nothing', async () => {
    mockRedisSet.mockResolvedValueOnce(null); // NX lost
    await fileStreakInvestigation(EV);
    expect(mockTicketCreate).not.toHaveBeenCalled();
  });

  it('every failure is swallowed (fire-and-forget → null)', async () => {
    mockTicketCreate.mockRejectedValueOnce(new Error('db down'));
    // Ticket 78f32515: the call now returns the auto-filed ticket id (string)
    // or null — the swallow path resolves null, never throws, never undefined.
    await expect(fileStreakInvestigation(EV)).resolves.toBeNull();
  });
});
