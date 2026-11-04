/**
 * audit 2026-10-06 T7-3 / T7-4 — deliverable hand-off: the diff base is the
 * ref the worktree branched from (origin/<base>), and the task card carries
 * the run's real spend, plan progress and current title.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { gitPathClasses, handoffTitle, runDeliverableHandoff, type HandoffDeps, type HandoffInput, type HandoffChat } from './deliverable-handoff';

const KS = ['DELIVERABLE_ORIGIN_BASE_DISABLED', 'HANDOFF_CARD_FACTS_DISABLED'];
beforeEach(() => { for (const k of KS) delete process.env[k]; });
afterAll(() => { for (const k of KS) delete process.env[k]; });

function g(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir() },
  });
}

describe('T7-3 — gitPathClasses diffs against origin/<base>, not the mirror\'s stale local base', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 't7-handoff-'));
    g(dir, ['init', '-q', '-b', 'main']);
    await fs.writeFile(path.join(dir, 'README.md'), 'r\n');
    g(dir, ['add', '-A']); g(dir, ['commit', '-q', '-m', 'c1']);
    // Two commits LAND ON ORIGIN after the mirror was cloned: origin/main moves, local main stays at c1.
    await fs.mkdir(path.join(dir, 'docs'));
    await fs.writeFile(path.join(dir, 'docs', 'OLD_INCIDENT.md'), 'old\n');
    g(dir, ['add', '-A']); g(dir, ['commit', '-q', '-m', 'c2']);
    await fs.writeFile(path.join(dir, 'docs', 'RELEASE_NOTES.md'), 'rel\n');
    g(dir, ['add', '-A']); g(dir, ['commit', '-q', '-m', 'c3']);
    const c3 = g(dir, ['rev-parse', 'HEAD']).trim();
    g(dir, ['update-ref', 'refs/remotes/origin/main', c3]);
    // The session branch is cut from origin/main and the run writes ONE new doc.
    g(dir, ['checkout', '-q', '-b', 'digby/session-x', 'origin/main']);
    g(dir, ['branch', '-f', 'main', `${c3}~2`]); // the mirror's local main stays stale at c1
    await fs.writeFile(path.join(dir, 'docs', 'INCIDENT_S4.md'), 'new\n');
    g(dir, ['add', '-A']); g(dir, ['commit', '-q', '-m', 'run work']);
  });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined); });

  it('only the run\'s own file is changed; origin-landed files are unchanged + pre-existing', async () => {
    const c = await gitPathClasses(dir, 'main');
    expect(c?.baseRef).toBe('origin/main');
    expect(c!.unchanged.has('docs/OLD_INCIDENT.md')).toBe(true);
    expect(c!.unchanged.has('docs/RELEASE_NOTES.md')).toBe(true);
    expect(c!.unchanged.has('docs/INCIDENT_S4.md')).toBe(false);
    expect(c!.preexisting.has('docs/RELEASE_NOTES.md')).toBe(true);
    expect(c!.preexisting.has('docs/INCIDENT_S4.md')).toBe(false);
  });

  it('DELIVERABLE_ORIGIN_BASE_DISABLED=1 restores the local-base diff (the stale files read as changed)', async () => {
    process.env.DELIVERABLE_ORIGIN_BASE_DISABLED = '1';
    const c = await gitPathClasses(dir, 'main');
    expect(c?.baseRef).toBe('main');
    expect(c!.unchanged.has('docs/OLD_INCIDENT.md')).toBe(false);
  });

  it('no origin/<base> (a local-provider mirror) falls back to the bare base name', async () => {
    const c = await gitPathClasses(dir, 'digby/session-x');
    expect(c?.baseRef).toBe('digby/session-x');
  });
});

describe('T7-4 — the task card carries spend, plan progress and the current title', () => {
  const SESSION = 'sess-0001'; const PARENT = 'parent-0001'; const USER = 'u1';
  const mkDeps = (chatTitle: string) => {
    const events: any[] = []; const messages: any[] = [];
    const chats = new Map<string, HandoffChat>([
      [SESSION, { id: SESSION, userId: USER, parentChatId: PARENT, title: chatTitle }],
      [PARENT, { id: PARENT, userId: USER, parentChatId: null, title: 'Paul' }],
    ]);
    const deps: HandoffDeps = {
      findChat: async (id) => chats.get(id) ?? null,
      countCompletedRuns: async () => 1,
      getRunReceipts: async () => [],
      listWorktree: async () => [],
      gitClasses: async () => null,
      readFile: async () => null,
      listCanvases: async () => [],
      copyCanvas: async () => null,
      persistFiles: async () => undefined,
      findChatFiles: async () => [],
      appendMessage: async (chatId, content, metadata) => { messages.push({ chatId, content, metadata }); return { id: `m${messages.length}` }; },
      claim: async () => true,
      releaseClaim: async () => undefined,
      saveRecord: async () => undefined,
      emitTask: (_c, payload) => { events.push(payload); },
      persistTaskCard: async () => null,
      recordMetric: () => undefined,
    } as HandoffDeps;
    return { deps, events, messages };
  };
  const input = (over: Partial<HandoffInput> = {}): HandoffInput => ({
    runId: 'r1', sessionId: SESSION, userId: USER, worktreeRoot: null, baseBranch: 'main',
    runStartedAt: new Date('2026-10-05T23:52:00Z'), finalText: 'Power-cycled S4 via Hue and wrote the incident doc.',
    sessionTitle: 'New chat', triggerKind: 'user', now: new Date('2026-10-06T00:47:00Z'), ...over,
  });

  it('real spend + steps; the fresh chat title beats the run-start "New chat" placeholder', async () => {
    const w = mkDeps('S4 incident watchdog');
    const r = await runDeliverableHandoff(input({ spendUsd: 3.07, loadSteps: async () => ({ done: 5, total: 5 }) }), w.deps);
    expect(r.posted).toBe(true);
    expect(w.events[0]).toMatchObject({ title: 'S4 incident watchdog', steps: { done: 5, total: 5 }, spendUsd: 3.07 });
    expect(w.messages[0].content).not.toContain('New chat');
  });

  it('both titles placeholders ⇒ "Task", never "New chat"', () => {
    expect(handoffTitle('New chat', 'New Chat')).toBe('Task');
    expect(handoffTitle('Build cql-agent', 'New chat')).toBe('Build cql-agent');
    expect(handoffTitle('New chat', 'Build cql-agent')).toBe('Build cql-agent');
    expect(handoffTitle('Explicit spawn title', 'Something else')).toBe('Explicit spawn title'); // pre-T7-4 precedence kept
  });

  it('HANDOFF_CARD_FACTS_DISABLED=1 restores steps 0/0 and the run-start title', async () => {
    process.env.HANDOFF_CARD_FACTS_DISABLED = '1';
    const w = mkDeps('S4 incident watchdog');
    await runDeliverableHandoff(input({ spendUsd: 3.07, steps: { done: 5, total: 5 } }), w.deps);
    expect(w.events[0]).toMatchObject({ title: 'New chat', steps: { done: 0, total: 0 } });
  });
});
