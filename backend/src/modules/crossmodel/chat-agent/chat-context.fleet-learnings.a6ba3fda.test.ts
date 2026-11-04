/**
 * Fleet learnings for PROJECTLESS supervisor chats + global-RAG retrieval text
 * (ticket a6ba3fda, 2026-10-17).
 *
 * Boundary suite — the unified store is mocked at its GATED entry point
 * (memSearchProjectsBlended), mirroring chat-context.project-learnings.test.ts.
 * Pins:
 *   - a supervisor chat with projectId NULL (the Fleet Supervisor's shape)
 *     still reads durable L3 memory: retrieveSupervisorLearnings hands the
 *     gated search the CALLER's id, EMPTY primaries + blendOwned (the owned
 *     projects ARE the scope) and the chat's own session+chat scopes as
 *     extraScopes, k=4, sources learning+decision, fail-soft + soft deadline;
 *   - buildFleetLearningsBlock renders the '[FLEET LEARNINGS & DECISIONS]'
 *     block, '' when empty, 'from project "…"' for project hits, no marker
 *     for the supervisor chat's OWN session-scope hits;
 *   - buildChatQueryContext wiring: the block lands in the system context for
 *     a projectless SUPERVISOR chat, and is ABSENT for a projectless plain
 *     chat (byte-identical to before);
 *   - the no-project global-RAG leg embeds retrievalMessage, NOT the composed
 *     machine-wake `message` (the lone holdout — every other leg already did).
 *
 * The per-user DROP itself (an unauthorized scope never reaching SQL) is the
 * real gate's job, pinned in unified-memory's own suites.
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
  crossModelProject: { count: jest.fn(async () => 1), findMany: jest.fn(async () => []) },
  chatFile: { findMany: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../context.service', () => ({
  __esModule: true,
  default: { loadChatContext: jest.fn(), loadSessionContext: jest.fn() },
}));
const mockBuildCrossProjectBlock = jest.fn(() => '');
jest.mock('../rag.service', () => ({
  retrieveChunks: jest.fn(async () => []),
  retrieveGlobalChunks: jest.fn(async () => []),
  buildContextBlock: jest.fn(() => ''),
  buildCrossProjectBlock: (...a: any[]) => mockBuildCrossProjectBlock(...(a as [])),
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
// PE-12-style timing row (dynamic import inside chat-context).
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { MEMORY_SEARCH_TIMING: 'memory_search_timing' },
}));

import {
  retrieveSupervisorLearnings,
  buildFleetLearningsBlock,
  buildChatQueryContext,
  type ProjectLearningsHit,
} from './chat-context';
import { memSearch, memSearchProjectsBlended, type MemBlendedHit } from '../memory/unified-memory.service';
import { getEnrichedContext } from '../langgraph/memory.graph';

const mockGated = memSearchProjectsBlended as jest.Mock;
const mockUngated = memSearch as jest.Mock;
// 2b8508cb: the supervisor-state recall seam reads the chat's own embedded
// doc rows via the SAME memSearch — mock the bridge so this suite's
// "L3 reads are gated" pin stays about the learnings leg only.
jest.mock('../platform/supervisor-state-memory', () => ({
  __esModule: true,
  buildSupervisorStateRecallBlock: jest.fn(async () => ''),
}));
const mockEnriched = getEnrichedContext as jest.Mock;

const SOURCES = ['learning', 'decision'];

const hit = (over: Partial<MemBlendedHit> = {}): MemBlendedHit => ({
  ref: 'abc123hash',
  title: '',
  source: 'learning',
  content: 'Never force-push main; the carrier holds the squash sha.',
  scopeType: 'project',
  scopeId: 'P1',
  createdAt: '2026-10-10T00:00:00Z',
  projectId: 'P1',
  projectName: 'crossmodel',
  crossProject: true,
  ...over,
});

const sessionHit = (over: Partial<MemBlendedHit> = {}): MemBlendedHit => ({
  ...hit({ scopeType: 'session', scopeId: 'chat-supervisor', projectId: '', projectName: null, crossProject: false, source: 'compaction' as any }),
  content: 'Prior wake: QB2 lane parked awaiting reviewer verdict.',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGated.mockResolvedValue([]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// retrieveSupervisorLearnings — the gated blended search with NO primary project
// ═══════════════════════════════════════════════════════════════════════════════

describe('retrieveSupervisorLearnings (ticket a6ba3fda)', () => {
  it('routes through the GATED store read with EMPTY primaries, blendOwned (owned projects = the scope) + the chat\'s own session/chat scopes', async () => {
    mockGated.mockResolvedValue([hit()]);
    const out = await retrieveSupervisorLearnings({ userId: 'alice', chatId: 'chat-supervisor', message: 'sweep the board' });
    expect(mockGated).toHaveBeenCalledWith(
      'alice', [], 'sweep the board', 4,
      {
        sources: SOURCES,
        blendOwned: true,
        ownedCap: 40,
        deadlineMs: expect.any(Number),
        purpose: 'fleet_learnings',
        extraScopes: [{ type: 'session', id: 'chat-supervisor' }, { type: 'chat', id: 'chat-supervisor' }],
      },
    );
    expect(mockUngated).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
  });

  it('returns [] without a userId, chatId or message — never reaches the store', async () => {
    await retrieveSupervisorLearnings({ userId: '', chatId: 'c', message: 'm' });
    await retrieveSupervisorLearnings({ userId: 'u', chatId: '', message: 'm' });
    await retrieveSupervisorLearnings({ userId: 'u', chatId: 'c', message: '   ' });
    expect(mockGated).not.toHaveBeenCalled();
  });

  it('a store failure degrades recall only — [] and no throw', async () => {
    mockGated.mockRejectedValue(new Error('digby_memory unreachable'));
    const out = await retrieveSupervisorLearnings({ userId: 'alice', chatId: 'chat-supervisor', message: 'sweep' });
    expect(out).toEqual([]);
  });

  it('the soft deadline resolves [] (a slow search never hangs the wake)', async () => {
    mockGated.mockImplementation(() => new Promise((resolve) => { setTimeout(() => resolve([hit()]), 10_000); }));
    const out = await retrieveSupervisorLearnings({ userId: 'alice', chatId: 'chat-supervisor', message: 'sweep', timeoutMs: 40 });
    expect(out).toEqual([]);
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildFleetLearningsBlock
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildFleetLearningsBlock', () => {
  it('renders the header + one line per hit, project hits carry the from-project marker', () => {
    const block = buildFleetLearningsBlock([hit({ projectName: 'crossmodel', title: '[crossmodel]' }), sessionHit()]);
    expect(block).toContain('[FLEET LEARNINGS & DECISIONS — 2 durable notes from your projects\' coding memory]');
    expect(block).toContain('- (learning · learnings.md · from project "crossmodel") Never force-push main');
    // The supervisor chat's OWN session-scope hit: no from-project marker, its own ref.
    expect(block).toContain('- (compaction · abc123hash) Prior wake: QB2 lane parked awaiting reviewer verdict.');
  });

  it('a chat/session-scope hit is NEVER labelled "another project" (its scopeId is a chat id, not a project id)', () => {
    const block = buildFleetLearningsBlock([sessionHit({ projectName: null })]);
    // The HIT line (last line) carries no provenance marker — only project hits do.
    const hitLine = block.trim().split('\n').pop()!;
    expect(hitLine).toBe('- (compaction · abc123hash) Prior wake: QB2 lane parked awaiting reviewer verdict.');
    expect(hitLine).not.toContain('another project');
    expect(hitLine).not.toContain('from project');
  });

  it('an unknown project name falls back to "other project", and empty hits render \'\'', () => {
    expect(buildFleetLearningsBlock([hit({ projectName: null })])).toContain('· other project)');
    expect(buildFleetLearningsBlock([])).toBe('');
    expect(buildFleetLearningsBlock(undefined as any)).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildChatQueryContext wiring — projectless supervisor chat
// ═══════════════════════════════════════════════════════════════════════════════

function primeProjectlessChat() {
  // The Fleet Supervisor's shape: projectId NULL (GET /chats/c0e22e36…/status).
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({
    projectId: null,
    systemPrompt: null,
    project: null,
  });
  mockEnriched.mockResolvedValue({
    conversationHistory: [{ role: 'user', content: 'earlier' }],
    userMemoryBlock: '',
    projectStateBlock: '',
  });
  mockPrisma.projectDocument.count.mockResolvedValue(0);
  mockPrisma.chatFile.findMany.mockResolvedValue([]);
  mockRedis.get.mockResolvedValue('[INTEGRATIONS]\ncached\n[/INTEGRATIONS]');
}

const run = (isSupervisorChat: boolean) => buildChatQueryContext({
  userId: 'alice', chatId: 'chat-supervisor', message: 'sweep the board',
  mode: 'thinking', modelSet: 'open_source', isSupervisorChat,
});

describe('buildChatQueryContext — fleet learnings wiring (ticket a6ba3fda)', () => {
  beforeEach(primeProjectlessChat);

  it('a PROJECTLESS SUPERVISOR chat reads durable L3 memory — the block lands in the system context', async () => {
    mockGated.mockResolvedValue([hit()]);
    const ctx = await run(true);
    expect(mockGated).toHaveBeenCalledTimes(1);
    expect(mockGated.mock.calls[0][1]).toEqual([]); // no primary project — the owned blend IS the scope
    expect(ctx.systemContext).toContain('[FLEET LEARNINGS & DECISIONS — 1 durable note');
    expect(ctx.systemContext).toContain('Never force-push main');
    expect(mockUngated).not.toHaveBeenCalled();
  });

  it('a projectless PLAIN chat stays byte-identical — no gated read, no block', async () => {
    const ctx = await run(false);
    expect(mockGated).not.toHaveBeenCalled();
    expect(ctx.systemContext).not.toContain('FLEET LEARNINGS');
  });

  it('an empty store result renders NO block (the context is unchanged)', async () => {
    mockGated.mockResolvedValue([]);
    const ctx = await run(true);
    expect(ctx.systemContext).not.toContain('FLEET LEARNINGS');
  });

  it('a store failure degrades recall only — the supervisor context still builds', async () => {
    mockGated.mockRejectedValue(new Error('digby_memory unreachable'));
    const ctx = await run(true);
    expect(ctx.systemContext).not.toContain('FLEET LEARNINGS');
    expect(ctx.conversationHistory).toEqual([{ role: 'user', content: 'earlier' }]);
  });

  it('a projectless supervisor chat with a PROJECT row (project supervisor) does NOT double-read (the project branch owns it)', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({
      projectId: 'P',
      systemPrompt: null,
      project: { id: 'P', name: 'Digby', systemPrompt: null },
    });
    const { getRagScopeFolderIds } = jest.requireMock('../platform/folder-inheritance');
    (getRagScopeFolderIds as jest.Mock).mockResolvedValue(['R', 'P']);
    const { getProjectSettings } = jest.requireMock('../langgraph/memory.graph');
    (getProjectSettings as jest.Mock).mockResolvedValue({ crossProjectMemory: false });
    await run(true);
    // ONE gated read — the project-learnings one, with the project chain as primaries.
    expect(mockGated).toHaveBeenCalledTimes(1);
    expect(mockGated.mock.calls[0][1]).toEqual(['P', 'R']);
    expect(mockGated.mock.calls[0][4]).toEqual(expect.objectContaining({ purpose: 'project_learnings' }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Global-RAG retrieval text — retrievalMessage, not the composed wake message
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildChatQueryContext — no-project global RAG embeds retrievalMessage (ticket a6ba3fda)', () => {
  beforeEach(primeProjectlessChat);

  it('the global-RAG leg embeds the PRE-preamble text, not the composed machine-wake message', async () => {
    mockPrisma.projectDocument.count.mockResolvedValue(3);
    const composed = `[MACHINE-TRIGGERED RUN — no user is on this turn…]\n${'boilerplate '.repeat(1500)}\nHOOK run_completed: board digest`;
    const original = 'HOOK run_completed: board digest';
    const ctx = await buildChatQueryContext({
      userId: 'alice', chatId: 'chat-supervisor', message: composed, retrievalMessage: original,
      mode: 'thinking', modelSet: 'open_source', machineWake: true, isSupervisorChat: true,
    });
    const { retrieveGlobalChunks } = jest.requireMock('../rag.service');
    expect((retrieveGlobalChunks as jest.Mock).mock.calls[0][0]).toBe(original);
    // The fleet-learnings leg embeds the pre-preamble text too.
    expect(mockGated.mock.calls[0][2]).toBe(original);
    expect(ctx.queryMessage).toBe(composed); // the model still sees the composed wake
  });

  it('without retrievalMessage the leg embeds `message` itself (user turns — unchanged)', async () => {
    mockPrisma.projectDocument.count.mockResolvedValue(1);
    await buildChatQueryContext({
      userId: 'alice', chatId: 'chat-plain', message: 'what do I know about pnpm?',
      mode: 'thinking', modelSet: 'open_source',
    });
    const { retrieveGlobalChunks } = jest.requireMock('../rag.service');
    expect((retrieveGlobalChunks as jest.Mock).mock.calls[0][0]).toBe('what do I know about pnpm?');
  });
});
