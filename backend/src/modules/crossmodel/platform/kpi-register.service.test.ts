/**
 * KPI register readers (tt-rd audit 2026-09-27): every kpi: premise on the
 * active/blocked goals of a project set; a PROJECT supervisor reads its own
 * project, the FLEET supervisor every opted-in project; reads fail toward [].
 */
const mockPrisma: any = {
  projectGoal: { findMany: jest.fn(async () => []) },
  crossModelProject: { findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK') } }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn() }));

import { loadProjectKpis, loadKpisForSupervisorChat } from './kpi-register.service';

beforeEach(() => jest.clearAllMocks());

describe('kpi-register.service', () => {
  it('loadProjectKpis returns one KpiView per KPI goal, tagged with goal + project', async () => {
    mockPrisma.projectGoal.findMany.mockResolvedValue([
      { id: 'g1', projectId: 'p1', title: 'Serve', premises: [{ key: 'host_tail', value: 1 }, { key: 'kpi:e2e', value: '5.08', unit: 'tok/s', receiptId: 'f5b42fe6' }] },
      { id: 'g2', projectId: 'p1', title: 'No kpi', premises: [{ key: 'x', value: 1 }] },
      { id: 'g3', projectId: 'p2', title: 'Garbage', premises: 'nope' },
    ]);
    const out = await loadProjectKpis(['p1', 'p2', 'p1']);
    expect(out).toEqual([expect.objectContaining({ goalId: 'g1', projectId: 'p1', goalTitle: 'Serve', key: 'kpi:e2e', value: 5.08, receiptId: 'f5b42fe6' })]);
    expect(mockPrisma.projectGoal.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ projectId: { in: ['p1', 'p2'] }, status: { in: ['active', 'blocked'] } }) }));
    expect(await loadProjectKpis([])).toEqual([]);
    mockPrisma.projectGoal.findMany.mockRejectedValueOnce(new Error('db'));
    expect(await loadProjectKpis(['p1'])).toEqual([]);
  });

  it('loadKpisForSupervisorChat: project scope reads its project; fleet scope reads every opted-in project of the owner; neither ⇒ []', async () => {
    mockPrisma.projectGoal.findMany.mockResolvedValue([]);
    await loadKpisForSupervisorChat({ projectId: 'p1' });
    expect(mockPrisma.projectGoal.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ projectId: { in: ['p1'] } }) }));
    mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: 'pa' }, { id: 'pb' }]);
    await loadKpisForSupervisorChat({ userId: 'u1', fleet: true });
    expect(mockPrisma.crossModelProject.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'u1', projectSupervisorEnabled: true }) }));
    expect(mockPrisma.projectGoal.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ projectId: { in: ['pa', 'pb'] } }) }));
    expect(await loadKpisForSupervisorChat({})).toEqual([]);
    mockPrisma.crossModelProject.findMany.mockRejectedValueOnce(new Error('db'));
    expect(await loadKpisForSupervisorChat({ userId: 'u1', fleet: true })).toEqual([]);
  });
});
