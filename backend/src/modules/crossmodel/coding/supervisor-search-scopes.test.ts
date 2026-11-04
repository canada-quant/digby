/**
 * fs-durable-memory (2026-10-22, rank #5b of the Fleet Supervisor context map):
 * search_memory on a supervisor chat must never ask for the placeholder
 * project 'chat', and must search the supervisor's own chat scope (the
 * supervisor_state ledger mirror) and the caller's OWN user-scope
 * conversation distills of THIS chat — every scope through the per-user
 * gate. SUPERVISOR_SEARCH_MEMORY_SCOPES_DISABLED=1 restores the old search.
 *
 * Three layers: the pure plan (supervisor-search-scopes.ts), searchMemory's
 * scope assembly (coding-retrieval.service.ts — the memory store mocked at
 * its boundary), and the tool seam (executeCodingTool 'search_memory').
 */

const mockProjectDocumentCount: jest.Mock = jest.fn(async () => 0);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { projectDocument: { count: (...a: any[]) => mockProjectDocumentCount(...a) } },
}));
const mockRerankTexts: jest.Mock = jest.fn(async (): Promise<any> => null);
jest.mock('../rag.service', () => ({
  __esModule: true,
  embedTexts: jest.fn(),
  rerankTexts: (...a: any[]) => mockRerankTexts(...a),
  retrieveChunks: jest.fn(async () => []),
}));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  ...jest.requireActual('../memory/unified-memory.service'),
  memSearch: jest.fn(async () => []),
  memSearchForUser: jest.fn(async () => []),
  memSearchArchive: jest.fn(async () => []),
  memSearchArchiveForUser: jest.fn(async () => []),
}));
const mockAuthorizedProjectScopeIds: jest.Mock = jest.fn(async (_u: string, ids: string[]) => ids);
jest.mock('../memory/memory-access', () => ({
  __esModule: true,
  authorizedProjectScopeIds: (...a: any[]) => mockAuthorizedProjectScopeIds(...a),
  ownsAllProjects: jest.fn(async () => true),
}));
jest.mock('../platform/folder-inheritance', () => ({ __esModule: true, getRagScopeFolderIds: jest.fn(async (id: string) => [id]) }));
jest.mock('../langgraph/memory.graph', () => ({ __esModule: true, getProjectSettings: jest.fn(async () => ({ crossProjectMemory: true })) }));

import {
  planSearchMemoryScopes,
  supervisorSearchCoverageNote,
  supervisorSearchMemoryEligible,
  CHAT_PLACEHOLDER_PROJECT_ID,
} from './supervisor-search-scopes';
import { searchMemory, CONVERSATION_SOURCE, conversationHitToFinding } from './coding-retrieval.service';

const { memSearch, memSearchForUser, memSearchArchiveForUser } = jest.requireMock('../memory/unified-memory.service');

const FS_CHAT = 'fs-chat-1';
const OWNER = 'owner-1';

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SUPERVISOR_SEARCH_MEMORY_SCOPES_DISABLED;
});
afterAll(() => { delete process.env.SUPERVISOR_SEARCH_MEMORY_SCOPES_DISABLED; });

describe('planSearchMemoryScopes (pure)', () => {
  it("a supervisor chat drops the 'chat' placeholder project and adds its own chat scope + conversation ref", () => {
    const plan = planSearchMemoryScopes({ sessionId: FS_CHAT, projectId: CHAT_PLACEHOLDER_PROJECT_ID, userId: OWNER, supervisorChat: true });
    expect(plan).toEqual({ projectId: undefined, chatScopeId: FS_CHAT, conversationRef: FS_CHAT, supervisor: true });
  });

  it('a project supervisor keeps its real project', () => {
    const plan = planSearchMemoryScopes({ sessionId: 'ps-1', projectId: 'proj-9', userId: OWNER, supervisorChat: true });
    expect(plan.projectId).toBe('proj-9');
    expect(plan.chatScopeId).toBe('ps-1');
  });

  it('a non-supervisor chat, an anonymous run and the kill switch keep the old plan byte-for-byte', () => {
    const base = { sessionId: 'c1', projectId: CHAT_PLACEHOLDER_PROJECT_ID, userId: OWNER };
    expect(planSearchMemoryScopes({ ...base, supervisorChat: false })).toEqual({ projectId: 'chat', supervisor: false });
    expect(planSearchMemoryScopes({ ...base, userId: 'anonymous', supervisorChat: true })).toEqual({ projectId: 'chat', supervisor: false });
    expect(supervisorSearchMemoryEligible({ sessionId: 'c1', userId: 'anonymous' })).toBe(false);
    process.env.SUPERVISOR_SEARCH_MEMORY_SCOPES_DISABLED = '1';
    expect(planSearchMemoryScopes({ ...base, supervisorChat: true })).toEqual({ projectId: 'chat', supervisor: false });
    expect(supervisorSearchMemoryEligible({ sessionId: 'c1', userId: OWNER })).toBe(false);
  });

  // Review 2026-10-23: with the ledger mirror switched off (SUPERVISOR_STATE_MEMORY_DISABLED=1) nothing new reaches the
  // chat scope — the note used to still claim "searched … your supervisor-state ledger — live AND archived", so an
  // empty or stale result read as "the owner never said this".
  it('SUPERVISOR_STATE_MEMORY_DISABLED=1: the frozen ledger mirror is not searched, and the note says so and names get_supervisor_state', () => {
    process.env.SUPERVISOR_STATE_MEMORY_DISABLED = '1';
    try {
      const plan = planSearchMemoryScopes({ sessionId: FS_CHAT, projectId: 'chat', userId: OWNER, supervisorChat: true });
      expect(plan.chatScopeId).toBeUndefined();
      expect(plan.conversationRef).toBe(FS_CHAT);
      for (const note of [supervisorSearchCoverageNote(plan, 'all'), supervisorSearchCoverageNote(plan, 'all', ['supervisor_state'])]) {
        const [searched, ...rest] = note.split('NOT searched');
        const notSearched = rest.join('NOT searched');
        expect(searched).not.toContain('supervisor-state ledger');
        expect(notSearched).toContain('supervisor-state ledger');
        expect(notSearched).toContain('get_supervisor_state');
      }
    } finally { delete process.env.SUPERVISOR_STATE_MEMORY_DISABLED; }
  });

  it('the coverage note says what was searched (never on scope project)', () => {
    const plan = planSearchMemoryScopes({ sessionId: FS_CHAT, projectId: 'chat', userId: OWNER, supervisorChat: true });
    expect(supervisorSearchCoverageNote(plan, 'all')).toContain('supervisor-state ledger');
    expect(supervisorSearchCoverageNote(plan, 'all')).toContain('no project knowledge');
    expect(supervisorSearchCoverageNote(plan, 'project')).toBe('');
    expect(supervisorSearchCoverageNote({ projectId: 'chat', supervisor: false }, 'all')).toBe('');
  });

  it('the coverage note lists ONLY the stores a source filter let through (review 2026-10-22)', () => {
    const plan = planSearchMemoryScopes({ sessionId: FS_CHAT, projectId: 'chat', userId: OWNER, supervisorChat: true });
    const unfiltered = supervisorSearchCoverageNote(plan, 'all', undefined);
    expect(unfiltered).toContain('supervisor-state ledger');
    expect(unfiltered).toContain('past exchanges');
    expect(unfiltered).not.toContain('NOT searched');

    const conv = supervisorSearchCoverageNote(plan, 'all', ['conversation']);
    expect(conv).toMatch(/searched[^.]*past exchanges/);
    expect(conv).toMatch(/NOT searched[^)]*supervisor-state ledger/);
    expect(conv.split('NOT searched')[0]).not.toContain('supervisor-state ledger');

    const web = supervisorSearchCoverageNote(plan, 'session', ['web_pipe']);
    expect(web.split('NOT searched')[0]).not.toContain('supervisor-state ledger');
    expect(web.split('NOT searched')[0]).not.toContain('past exchanges');
    expect(web).toContain("source 'web_pipe'");

    // A project supervisor: the project's knowledge base only joins under 'document' (or no filter).
    const ps = planSearchMemoryScopes({ sessionId: 'ps-1', projectId: 'p1', userId: OWNER, supervisorChat: true });
    expect(supervisorSearchCoverageNote(ps, 'all', ['decision'])).toMatch(/this project's knowledge \(source 'decision' rows/);
    expect(supervisorSearchCoverageNote(ps, 'all', ['decision'])).toMatch(/NOT searched[^)]*documents/);
    expect(supervisorSearchCoverageNote(ps, 'all', ['document'])).not.toMatch(/NOT searched[^)]*documents/);
  });
});

describe('searchMemory with the supervisor scopes', () => {
  it('adds the chat scope to the gated main read and a ref-filtered user-scope conversation leg (the caller\'s own id only)', async () => {
    await searchMemory(FS_CHAT, 'what did the owner decide about the H100 box', 6, {
      scope: 'all', userId: OWNER, chatScopeId: FS_CHAT, conversationRef: FS_CHAT,
    });
    expect(memSearch).not.toHaveBeenCalled(); // every leg goes through the per-user gate
    const calls = (memSearchForUser as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    const main = calls.find((c: any[]) => c[1].some((s: any) => s.type === 'session'));
    expect(main[0]).toBe(OWNER);
    expect(main[1]).toEqual([{ type: 'session', id: FS_CHAT }, { type: 'chat', id: FS_CHAT }]);
    const conv = calls.find((c: any[]) => c[1].some((s: any) => s.type === 'user'));
    expect(conv[0]).toBe(OWNER);
    expect(conv[1]).toEqual([{ type: 'user', id: OWNER }]);
    expect(conv[4]).toEqual(expect.objectContaining({ sources: [CONVERSATION_SOURCE], refs: [FS_CHAT] }));
    // never the placeholder project, never another user's scope
    for (const c of calls) {
      expect(c[1]).not.toContainEqual({ type: 'project', id: 'chat' });
      for (const s of c[1]) if (s.type === 'user') expect(s.id).toBe(OWNER);
    }
    expect(mockAuthorizedProjectScopeIds).not.toHaveBeenCalled();
  });

  it('conversation hits merge into the result with their question + date', async () => {
    (memSearchForUser as jest.Mock).mockImplementation(async (_u: string, scopes: any[]) =>
      scopes[0].type === 'user'
        ? [{ ref: FS_CHAT, title: 'Is the H100 box retired?', source: 'conversation', content: 'Owner said the H100 box is retired.\nResolution: never schedule on it.', scopeType: 'user', scopeId: OWNER, createdAt: '2026-10-15T09:30:00.000Z' }]
        : [{ ref: 'directive ask-1', title: 'Directive [ask-1]', source: 'supervisor_state', content: 'Directive ask-1: billing moved to the new Stripe account', scopeType: 'chat', scopeId: FS_CHAT, createdAt: '2026-10-16T00:00:00.000Z' }]);
    const out = await searchMemory(FS_CHAT, 'H100', 6, { scope: 'all', userId: OWNER, chatScopeId: FS_CHAT, conversationRef: FS_CHAT });
    expect(out.map((f) => f.source)).toEqual(['supervisor_state', 'conversation']);
    expect(out[1].content).toBe('[2026-10-15 09:30Z] Q: Is the H100 box retired?\nOwner said the H100 box is retired.\nResolution: never schedule on it.');
    expect(conversationHitToFinding({ ref: 'r', title: '', source: '', content: 'c', scopeType: 'user', scopeId: 'u', createdAt: 'garbage' }).content).toBe('c');
  });

  it("a source filter that excludes 'conversation' skips the conversation leg; scope 'project' adds neither", async () => {
    await searchMemory(FS_CHAT, 'q', 6, { scope: 'all', userId: OWNER, chatScopeId: FS_CHAT, conversationRef: FS_CHAT, sources: ['supervisor_state'] });
    expect((memSearchForUser as jest.Mock).mock.calls).toHaveLength(1);
    jest.clearAllMocks();
    await searchMemory(FS_CHAT, 'q', 6, { scope: 'project', projectId: 'proj-9', userId: OWNER, chatScopeId: FS_CHAT, conversationRef: FS_CHAT });
    const calls = (memSearchForUser as jest.Mock).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual([{ type: 'project', id: 'proj-9' }]);
  });

  it('without a userId the supervisor scopes are never added (no ungated read of chat / user scopes)', async () => {
    await searchMemory(FS_CHAT, 'q', 6, { scope: 'all', chatScopeId: FS_CHAT, conversationRef: FS_CHAT });
    expect(memSearchForUser).not.toHaveBeenCalled();
    expect((memSearch as jest.Mock).mock.calls[0][0]).toEqual([{ type: 'session', id: FS_CHAT }]);
  });

  // Review 2026-10-23 (privacy): a distill is a model summary of the RAW owner message — its refs ("systems, files,
  // URLs, or entities mentioned") can copy a pasted credential, and the supervisor leg brought it back verbatim, days
  // later, on any wake. Every other owner-words surface of the same wave redacts.
  const HF = 'hf_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9';
  it('a credential in a conversation distill (hot or archived) never comes back from the supervisor leg', async () => {
    (memSearchForUser as jest.Mock).mockImplementation(async (_u: string, scopes: any[]) =>
      scopes[0].type === 'user'
        ? [{ ref: FS_CHAT, title: `use ${HF} for the HF upload?`, source: 'conversation', content: `Owner gave the HF token.\nRefs: Hugging Face, spark lane, ${HF}`, scopeType: 'user', scopeId: OWNER, createdAt: '2026-10-15T09:30:00.000Z' }]
        : []);
    (memSearchArchiveForUser as jest.Mock).mockImplementation(async (_u: string, scopes: any[]) =>
      scopes[0].type === 'user'
        ? [{ ref: FS_CHAT, title: 'older', source: 'conversation', content: `Earlier: token ${HF} for the mirror`, scopeType: 'user', scopeId: OWNER, createdAt: '2026-09-01T00:00:00.000Z', archivedAt: '2026-10-01T00:00:00.000Z' }]
        : []);
    const out = await searchMemory(FS_CHAT, 'HF upload token', 6, { scope: 'all', userId: OWNER, chatScopeId: FS_CHAT, conversationRef: FS_CHAT, includeArchive: true });
    expect(out.length).toBeGreaterThanOrEqual(2);
    for (const f of out) {
      expect(f.content).not.toContain('hf_A1b2');
      expect(String(f.ref ?? '')).not.toContain('hf_A1b2');
    }
    expect(out.some((f) => f.content.includes('[REDACTED: looked like a credential]'))).toBe(true);
    expect(out.find((f) => f.archived)?.content).toContain('[REDACTED: looked like a credential]');
  });

  it('the archive top-up for the conversation leg keeps the ref filter', async () => {
    await searchMemory(FS_CHAT, 'q', 6, { scope: 'all', userId: OWNER, chatScopeId: FS_CHAT, conversationRef: FS_CHAT, includeArchive: true });
    const archiveCalls = (memSearchArchiveForUser as jest.Mock).mock.calls;
    const convArchive = archiveCalls.find((c: any[]) => c[1][0].type === 'user');
    expect(convArchive).toBeDefined();
    expect(convArchive[0]).toBe(OWNER);
    expect(convArchive[1]).toEqual([{ type: 'user', id: OWNER }]);
    expect(convArchive[4]).toEqual(expect.objectContaining({ sources: [CONVERSATION_SOURCE], refs: [FS_CHAT] }));
  });
});
