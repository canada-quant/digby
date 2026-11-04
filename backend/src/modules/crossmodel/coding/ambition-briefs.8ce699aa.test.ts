/**
 * AMBITION MAP TRANCHE 3 (todo 8ce699aa, goal b3f240e4) — B1 + B2 pins.
 *
 * docs/AMBITIOUS_PROMPTING_MAP_2026-10-15.md §3 (merged as PR #1512):
 *   B1 — the "deeper, not bigger" delegate-brief contract, one sentence in
 *        roles.ts orchestratorRoleGuidance: name the RAW material and the
 *        PROVE condition (the essay's meta-prompt questions (2)+(4)).
 *   B2 — the honest altitude note, one bullet in agent.ts systemPrompt
 *        "How you work" (after the commit bullet): scope to the stated goal,
 *        name a visible bigger outcome in ONE line as a suggestion, leave it
 *        to the owner — altitude is an offer, never a silent expansion (map
 *        §6 anti-pattern 3).
 *
 * Every touched string is pinned VERBATIM (the map's drop-in text, byte for
 * byte), position is pinned (B1 after the brief-toolset paragraph, B2 after
 * the commit bullet), the pre-existing contracts both surfaces already carry
 * stay pinned, and map §6 anti-patterns stay ABSENT. Placement note: the map
 * says the sentence lands "after the 'Complete, self-contained instructions'
 * clause" — that literal clause is the delegate tool's task-param description
 * (agent.ts), not part of orchestratorRoleGuidance; the sentence is placed
 * immediately after the MATCH THE DELIVERABLE brief-quality paragraph, the
 * other brief-doctrine in that function, which is where a brief contract
 * belongs.
 *
 * Scaffold mirrors tool-groups.registry.test.ts (the proven import path for
 * systemPrompt from agent.ts).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'y'.repeat(32) },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSubscriber: { subscribe: jest.fn(), on: jest.fn() },
}));
jest.mock('../github/github-mcp', () => ({
  __esModule: true, isGitHubMcpConfigured: jest.fn(() => false), callGitHubMcpTool: jest.fn(),
}));
jest.mock('../google/google-mcp', () => ({
  __esModule: true, isGoogleMcpConfigured: jest.fn(() => false), callGoogleMcpTool: jest.fn(),
}));
jest.mock('../imessage/agent-link', () => ({
  agentBroker: { dispatch: jest.fn() },
}));

jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  noteSeatFallback: jest.fn(),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', PROVIDER_REJECTED: 'provider_rejected', SEAT_FALLBACK: 'seat_fallback', PROVIDER_COOLDOWN: 'provider_cooldown', TOOL_LIST_TRIMMED: 'tool_list_trimmed', TOOL_GROUPS: 'tool_groups' },
}));
jest.mock('../feedback/feedback.service', () => {
  const actual = jest.requireActual('../feedback/feedback.service');
  return { ...actual, fileFeedbackTicket: jest.fn(async () => ({ id: 'ticket-1' })) };
});
jest.mock('./run-journal.service', () => ({
  __esModule: true,
  getRecentJournalEntries: jest.fn(async () => []),
  formatJournalBlock: jest.fn(() => ''),
}));
jest.mock('./container.service', () => ({
  __esModule: true,
  ensureSessionContainer: jest.fn(async () => false),
  execInContainer: jest.fn(),
  isContainerMode: jest.fn(() => false),
}));
jest.mock('./session-credentials', () => ({
  __esModule: true,
  gatherSessionCredentialEnv: jest.fn(async () => ({})),
  credentialEnvNote: jest.fn(() => ''),
}));
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn() }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ''),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0) }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));

import { systemPrompt } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { orchestratorRoleGuidance } from './roles';

const PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 90_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

const makeInput = (extra?: Partial<AgentRunInput>): AgentRunInput => ({
  worktree: '/tmp/ambition-briefs',
  sessionId: 'sess-ambition',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.3',
  projectName: 'test',
  branch: 'chat',
  profile: PROFILE,
  history: [] as any,
  userMessage: 'ship the tranche',
  emit: jest.fn(),
  ...extra,
});

// The map's drop-in text (§3 B1) — pinned VERBATIM.
const B1_BRIEF_CONTRACT =
  'Write briefs the way a demanding principal would: name the RAW material to start from (files, logs, URLs — not pre-digested summaries) and, for anything investigative, what would PROVE the answer right or wrong — a brief that omits both gets a shallower worker.';

// The map's drop-in text (§3 B2) — pinned VERBATIM, leading '- ' included.
const B2_ALTITUDE_BULLET =
  '- Scope to the stated goal — never silently expand it. But if the task is a symptom of a bigger outcome you can see (the fix that wants a guardrail, the report that wants a standing schedule), name it in ONE line of your final as a suggestion with the concrete next command, and leave it to the owner.';

describe('ambition map tranche 3 · B1 — delegate-brief contract (roles.ts orchestratorRoleGuidance)', () => {
  it('carries the demanding-principal brief contract VERBATIM (map §3 B1 drop-in)', () => {
    expect(orchestratorRoleGuidance()).toContain(B1_BRIEF_CONTRACT);
  });

  it('sits with the brief doctrine — directly after the MATCH THE DELIVERABLE toolset paragraph (the placement note in the suite header)', () => {
    const g = orchestratorRoleGuidance();
    const deliverable = g.indexOf('Never ask a read-only worker to persist an artifact to disk.');
    const contract = g.indexOf(B1_BRIEF_CONTRACT);
    const context = g.indexOf('CONTEXT DISCIPLINE (important):');
    expect(deliverable).toBeGreaterThanOrEqual(0);
    expect(contract).toBeGreaterThan(deliverable);
    expect(context).toBeGreaterThan(contract);
  });

  it('the pre-existing orchestrator contracts stay intact (roles.test.ts + prompt-layers + doctrine-coverage surfaces)', () => {
    const g = orchestratorRoleGuidance();
    expect(g).toContain('MATCH THE DELIVERABLE TO THE ROLE\'S TOOLSET');
    expect(g).toContain('CONTEXT DISCIPLINE (important):');
    expect(g).toMatch(/search_memory/);
    expect(g).toMatch(/search_code_semantic/);
    expect(g).toContain('Available roles:');
    // the background-delegation paragraph renders when the kill switch is off
    expect(g).toContain('BLOCKING vs BACKGROUND DELEGATION');
  });
});

describe('ambition map tranche 3 · B2 — the honest altitude note (agent.ts systemPrompt)', () => {
  const prompt = (): string =>
    systemPrompt(makeInput(), 'repo context', 'memory block', '', 'date time block');

  it('carries the altitude bullet VERBATIM (map §3 B2 drop-in, leading "- " included)', () => {
    expect(prompt()).toContain(B2_ALTITUDE_BULLET);
  });

  it('sits in "How you work" directly after the commit bullet (the map\'s placement)', () => {
    const p = prompt();
    const commitBullet = p.indexOf('- Commit logical units with git_commit on the session branch.');
    const altitude = p.indexOf(B2_ALTITUDE_BULLET);
    const docs = p.indexOf('- **Docs move with the code:**');
    const howYouWork = p.indexOf('## How you work (Digby defaults)');
    const safety = p.indexOf('## Safety (always, even in AUTO mode)');
    expect(howYouWork).toBeGreaterThanOrEqual(0);
    expect(commitBullet).toBeGreaterThanOrEqual(0);
    expect(altitude).toBeGreaterThan(commitBullet);
    expect(altitude).toBeGreaterThan(howYouWork);
    expect(altitude).toBeLessThan(docs);
    expect(altitude).toBeLessThan(safety);
  });

  it('the pre-existing harness contracts stay intact (the honest-incomplete + scope discipline B2 leans on)', () => {
    const p = prompt();
    expect(p).toContain('an honest incomplete is a pass; an uncited completion claim is a fabrication strike');
    expect(p).toContain('- **Docs move with the code:**');
    expect(p).toContain('Finish with a short summary of what changed and how you verified it');
    expect(p).toContain('## How you work (Digby defaults)');
  });
});

describe('ambition map §6 anti-patterns stay ABSENT from both touched surfaces (tranche guard)', () => {
  it('no "you can do it" belief pressure, no persona/roleplay crew, no permission-to-fail inflation (map §6.1/§6.2)', () => {
    for (const text of [orchestratorRoleGuidance(), systemPrompt(makeInput(), 'repo', 'mem', '', 'clock')]) {
      expect(text).not.toMatch(/you can do it/i);
      expect(text).not.toMatch(/the impossible is possible/i);
      expect(text).not.toMatch(/pretend to be/i);
      expect(text).not.toMatch(/short seller persona/i);
    }
  });

  it('B2 stays an OFFER — the bullet pairs "never silently expand it" with the one-line suggestion, never a substitution (map §6.3)', () => {
    const p = systemPrompt(makeInput(), 'repo', 'mem', '', 'clock');
    expect(p).toContain('never silently expand it');
    expect(p).toContain('as a suggestion with the concrete next command, and leave it to the owner');
  });
});
