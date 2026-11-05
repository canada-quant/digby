/**
 * Project learnings & decisions → chat knowledge block (owner 2026-09-14).
 *
 * Boundary suite — the unified store is mocked at its GATED entry point
 * (memSearchProjectsBlended). Pins:
 *   - retrieveProjectLearnings hands the gated search the CALLER's id + the full
 *     folder chain (self first, deduped), k=4, sources learning+decision; asks
 *     for the owned-project blend ONLY when the blend key is the caller;
 *     fail-soft on error + soft deadline;
 *   - buildProjectLearningsSubBlock: '- (<source> · <ref>) <excerpt ≤300>' lines,
 *     '' when empty, 'from project "…"' / 'other project' marker for blended hits;
 *   - buildChatQueryContext wiring: the sub-block lands INSIDE the project
 *     knowledge block when there are authorized hits, is absent when the store
 *     is empty.
 *
 * The per-user DROP itself (a foreign project id never reaching SQL) is pinned
 * end-to-end through the REAL gate in chat-context.project-learnings.gated.test.ts.
 *
 * Mocking mirrors chat-context.test.ts (leaf modules mocked; datetime /
 * followup-enrichment / chat-uploads-block / integration-status-cache real).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const mockRedis = { get: jest.fn(), setEx: jest.fn(), del: jest.fn() };
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockPrisma: any = {
  crossModelChat: { findUnique: jest.fn() },
  projectDocument: { count: jest.fn() },
  // ownsAllProjects (blend precondition, EOD review 2026-09-14): the caller owns the project by default here.
  crossModelProject: { count: jest.fn(async () => 1) },
  chatFile: { findMany: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../context.service', () => ({
  __esModule: true,
  default: { loadChatContext: jest.fn(), loadSessionContext: jest.fn() },
}));
const mockBuildContextBlock = jest.fn();
jest.mock('../rag.service', () => ({
  retrieveChunks: jest.fn(async () => []),
  retrieveGlobalChunks: jest.fn(async () => []),
  buildContextBlock: (...a: any[]) => mockBuildContextBlock(...a),
  buildCrossProjectBlock: jest.fn(() => ''),
}));
jest.mock('../platform/folder-inheritance', () => ({
  foldersInheritanceOn: () => true,
  getEffectiveSystemPrompt: jest.fn(async () => null),
  getRagScopeFolderIds: jest.fn(),
}));
jest.mock('../langgraph/memory.graph', () => ({
  getEnrichedContext: jest.fn(),
  getProjectSettings: jest.fn(),
}));
jest.mock('../memory/unified-memory.service', () => ({
  memSearchProjectsBlended: jest.fn(),
  memSearch: jest.fn(), // ungated — must never be reached from chat-context
}));
// PE-12: the soft-deadline timing row (dynamic import inside chat-context).
const mockMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockMetric(...a),
  LOOP_METRIC_KINDS: { MEMORY_SEARCH_TIMING: 'memory_search_timing' },
}));

import {
  retrieveProjectLearnings,
  buildProjectLearningsSubBlock,
  buildChatQueryContext,
  projectLearningsTimeoutMs,
  PROJECT_LEARNINGS_DEFAULT_TIMEOUT_MS,
  PROJECT_LEARNINGS_HEADER,
  type ProjectLearningsHit,
} from './chat-context';
import { memSearch, memSearchProjectsBlended, type MemBlendedHit } from '../memory/unified-memory.service';
import { getRagScopeFolderIds } from '../platform/folder-inheritance';
import { getEnrichedContext, getProjectSettings } from '../langgraph/memory.graph';
import logger from '../../../utils/logger';

const mockGated = memSearchProjectsBlended as jest.Mock;
const mockUngated = memSearch as jest.Mock;
const mockRagScope = getRagScopeFolderIds as jest.Mock;
const mockEnriched = getEnrichedContext as jest.Mock;
const mockSettings = getProjectSettings as jest.Mock;

const hit = (over: Partial<MemBlendedHit> = {}): MemBlendedHit => ({
  ref: 'abc123hash',
  title: '',
  source: 'learning',
  content: 'Always run prisma generate after schema edits; CI caches the client.',
  scopeType: 'project',
  scopeId: 'P',
  createdAt: '2026-09-10T00:00:00Z',
  projectId: 'P',
  projectName: null,
  crossProject: false,
  ...over,
});

const SOURCES = ['learning', 'decision'];

beforeEach(() => {
  jest.clearAllMocks();
  mockGated.mockResolvedValue([]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// retrieveProjectLearnings — gated entry point, blend flag, fail-soft
// ═══════════════════════════════════════════════════════════════════════════════

describe('retrieveProjectLearnings', () => {
  it('routes through the GATED store read with the caller\'s id + the whole folder chain (self first, deduped), k=4, learning+decision', async () => {
    mockGated.mockResolvedValue([hit()]);
    const out = await retrieveProjectLearnings({
      userId: 'alice', projectId: 'P', ragScopeIds: ['R', 'P', 'F'], message: 'how do we run migrations?',
    });
    expect(out).toEqual([hit()]);
    expect(mockGated).toHaveBeenCalledTimes(1);
    expect(mockGated).toHaveBeenCalledWith('alice', ['P', 'R', 'F'], 'how do we run migrations?', 4, {
      sources: SOURCES, blendOwned: false, ownedCap: 40, deadlineMs: expect.any(Number), purpose: 'project_learnings', excludeUserSpace: true,
    });
    // The ungated primitive is never what chat-context calls.
    expect(mockUngated).not.toHaveBeenCalled();
  });

  it('asks for the OWNED-project blend only when the blend key is the caller (crossProjectMemory on)', async () => {
    await retrieveProjectLearnings({ userId: 'alice', projectId: 'P', ragScopeIds: ['R', 'P'], blendUserId: 'alice', message: 'deploy conventions' });
    expect(mockGated.mock.calls[0][4]).toEqual({ sources: SOURCES, blendOwned: true, ownedCap: 40, deadlineMs: expect.any(Number), purpose: 'project_learnings', excludeUserSpace: true }); // time-boxed search (2026-09-23)
  });

  it('does NOT blend when crossProjectMemory is off (no blend key)', async () => {
    await retrieveProjectLearnings({ userId: 'alice', projectId: 'P', ragScopeIds: ['P'], message: 'x' });
    expect(mockGated.mock.calls[0][4].blendOwned).toBe(false);
  });

  it('REFUSES a blend key naming another user — never another user\'s projects', async () => {
    await retrieveProjectLearnings({ userId: 'alice', projectId: 'P', ragScopeIds: ['P'], blendUserId: 'bob', message: 'x' });
    expect(mockGated.mock.calls[0][0]).toBe('alice');
    expect(mockGated.mock.calls[0][4].blendOwned).toBe(false);
  });

  it('returns [] for a missing user / project / blank message without touching the store', async () => {
    expect(await retrieveProjectLearnings({ userId: '', projectId: 'P', ragScopeIds: [], message: 'x' })).toEqual([]);
    expect(await retrieveProjectLearnings({ userId: 'alice', projectId: '', ragScopeIds: [], message: 'x' })).toEqual([]);
    expect(await retrieveProjectLearnings({ userId: 'alice', projectId: 'P', ragScopeIds: [], message: '   ' })).toEqual([]);
    expect(mockGated).not.toHaveBeenCalled();
  });

  it('degrades to [] (with a warning) when the store throws — never the request', async () => {
    mockGated.mockRejectedValue(new Error('embed 500'));
    expect(await retrieveProjectLearnings({ userId: 'alice', projectId: 'P', ragScopeIds: ['P'], message: 'x' })).toEqual([]);
    expect((logger.warn as jest.Mock).mock.calls.some((c) => String(c[0]).includes('project learnings failed'))).toBe(true);
  });

  // PE-12 (2026-09-28): the deadline is an expected degradation — info + a
  // memory_search_timing row with phase 'deadline', never a warn.
  it('returns [] when the soft deadline passes before the store answers — logged at INFO with a timing row (phase deadline)', async () => {
    mockGated.mockImplementation(() => new Promise(() => { /* never resolves */ }));
    const out = await retrieveProjectLearnings({ userId: 'alice', projectId: 'P', ragScopeIds: ['P'], message: 'x', timeoutMs: 5, machine: true });
    expect(out).toEqual([]);
    expect((logger.warn as jest.Mock).mock.calls.some((c) => String(c[0]).includes('soft deadline'))).toBe(false);
    expect((logger.info as jest.Mock).mock.calls.some((c) => String(c[0]).includes('soft deadline 5ms hit for project P'))).toBe(true);
    await new Promise((r) => setTimeout(r, 10)); // the row is fire-and-forget (dynamic import)
    expect(mockMetric).toHaveBeenCalledWith({
      kind: 'memory_search_timing',
      value: 5,
      meta: { purpose: 'project_learnings', phase: 'deadline', deadlineMs: 5, projectId: 'P', machine: true },
    });
  });

  it('the user-turn deadline defaults to 10 s and PROJECT_LEARNINGS_TIMEOUT_MS overrides it (floor 1000; junk → default)', async () => {
    expect(projectLearningsTimeoutMs()).toBe(PROJECT_LEARNINGS_DEFAULT_TIMEOUT_MS);
    expect(PROJECT_LEARNINGS_DEFAULT_TIMEOUT_MS).toBe(10_000);
    process.env.PROJECT_LEARNINGS_TIMEOUT_MS = '8000';
    expect(projectLearningsTimeoutMs()).toBe(8000);
    process.env.PROJECT_LEARNINGS_TIMEOUT_MS = '10';
    expect(projectLearningsTimeoutMs()).toBe(PROJECT_LEARNINGS_DEFAULT_TIMEOUT_MS);
    process.env.PROJECT_LEARNINGS_TIMEOUT_MS = 'soon';
    expect(projectLearningsTimeoutMs()).toBe(PROJECT_LEARNINGS_DEFAULT_TIMEOUT_MS);
    // the search's own time-box follows the effective deadline
    process.env.PROJECT_LEARNINGS_TIMEOUT_MS = '7000';
    mockGated.mockResolvedValue([]);
    await retrieveProjectLearnings({ userId: 'alice', projectId: 'P', ragScopeIds: ['P'], message: 'x' });
    expect(mockGated.mock.calls[0][4].deadlineMs).toBe(6750);
    delete process.env.PROJECT_LEARNINGS_TIMEOUT_MS;
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildProjectLearningsSubBlock — rendering
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildProjectLearningsSubBlock', () => {
  it('renders nothing for no hits (knowledge block stays byte-identical)', () => {
    expect(buildProjectLearningsSubBlock([])).toBe('');
    expect(buildProjectLearningsSubBlock(undefined as any)).toBe('');
  });

  it('renders the header + one "- (<source> · <ref>) <excerpt>" line per hit; learning refs show learnings.md', () => {
    const block = buildProjectLearningsSubBlock([
      hit(),
      hit({ source: 'decision', ref: 'decisions/2026-09-01', content: 'Use RDS Postgres; the local container is retired.' }),
    ], ['P']);
    const lines = block.split('\n');
    expect(lines[0]).toBe(`[${PROJECT_LEARNINGS_HEADER} — 2 durable notes from this project's coding memory]`);
    expect(lines[1]).toMatch(/^\(Background only — use ONLY when directly relevant/);
    expect(lines[2]).toBe('- (learning · learnings.md) Always run prisma generate after schema edits; CI caches the client.');
    expect(lines[3]).toBe('- (decision · decisions/2026-09-01) Use RDS Postgres; the local container is retired.');
    expect(lines).toHaveLength(4);
  });

  it('caps each excerpt at 300 chars (ellipsis) and collapses whitespace', () => {
    const long = 'word '.repeat(120); // 600 chars
    const block = buildProjectLearningsSubBlock([hit({ content: `  line one\n\n  ${long}` })]);
    const line = block.split('\n')[2];
    const excerpt = line.replace('- (learning · learnings.md) ', '');
    expect(excerpt.length).toBeLessThanOrEqual(300);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt).not.toMatch(/\s{2,}|\n/);
  });

  it('prefixes a title when the content does not already start with it', () => {
    const block = buildProjectLearningsSubBlock([hit({ source: 'decision', ref: 'd1', title: 'DB choice', content: 'RDS over local.' })]);
    expect(block.split('\n')[2]).toBe('- (decision · d1) DB choice — RDS over local.');
    const dup = buildProjectLearningsSubBlock([hit({ source: 'decision', ref: 'd1', title: 'DB choice', content: 'DB choice: RDS over local.' })]);
    expect(dup.split('\n')[2]).toBe('- (decision · d1) DB choice: RDS over local.');
  });

  it('labels blended hits with their project name and strips the store\'s "[Name]" title prefix (no double label)', () => {
    const block = buildProjectLearningsSubBlock([
      hit({ scopeId: 'P' }),
      hit({ scopeId: 'O1', projectId: 'O1', projectName: 'Other Repo', crossProject: true, title: '[Other Repo] pnpm', content: 'Other repo uses pnpm.' }),
    ], ['P', 'R']);
    const lines = block.split('\n');
    expect(lines[2]).toMatch(/^- \(learning · learnings\.md\) /);
    expect(lines[3]).toBe('- (learning · learnings.md · from project "Other Repo") pnpm — Other repo uses pnpm.');
  });

  it('falls back to "other project" when the name is unknown, and to the in-scope list for a plain (un-blended) hit', () => {
    const unnamed = buildProjectLearningsSubBlock([hit({ scopeId: 'O1', projectId: 'O1', projectName: null, crossProject: true, title: '[another project]', content: 'Uses pnpm.' })], ['P']);
    expect(unnamed.split('\n')[2]).toBe('- (learning · learnings.md · other project) Uses pnpm.');

    const plain: ProjectLearningsHit = { ref: 'h', title: '', source: 'learning', content: 'Uses pnpm.', scopeType: 'project', scopeId: 'O1', createdAt: 'x' };
    expect(buildProjectLearningsSubBlock([plain], ['P', 'R']).split('\n')[2]).toBe('- (learning · learnings.md · other project) Uses pnpm.');
    expect(buildProjectLearningsSubBlock([{ ...plain, scopeId: 'P' }], ['P', 'R']).split('\n')[2]).toBe('- (learning · learnings.md) Uses pnpm.');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildChatQueryContext wiring — the sub-block inside the project knowledge block
// ═══════════════════════════════════════════════════════════════════════════════

function primeProjectChat() {
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({
    projectId: 'P',
    systemPrompt: null,
    project: { id: 'P', name: 'Digby', systemPrompt: null },
  });
  mockRagScope.mockResolvedValue(['R', 'P']);
  mockSettings.mockResolvedValue({ crossProjectMemory: false });
  mockEnriched.mockResolvedValue({
    conversationHistory: [{ role: 'user', content: 'earlier' }],
    userMemoryBlock: '',
    projectStateBlock: '',
  });
  mockPrisma.projectDocument.count.mockResolvedValue(0);
  mockPrisma.chatFile.findMany.mockResolvedValue([]);
  mockRedis.get.mockResolvedValue('[INTEGRATIONS]\ncached\n[/INTEGRATIONS]');
  // Mimic the real block shape: the trailing free-text slot lands before the closing rule.
  mockBuildContextBlock.mockImplementation((name: string, _p: any, _c: any[], extra?: string) =>
    `═══ PROJECT: ${name} ═══${extra ? `\n\n${extra}` : ''}\n═══════════════════════`);
}

const run = () => buildChatQueryContext({ userId: 'alice', chatId: 'chat1', message: 'how do we run migrations?', mode: 'thinking', modelSet: 'open_source' });

describe('buildChatQueryContext — [PROJECT LEARNINGS & DECISIONS] wiring', () => {
  beforeEach(primeProjectChat);

  it('appends the sub-block INSIDE the project knowledge block when there are authorized hits', async () => {
    mockGated.mockResolvedValue([hit()]);
    const ctx = await run();
    // The gated read got the caller + the folder chain (self first) with the RAG blend setting (off here).
    expect(mockGated).toHaveBeenCalledWith('alice', ['P', 'R'], 'how do we run migrations?', 4, { sources: SOURCES, blendOwned: false, ownedCap: 40, deadlineMs: expect.any(Number), purpose: 'project_learnings', excludeUserSpace: true });
    expect(mockUngated).not.toHaveBeenCalled();
    // The rendered sub-block is handed to buildContextBlock's trailing slot …
    const extra = mockBuildContextBlock.mock.calls[0][3];
    expect(extra).toContain(`[${PROJECT_LEARNINGS_HEADER} — 1 durable note`);
    expect(extra).toContain('- (learning · learnings.md) Always run prisma generate');
    // … and lands in the system context inside the PROJECT block, before its closing rule.
    const start = ctx.systemContext.indexOf('═══ PROJECT: Digby ═══');
    const sub = ctx.systemContext.indexOf(`[${PROJECT_LEARNINGS_HEADER}`);
    const close = ctx.systemContext.indexOf('═══════════════════════', start);
    expect(start).toBeGreaterThan(-1);
    expect(sub).toBeGreaterThan(start);
    expect(close).toBeGreaterThan(sub);
    expect(ctx.retrievedSources).toEqual([]); // RAG arm untouched (no docs)
  });

  it('is ABSENT when the store returns nothing (trailing slot stays undefined — byte-identical block)', async () => {
    mockGated.mockResolvedValue([]);
    const ctx = await run();
    expect(mockGated).toHaveBeenCalledTimes(1);
    expect(mockBuildContextBlock.mock.calls[0][3]).toBeUndefined();
    expect(ctx.systemContext).not.toContain(PROJECT_LEARNINGS_HEADER);
  });

  it('passes the folder chain the RAG arm resolved (a foreign id in it reaches the GATE, never the store directly)', async () => {
    mockRagScope.mockResolvedValue(['F', 'P']);
    mockGated.mockResolvedValue([hit()]);
    await run();
    expect(mockGated.mock.calls[0][1]).toEqual(['P', 'F']);
    expect(mockUngated).not.toHaveBeenCalled();
  });

  it('requests the OWNED-project blend only when the project setting crossProjectMemory is on, and labels the blended hit', async () => {
    mockSettings.mockResolvedValue({ crossProjectMemory: true });
    mockGated.mockResolvedValue([hit({ scopeId: 'O1', projectId: 'O1', projectName: 'Other Repo', crossProject: true, title: '[Other Repo]', content: 'Other repo uses pnpm.' })]);
    await run();
    expect(mockGated.mock.calls[0][4]).toEqual({ sources: SOURCES, blendOwned: true, ownedCap: 40, deadlineMs: expect.any(Number), purpose: 'project_learnings', excludeUserSpace: true }); // time-boxed search (2026-09-23)
    expect(mockBuildContextBlock.mock.calls[0][3]).toContain('- (learning · learnings.md · from project "Other Repo") Other repo uses pnpm.');
  });

  it('a store failure degrades recall only — the chat context still builds', async () => {
    mockGated.mockRejectedValue(new Error('digby_memory unreachable'));
    const ctx = await run();
    expect(ctx.systemContext).toContain('═══ PROJECT: Digby ═══');
    expect(ctx.systemContext).not.toContain(PROJECT_LEARNINGS_HEADER);
    expect(mockBuildContextBlock.mock.calls[0][3]).toBeUndefined();
  });

  // ── PE-12 (2026-09-28): EARLY START — the lookup overlaps the enriched-context load ──
  const deferredEnriched = () => {
    let release!: () => void;
    mockEnriched.mockImplementation(() => new Promise((res) => {
      release = () => res({ conversationHistory: [{ role: 'user', content: 'earlier' }], userMemoryBlock: '', projectStateBlock: '' });
    }));
    return () => release();
  };
  const settle = () => new Promise((r) => setTimeout(r, 15));

  it('EARLY START: the gated learnings read (and ONE scope read) starts while the enriched-context load is still pending', async () => {
    const release = deferredEnriched();
    mockGated.mockResolvedValue([hit()]);
    const pending = run();
    await settle();
    expect(mockEnriched).toHaveBeenCalledTimes(1);
    expect(mockGated).toHaveBeenCalledTimes(1); // already running — 1b has not resolved
    expect(mockGated).toHaveBeenCalledWith('alice', ['P', 'R'], 'how do we run migrations?', 4, expect.objectContaining({ purpose: 'project_learnings', blendOwned: false }));
    release();
    const ctx = await pending;
    expect(mockGated).toHaveBeenCalledTimes(1);   // the RAG section reused the promise — no second read
    expect(mockRagScope).toHaveBeenCalledTimes(1); // one scope resolution shared by both arms
    expect(mockSettings).toHaveBeenCalledTimes(1);
    expect(ctx.systemContext).toContain(`[${PROJECT_LEARNINGS_HEADER} — 1 durable note`);
    expect(ctx.conversationHistory).toEqual([{ role: 'user', content: 'earlier' }]);
  });

  it('EARLY START honours the blend key exactly as the RAG section does (crossProjectMemory on + owner ⇒ blendOwned)', async () => {
    mockSettings.mockResolvedValue({ crossProjectMemory: true });
    mockGated.mockResolvedValue([]);
    await run();
    expect(mockGated).toHaveBeenCalledTimes(1);
    expect(mockGated.mock.calls[0][4]).toEqual(expect.objectContaining({ blendOwned: true }));
  });

  it('EARLY START: a scope-resolution failure is swallowed by the early arm and handled by the RAG section (context still builds, no unhandled rejection)', async () => {
    mockRagScope.mockRejectedValue(new Error('folder chain unavailable'));
    mockGated.mockResolvedValue([hit()]);
    const ctx = await run();
    expect(mockGated).not.toHaveBeenCalled();
    expect(ctx.systemContext).not.toContain(PROJECT_LEARNINGS_HEADER);
  });

  // 2026-09-19 audit: the composed machine-wake message (freshness preamble +
  // supervisor state + board digest, 13–22k chars) was what every retrieval
  // leg embedded and reranked — 27 s on a live wake, so the learnings lookup's
  // 6 s deadline tripped on ~50% of machine turns. `retrievalMessage` (the
  // pre-preamble event text) now drives the retrieval legs; `message` still
  // drives the prompt and the returned queryMessage.
  it('retrievalMessage (machine wakes: the pre-preamble text) drives the learnings, RAG and memory-relevance legs — `message` keeps the prompt', async () => {
    mockGated.mockResolvedValue([]);
    mockPrisma.projectDocument.count.mockResolvedValue(1);
    const composed = `[MACHINE-TRIGGERED RUN — no user is on this turn…]\n${'boilerplate '.repeat(1200)}\nHOOK run_completed: node-a gpqa-40 row truncated`;
    const original = 'HOOK run_completed: node-a gpqa-40 row truncated';
    const ctx = await buildChatQueryContext({ userId: 'alice', chatId: 'chat1', message: composed, retrievalMessage: original, mode: 'thinking', modelSet: 'open_source', machineWake: true });
    expect(mockGated.mock.calls[0][2]).toBe(original);
    const { retrieveChunks } = jest.requireMock('../rag.service');
    expect((retrieveChunks as jest.Mock).mock.calls[0][0]).toBe(original);
    expect(mockEnriched.mock.calls[0][0]).toMatchObject({ userMessage: original, deepHistory: true });
    expect(ctx.queryMessage).toBe(composed);
  });

  it('without retrievalMessage every leg embeds `message` itself (user turns — unchanged)', async () => {
    mockGated.mockResolvedValue([]);
    await run();
    expect(mockGated.mock.calls[0][2]).toBe('how do we run migrations?');
    expect(mockEnriched.mock.calls[0][0]).toMatchObject({ userMessage: 'how do we run migrations?' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2026-10-20 real-user audit — a plain chat in the hidden user space keeps its own memory
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildChatQueryContext — a plain user-space chat reads no project memory (userSpaceChatIsolated)', () => {
  const primeUserSpace = (isUserSpace: boolean, crossProjectMemory = false) => {
    primeProjectChat();
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({
      projectId: 'U', systemPrompt: null, project: { id: 'U', name: 'Workspace', systemPrompt: null, isUserSpace },
    });
    mockRagScope.mockResolvedValue(['U']);
    mockSettings.mockResolvedValue({ crossProjectMemory });
    mockEnriched.mockResolvedValue({ conversationHistory: [{ role: 'user', content: 'earlier' }], userMemoryBlock: '', projectStateBlock: '' });
    mockGated.mockResolvedValue([hit({ source: 'decision', ref: 'd1', scopeId: 'U', projectId: 'U', content: 'Logo brief: Happy Tails dog walking, teal + orange.' })]);
  };
  const runAs = (isSupervisorChat?: boolean) => buildChatQueryContext({ userId: 'alice', chatId: 'chat1', message: 'make me a logo', mode: 'thinking', modelSet: 'open_source', ...(isSupervisorChat ? { isSupervisorChat } : {}) });
  afterEach(() => { delete process.env.USER_SPACE_CHAT_ISOLATION_DISABLED; });

  it('the user space, blend off: no learnings lookup at all, the shared project state is not loaded, the flag rides the context', async () => {
    primeUserSpace(true);
    const ctx = await runAs();
    expect(mockGated).not.toHaveBeenCalled();
    expect(mockEnriched.mock.calls[0][0]).toMatchObject({ projectId: 'U', skipProjectState: true });
    expect(ctx.systemContext).not.toContain(PROJECT_LEARNINGS_HEADER);
    expect(ctx.systemContext).not.toContain('Happy Tails');
    expect(ctx.projectMemoryIsolated).toBe(true);
    expect(ctx.projectId).toBe('U'); // still filed there — the user's uploaded files (RAG) stay reachable
  });

  it('the user space, blend on: only the user\'s REAL owned projects are searched (no primary scope, the space excluded), labelled by project', async () => {
    primeUserSpace(true, true);
    mockGated.mockResolvedValue([hit({ scopeId: 'O1', projectId: 'O1', projectName: 'Bakery', crossProject: true, title: '[Bakery]', content: 'Brand colours are warm browns.' })]);
    const ctx = await runAs();
    expect(mockGated).toHaveBeenCalledTimes(1);
    expect(mockGated.mock.calls[0][1]).toEqual([]);
    expect(mockGated.mock.calls[0][4]).toMatchObject({ blendOwned: true, excludeUserSpace: true });
    expect(ctx.systemContext).toContain('from project "Bakery"');
    expect(ctx.systemContext).toContain("from your other projects' coding memory]"); // every hit foreign — the header says so
    expect(ctx.projectMemoryIsolated).toBe(true);
  });

  it('a real project, a supervisor chat, and the kill switch keep the shared memory', async () => {
    primeUserSpace(false);
    expect((await runAs()).projectMemoryIsolated).toBe(false);
    expect(mockGated.mock.calls[0][1]).toEqual(['U']);
    expect(mockEnriched.mock.calls[0][0].skipProjectState).toBeUndefined();

    jest.clearAllMocks(); primeUserSpace(true);
    expect((await runAs(true)).projectMemoryIsolated).toBe(false);
    expect(mockGated.mock.calls[0][1]).toEqual(['U']);

    jest.clearAllMocks(); primeUserSpace(true);
    process.env.USER_SPACE_CHAT_ISOLATION_DISABLED = '1';
    const ctx = await runAs();
    expect(ctx.projectMemoryIsolated).toBe(false);
    expect(mockGated.mock.calls[0][1]).toEqual(['U']);
    expect(mockGated.mock.calls[0][4].excludeUserSpace).toBeUndefined(); // the switch also restores the space in other chats' blend
    expect(ctx.systemContext).toContain('Happy Tails');
  });
});
