/**
 * Pins the Fleet Supervisor profile budget (owner 2026-09-11: the supervisor
 * runs on a 1M-token glm-5.3 seat at reasoning_effort max — a single turn
 * streams ~12 min of thinking before its first content token, so the run
 * deadline must leave room for survey → act → verify).
 */
import { supervisorProfile, chatProfile } from './agent-profiles';

describe('supervisorProfile — the Fleet Supervisor budget', () => {
  it('45-minute run deadline, 24 steps, 1M-char context budget (glm-5.3 max seat, measured 2026-09-11)', () => {
    const p = supervisorProfile();
    expect(p.kind).toBe('chat');
    expect(p.maxSteps).toBe(24);
    expect(p.contextCharBudget).toBe(1_000_000);
    expect(p.runDeadlineMs).toBe(2_700_000);
    expect(p.workspaceTools).toBe(false);
  });

  it('the interactive chat profiles keep their latency contracts (not widened with the supervisor)', () => {
    expect(chatProfile('thinking', false).runDeadlineMs).toBe(480_000);
    expect(chatProfile('single_thinking', false).runDeadlineMs).toBe(240_000);
  });
});
