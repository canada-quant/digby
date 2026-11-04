jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));

import { mergeRunIntoSession, emptySessionUsage, commitRunUsage } from './usage-store';
import { RunUsage } from './cost';

const run = (runId: string, over: Partial<RunUsage> = {}): RunUsage => ({
  runId, totalInTokens: 1000, totalOutTokens: 200, totalCostUsd: 0.01, turns: 3, estimated: false,
  agents: [{ agent: 'Digby', model: 'glm-5.2', inTokens: 1000, outTokens: 200, costUsd: 0.01, turns: 3, estimated: false }],
  ...over,
});

describe('session usage store', () => {
  it('merges runs cumulatively and per-agent', () => {
    let s = emptySessionUsage();
    s = mergeRunIntoSession(s, run('r1'));
    s = mergeRunIntoSession(s, run('r2', {
      agents: [
        { agent: 'Digby', model: 'glm-5.2', inTokens: 500, outTokens: 100, costUsd: 0.005, turns: 2, estimated: false },
        { agent: 'Fix tests', role: 'coder', model: 'glm-5.2', inTokens: 300, outTokens: 50, costUsd: 0.003, turns: 1, estimated: true },
      ],
      totalInTokens: 800, totalOutTokens: 150, totalCostUsd: 0.008, turns: 3, estimated: true,
    }));
    expect(s.inTokens).toBe(1800);
    expect(s.outTokens).toBe(350);
    expect(s.runs).toBe(2);
    expect(s.estimated).toBe(true);
    const digby = s.agents.find(a => a.agent === 'Digby')!;
    expect(digby.inTokens).toBe(1500);
    expect(digby.turns).toBe(5);
    expect(s.agents.find(a => a.agent === 'Fix tests')!.role).toBe('coder');
  });

  it('is idempotent per runId (SSE replay / double-commit safe)', () => {
    let s = emptySessionUsage();
    s = mergeRunIntoSession(s, run('r1'));
    const again = mergeRunIntoSession(s, run('r1'));
    expect(again).toBe(s); // unchanged reference — nothing double-counted
    expect(again.inTokens).toBe(1000);
    expect(again.runs).toBe(1);
  });

  it('commitRunUsage persists the merge', async () => {
    const { storePut } = jest.requireMock('../memory/context-store');
    (storePut as jest.Mock).mockClear();
    const merged = await commitRunUsage('sess-x', run('r9'));
    expect(merged.inTokens).toBe(1000);
    expect(storePut).toHaveBeenCalledWith(['sess-x', 'coding-usage'], 'session-total', expect.objectContaining({ runs: 1 }));
  });
});
