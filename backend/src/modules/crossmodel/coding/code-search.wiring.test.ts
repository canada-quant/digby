/**
 * fs-code-knowledge (2026-10-22) — search_code_semantic through the REAL
 * executeCodingTool. THE INCIDENT: the Fleet Supervisor (ungrouped chat, every
 * chat-surface run carries projectId 'chat') called search_code_semantic, the
 * executor only refused a FALSY projectId, so it searched project 'chat' — a
 * scope no index sync ever writes — and answered "No indexed code matched …
 * The index may still be building … use grep/glob". The supervisor has no
 * grep/glob, read the miss as absence and told the owner a shipped UI feature
 * did not exist.
 *
 * DISCRIMINATORS (fail on the pre-fix executor): the 'chat' scope test (old
 * code searched 'chat' and printed the "may still be building" wording), the
 * supervisor test (old code never searched the platform project) and the
 * empty-result wording test.
 *
 * Boundary mocks mirror grep-false-zero.b6d50f4a.test.ts (the tools.ts import
 * graph reaches config/env, which process.exit(1)s without env).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../platform/platform.service', () => ({ __esModule: true }));
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'],
}));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('./coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
  clearSessionMemory: jest.fn(async () => {}),
  buildSessionMemoryInventory: jest.fn(async () => ''),
}));
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits',
    MERGE_GATE_FAILURE: 'merge_gate_failure', MERGE_SUCCESS: 'merge_success', MERGE_SIZE_GUARD: 'merge_size_guard',
  },
}));
jest.mock('./self-merge.service', () => ({ __esModule: true, selfMergeDisabled: () => false }));
jest.mock('../platform/owner-questions', () => ({ __esModule: true, flagOwnerQuestion: jest.fn() }));
jest.mock('./ci-status', () => ({ __esModule: true, observeCiAfterPush: jest.fn(async () => ''), fetchCiStatus: jest.fn(), renderCiStatus: jest.fn(() => ''), emitCiFailed: jest.fn() }));
jest.mock('./process.service', () => ({ __esModule: true, processSnapshot: jest.fn(() => []) }));
const mockSearch = jest.fn();
const mockReadState = jest.fn();
jest.mock('./code-index.service', () => ({
  __esModule: true,
  searchCodeSemantic: (...a: any[]) => mockSearch(...a),
  readCodeIndexState: (...a: any[]) => mockReadState(...a),
  syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })),
  kickCodeIndexSync: jest.fn(),
}));
const mockSupervisorFlag = jest.fn();
jest.mock('../platform/supervisor-state.service', () => ({
  __esModule: true,
  supervisorChatFlag: (...a: any[]) => mockSupervisorFlag(...a),
}));
const mockFindMany = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { crossModelProject: { findMany: (...a: any[]) => mockFindMany(...a) } },
}));
jest.mock('./schedule.service', () => ({ __esModule: true, createSchedule: jest.fn() }));
jest.mock('./run-idempotency', () => ({
  __esModule: true,
  findPriorRunPushReceipt: jest.fn(async (): Promise<any> => null),
  findPriorRunPrReceipt: jest.fn(async (): Promise<any> => null),
  prHeadMatchesReceipt: jest.fn(async (): Promise<boolean> => false),
}));

import { executeCodingTool, ToolContext } from './tools';

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';

const mkCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
  worktree: '/nonexistent', sessionId: 'fs-chat-1', userId: 'owner-1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: jest.fn(async () => 'allow' as const),
  execShell: jest.fn(async () => ({ stdout: '', stderr: '' })),
  ...over,
}) as unknown as ToolContext;

const ENV = { ...process.env };
beforeEach(() => {
  process.env = { ...ENV };
  delete process.env.CODE_SEARCH_CHAT_SCOPE_REFUSE_DISABLED;
  delete process.env.CODE_INDEX_WALK_V2_DISABLED;
  delete process.env.DIGBY_INSTANCE;
  delete process.env.SELF_REPO;
  mockSearch.mockReset().mockResolvedValue([]);
  mockReadState.mockReset().mockResolvedValue(null);
  mockSupervisorFlag.mockReset().mockResolvedValue(false);
  mockFindMany.mockReset().mockResolvedValue([]);
  mockRecordLoopMetric.mockReset();
});
afterAll(() => { process.env = ENV; });

describe("search_code_semantic on an ungrouped chat (projectId 'chat')", () => {
  it('answers NO CODE INDEX — never searches the sentinel scope, never names grep/glob', async () => {
    const out = await executeCodingTool(mkCtx({ projectId: 'chat', agentSurface: 'chat' }), 'search_code_semantic', { query: 'composer ghost toggle' });
    expect(mockSearch).not.toHaveBeenCalled();
    expect(out).toContain('NO CODE INDEX');
    expect(out).toContain('NOT evidence that the code does not exist');
    expect(out).not.toMatch(/may still be building|\bgrep\b|\bglob\b/);
    const row = mockRecordLoopMetric.mock.calls.map(c => c[0]).find(r => r.kind === 'coding_retrieval_hits');
    expect(row).toMatchObject({ value: 0, meta: { tool: 'search_code_semantic', scope: 'none', noIndex: 'chat_scope' } });
  });

  it('a SUPERVISOR chat searches the platform repository project index (SELF_REPO → project repoUrl)', async () => {
    mockSupervisorFlag.mockResolvedValue(true);
    mockFindMany.mockResolvedValue([
      { id: 'proj-user-app', name: 'app', repoUrl: 'https://github.com/someone/app' },
      { id: 'proj-platform', name: 'crossmodel', repoUrl: 'https://github.com/canada-quant/digby.git' },
    ]);
    mockReadState.mockImplementation(async (id: string) => (id === 'proj-platform'
      ? { files: { 'frontend/app/crossmodel/GhostToggle.tsx': 'h' }, lastSyncAt: new Date(Date.now() - 5.5 * 60_000).toISOString(), indexedSha: SHA, branch: 'main' }
      : null));
    mockSearch.mockResolvedValue([{ ref: 'frontend/app/crossmodel/GhostToggle.tsx', content: 'export function GhostToggle() {}' }]);
    const out = await executeCodingTool(mkCtx({ projectId: 'chat', agentSurface: 'chat' }), 'search_code_semantic', { query: 'composer ghost toggle' });
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'owner-1', archivedAt: null }) }));
    expect(mockSearch).toHaveBeenCalledWith('proj-platform', 'composer ghost toggle', 8);
    expect(out).toContain('platform repository\'s code index — project "crossmodel"');
    expect(out).toContain('index of main@abcdef0, synced 5m ago');
    expect(out).toContain('[1] frontend/app/crossmodel/GhostToggle.tsx');
  });

  it('an ungrouped chat filed in the hidden personal workspace (projectMemoryIsolated) is the same no-index scope', async () => {
    const out = await executeCodingTool(mkCtx({ projectId: 'userspace-proj', projectMemoryIsolated: true, agentSurface: 'chat' }), 'search_code_semantic', { query: 'q' });
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockReadState).not.toHaveBeenCalled();
    expect(out).toContain('NO CODE INDEX in this chat\'s scope');
  });

  it('kill switch CODE_SEARCH_CHAT_SCOPE_REFUSE_DISABLED=1 restores the old search + wording byte-for-byte', async () => {
    process.env.CODE_SEARCH_CHAT_SCOPE_REFUSE_DISABLED = '1';
    const out = await executeCodingTool(mkCtx({ projectId: 'chat', agentSurface: 'chat' }), 'search_code_semantic', { query: 'q' });
    expect(mockSearch).toHaveBeenCalledWith('chat', 'q', 8);
    expect(out).toBe('No indexed code matched THIS phrasing. The index may still be building for this project (it syncs at run start), or the concept lives under different vocabulary — try once more with different words (what the code DOES), and use grep/glob for exact symbols meanwhile.');
  });
});

describe('search_code_semantic on a real coding project', () => {
  it('an empty result says not-found ≠ does-not-exist, carries provenance, names the coding probes', async () => {
    mockReadState.mockResolvedValue({ files: { 'src/a.ts': 'h' }, lastSyncAt: new Date().toISOString(), indexedSha: SHA, branch: 'digby/session-x' });
    const out = await executeCodingTool(mkCtx({ projectId: 'proj-1', agentSurface: 'coding' }), 'search_code_semantic', { query: 'retry throttle' });
    expect(mockSearch).toHaveBeenCalledWith('proj-1', 'retry throttle', 8);
    expect(out).toContain('index of digby/session-x@abcdef0');
    expect(out).toContain('Not found is NOT does-not-exist');
    expect(out).toContain('grep / glob / read_file on this worktree');
    expect(out).not.toMatch(/may still be building/);
  });

  it('a PROJECT supervisor chat (its own project, chat surface) is offered the ask-a-lane probe on a miss', async () => {
    mockSupervisorFlag.mockResolvedValue(true);
    mockReadState.mockResolvedValue({ fileCount: 812, lastSyncAt: new Date().toISOString(), indexedSha: SHA, branch: 'main' });
    const out = await executeCodingTool(mkCtx({ sessionId: 'ps-chat-1', projectId: 'proj-ps', agentSurface: 'chat' }), 'search_code_semantic', { query: 'tenant billing export' });
    expect(mockSearch).toHaveBeenCalledWith('proj-ps', 'tenant billing export', 8);
    expect(mockSupervisorFlag).toHaveBeenCalledWith('ps-chat-1');
    expect(out).toContain("send_chat_message to one of this project's coding lanes");
    expect(out).toContain('812 files');
    expect(out).not.toMatch(/\bgrep\b|\bglob\b/);
  });

  it('CODE_INDEX_WALK_V2_DISABLED=1 drops the provenance line from hits', async () => {
    process.env.CODE_INDEX_WALK_V2_DISABLED = '1';
    mockReadState.mockResolvedValue({ files: { 'src/a.ts': 'h' }, lastSyncAt: new Date().toISOString(), indexedSha: SHA, branch: 'main' });
    mockSearch.mockResolvedValue([{ ref: 'src/a.ts', content: 'export const x = 1;' }]);
    const out = await executeCodingTool(mkCtx({ projectId: 'proj-1', agentSurface: 'coding' }), 'search_code_semantic', { query: 'q' });
    expect(out.startsWith('[1] src/a.ts')).toBe(true);
  });
});
