/**
 * fs-code-knowledge (2026-10-22) — search_code_semantic scope + honesty, the
 * pure leaf (code-search.ts). The incident: the Fleet Supervisor (an ungrouped
 * chat, projectId sentinel 'chat') searched a scope no index sync ever writes,
 * read the empty answer as absence and told the owner a shipped UI feature did
 * not exist. The wiring through executeCodingTool is pinned in
 * code-search.wiring.test.ts.
 */

import {
  runCodeSemanticSearch, renderCodeIndexFreshness, renderNoCodeIndex, renderNoCodeMatch, codeAbsenceProbes,
  probeToolAvailable, pickPlatformIndexProject, isUngroupedChatScope, codeSearchChatScopeRefuseDisabled,
  codeIndexWalkV2Disabled, type CodeSearchDeps, type CodeSearchCaller,
} from './code-search';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';

const chatTools = (n: string) => probeToolAvailable(n, { surface: 'chat', integrationTool: (x) => x === 'github_search_code' || x === 'github_get_file_contents' });
const codingTools = (n: string) => probeToolAvailable(n, { surface: 'coding', integrationTool: (x) => x === 'github_search_code' || x === 'github_get_file_contents' });

function deps(over: Partial<CodeSearchDeps> = {}): CodeSearchDeps & { search: jest.Mock } {
  return {
    search: jest.fn(async () => []),
    readState: jest.fn(async () => null),
    isSupervisorChat: jest.fn(async () => false),
    listRepoProjects: jest.fn(async () => []),
    ownRepoSlug: () => 'canada-quant/digby',
    now: () => NOW,
    ...over,
  } as any;
}

const chatCaller = (over: Partial<CodeSearchCaller> = {}): CodeSearchCaller => ({
  projectId: 'chat', sessionId: 'fs-chat', userId: 'owner', surface: 'chat', hasTool: chatTools, ...over,
});

describe('switches + scope', () => {
  it('both switches default ON and flip only on =1', () => {
    expect(codeSearchChatScopeRefuseDisabled({} as any)).toBe(false);
    expect(codeSearchChatScopeRefuseDisabled({ CODE_SEARCH_CHAT_SCOPE_REFUSE_DISABLED: '1' } as any)).toBe(true);
    expect(codeIndexWalkV2Disabled({} as any)).toBe(false);
    expect(codeIndexWalkV2Disabled({ CODE_INDEX_WALK_V2_DISABLED: '1' } as any)).toBe(true);
  });
  it("the ungrouped-chat sentinel 'chat' and no project hold no index", () => {
    expect(isUngroupedChatScope('chat')).toBe(true);
    expect(isUngroupedChatScope(undefined)).toBe(true);
    expect(isUngroupedChatScope('')).toBe(true);
    expect(isUngroupedChatScope('3f1c9e2a-0000-4000-8000-000000000000')).toBe(false);
  });
});

describe("'chat' scope → an honest no-index answer, nothing searched", () => {
  it('a plain ungrouped chat never searches project "chat"', async () => {
    const d = deps();
    const r = await runCodeSemanticSearch(chatCaller(), 'where is the ghost toggle rendered', d);
    expect(d.search).not.toHaveBeenCalled();
    expect(r).toMatchObject({ hits: 0, scope: 'none', noIndex: 'chat_scope' });
    expect(r.text).toContain('NO CODE INDEX');
    expect(r.text).toContain('NOT evidence that the code does not exist');
    // never the old wording, never a tool a chat run lacks
    expect(r.text).not.toMatch(/may still be building/);
    expect(r.text).not.toMatch(/\bgrep\b|\bglob\b/);
    expect(r.text).toContain('github_get_file_contents');
  });

  it('a supervisor chat with no project naming the platform repo still answers no-index', async () => {
    const d = deps({ isSupervisorChat: jest.fn(async () => true), listRepoProjects: jest.fn(async () => [{ id: 'p-app', name: 'app', repoUrl: 'https://github.com/acme/app' }]) });
    const r = await runCodeSemanticSearch(chatCaller(), 'composer ghost toggle', d);
    expect(d.search).not.toHaveBeenCalled();
    expect(r.noIndex).toBe('chat_scope');
    expect(r.text).toContain('send_chat_message'); // a supervisor can ask a lane to read main
  });

  it('an unreadable supervisor flag is treated as not-a-supervisor (no throw)', async () => {
    const d = deps({ isSupervisorChat: jest.fn(async () => { throw new Error('db down'); }) });
    const r = await runCodeSemanticSearch(chatCaller(), 'q', d);
    expect(r.noIndex).toBe('chat_scope');
  });
});

describe('supervisor chat → the platform repository project index', () => {
  const projects = [
    { id: 'p-app-0000', name: 'app', repoUrl: 'https://github.com/acme/app' },
    { id: 'p-plat-old', name: 'crossmodel (old)', repoUrl: 'git@github.com:canada-quant/old-copy.git' },
    { id: 'p-plat-main', name: 'crossmodel', repoUrl: 'https://github.com/canada-quant/digby.git' },
  ];
  const states: Record<string, any> = {
    'p-plat-old': { files: { 'a.ts': 'h' }, lastSyncAt: '2026-10-01T00:00:00Z' },
    'p-plat-main': { files: { 'a.ts': 'h', 'b.ts': 'h', 'c.tsx': 'h' }, lastSyncAt: '2026-10-22T10:00:00Z', indexedSha: SHA, branch: 'digby/session-1234' },
  };

  it('searches the best-indexed project whose repoUrl names SELF_REPO, with a header + provenance', async () => {
    const d = deps({
      isSupervisorChat: jest.fn(async () => true),
      listRepoProjects: jest.fn(async () => projects),
      readState: jest.fn(async (id: string) => states[id] ?? null),
      search: jest.fn(async () => [{ ref: 'frontend/app/crossmodel/GhostToggle.tsx', content: 'export function GhostToggle()' }]),
    });
    const r = await runCodeSemanticSearch(chatCaller(), 'composer ghost toggle', d, { freshness: true });
    expect(d.search).toHaveBeenCalledWith('p-plat-main', 'composer ghost toggle', 8);
    expect(r).toMatchObject({ hits: 1, scope: 'platform', searchedProjectId: 'p-plat-main' });
    expect(r.text).toContain('searched the platform repository\'s code index — project "crossmodel"');
    expect(r.text).toContain('index of digby/session-1234@1a2b3c4, synced 2h ago');
    expect(r.text).toContain('[1] frontend/app/crossmodel/GhostToggle.tsx');
  });

  it('a platform project with no index state answers platform_unindexed (nothing searched)', async () => {
    const d = deps({ isSupervisorChat: jest.fn(async () => true), listRepoProjects: jest.fn(async () => [projects[2]]) });
    const r = await runCodeSemanticSearch(chatCaller(), 'q', d);
    expect(d.search).not.toHaveBeenCalled();
    expect(r.noIndex).toBe('platform_unindexed');
    expect(r.text).toContain('project "crossmodel"');
  });

  it('no own repo configured (non-prod instance) → no platform search', async () => {
    const d = deps({ isSupervisorChat: jest.fn(async () => true), ownRepoSlug: () => '', listRepoProjects: jest.fn(async () => projects) });
    const r = await runCodeSemanticSearch(chatCaller(), 'q', d);
    expect(d.listRepoProjects).not.toHaveBeenCalled();
    expect(r.noIndex).toBe('chat_scope');
  });

  it('pickPlatformIndexProject: slug-normalized match, most files first, then freshest', () => {
    const cands = projects.map(p => ({ ...p, state: states[p.id] ?? null }));
    expect(pickPlatformIndexProject(cands, 'canada-quant/digby')?.id).toBe('p-plat-main');
    expect(pickPlatformIndexProject(cands, 'https://github.com/acme/app')?.id).toBe('p-app-0000');
    expect(pickPlatformIndexProject(cands, 'nobody/nothing')).toBeNull();
    expect(pickPlatformIndexProject(cands, '')).toBeNull();
  });
});

describe('a real project', () => {
  it('a project whose index was never built answers project_unindexed (nothing searched)', async () => {
    const d = deps();
    const r = await runCodeSemanticSearch({ ...chatCaller(), projectId: 'proj-1', surface: 'coding', hasTool: codingTools }, 'q', d);
    expect(d.search).not.toHaveBeenCalled();
    expect(r.noIndex).toBe('project_unindexed');
    expect(r.text).toContain('NOT evidence');
  });

  it('an unreadable state fails open: search anyway, no freshness line', async () => {
    const d = deps({ readState: jest.fn(async () => { throw new Error('store down'); }), search: jest.fn(async () => [{ ref: 'src/a.ts', content: 'x' }]) });
    const r = await runCodeSemanticSearch({ ...chatCaller(), projectId: 'proj-1', surface: 'coding', hasTool: codingTools }, 'q', d);
    expect(d.search).toHaveBeenCalledWith('proj-1', 'q', 8);
    expect(r.text.startsWith('[1] src/a.ts')).toBe(true);
  });

  it('empty result: not-found ≠ does-not-exist, and only the probes a coding caller holds', async () => {
    const d = deps({ readState: jest.fn(async () => ({ files: { 'a.ts': 'h' }, lastSyncAt: '2026-10-22T11:30:00Z', indexedSha: SHA, branch: 'main' })) });
    const r = await runCodeSemanticSearch({ ...chatCaller(), projectId: 'proj-1', surface: 'coding', hasTool: codingTools }, 'q', d, { freshness: true });
    expect(r).toMatchObject({ hits: 0, scope: 'project' });
    expect(r.text).toContain('index of main@1a2b3c4, synced 30m ago');
    expect(r.text).toContain('Not found is NOT does-not-exist');
    expect(r.text).toContain('grep / glob / read_file on this worktree');
    expect(r.text).toContain('git_show {ref:"origin/<default branch>", path}');
    expect(r.text).not.toContain('send_chat_message'); // a chat-surface probe never offered to a coding lane
  });

  it('freshness:false (walk v2 switched off) drops the provenance line', async () => {
    const d = deps({ readState: jest.fn(async () => ({ files: { 'a.ts': 'h' }, indexedSha: SHA, branch: 'main', lastSyncAt: '2026-10-22T11:00:00Z' })), search: jest.fn(async () => [{ ref: 'a.ts', content: 'x' }]) });
    const r = await runCodeSemanticSearch({ ...chatCaller(), projectId: 'proj-1', surface: 'coding', hasTool: codingTools }, 'q', d, { freshness: false });
    expect(r.text).not.toContain('index of');
  });
});

describe('project supervisors get the ask-a-lane probe too (review fix)', () => {
  const indexed = { files: { 'a.ts': 'h' }, lastSyncAt: '2026-10-22T11:30:00Z', indexedSha: SHA, branch: 'main' };

  it('a PROJECT supervisor chat (real projectId) is offered send_chat_message to one of its own lanes on a miss', async () => {
    const d = deps({ readState: jest.fn(async () => indexed), isSupervisorChat: jest.fn(async () => true) });
    const r = await runCodeSemanticSearch(chatCaller({ projectId: 'proj-1', sessionId: 'ps-chat' }), 'q', d);
    expect(d.isSupervisorChat).toHaveBeenCalledWith('ps-chat');
    expect(r).toMatchObject({ hits: 0, scope: 'project' });
    expect(r.text).toContain("send_chat_message to one of this project's coding lanes");
    expect(r.text).not.toContain('Framework Operator'); // the platform wording is the Fleet Supervisor's
  });

  it('a project supervisor whose project was never indexed gets the same probe', async () => {
    const d = deps({ isSupervisorChat: jest.fn(async () => true) });
    const r = await runCodeSemanticSearch(chatCaller({ projectId: 'proj-1', sessionId: 'ps-chat' }), 'q', d);
    expect(r.noIndex).toBe('project_unindexed');
    expect(r.text).toContain("send_chat_message to one of this project's coding lanes");
  });

  it('a plain project chat (not a supervisor) is never offered it, and a hit never asks the flag', async () => {
    const d = deps({ readState: jest.fn(async () => indexed), isSupervisorChat: jest.fn(async () => false) });
    const miss = await runCodeSemanticSearch(chatCaller({ projectId: 'proj-1' }), 'q', d);
    expect(miss.text).not.toContain('send_chat_message');
    const d2 = deps({ readState: jest.fn(async () => indexed), search: jest.fn(async () => [{ ref: 'a.ts', content: 'x' }]) });
    await runCodeSemanticSearch(chatCaller({ projectId: 'proj-1' }), 'q', d2);
    expect(d2.isSupervisorChat).not.toHaveBeenCalled();
  });

  it('a project supervisor without send_chat_message is not offered it', async () => {
    const has = (n: string) => n !== 'send_chat_message' && chatTools(n);
    const d = deps({ readState: jest.fn(async () => indexed), isSupervisorChat: jest.fn(async () => true) });
    const r = await runCodeSemanticSearch(chatCaller({ projectId: 'proj-1', hasTool: has }), 'q', d);
    expect(r.text).not.toContain('send_chat_message');
  });

  it('a coding-surface caller never asks the supervisor flag', async () => {
    const d = deps({ readState: jest.fn(async () => indexed) });
    await runCodeSemanticSearch({ ...chatCaller(), projectId: 'proj-1', surface: 'coding', hasTool: codingTools }, 'q', d);
    expect(d.isSupervisorChat).not.toHaveBeenCalled();
  });
});

describe('freshness line — review-fix fields', () => {
  it('a summarised view (fileCount, no files map) still counts files', () => {
    expect(renderCodeIndexFreshness({ fileCount: 3412, lastSyncAt: '2026-10-22T11:00:00Z', indexedSha: SHA, branch: 'main' }, NOW)).toContain('3,412 files');
  });
  it('names a listing that could not be read, and files held back by the row cap', () => {
    const line = renderCodeIndexFreshness({ fileCount: 2, lastSyncAt: '2026-10-22T11:00:00Z', listingErrors: 2, capDeferred: 4 }, NOW);
    expect(line).toContain('could not read 2 entries — files there keep their last-synced rows');
    expect(line).not.toContain('not swept');
    expect(line).toContain('4 files not indexed — the project\'s code-row cap is full');
  });
});

describe('probe naming', () => {
  it('a worker role sees only its allowed tools; a chat run never sees worktree tools', () => {
    const allowed = new Set(['read_file', 'github_search_code']);
    const has = (n: string) => probeToolAvailable(n, { surface: 'coding', allowedTools: allowed, integrationTool: () => true });
    const probes = codeAbsenceProbes({ surface: 'coding', supervisor: false, hasTool: has }).join('\n');
    expect(probes).toContain('read_file on this worktree');
    expect(probes).not.toMatch(/\bgrep\b|git_show|github_get_file_contents/);
    expect(chatTools('grep')).toBe(false);
    expect(chatTools('git_show')).toBe(false);
  });
  it('a switched-off github_get_file_contents is never named', () => {
    const has = (n: string) => probeToolAvailable(n, { surface: 'chat', integrationTool: (x) => x === 'github_search_code' });
    expect(codeAbsenceProbes({ surface: 'chat', supervisor: true, hasTool: has }).join('\n')).not.toContain('github_get_file_contents');
  });
  it('no probe at all → the answer says NOT checked, never "does not exist"', () => {
    expect(renderNoCodeMatch([])).toContain('say the code was NOT checked');
    expect(renderNoCodeIndex('chat_scope', [])).toContain('say the code was NOT checked');
  });
});

describe('renderCodeIndexFreshness', () => {
  it('names branch@sha7, age and file count; flags partial / truncated', () => {
    const line = renderCodeIndexFreshness({ files: { a: '1', b: '2' }, lastSyncAt: '2026-10-19T12:00:00Z', indexedSha: SHA, branch: 'digby/x', partial: true, truncated: true }, NOW);
    expect(line).toContain('index of digby/x@1a2b3c4, synced 3d ago');
    expect(line).toContain('2 files');
    expect(line).toContain('partial');
    expect(line).toContain('file cap');
  });
  it('a legacy state (no sha recorded) says so instead of implying main', () => {
    expect(renderCodeIndexFreshness({ files: { a: '1' }, lastSyncAt: '2026-10-22T11:59:30Z' }, NOW)).toContain('index synced just now — branch/commit not recorded');
  });
  it('no state → no line', () => {
    expect(renderCodeIndexFreshness(null, NOW)).toBe('');
  });
});
