/**
 * Ticket e3113ec9 — the video-capability note's WIRING. The leaf's own suite
 * (video-capability-note.test.ts) pins the classifier and the brief's text;
 * THIS one proves the real chat-agent service composes the note into the
 * doctrine on exactly the turn that needs it and composes nothing on every
 * other turn.
 *
 * The incident (2026-10-28, chat 196ddcb5): the user asked for a 60-second
 * advertising Reel; the run delivered a scenario + 4 generate_image frames +
 * external-app prompts across several turns, and the user's complaint was that
 * the capability gap was never disclosed first («وقتی بلد نیستی ویدیو بسازی
 * چرا وقتمو می‌گیری — همون اول بگو» — "if you can't make videos, say so at the
 * START"). This suite pins the two facts that make the fix real:
 *   1. a human video ask → the doctrine the lead actually receives carries the
 *      first-line disclosure brief;
 *   2. nothing else changes — an ordinary turn, a video-understanding turn
 *      (a real capability), a machine wake, and the kill switch stay clean.
 *
 * Harness mirrors search-discipline.test.ts (its (g1) case is the precedent):
 * real in-memory live-runs registry, everything else mocked at the module
 * boundary; the doctrine the lead would have received is read off the mocked
 * runCodingAgent's doctrineOverride.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelMessage: {
    create: jest.fn(async () => ({})),
    count: jest.fn(async ({ where }: any) => (where?.OR ? 0 : 2)),
  },
  crossModelChat: {
    update: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: 1 })),
    findUnique: jest.fn(async () => ({ title: 'A proper existing title' })),
  },
  pendingChatMessage: { findFirst: jest.fn(async () => null), delete: jest.fn(async () => ({})) },
  agentRun: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const redisStore = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean }) => {
      if (opts?.NX && redisStore.has(k)) return null;
      redisStore.set(k, v);
      return 'OK';
    }),
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    del: jest.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
    exists: jest.fn(async (k: string) => (redisStore.has(k) ? 1 : 0)),
    mGet: jest.fn(async (keys: string[]) => keys.map((k) => redisStore.get(k) ?? null)),
  },
}));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

// Seat pre-flight: the REAL seatUnservableReason reads provider env keys, and
// this jest env is keyless — keep the rest of coding-model REAL (same shim as
// search-discipline.test.ts).
jest.mock('../coding/coding-model', () => ({
  __esModule: true,
  ...jest.requireActual('../coding/coding-model'),
  seatUnservableReason: jest.fn(async () => null),
}));

jest.mock('../coding/agent', () => ({
  runCodingAgent: jest.fn(async () => ({ finalText: 'A'.repeat(500) })),
  runChatWorker: jest.fn(async () => ({ finalText: '' })),
}));
jest.mock('../mcp-search', () => ({
  __esModule: true,
  searchWithBrightData: jest.fn(async () => ''),
  SEARCH_UNAVAILABLE_NOTE: '[search unavailable]',
}));
jest.mock('../image-describe', () => ({
  __esModule: true,
  describeImageWithVision: jest.fn(async (..._a: any[]) => 'a described image'),
  VISION_UTILITY_MODEL: 'glm-5.3-flash',
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { CHAT_SEARCH_USAGE: 'chat_search_usage', CHAT_PLATFORM_USAGE: 'chat_platform_usage', CHAT_PHANTOM_WEB_CLAIM: 'chat_phantom_web_claim' },
}));
jest.mock('../langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
jest.mock('../context.service', () => ({
  __esModule: true,
  default: { saveToSessionHistory: jest.fn(async () => {}) },
}));
jest.mock('../integrations/moonshot.integration', () => ({
  __esModule: true,
  default: { generateTitle: jest.fn(async () => 'A Generated Title') },
}));
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: jest.fn(async () => {}),
  clearHookDepth: jest.fn(async () => {}),
  stampHookDepth: jest.fn(async () => {}),
}));
jest.mock('./machine-wake', () => ({
  __esModule: true,
  machineWakePreamble: jest.fn(() => '[MOCK-WAKE-PREAMBLE]\n'),
}));
jest.mock('./chat-context', () => ({
  // queryMessage passes the caller's message THROUGH — the video classifier
  // reads args.message directly, so a test's message must reach the service.
  __esModule: true,
  buildChatQueryContext: jest.fn(async (args: any) => ({
    queryMessage: String(args?.message ?? 'the question'),
    systemContext: '',
    conversationHistory: [{ role: 'user', content: 'earlier' }],
    projectId: null,
  })),
  persistAndEmitCanvases: jest.fn(async () => []),
}));

import { startDetachedChatRun } from './chat-agent.service';
import { runCodingAgent } from '../coding/agent';
import { isRunActive } from '../coding/live-runs';

const mockRunCodingAgent = runCodingAgent as jest.Mock;

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10));
  if (!pred()) throw new Error('timed out waiting for run events');
}

const doctrineOf = () => String(mockRunCodingAgent.mock.calls.at(-1)?.[0]?.doctrineOverride ?? '');

const REEL_ASK = 'Make me a 60-second advertising Reel for my café — a scenario plus photorealistic reference frames, then the video.';

describe('ticket e3113ec9 — the video-capability note rides the chat doctrine', () => {
  jest.setTimeout(30000);

  beforeEach(() => {
    jest.clearAllMocks();
    redisStore.clear();
    mockRunCodingAgent.mockImplementation(async () => ({ finalText: 'A'.repeat(500) }));
  });

  it('a HUMAN turn asking for a Reel carries the first-line disclosure brief', async () => {
    const key = await startDetachedChatRun({ message: REEL_ASK, mode: 'thinking' as const, userId: 'u1', chatId: 'chat-e3113ec9-a', sessionId: null });
    await waitFor(() => !isRunActive(key!), 20000);
    const doctrine = doctrineOf();
    expect(doctrine).toContain('## This turn asks for a VIDEO');
    expect(doctrine).toContain('NO video generation');
    expect(doctrine).toContain('Say it in your FIRST line');
    expect(doctrine).toContain('generate_image');
    // The doctrine still carries everything else (the playbook row too).
    expect(doctrine).toContain('## Doing things for the user (you operate Digby)');
  });

  it('an ordinary turn carries NO video note', async () => {
    const key = await startDetachedChatRun({ message: 'what is the capital of France', mode: 'thinking' as const, userId: 'u1', chatId: 'chat-e3113ec9-b', sessionId: null });
    await waitFor(() => !isRunActive(key!), 20000);
    expect(doctrineOf()).not.toContain('## This turn asks for a VIDEO');
  });

  it('a video-UNDERSTANDING turn (a real Digby capability) gets NO limitation note', async () => {
    const key = await startDetachedChatRun({ message: 'summarise this video for me', mode: 'thinking' as const, userId: 'u1', chatId: 'chat-e3113ec9-c', sessionId: null });
    await waitFor(() => !isRunActive(key!), 20000);
    expect(doctrineOf()).not.toContain('## This turn asks for a VIDEO');
  });

  it('a MACHINE wake never carries the note (no user waiting; it would leak into notify_user)', async () => {
    const key = await startDetachedChatRun({ message: REEL_ASK, mode: 'thinking' as const, userId: 'u1', chatId: 'chat-e3113ec9-d', sessionId: null, machineWake: true });
    await waitFor(() => !isRunActive(key!), 20000);
    expect(doctrineOf()).not.toContain('## This turn asks for a VIDEO');
  });

  it('VIDEO_CAPABILITY_NOTE_DISABLED=1 returns the plain doctrine on a real video ask', async () => {
    process.env.VIDEO_CAPABILITY_NOTE_DISABLED = '1';
    try {
      const key = await startDetachedChatRun({ message: REEL_ASK, mode: 'thinking' as const, userId: 'u1', chatId: 'chat-e3113ec9-e', sessionId: null });
      await waitFor(() => !isRunActive(key!), 20000);
      expect(doctrineOf()).not.toContain('## This turn asks for a VIDEO');
    } finally {
      delete process.env.VIDEO_CAPABILITY_NOTE_DISABLED;
    }
  });
});