/**
 * Tests for the 3-tier memory block formatting (user / project / session).
 */

jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
// prisma (used by the project dream cycle) is mocked so the suite stays env-free.
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { chatCodingState: { findMany: jest.fn(async () => []) } },
}));
// coding-memory now imports learnings-index.service (dreamLearnings' parser),
// whose graph reaches unified-memory → rag.service — keep the suite env-free.
jest.mock('../rag.service', () => ({ __esModule: true, embedTexts: jest.fn(), rerankTexts: jest.fn() }));
// Loop telemetry (P0 noteMemoryReplace observation + P6 shrink guard): ONE
// boundary mock shared by both suites below.
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { MEMORY_SHRUNK: 'memory_shrunk' },
}));
const mockRecordExtractionOutcome: jest.Mock = jest.fn();
jest.mock('../memory/memory-audit', () => ({
  recordExtractionOutcome: (...a: any[]) => mockRecordExtractionOutcome(...a),
  // 2026-09-23: the fold/dream outcome rows keep head+tail of the raw answer via this pure helper.
  extractionDetailOf: (raw: unknown) => String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
  parseModelJson: (text: unknown) => { const raw = String(text ?? '').replace(/```json\n?|\n?```/g, '').trim(); if (!raw) return null; try { return JSON.parse(raw); } catch {} const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a, b + 1)); } catch {} } return null; },
}));

import {
  formatCodingMemoryBlock, dreamLearnings, dreamCodingProjects, memoryShrankOverThreshold, noteMemoryReplace,
  updateCodingMemoryAsync, memoryShrankSuspiciously, codingMemoryEchoBudget,
  MEMORY_SHRINK_MIN_RATIO, MEMORY_SHRINK_MAX_LINE_DROP,
  UserCodingMemory, ProjectCodingMemory, SessionCodingMemory,
} from './coding-memory.service';

const mockRecordLoopMetric = jest.requireMock('../platform/loop-metrics.service').recordLoopMetric as jest.Mock;

const { utilityChat } = jest.requireMock('../../../utils/utility-llm');

const user: UserCodingMemory = { preferences: ['prefers pnpm', 'concise commits'], notes: [], updatedAt: '' };
const project: ProjectCodingMemory = { overview: 'A Next.js app', commands: ['pnpm test'], notes: ['uses RSC'], updatedAt: '' };
const session: SessionCodingMemory = { summary: 'Added auth pages.', updatedAt: '' };

describe('formatCodingMemoryBlock (3 tiers)', () => {
  test('renders all three tiers, user first', () => {
    const out = formatCodingMemoryBlock(user, project, session);
    expect(out).toContain('[USER PREFERENCES');
    expect(out).toContain('prefers pnpm');
    expect(out).toContain('[PROJECT MEMORY');
    expect(out).toContain('A Next.js app');
    expect(out).toContain('[SESSION SO FAR]');
    expect(out).toContain('Added auth pages.');
    // user block precedes project block precedes session block
    expect(out.indexOf('[USER PREFERENCES')).toBeLessThan(out.indexOf('[PROJECT MEMORY'));
    expect(out.indexOf('[PROJECT MEMORY')).toBeLessThan(out.indexOf('[SESSION SO FAR]'));
  });

  test('omits empty tiers cleanly', () => {
    const out = formatCodingMemoryBlock(
      { preferences: [], notes: [], updatedAt: '' },
      { overview: '', commands: [], notes: [], updatedAt: '' },
      null,
    );
    expect(out).toBe('');
  });

  test('user-only memory renders just the user block', () => {
    const out = formatCodingMemoryBlock(user, { overview: '', commands: [], notes: [], updatedAt: '' }, null);
    expect(out).toContain('[USER PREFERENCES');
    expect(out).not.toContain('[PROJECT MEMORY');
    expect(out).not.toContain('[SESSION SO FAR]');
  });
});

describe('dreamLearnings (audit #11: learnings.md dedupe dream pass)', () => {
  const HEADER = '# Learned conventions (durable)\n\nOne line per durable discovery.';
  const md = (...entries: string[]) => `${HEADER}\n\n${entries.join('\n')}\n`;
  // Distinct filler entries (no shared distinctive tokens → never cluster).
  const E1 = '- Prisma migrations are hand-written via migrate diff; production runs migrate deploy.';
  const E2 = '- Sonner toasts position through mobile-offset-top, never the spacing variable.';
  const E3 = '- Playwright chromium needs dpkg-extracted libraries inside the container sandbox.';
  const E4 = '- Backups ride the nightly systemd timer plus the S3 offsite bucket instance role.';
  const E5 = '- Deploy health gates bind on the compose start-period, widen before blind retrying.';
  const E6 = '- Heredoc terminators under Actions blocks demand matching indentation columns.';

  beforeEach(() => (utilityChat as jest.Mock).mockClear().mockResolvedValue(''));

  test('verbatim duplicates collapse to the first copy (no LLM involved)', async () => {
    const res = await dreamLearnings(md(E1, E2, E3, E4, E5, E6, E2, E1, '<!-- keep me -->'));
    expect(res.changed).toBe(true);
    expect(res.guardTripped).toBe(false);
    expect(res.entriesBefore).toBe(8);
    expect(res.entriesAfter).toBe(6);
    expect(res.removedVerbatim).toBe(2);
    expect(res.mergedNearDupes).toBe(0);
    expect(utilityChat).not.toHaveBeenCalled();
    // One copy each, order preserved, header + comment preserved.
    expect(res.content.match(/Sonner toasts/g)).toHaveLength(1);
    expect(res.content.match(/Prisma migrations/g)).toHaveLength(1);
    expect(res.content.indexOf('Prisma migrations')).toBeLessThan(res.content.indexOf('Sonner toasts'));
    expect(res.content).toContain(HEADER.split('\n')[0]);
    expect(res.content).toContain('<!-- keep me -->');
  });

  test('near-duplicates merge via the utility LLM into one entry', async () => {
    const A = '- alpha bravo charlie delta echo foxtrot golf hotel india juliet convention';
    const B = '- alpha bravo charlie delta echo foxtrot golf hotel india kilo convention';
    const MERGED = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo convention (merged)';
    (utilityChat as jest.Mock).mockResolvedValue(JSON.stringify({ merged: [MERGED] }));
    const res = await dreamLearnings(md(E1, A, E2, B, E3, E4));
    expect(res.changed).toBe(true);
    expect(res.mergedNearDupes).toBe(1);
    expect(res.entriesAfter).toBe(5);
    expect(res.content).toContain(`- ${MERGED}`);
    expect(res.content).not.toContain('india kilo convention\n'); // original B gone
    // The merge prompt carried both entries as one group.
    const prompt = (utilityChat as jest.Mock).mock.calls[0][0][0].content;
    expect(prompt).toContain('GROUP 1');
    expect(prompt).toContain('india juliet');
    expect(prompt).toContain('india kilo');
  });

  test('anti-wipe guard: dropping >30% of entries keeps the original + warns', async () => {
    const res = await dreamLearnings(md(E1, E2, E1, E2)); // dedupe would drop 2 of 4 (50%)
    expect(res.guardTripped).toBe(true);
    expect(res.changed).toBe(false);
    expect(res.content).toBe(md(E1, E2, E1, E2)); // untouched
    expect(res.warning).toMatch(/keeping the original/);
  });

  test('LLM garbage degrades safely: bad JSON → no merge; too-short merge → originals kept', async () => {
    const A = '- alpha bravo charlie delta echo foxtrot golf hotel india juliet convention';
    const B = '- alpha bravo charlie delta echo foxtrot golf hotel india kilo convention';
    (utilityChat as jest.Mock).mockResolvedValue('not json at all');
    let res = await dreamLearnings(md(E1, A, E2, B, E3, E4));
    expect(res.changed).toBe(false);
    expect(res.content).toBe(md(E1, A, E2, B, E3, E4));
    (utilityChat as jest.Mock).mockResolvedValue(JSON.stringify({ merged: ['ok'] })); // < 30 chars = garbage
    res = await dreamLearnings(md(E1, A, E2, B, E3, E4));
    expect(res.changed).toBe(false);
    expect(res.content).toContain('india juliet');
    expect(res.content).toContain('india kilo');
  });

  test('an empty or entry-less file is returned unchanged', async () => {
    expect((await dreamLearnings('')).changed).toBe(false);
    const res = await dreamLearnings(`${HEADER}\n`);
    expect(res.changed).toBe(false);
    expect(res.entriesBefore).toBe(0);
    expect(utilityChat).not.toHaveBeenCalled();
  });
});

// ── memory_shrunk telemetry (remediation P0) ─────────────────────────────────

describe('memoryShrankOverThreshold (pure, remediation P0 memory_shrunk)', () => {
  test('flags a >30% byte shrink; tolerates smaller shrinks and growth', () => {
    expect(memoryShrankOverThreshold(1000, 699)).toBe(true);   // -30.1%
    expect(memoryShrankOverThreshold(1000, 700)).toBe(false);  // exactly -30% — threshold is EXCLUSIVE
    expect(memoryShrankOverThreshold(1000, 900)).toBe(false);
    expect(memoryShrankOverThreshold(1000, 2000)).toBe(false);
  });

  test('a 0/absent "before" never flags (first write is not a shrink)', () => {
    expect(memoryShrankOverThreshold(0, 0)).toBe(false);
    expect(memoryShrankOverThreshold(NaN as any, 10)).toBe(false);
  });
});

describe('noteMemoryReplace (site logic for the memory_shrunk row)', () => {
  beforeEach(() => mockRecordLoopMetric.mockClear());

  test('a REPLACE shrinking the blob >30% emits one memory_shrunk row with before/after bytes', () => {
    const before = { overview: 'x'.repeat(500), commands: ['a', 'b'], notes: ['n'.repeat(200)], updatedAt: '' };
    const after = { overview: 'tiny', commands: [], notes: [], updatedAt: '' };
    noteMemoryReplace('project', 'sess-1', before, after);
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    const row = mockRecordLoopMetric.mock.calls[0][0];
    expect(row.kind).toBe('memory_shrunk');
    expect(row.sessionId).toBe('sess-1');
    expect(row.unit).toBe('bytes');
    expect(row.meta.scope).toBe('project');
    expect(row.meta.beforeBytes).toBeGreaterThan(row.meta.afterBytes);
    expect(row.value).toBe(row.meta.beforeBytes - row.meta.afterBytes);
  });

  test('a same-size or growing replace emits nothing (normal churn)', () => {
    const blob = { preferences: ['prefers pnpm'], notes: [], updatedAt: '' };
    noteMemoryReplace('user', 'sess-1', blob, { ...blob, notes: ['more'] });
    noteMemoryReplace('user', 'sess-1', blob, blob);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  test('never throws on unserializable input (telemetry must not break the memory path)', () => {
    const circular: any = {};
    circular.self = circular;
    expect(() => noteMemoryReplace('project', 'sess-1', circular, {})).not.toThrow();
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });
});

// ── P6 (spark B22/G11): the per-turn project/user memory update is an LLM
// REPLACE — the shrink guard keeps the old entries and APPENDS instead when a
// replacement is suspiciously smaller. ───────────────────────────────────────
describe('memory shrink guard (P6 — B22/G11)', () => {
  const flush = () => new Promise(res => setTimeout(res, 0));
  const { storeGet, storePut } = jest.requireMock('../memory/context-store');
  const { recordLoopMetric } = jest.requireMock('../platform/loop-metrics.service');

  const bigProject: ProjectCodingMemory = {
    overview: 'A long-lived monorepo with a Next.js frontend and an Express backend, deployed blue-green on EC2.',
    commands: Array.from({ length: 12 }, (_, i) => `command-${i}: npx do-thing-${i} --with --long --flags`),
    notes: Array.from({ length: 12 }, (_, i) => `note-${i}: a hard-won convention about subsystem ${i} that took a full session to learn`),
    updatedAt: '2026-09-01T00:00:00.000Z',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (storeGet as jest.Mock).mockImplementation(async (ns: string[]) =>
      ns[1] === 'coding-project' ? bigProject : null);
  });

  test('constants pinned + memoryShrankSuspiciously fires only on BOTH conditions (<60% chars AND >10 lines dropped)', () => {
    expect(MEMORY_SHRINK_MIN_RATIO).toBe(0.6);
    expect(MEMORY_SHRINK_MAX_LINE_DROP).toBe(10);
    const old = Array.from({ length: 20 }, (_, i) => `entry ${i} with a reasonable amount of text on it`);
    expect(memoryShrankSuspiciously(old, old.slice(0, 5))).toBe(true);            // both trip
    expect(memoryShrankSuspiciously(old, old.slice(0, 15))).toBe(false);          // only 5 lines dropped
    const shorterButFew = [...old.slice(0, 12), 'x', 'y'];                        // >60% of chars kept
    expect(memoryShrankSuspiciously(old, shorterButFew)).toBe(false);
    expect(memoryShrankSuspiciously(['one line'], [])).toBe(false);               // small stores never trip
  });

  test('a suspicious project-memory REPLACE keeps the old entries, appends the new, and emits memory_shrunk', async () => {
    (utilityChat as jest.Mock)
      .mockResolvedValueOnce('Session summary text.') // session tier
      .mockResolvedValueOnce(JSON.stringify({          // project tier — the destructive replace
        overview: 'Tiny new overview.', commands: ['only-one-command'], notes: [],
      }))
      .mockResolvedValueOnce(JSON.stringify({ preferences: [], notes: [] })); // user tier (empty → no write)
    updateCodingMemoryAsync({
      userId: 'u1', projectId: 'p1', sessionId: 's1',
      userMessage: 'small tweak', assistantSummary: 'did a small tweak', toolsUsed: ['edit_file'],
    });
    await flush(); await flush();

    const projWrite = (storePut as jest.Mock).mock.calls.find((c: any[]) => c[0][1] === 'coding-project');
    expect(projWrite).toBeDefined();
    const stored = projWrite![2];
    // Old entries survive; the new ones are APPENDED, not substituted.
    expect(stored.commands).toEqual(expect.arrayContaining([...bigProject.commands, 'only-one-command']));
    expect(stored.notes).toEqual(expect.arrayContaining(bigProject.notes));
    expect(stored.overview).toContain(bigProject.overview);
    expect(stored.overview).toContain('shrink-guarded update');
    expect(stored.overview).toContain('Tiny new overview.');
    expect(recordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'memory_shrunk',
      meta: expect.objectContaining({ store: 'project' }),
    }));
  });

  test('a healthy same-size REPLACE passes through untouched (no guard, no metric)', async () => {
    const healthy = {
      overview: 'A long-lived monorepo with a Next.js frontend and an Express backend, deployed blue-green on EC2 (updated).',
      commands: bigProject.commands, notes: bigProject.notes,
    };
    (utilityChat as jest.Mock)
      .mockResolvedValueOnce('Session summary text.')
      .mockResolvedValueOnce(JSON.stringify(healthy))
      .mockResolvedValueOnce(JSON.stringify({ preferences: [], notes: [] }));
    updateCodingMemoryAsync({
      userId: 'u1', projectId: 'p1', sessionId: 's1',
      userMessage: 'refresh', assistantSummary: 'refreshed memory', toolsUsed: [],
    });
    await flush(); await flush();
    const projWrite = (storePut as jest.Mock).mock.calls.find((c: any[]) => c[0][1] === 'coding-project');
    expect(projWrite![2].overview).toBe(healthy.overview);
    expect(projWrite![2].commands).toEqual(healthy.commands.slice(0, 12));
    expect(recordLoopMetric).not.toHaveBeenCalled();
  });
});

// ── firing-10b (2026-09-23): the per-run project FOLD was truncating on large
// states — 1500 thinking-off cut the echoed 12+12-entry JSON mid-string
// (coding_project_fold parse_error 2/2 in the live audit, budget column NULL).
// Same rule as the 2026-09-22 dream now: reasoning on (shared kill switch),
// budget that fits the LARGEST legal answer, budget in the outcome row, and a
// healthy fold is no longer silent. ─────────────────────────────────────────
describe('updateCodingMemoryAsync project fold (firing-10b budget + reasoning)', () => {
  const flush = () => new Promise(res => setTimeout(res, 0));
  const { storeGet, storePut } = jest.requireMock('../memory/context-store');
  // 2026-10-20 memory wave: these pin the WHOLE-OBJECT fold (scaled echo budget, no salvage), which
  // is now the MEMORY_STATE_OPS_DISABLED=1 path — the kill switch must keep restoring it exactly. The
  // per-item ops fold is pinned in coding-memory.state-ops.test.ts.
  beforeAll(() => { process.env.MEMORY_STATE_OPS_DISABLED = '1'; });
  afterAll(() => { delete process.env.MEMORY_STATE_OPS_DISABLED; });

  beforeEach(() => {
    jest.clearAllMocks();
    (storeGet as jest.Mock).mockImplementation(async (ns: string[]) =>
      ns[1] === 'coding-project' ? { ...bigProjectFixture } : null);
  });

  const bigProjectFixture: ProjectCodingMemory = {
    overview: 'A long-lived monorepo with a Next.js frontend and an Express backend, deployed blue-green on EC2.',
    commands: Array.from({ length: 12 }, (_, i) => `command-${i}: npx do-thing-${i} --with --long --flags`),
    notes: Array.from({ length: 12 }, (_, i) => `note-${i}: a hard-won convention about subsystem ${i} that took a full session to learn`),
    updatedAt: '2026-09-01T00:00:00.000Z',
  };

  test('a truncated fold answer records parse_error WITH the budget, and the project memory is NOT replaced', async () => {
    (utilityChat as jest.Mock)
      .mockResolvedValueOnce('Session summary text.')
      .mockResolvedValueOnce('{\n  "overview": "A long-lived monorepo",\n  "commands": ["pnpm test", "pnpm bui') // cut mid-string by the token budget
      .mockResolvedValueOnce(JSON.stringify({ preferences: [], notes: [] }));
    updateCodingMemoryAsync({
      userId: 'u1', projectId: 'p1', sessionId: 's1',
      userMessage: 'big change', assistantSummary: 'did a big change', toolsUsed: ['edit_file'],
    });
    await flush(); await flush();
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({
      source: 'coding_project_fold', outcome: 'parse_error', budgetTokens: 3000,
    }));
    // Nothing was written to the project store — the truncated answer must not
    // wipe or half-replace the memory (the pre-fa945d380 silent-no-update shape).
    const projWrite = (storePut as jest.Mock).mock.calls.find((c: any[]) => c[0][1] === 'coding-project');
    expect(projWrite).toBeUndefined();
  });

  test('a clean fold answer records changed (not silence) and the call carries reasoning + the raised budget', async () => {
    const clean = JSON.stringify({
      overview: 'A long-lived monorepo with a Next.js frontend and an Express backend (updated).',
      commands: bigProjectFixture.commands, notes: [...bigProjectFixture.notes.slice(0, 11), 'new convention learned'],
    });
    (utilityChat as jest.Mock)
      .mockResolvedValueOnce('Session summary text.')
      .mockResolvedValueOnce(clean)
      .mockResolvedValueOnce(JSON.stringify({ preferences: [], notes: [] }));
    updateCodingMemoryAsync({
      userId: 'u1', projectId: 'p1', sessionId: 's1',
      userMessage: 'refresh', assistantSummary: 'refreshed memory', toolsUsed: [],
    });
    await flush(); await flush();
    // The FOLD call is the second utilityChat invocation (session tier is first).
    expect((utilityChat as jest.Mock).mock.calls[1][1]).toEqual(expect.objectContaining({
      thinking: true, retryNotFound: true,
    }));
    // Firing 11: the budget SCALES with the state actually echoed (floor 3000) —
    // a fixed budget can never fit an extractor that echoes its stored state.
    const shownChars = JSON.stringify({ overview: bigProjectFixture.overview, commands: bigProjectFixture.commands, notes: bigProjectFixture.notes }).length;
    expect((utilityChat as jest.Mock).mock.calls[1][1].maxTokens).toBe(codingMemoryEchoBudget(shownChars));
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({
      source: 'coding_project_fold', outcome: 'changed',
    }));
    const projWrite = (storePut as jest.Mock).mock.calls.find((c: any[]) => c[0][1] === 'coding-project');
    expect(projWrite![2].notes).toHaveLength(12);
    expect(projWrite![2].notes).toContain('new convention learned');
  });

  test('firing 11: oversized items are clamped on save so a legal 12+12 state stays under the echo ceiling', async () => {
    const withLongNote = JSON.stringify({
      overview: bigProjectFixture.overview,
      commands: bigProjectFixture.commands,
      notes: [...bigProjectFixture.notes.slice(0, 11), 'X'.repeat(1200)], // the 1,068-char measured growth vector
    });
    (utilityChat as jest.Mock)
      .mockResolvedValueOnce('Session summary text.')
      .mockResolvedValueOnce(withLongNote)
      .mockResolvedValueOnce(JSON.stringify({ preferences: [], notes: [] }));
    updateCodingMemoryAsync({
      userId: 'u1', projectId: 'p1', sessionId: 's1',
      userMessage: 'big note', assistantSummary: 'learned a huge convention', toolsUsed: [],
    });
    await flush(); await flush();
    const projWrite = (storePut as jest.Mock).mock.calls.find((c: any[]) => c[0][1] === 'coding-project');
    expect(projWrite).toBeDefined();
    for (const n of projWrite![2].notes) expect(n.length).toBeLessThanOrEqual(240);
    expect(projWrite![2].notes.join('')).toContain(' … '); // head+tail elision marker
  });
});

// 2026-09-22 audit: the nightly project dream had failed for EVERY project two
// nights running — a 600-token budget truncated the pretty-printed JSON, parse
// threw, `{}` came back and the only trace was a warn. Pins: a truncated answer
// records a parse_error outcome and KEEPS the memory (dreamAt stamped); a clean
// answer consolidates and records 'changed'; the call opts into reasoning with a
// budget that fits a full 12+12 answer.
describe('dreamCodingProjects (nightly coding-project consolidation)', () => {
  const { storeGet, storePut } = jest.requireMock('../memory/context-store');
  const prismaMock = jest.requireMock('../../../config/database').default;
  const existing: ProjectCodingMemory & { dreamAt?: string } = {
    overview: 'A Next.js app', commands: ['pnpm test', 'pnpm build'], notes: ['uses RSC', 'deploys to Amplify'], updatedAt: '2026-09-20T00:00:00.000Z',
  };
  // 2026-10-20 memory wave: the WHOLE-OBJECT dream (scaled echo budget) is the
  // MEMORY_STATE_OPS_DISABLED=1 path; the ops dream is pinned in coding-memory.state-ops.test.ts.
  beforeAll(() => { process.env.MEMORY_STATE_OPS_DISABLED = '1'; });
  afterAll(() => { delete process.env.MEMORY_STATE_OPS_DISABLED; });
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.chatCodingState.findMany.mockImplementation(async (args: any) => (args?.select?.projectId ? [{ projectId: 'p1' }] : [{ id: 's1' }]));
    storeGet.mockImplementation(async (ns: string[], _key: string) => {
      if (ns[1] === 'coding-project') return { ...existing };
      if (ns[1] === 'coding-session') return { summary: 'Added auth pages and fixed the Amplify redirects.', updatedAt: '' };
      return null;
    });
  });

  test('a truncated JSON answer records parse_error and keeps the existing memory (dreamAt stamped, nothing erased)', async () => {
    utilityChat.mockResolvedValueOnce('{\n  "overview": "A Next.js app with auth",\n  "commands": ["pnpm test", "pnpm bui'); // cut mid-string by the token budget
    const n = await dreamCodingProjects();
    expect(n).toBe(0);
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({ source: 'coding_project_dream', outcome: 'parse_error', userId: 'p1' }));
    const put = storePut.mock.calls.find((c: any[]) => c[0][1] === 'coding-project');
    expect(put[2]).toEqual(expect.objectContaining({ overview: 'A Next.js app', commands: existing.commands, notes: existing.notes, dreamAt: expect.any(String) }));
  });

  // Firing 13 (2026-09-24): the dream SCALES its budget (f5af259db) but its
  // outcome rows never carried budgetTokens — the live audit read min_budget/
  // max_budget NULL on all 13 in-window dream rows while the fold's read
  // 3000–3300. A truncation on this node was undiagnosable by row (which leg,
  // what budget). The rows now carry both, mirroring the fold.
  test('firing 13: a dream parse_error carries the SCALED budget AND the provider leg/finishReason (7555d2f6a class, dream half)', async () => {
    const dreamShownChars = JSON.stringify({ overview: existing.overview, commands: existing.commands, notes: existing.notes }).length;
    utilityChat.mockImplementationOnce(async (_m: any[], opts: any) => {
      opts?.onMeta?.({ leg: 'deepseek', model: 'deepseek-flash', finishReason: 'length' }); // the truncation signature
      return '{\n  "overview": "A Next.js app with auth",\n  "commands": ["pnpm test", "pnpm bui';
    });
    const n = await dreamCodingProjects();
    expect(n).toBe(0);
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({
      source: 'coding_project_dream', outcome: 'parse_error', userId: 'p1',
      budgetTokens: codingMemoryEchoBudget(dreamShownChars),
      leg: 'deepseek', finishReason: 'length',
    }));
  });

  test('a clean answer consolidates, records changed, and the call carries reasoning + a budget that fits a full answer', async () => {
    utilityChat.mockResolvedValueOnce(JSON.stringify({ overview: 'A Next.js app with auth pages', commands: ['pnpm test', 'pnpm build'], notes: ['uses RSC', 'deploys to Amplify', 'auth pages under /app/(auth)'] }));
    const n = await dreamCodingProjects();
    expect(n).toBe(1);
    // Firing 11: the dream budget SCALES with the echoed state (was a fixed
    // 2000 — the same echo-truncation class the fold hit at 3000).
    const dreamShownChars = JSON.stringify({ overview: existing.overview, commands: existing.commands, notes: existing.notes }).length;
    expect(utilityChat.mock.calls[0][1]).toEqual(expect.objectContaining({ thinking: true, maxTokens: codingMemoryEchoBudget(dreamShownChars) }));
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({ source: 'coding_project_dream', outcome: 'changed' }));
    const put = storePut.mock.calls.find((c: any[]) => c[0][1] === 'coding-project');
    expect(put[2].notes).toHaveLength(3);
  });

  test('firing 13: a healthy dream row also carries the scaled budget (changed rows prove the fix live, not just failures)', async () => {
    utilityChat.mockResolvedValueOnce(JSON.stringify({ overview: 'A Next.js app', commands: ['pnpm test'], notes: ['uses RSC'] }));
    const n = await dreamCodingProjects();
    expect(n).toBe(1);
    const dreamShownChars = JSON.stringify({ overview: existing.overview, commands: existing.commands, notes: existing.notes }).length;
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({
      source: 'coding_project_dream', outcome: 'changed', budgetTokens: codingMemoryEchoBudget(dreamShownChars),
    }));
  });
});
