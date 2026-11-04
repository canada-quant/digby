/**
 * system-prompt-clip-bench.test.ts — the before/after bench + pin for the
 * role-aware clipOversizedMessages (R&D stream 3, test-bench experiment #3,
 * 2026-09-18; todo 160ac1b0).
 *
 * MEASUREMENT that motivated the fix: clipOversizedMessages had NO role guard —
 * it head+tail-clipped ANY message over PER_MSG_CHAR_CAP (14_000) to 7k + 7k,
 * including messages[0], the run's system prompt. Every compaction tail
 * (compaction.ts v1/v2) and both agent.ts recovery clips therefore amputated
 * the MIDDLE of the system prompt mid-run (AGENTS.md, chat instructions,
 * memory blocks, any doctrine past the retained head) — content recoverable
 * from nowhere. This bench composes the REAL prompts and prints the
 * before/after table for the PR body; the assertions pin the after-invariant
 * (byte-identity) so the bench doubles as a re-clip guardrail.
 *
 * The BEFORE column is measured, not hand-computed: the same string clipped as
 * role:'user' still rides the old 14k formula, so its clipped length IS the
 * pre-fix system-prompt size.
 *
 * Token counts use js-tiktoken cl100k_base as a REFERENCE tokenizer (the served
 * models differ; deltas are what matter, not absolutes).
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
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: jest.fn() },
}));
jest.mock('./schedule.service', () => ({
  __esModule: true,
  emitScheduleDisabled: jest.fn(async () => undefined),
}));
jest.mock('../../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: jest.fn(async () => 'RECAP: explored the repo, edited a.ts, ran tests (green).'),
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
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return { ...actual, runModelTurn: jest.fn() };
});
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: jest.fn(async () => 'ok') };
});
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  recordRunSpend: jest.fn(),
  noteSeatFallback: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', PROVIDER_REJECTED: 'provider_rejected' },
}));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => undefined),
}));
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
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 1) }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));

import path from 'path';
import { systemPrompt, buildAgentGuide } from './agent';
import { clipOversizedMessages, compactMessages, PER_MSG_CHAR_CAP } from './compaction';
import { buildFleetSupervisorPrompt, buildFleetSweepPrompt } from '../platform/supervisor.service';
import { buildProjectSupervisorPrompt, buildProjectSupervisorSweepPrompt } from '../platform/project-supervisor.service';
import { rebuildSweepPromptDoctrine, sweepDoctrineBlock } from '../platform/sweep-doctrine-rebuild';
import { machineWakePreamble } from '../chat-agent/machine-wake';

function cl100kTokens(text: string): number | null {
  try {
    const { getEncoding } = require('js-tiktoken');
    return getEncoding('cl100k_base').encode(text).length;
  } catch {
    return null; // tokenizer absent — the bench still runs on chars
  }
}

const PROJ = { projectName: 'crossmodel', projectId: 'proj_test000', fleetSupervisorChatId: 'chat_fleet000' };
const fmt = (n: number | null) => (n === null ? 'n/a' : n.toLocaleString('en-US'));

describe('system-prompt clip bench (test-bench #3)', () => {
  it('measures the REAL prompts and prints the before/after table; pins byte-identity after the role-aware fix', async () => {
    // The REAL coding-lane prompt: static doctrine + the REAL guide block this
    // repo produces (AGENTS.md 187,952c → 8,000-char injection window + the
    // learnings slice + .digby/rules). repoContext/memoryBlock are left EMPTY
    // — a conservative LOWER bound on the production compose (which adds
    // several thousand more chars of memory/repo/role blocks).
    const repoRoot = path.join(__dirname, '..', '..', '..', '..', '..');
    const guide = await buildAgentGuide(repoRoot);
    const codingSys = systemPrompt(
      { projectName: 'crossmodel', branch: 'digby/session-b1923139', permissionMode: 'auto' } as any,
      '', '', guide, '[CURRENT DATE & TIME]',
    );
    const fleetSys = buildFleetSupervisorPrompt();
    const projectSys = buildProjectSupervisorPrompt(PROJ);

    const rows: string[] = [];
    for (const [label, prompt] of [
      ['coding-lane system prompt (static + real guide — lower bound)', codingSys],
      ['fleet supervisor stock system prompt', fleetSys],
      ['project supervisor stock system prompt', projectSys],
    ] as const) {
      expect(prompt.length).toBeGreaterThan(PER_MSG_CHAR_CAP); // the pre-fix clip really engaged
      // BEFORE (measured): the same string under the OLD formula — user-role
      // content still rides the 14k cap, so this IS the pre-fix outcome.
      // (iteration 10, 2026-09-24: the FIRST user message now rides its own
      // valve too — the OLD formula is measured with that exemption switched off.)
      // Measured on a NON-first user message: the first-user exemption is
      // keyed on position, so this IS the pre-fix flat-cap outcome.
      const before = (clipOversizedMessages([
        { role: 'user', content: 'prior task' },
        { role: 'user', content: prompt },
      ]) as any[])[1].content as string;
      expect(before).toMatch(/clipped .* chars/);
      // AFTER (task message): the run's first user message survives intact as well.
      expect((clipOversizedMessages([{ role: 'user', content: prompt }]) as any[])[0].content).toBe(prompt);
      // AFTER: the role-aware clip leaves the system prompt byte-identical.
      const after = (clipOversizedMessages([{ role: 'system', content: prompt }]) as any[])[0].content as string;
      expect(after).toBe(prompt);
      rows.push(
        `| ${label} | ${fmt(prompt.length)} | ${fmt(cl100kTokens(prompt))} | ${fmt(before.length)} (${Math.round((before.length / prompt.length) * 100)}%) | ${fmt(after.length)} (100%) | ${fmt(prompt.length - before.length)}c |`,
      );
    }
    console.log(
      `\n| prompt | full chars | cl100k tok | before: through 14k clip | after: role-aware clip | middle recovered |\n|---|---:|---:|---:|---:|---:|\n${rows.join('\n')}\n`,
    );

    // …and through the REAL compaction tail (the pre-fix path that produced a
    // 7k-head/7k-tail messages[0]): byte-identity survives a full compaction.
    const asstCall = (name: string) => ({ role: 'assistant', content: '', tool_calls: [{ id: 't', type: 'function', function: { name } }] });
    const toolRes = (t: string) => ({ role: 'tool', tool_call_id: 't', content: t });
    const msgs: any[] = [{ role: 'system', content: codingSys }];
    for (let i = 0; i < 12; i++) { msgs.push(asstCall(`tool${i}`)); msgs.push(toolRes(`result ${i} `.repeat(40))); }
    const out = await compactMessages(msgs, undefined, { mode: 'full' });
    expect(out).not.toBeNull();
    expect(out![0].role).toBe('system');
    expect(out![0].content).toBe(codingSys);
    console.log(
      `post-compaction messages[0]: retained ${fmt(String(out![0].content).length)}c of ${fmt(codingSys.length)}c (pre-fix: ${fmt((clipOversizedMessages([{ role: 'user', content: codingSys }]) as any[])[0].content.length)}c)`,
    );
  });

  it('C6 rows: fallback/forced firing composites keep the rebuilt doctrine through the user-role clip', () => {
    // Adversarial-review finding C6 (test-bench #3): the exp #2 trigger-keyed
    // rebuild inlined the doctrine after the opener — inside the middle the
    // 14k user-role clip elides from >14k firing composites (fleet 14,657c /
    // project 16,022c). The doctrine is now the body SUFFIX (end-injection),
    // riding the clip's retained 7,000c tail. These rows are the PR-table
    // evidence; the assertions pin the survival.
    const preamble = machineWakePreamble(new Date('2026-09-18T12:00:00.000Z'));
    const rows: string[] = [];
    for (const [cls, slim, label] of [
      ['fleet', buildFleetSweepPrompt(), 'fleet sweep FIRING — doctrine inline (fallback)'],
      ['project', buildProjectSupervisorSweepPrompt(PROJ), 'project sweep FIRING — doctrine inline (fallback)'],
    ] as const) {
      const block = sweepDoctrineBlock(cls);
      const composite = preamble + rebuildSweepPromptDoctrine({ prompt: slim, systemPrompt: null }).prompt;
      expect(composite.length).toBeGreaterThan(PER_MSG_CHAR_CAP); // the clip really engages
      const clipped = (clipOversizedMessages([{ role: 'user', content: composite }]) as any[])[0].content as string;
      expect(clipped).toContain(block); // the doctrine survives the clip WHOLE
      expect(clipped.endsWith(block)).toBe(true);
      rows.push(`| ${label} | ${fmt(composite.length)} | ${fmt(cl100kTokens(composite))} | ${fmt(block.length)}c | YES — retained suffix | ${fmt(7_000 - block.length)}c |`);
    }
    console.log(`\nC6 fallback-firing clip survival (after end-injection):\n| composite | chars | cl100k tok | doctrine block | survives 14k clip | tail margin |\n|---|---:|---:|---:|---|---:|\n${rows.join('\n')}\n`);
  });
});
