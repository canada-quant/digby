/**
 * REGRESSION PIN (2026-09-27, first prod dry run of the layered-prompt
 * re-scaffold, deploy fb1e584a): `migrateSupervisorPrompts` walked all 15
 * supervisor chats and then the stock-sweep scan threw
 * "Unknown field `chatId` for select statement on model `ChatSchedule`" —
 * the schedule row keys its chat as `sessionId` (schema.prisma: `sessionId
 * String // == crossmodel_chats.id`). The whole sweep pass was lost to the
 * catch-all outcome row. Pins: the schedule query selects `sessionId`, never
 * `chatId`, and a stock sweep body that differs from the current builder is
 * reported as `would-rewrite` on a dry run.
 */

const findManySchedules = jest.fn();
const findManyChats = jest.fn();

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelChat: { findMany: (...a: any[]) => findManyChats(...a) },
    chatSchedule: { findMany: (...a: any[]) => findManySchedules(...a), update: jest.fn() },
  },
}));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./project-supervisor.service', () => ({
  rescaffoldProjectSupervisorPrompt: jest.fn(),
  buildProjectSupervisorSweepPrompt: jest.fn(() => 'Project Supervisor sweep — CURRENT BODY'),
}));
jest.mock('./supervisor.service', () => ({
  healSupervisorStockPrompt: jest.fn(),
  buildFleetSweepPrompt: jest.fn(() => 'Fleet Supervisor sweep — CURRENT BODY'),
  findFleetSupervisorChat: jest.fn(async () => ({ id: 'fleet-chat' })),
}));

import { migrateSupervisorPrompts } from './prompt-migrate';
import { SWEEP_PROMPT_OPENER, PROJECT_SWEEP_PROMPT_OPENER } from './supervisor-doctrine';

describe('prompt-migrate — stock sweep scan selects the schedule chat by sessionId', () => {
  beforeEach(() => {
    delete process.env.PROMPT_LAYERING_DISABLED;
    findManyChats.mockReset().mockResolvedValue([]);
    findManySchedules.mockReset().mockResolvedValue([
      { id: 'sched-fleet', sessionId: 'fleet-chat', prompt: `${SWEEP_PROMPT_OPENER} old fleet body`, chat: { id: 'fleet-chat', userId: 'u1', projectId: null, isSupervisor: true, isProjectSupervisor: false, project: null } },
      { id: 'sched-proj', sessionId: 'proj-chat', prompt: `${PROJECT_SWEEP_PROMPT_OPENER} old project body`, chat: { id: 'proj-chat', userId: 'u1', projectId: 'p1', isSupervisor: false, isProjectSupervisor: true, project: { name: 'Proj' } } },
    ]);
  });

  it('never selects the non-existent `chatId` column and reports both stale sweeps as would-rewrite on a dry run', async () => {
    const report = await migrateSupervisorPrompts({ dryRun: true });
    expect(findManySchedules).toHaveBeenCalledTimes(1);
    const args = findManySchedules.mock.calls[0][0];
    expect(args.select.sessionId).toBe(true);
    expect(args.select).not.toHaveProperty('chatId');
    expect(args.select.chat.select).toMatchObject({ id: true, userId: true, projectId: true, isSupervisor: true, isProjectSupervisor: true });
    const sweeps = report.outcomes.filter((o) => o.kind === 'sweep');
    expect(sweeps.map((o) => [o.chatId, o.outcome])).toEqual([
      ['fleet-chat', 'would-rewrite'],
      ['proj-chat', 'would-rewrite'],
    ]);
    expect(report.outcomes.some((o) => o.outcome === 'error')).toBe(false);
  });
});
