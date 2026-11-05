/**
 * scripts/framework-audit/lane-retire-preview.js — the lane lifecycle C1
 * pre-deploy check (2026-10-21): READ-ONLY. Runs the acting discovery query
 * (180 d, newest first, 100 projects), the index + R6 candidates and
 * previewLaneRetire, prints verdicts / proofs per project, skips a partial
 * index, and never calls an archive path.
 */
import path from 'path';

const script: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'lane-retire-preview.js'));

const NOW = new Date('2026-10-21T19:00:00Z');
const laneRow = (laneId: string) => ({ laneId, title: `ticket 4a8fcbde: ${'x'.repeat(30)} token ABCDEFGHIJKLMNOPQRSTUVWXYZ0123`, isCoding: true });

function deps(opts: { partialFor?: string } = {}) {
  const prisma: any = { crossModelChat: { findMany: jest.fn(async () => [{ projectId: 'proj-1', userId: 'u1' }, { projectId: 'proj-2', userId: 'u1' }]) } };
  const topology: any = {
    buildLaneIndex: jest.fn(async (projectId: string) => ({ lanes: projectId === 'proj-1' ? [laneRow('lane-aaaaaaaa1'), laneRow('lane-bbbbbbbb2')] : [laneRow('lane-cccccccc3')], goalTitles: {}, partial: projectId === opts.partialFor })),
    retireCandidates: jest.fn((lanes: any[]) => lanes.map((l) => ({ laneId: l.laneId, title: l.title, idleSec: null }))),
  };
  const laneRetire: any = {
    LANE_RETIRE_PROJECT_LOOKBACK_MS: 180 * 86400_000, LANE_RETIRE_MAX_PROJECTS: 100, LANE_RETIRE_MAX_PER_PASS: 25,
    previewLaneRetire: jest.fn(async (cands: any[]) => cands.map((c, i) => ({
      laneId: c.lane.laneId, title: c.lane.title, projectId: c.projectId, userId: c.userId,
      eligible: i === 0, reason: i === 0 ? 'eligible' : 'owner_created', proof: i === 0 ? 'p2:dispatched_to' : null, idleDays: 9, parentChatId: null,
    }))),
    retireIdleLanes: jest.fn(),
    archiveIdleLane: jest.fn(),
  };
  return { prisma, topology, laneRetire };
}

describe('lane-retire-preview.js (lane lifecycle C1, 2026-10-21)', () => {
  it('reports verdicts + proofs per project with the acting discovery query, and never archives', async () => {
    const d = deps();
    const r = await script.run({ ...d, argv: [], now: NOW });
    expect(d.prisma.crossModelChat.findMany).toHaveBeenCalledWith({
      where: { archivedAt: null, projectId: { not: null }, codingState: { isNot: null }, updatedAt: { gte: new Date(NOW.getTime() - 180 * 86400_000) } },
      select: { projectId: true, userId: true }, distinct: ['projectId'], orderBy: { updatedAt: 'desc' }, take: 100,
    });
    expect(r).toMatchObject({ readOnly: true, projectsScanned: 2, projectsWithCandidates: 2, candidates: 3, eligible: 2, wouldArchiveFirstPass: 2, byReason: { eligible: 2, owner_created: 1 }, byProof: { 'p2:dispatched_to': 2 } });
    expect(r.projects[0].verdicts[0]).toEqual({ laneId: 'lane-aaa', title: expect.stringContaining('<tok>'), eligible: true, reason: 'eligible', proof: 'p2:dispatched_to', idleDays: 9, parent: null });
    expect(r.projects[0].verdicts[0].title.length).toBeLessThanOrEqual(60);
    expect(d.laneRetire.retireIdleLanes).not.toHaveBeenCalled();
    expect(d.laneRetire.archiveIdleLane).not.toHaveBeenCalled();
  });

  it('a partial index is reported and skipped; --project narrows; unknown args are usage errors', async () => {
    const d = deps({ partialFor: 'proj-2' });
    const r = await script.run({ ...d, argv: [], now: NOW });
    expect(r.projects.find((p: any) => p.projectId === 'proj-2')).toEqual({ projectId: 'proj-2', candidates: 1, partial: true, verdicts: [] });
    expect(d.laneRetire.previewLaneRetire).toHaveBeenCalledTimes(1);
    const only = await script.run({ ...deps(), argv: ['--project', 'proj-2'], now: NOW });
    expect(only.projects.map((p: any) => p.projectId)).toEqual(['proj-2']);
    expect(() => script.parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });

  it('review fixer (2026-10-21): on a dist with collectRetireCandidates it previews the cron\'s OWN coding-lane walk (cursor untouched), reporting pages / partial pages', async () => {
    const d = deps();
    d.laneRetire.collectRetireCandidates = jest.fn(async (projectId: string) => (projectId === 'proj-1'
      ? { candidates: [{ lane: laneRow('lane-aaaaaaaa1'), projectId, userId: 'u1' }], pages: 3, partialPages: 1, truncated: false }
      : { candidates: [], pages: 1, partialPages: 0, truncated: false }));
    const r = await script.run({ ...d, argv: [], now: NOW });
    expect(d.laneRetire.collectRetireCandidates).toHaveBeenCalledWith('proj-1', 'u1', NOW, { persistCursor: false });
    expect(d.topology.buildLaneIndex).not.toHaveBeenCalled();
    expect(r.projects).toEqual([expect.objectContaining({ projectId: 'proj-1', candidates: 1, partial: true, partialPages: 1, pages: 3, truncated: false })]);
    expect(d.laneRetire.retireIdleLanes).not.toHaveBeenCalled();
  });
});
