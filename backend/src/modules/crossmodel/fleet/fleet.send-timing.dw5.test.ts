/**
 * DW-5 measure-first (FO firing 68) — the FLEET SURFACE half of the
 * supervisor_send_timing instrument: sendSupervisorMessage (Management UI →
 * POST /fleet/supervisor/messages) marks its platform send
 * timingSurface:'fleet', and the defensive 409→enqueue fallback stamps the
 * queued_409 outcome row itself. The seam half (seam breakdown, kill switch,
 * no-marker purity) lives in supervisor-send-timing.dw5.test.ts.
 *
 * platform.service is mocked at the module boundary here (fleet.service
 * reaches it via dynamic import, which jest.mock intercepts); everything
 * else fleet.service needs is mocked at its import surface.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
const mockRedis: any = {};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

// requireSupervisor's dynamic import — a fleet supervisor chat always resolves.
const mockFindFleetSupervisorChat = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'sup-1', title: 'Fleet Supervisor' }));
jest.mock('../platform/supervisor.service', () => ({
  __esModule: true,
  findFleetSupervisorChat: (...a: any[]) => mockFindFleetSupervisorChat(...a),
  ensureFleetSupervisor: jest.fn(async () => ({ id: 'sup-1', title: 'Fleet Supervisor' })),
}));

// The platform seam — captured (this file pins the MARKER, not the seam).
const mockSendChatMessage = jest.fn(async (..._a: any[]): Promise<any> => ({}));
jest.mock('../platform/platform.service', () => ({
  __esModule: true,
  sendChatMessage: (...a: any[]) => mockSendChatMessage(...a),
}));

// The instrument's fallback leg (dynamic import in the 409 catch).
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

// The 409 fallback's enqueue (dynamic import).
const mockEnqueueChatMessage = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'p2', position: 2 }));
jest.mock('../chat-agent/message-queue.service', () => ({
  __esModule: true,
  enqueueChatMessage: (...a: any[]) => mockEnqueueChatMessage(...a),
}));

// fleet.service's other static imports (only their leaves are needed).
jest.mock('../attachment-resolution', () => ({
  __esModule: true,
  resolveStagedUploads: jest.fn(async () => ({ loaded: [], droppedCount: 0 })),
  attachmentDropAnnotation: (n: number) => `[${n} attachment(s) could not be loaded]`,
}));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  projectedDailyFiringsFor: jest.fn(() => 0),
  clockDriftMinutesFor: jest.fn(() => 0),
  projectNextFirings: jest.fn(() => []),
}));
jest.mock('./owner-briefing.service', () => ({
  __esModule: true,
  OWNER_BRIEFING_KIND: 'owner_briefing',
  generateOwnerBriefing: jest.fn(async () => null),
}));
jest.mock('../chat-agent/machine-wake', () => ({
  __esModule: true,
  OWNER_DIGEST_KIND: 'owner_digest',
}));
jest.mock('../chat-agent/chat-busy', () => ({
  __esModule: true,
  isChatBusy: jest.fn(async () => false),
  getBusyChatIds: jest.fn(async () => []),
}));
jest.mock('../platform/supervisor-switch', () => ({
  __esModule: true,
  getSupervisorSwitchState: jest.fn(async () => ({ fleet: { enabled: true } })),
}));
jest.mock('../coding/renew-refusal-surface', () => ({
  __esModule: true,
  getRenewRefusalSummary: jest.fn(async () => null),
}));

import { sendSupervisorMessage } from './fleet.service';

const OWNER = 'u-owner';
const timingRows = () => mockRecordLoopMetric.mock.calls
  .map((c: any[]) => c[0])
  .filter((r: any) => r?.kind === 'supervisor_send_timing');

beforeEach(() => { jest.clearAllMocks(); });

describe('DW-5 — sendSupervisorMessage marks its platform send for timing (FO firing 68)', () => {
  it('passes timingSurface fleet + the user-turn anchor; a started send reports queued:false', async () => {
    const r = await sendSupervisorMessage(OWNER, 'status?');
    expect(r).toEqual({ queued: false });
    expect(mockSendChatMessage).toHaveBeenCalledTimes(1);
    expect(mockSendChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      userId: OWNER, chatId: 'sup-1', content: 'status?',
      origin: { kind: 'user' },
      timingSurface: 'fleet',
    }));
    // The arg carries a real userTurnAt anchor (the run's confirmation anchor).
    const arg = mockSendChatMessage.mock.calls[0][0];
    expect(arg.userTurnAt instanceof Date).toBe(true);
  });

  it('a platform-queued send maps onto { queued: true, position } with the marker intact', async () => {
    mockSendChatMessage.mockResolvedValueOnce({ position: 3 });
    const r = await sendSupervisorMessage(OWNER, 'nudge');
    expect(r).toEqual({ queued: true, position: 3 });
    expect(mockSendChatMessage).toHaveBeenCalledWith(expect.objectContaining({ timingSurface: 'fleet' }));
  });

  it('the defensive 409→enqueue fallback stamps the queued_409 outcome row', async () => {
    const { AppError } = require('../../../middleware/error-handler');
    mockSendChatMessage.mockRejectedValueOnce(new AppError(409, 'A run is already in progress'));
    const r = await sendSupervisorMessage(OWNER, 'during a run');
    expect(r).toEqual({ queued: true, position: 2 });
    expect(mockEnqueueChatMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'sup-1', userId: OWNER }));
    const rows = timingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe('sup-1');
    expect(rows[0].unit).toBe('ms');
    expect(typeof rows[0].value).toBe('number');
    expect(rows[0].meta).toMatchObject({ surface: 'fleet', outcome: 'queued_409' });
  });

  it('a NON-409 platform error propagates (no fallback, no timing row)', async () => {
    const { AppError } = require('../../../middleware/error-handler');
    mockSendChatMessage.mockRejectedValueOnce(new AppError(403, 'no access'));
    await expect(sendSupervisorMessage(OWNER, 'x')).rejects.toMatchObject({ statusCode: 403 });
    expect(mockEnqueueChatMessage).not.toHaveBeenCalled();
    expect(timingRows()).toHaveLength(0);
  });
});
