/**
 * audit 2026-10-06 T8-1 + T8-4 — owner-briefing head scope and scrubber husks.
 *
 * T8-1 (schooltime F7, spark F10, others F12): the nightly "Live-chat audit
 * (last 24 h)" line headed 87 of 90 briefings in 48 h — 65 of them in
 * PROJECT-supervisor chats, the same ~17-hour-old row every time. The
 * fleet-wide head lines (live-chat audit + decision-gate rollout) now ride the
 * FLEET briefing only, and the audit line only while the nightly row is < 6 h
 * old. BRIEFING_FLEET_HEAD_SCOPE_DISABLED=1 restores both in every scope with
 * the audit module's 36 h window.
 *
 * T8-4 (stanne P3): id removals left "(todo )", "TIMING )" and "Lane 's".
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async ({ data }: any) => ({ id: 'brief-row-1', ...data })) },
  systemSetting: { findUnique: jest.fn(async () => null) },
  crossModelChat: { findUnique: jest.fn(async ({ where }: any) => ({ isProjectSupervisor: where.id === 'proj-sup-1' })) },
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
  },
}));
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
jest.mock('../platform/supervisor-state.service', () => ({ __esModule: true, getFleetLivenessSnapshot: jest.fn(async () => null) }));

const AUDIT_LINE = 'Live-chat audit (last 24 h): 106 human turns · Quick lane 2';
const mockAuditLine: jest.Mock = jest.fn(async () => AUDIT_LINE);
jest.mock('../platform/live-chat-audit', () => ({ __esModule: true, liveChatAuditBriefingLine: (...a: any[]) => mockAuditLine(...a) }));
const ROLLOUT_LINE = 'Decision gate (auto-rollout ON): 2 purposes moved to act';
jest.mock('../platform/decision-gate-rollout', () => ({ __esModule: true, rolloutBriefingLine: jest.fn(async () => ROLLOUT_LINE) }));

import { generateOwnerBriefing, FLEET_HEAD_AUDIT_FRESH_MS, scrubMachineArtifacts, scrubIdHusks } from './owner-briefing.service';

const NOTE = '**canlegal-bench** — gold rebuild: 3 of 8 shards done → shards 4-8 queued → about a day\nWAKE: actions taken.';
const posted = () => mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content as string;

beforeEach(() => {
  jest.clearAllMocks();
  redisStore.clear();
  mockAuditLine.mockImplementation(async () => AUDIT_LINE);
});
afterEach(() => { delete process.env.BRIEFING_FLEET_HEAD_SCOPE_DISABLED; delete process.env.BRIEFING_SCRUB_HUSKS_DISABLED; });

describe('fleet-wide briefing head lines are fleet-scope only (audit 2026-10-06 T8-1)', () => {
  it('a PROJECT-supervisor briefing carries neither the live-chat audit line nor the rollout line', async () => {
    expect(await generateOwnerBriefing({ chatId: 'proj-sup-1', userId: 'u-admin', noteContent: NOTE })).toBe(true);
    expect(posted()).not.toContain('Live-chat audit');
    expect(posted()).not.toContain('Decision gate');
    expect(posted()).toContain('canlegal-bench: gold rebuild');
    expect(mockAuditLine).not.toHaveBeenCalled();
  });

  it('the FLEET briefing carries both, and asks for the audit row with the 6 h freshness window', async () => {
    expect(await generateOwnerBriefing({ chatId: 'fleet-sup', userId: 'u-admin', noteContent: NOTE })).toBe(true);
    expect(posted().startsWith(`${ROLLOUT_LINE}\n${AUDIT_LINE}\n\n`)).toBe(true);
    expect(mockAuditLine).toHaveBeenCalledWith('u-admin', expect.any(Date), FLEET_HEAD_AUDIT_FRESH_MS);
    expect(FLEET_HEAD_AUDIT_FRESH_MS).toBe(6 * 60 * 60_000);
  });

  it('a stale audit row (the module answers null inside the window) leaves the fleet briefing without the line', async () => {
    mockAuditLine.mockImplementation(async () => null);
    expect(await generateOwnerBriefing({ chatId: 'fleet-sup', userId: 'u-admin', noteContent: NOTE })).toBe(true);
    expect(posted()).not.toContain('Live-chat audit');
  });

  it('BRIEFING_FLEET_HEAD_SCOPE_DISABLED=1: every scope carries both lines and the audit module keeps its own window (previous behaviour)', async () => {
    process.env.BRIEFING_FLEET_HEAD_SCOPE_DISABLED = '1';
    expect(await generateOwnerBriefing({ chatId: 'proj-sup-1', userId: 'u-admin', noteContent: NOTE })).toBe(true);
    expect(posted()).toContain(AUDIT_LINE);
    expect(posted()).toContain(ROLLOUT_LINE);
    expect(mockAuditLine).toHaveBeenCalledWith('u-admin');
  });
});

describe('scrubber husks (audit 2026-10-06 T8-4)', () => {
  it('removes "(todo )" husks, the space before a closer, and re-attaches a detached possessive', () => {
    expect(scrubMachineArtifacts('running the cql-gateway build (todo 57e0fe8d), 64m in')).toBe('running the cql-gateway build, 64m in');
    expect(scrubMachineArtifacts('done (per harness TIMING at 02:58Z)')).toBe('done (per harness TIMING)');
    expect(scrubMachineArtifacts("Lane 1a2b3c4d's firing 7 ran")).toBe("Lane's firing 7 ran");
    expect(scrubMachineArtifacts('three lanes moved (goal 4d5e6f70, todo 1a2b3c4d)')).toBe('three lanes moved');
  });

  it('a paren group with real words survives', () => {
    expect(scrubIdHusks('(lanes + three self-recovered)')).toBe('(lanes + three self-recovered)');
    expect(scrubIdHusks('the todo list (two items)')).toBe('the todo list (two items)');
  });

  it('BRIEFING_SCRUB_HUSKS_DISABLED=1 restores the previous output', () => {
    process.env.BRIEFING_SCRUB_HUSKS_DISABLED = '1';
    expect(scrubMachineArtifacts('running the cql-gateway build (todo 57e0fe8d), 64m in')).toBe('running the cql-gateway build (todo ), 64m in');
  });
});
