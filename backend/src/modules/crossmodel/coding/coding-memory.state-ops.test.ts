/**
 * coding-memory — per-item ops for the per-run FOLD, the user-prefs leg and the nightly project DREAM
 * (2026-10-20 memory wave, memory/state-ops.ts).
 *
 * Why: the fold and the dream re-emitted the WHOLE stored memory, so their answer grew with the state
 * and eventually outgrew any budget (1500 → 3000 → scaled to 8000). The regression simulator below is a
 * model that answers in the shape it is asked for: it spends half of a thinking call's budget reasoning
 * (max_tokens covers reasoning + answer) and writes JSON at 2 chars/token — the ratio
 * codingMemoryEchoBudget itself assumes. Asked to ECHO a memory at its caps, its answer is cut and
 * nothing parses (today's path); asked for the CHANGES, the answer fits a fixed budget.
 *
 * Boundary-mocked like coding-memory.test.ts; the real engine (state-ops + model-json) runs.
 */

jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { chatCodingState: { findMany: jest.fn(async () => []) } },
}));
jest.mock('../rag.service', () => ({ __esModule: true, embedTexts: jest.fn(), rerankTexts: jest.fn() }));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { MEMORY_SHRUNK: 'memory_shrunk', INDEX_SWEPT: 'index_swept' },
}));
const mockRecordExtractionOutcome: jest.Mock = jest.fn();
jest.mock('../memory/memory-audit', () => ({
  recordExtractionOutcome: (...a: any[]) => mockRecordExtractionOutcome(...a),
  extractionDetailOf: (raw: unknown) => String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
  parseModelJson: (text: unknown) => jest.requireActual('../memory/model-json').parseModelJson(text),
}));

import {
  updateCodingMemoryAsync, dreamCodingProjects, codingMemoryEchoBudget,
  PROJECT_MEMORY_OPS_SPEC, CODING_PROJECT_FOLD_OPS_BUDGET_TOKENS, CODING_PROJECT_DREAM_OPS_BUDGET_TOKENS,
  CODING_USER_FOLD_OPS_BUDGET_TOKENS, PROJECT_DREAM_MAX_REMOVE_RATIO, MEMORY_SHRINK_MAX_LINE_DROP,
  opsFoldRemovalRefused, projectDreamRemovalRefused,
  type ProjectCodingMemory, type UserCodingMemory,
} from './coding-memory.service';
import { maxOpsAnswerChars } from '../memory/state-ops';

const { utilityChat } = jest.requireMock('../../../utils/utility-llm');
const { storeGet, storePut } = jest.requireMock('../memory/context-store');
const { recordLoopMetric } = jest.requireMock('../platform/loop-metrics.service');
const logger = jest.requireMock('../../../utils/logger').default;
const prismaMock = jest.requireMock('../../../config/database').default;

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };

// ── the model simulator ──────────────────────────────────────────────────────
const SIM_REASONING_SHARE = 0.5; // a thinking call spends this share of max_tokens before answering
const SIM_CHARS_PER_TOKEN = 2;   // codingMemoryEchoBudget's own ratio (0.5 output tokens per char)
const asksForOps = (prompt: string) => prompt.includes('Return ONLY the CHANGES');
function simulate(prompt: string, opts: any, wholeObject: unknown, ops: unknown): string {
  const full = asksForOps(prompt) ? JSON.stringify(ops) : JSON.stringify(wholeObject, null, 2);
  const room = Math.floor(opts.maxTokens * (opts.thinking ? 1 - SIM_REASONING_SHARE : 1) * SIM_CHARS_PER_TOKEN);
  return full.slice(0, room);
}

/** Distinct 240-char items (no whitespace to collapse, so the engine leaves them byte-identical). */
const item = (p: string, i: number, len = 240) => `${p}-${String(i).padStart(2, '0')}:${'abcdefghij'.repeat(30)}`.slice(0, len);
const AT_CAPS: ProjectCodingMemory = {
  overview: item('overview', 0),
  commands: Array.from({ length: 12 }, (_, i) => item('command', i)),
  notes: Array.from({ length: 12 }, (_, i) => item('note', i)),
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const NEW_NOTE = 'migrations are hand-written with prisma migrate diff; production runs migrate deploy only';
const RUN = { userId: 'u1', projectId: 'p1', sessionId: 's1', userMessage: 'add the migration', assistantSummary: 'wrote the migration by hand with migrate diff', toolsUsed: ['run_command'] };

const isFold = (p: string) => p.includes('DURABLE memory about a codebase');
const isUserLeg = (p: string) => p.includes('CROSS-PROJECT preferences');
const isSession = (p: string) => p.includes('rolling summary');

function routeModel(answers: { fold?: (p: string, o: any) => string; user?: (p: string, o: any) => string }) {
  (utilityChat as jest.Mock).mockImplementation(async (msgs: any[], opts: any) => {
    const p = msgs[0].content as string;
    if (isSession(p)) return 'Session summary text.';
    if (isFold(p)) return answers.fold ? answers.fold(p, opts) : '{}';
    if (isUserLeg(p)) return answers.user ? answers.user(p, opts) : '{}';
    return '';
  });
}
const callFor = (pred: (p: string) => boolean) => (utilityChat as jest.Mock).mock.calls.find((c: any[]) => pred(c[0][0].content));
const projectWrite = () => (storePut as jest.Mock).mock.calls.find((c: any[]) => c[0][1] === 'coding-project');
const userWrite = () => (storePut as jest.Mock).mock.calls.find((c: any[]) => c[0][1] === 'coding-user');
const foldRow = () => mockRecordExtractionOutcome.mock.calls.map(c => c[0]).find(r => r.source === 'coding_project_fold');

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.MEMORY_STATE_OPS_DISABLED;
});

describe('per-run project fold as ops (regression: the echo at caps no longer fits — the change does)', () => {
  beforeEach(() => {
    (storeGet as jest.Mock).mockImplementation(async (ns: string[]) => (ns[1] === 'coding-project' ? JSON.parse(JSON.stringify(AT_CAPS)) : null));
  });
  const wholeObjectWithNewNote = { overview: AT_CAPS.overview, commands: AT_CAPS.commands, notes: [NEW_NOTE, ...AT_CAPS.notes.slice(0, 11)] };

  test('a memory at its caps: the ops answer lands with a fixed budget; the new note goes first and the oldest is evicted', async () => {
    routeModel({ fold: (p, o) => simulate(p, o, wholeObjectWithNewNote, { add: { notes: [NEW_NOTE] } }) });
    updateCodingMemoryAsync(RUN);
    await flush();
    const call = callFor(isFold)!;
    expect(call[1]).toEqual(expect.objectContaining({ maxTokens: CODING_PROJECT_FOLD_OPS_BUDGET_TOKENS, thinking: true, contentOnly: true }));
    // The model is shown every item behind a stable id, and asked for the changes only.
    expect(call[0][0].content).toContain('[C1] command-00');
    expect(call[0][0].content).toContain('[N12] note-11');
    expect(call[0][0].content).toContain('Return {} when nothing should change');
    const stored = projectWrite()![2];
    expect(stored.notes).toHaveLength(12);
    expect(stored.notes[0]).toBe(NEW_NOTE);
    expect(stored.notes.slice(1)).toEqual(AT_CAPS.notes.slice(0, 11)); // note-11 (the oldest) evicted
    expect(stored.commands).toEqual(AT_CAPS.commands);
    expect(stored.overview).toBe(AT_CAPS.overview);
    expect(foldRow()).toEqual(expect.objectContaining({ outcome: 'changed', budgetTokens: CODING_PROJECT_FOLD_OPS_BUDGET_TOKENS }));
    expect(foldRow().detail).toMatch(/add=1/);
    expect(foldRow().detail).toMatch(/evicted=1/);
    // The eviction is logged (nothing else happens with it).
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/evicted 1 oldest item/));
  });

  test('MEMORY_STATE_OPS_DISABLED=1 restores the whole-object fold — and the same model then truncates at the scaled budget (today\'s failure)', async () => {
    process.env.MEMORY_STATE_OPS_DISABLED = '1';
    routeModel({ fold: (p, o) => simulate(p, o, wholeObjectWithNewNote, { add: { notes: [NEW_NOTE] } }) });
    updateCodingMemoryAsync(RUN);
    await flush();
    const shownChars = JSON.stringify({ overview: AT_CAPS.overview, commands: AT_CAPS.commands, notes: AT_CAPS.notes }).length;
    const call = callFor(isFold)!;
    expect(call[1].maxTokens).toBe(codingMemoryEchoBudget(shownChars));
    expect(call[0][0].content).toContain('Return ONLY valid JSON:\n{"overview": "...", "commands": ["cmd"], "notes": ["note"]}');
    expect(foldRow()).toEqual(expect.objectContaining({ outcome: 'parse_error', budgetTokens: codingMemoryEchoBudget(shownChars) }));
    expect(projectWrite()).toBeUndefined(); // the learned fact is lost
  });

  test('{} is a noop: nothing written, no shrink row, a noop outcome with the budget', async () => {
    routeModel({ fold: () => '{}' });
    updateCodingMemoryAsync(RUN);
    await flush();
    expect(projectWrite()).toBeUndefined();
    expect(recordLoopMetric).not.toHaveBeenCalled();
    expect(foldRow()).toEqual(expect.objectContaining({ outcome: 'noop', budgetTokens: CODING_PROJECT_FOLD_OPS_BUDGET_TOKENS }));
  });

  test('update / remove by id and set the overview', async () => {
    routeModel({ fold: () => JSON.stringify({ set: { overview: 'A billing monorepo (Next.js + Express).' }, update: { C2: 'pnpm test --run' }, remove: ['N3'] }) });
    updateCodingMemoryAsync(RUN);
    await flush();
    const stored = projectWrite()![2];
    expect(stored.overview).toBe('A billing monorepo (Next.js + Express).');
    expect(stored.commands[1]).toBe('pnpm test --run');
    expect(stored.notes).toHaveLength(11);
    expect(stored.notes).not.toContain(AT_CAPS.notes[2]);
    expect(Object.keys(stored).sort()).toEqual(['commands', 'notes', 'overview', 'updatedAt']);
  });

  test('shrink guard for ops: an answer removing more than MEMORY_SHRINK_MAX_LINE_DROP items is refused (memory kept, memory_shrunk row)', async () => {
    const ids = [...Array.from({ length: 6 }, (_, i) => `C${i + 1}`), ...Array.from({ length: 5 }, (_, i) => `N${i + 1}`)]; // 11 removals
    routeModel({ fold: () => JSON.stringify({ remove: ids, add: { notes: ['one new note'] } }) });
    updateCodingMemoryAsync(RUN);
    await flush();
    expect(projectWrite()).toBeUndefined();
    expect(recordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'memory_shrunk', meta: expect.objectContaining({ store: 'project', mode: 'ops', refused: true, removed: 11 }),
    }));
    expect(foldRow()).toEqual(expect.objectContaining({ outcome: 'noop' }));
    expect(foldRow().detail).toMatch(/shrink guard refused/);
  });

  test('…while removals within the tolerance apply', async () => {
    const ids = Array.from({ length: MEMORY_SHRINK_MAX_LINE_DROP }, (_, i) => `N${i + 1}`);
    routeModel({ fold: () => JSON.stringify({ remove: ids }) });
    updateCodingMemoryAsync(RUN);
    await flush();
    expect(projectWrite()![2].notes).toEqual(AT_CAPS.notes.slice(MEMORY_SHRINK_MAX_LINE_DROP));
    expect(recordLoopMetric).not.toHaveBeenCalled();
    expect(opsFoldRemovalRefused(MEMORY_SHRINK_MAX_LINE_DROP)).toBe(false);
    expect(opsFoldRemovalRefused(MEMORY_SHRINK_MAX_LINE_DROP + 1)).toBe(true);
  });

  test('clearing the overview counts as a removal toward the guard', async () => {
    const ids = Array.from({ length: MEMORY_SHRINK_MAX_LINE_DROP }, (_, i) => `N${i + 1}`);
    routeModel({ fold: () => JSON.stringify({ remove: ids, set: { overview: '' } }) });
    updateCodingMemoryAsync(RUN);
    await flush();
    expect(projectWrite()).toBeUndefined();
  });

  test('a truncated ops answer keeps its complete groups (salvage)', async () => {
    routeModel({ fold: () => '{"set": {"overview": "Billing monorepo."}, "add": {"notes": ["first", "seco' });
    updateCodingMemoryAsync(RUN);
    await flush();
    const stored = projectWrite()![2];
    expect(stored.overview).toBe('Billing monorepo.');
    expect(stored.notes).toEqual(AT_CAPS.notes);
    expect(foldRow().detail).toMatch(/salvaged/);
  });

  test('a model that still answers the OLD whole-object shape is honoured (replace semantics, never lost)', async () => {
    routeModel({ fold: () => JSON.stringify({ overview: AT_CAPS.overview, commands: ['pnpm test', ...AT_CAPS.commands.slice(0, 11)], notes: AT_CAPS.notes }) });
    updateCodingMemoryAsync(RUN);
    await flush();
    const stored = projectWrite()![2];
    expect(stored.commands[0]).toBe('pnpm test');
    expect(stored.commands).toHaveLength(12);
    expect(foldRow()).toEqual(expect.objectContaining({ outcome: 'changed', budgetTokens: CODING_PROJECT_FOLD_OPS_BUDGET_TOKENS }));
    expect(foldRow().detail).toMatch(/legacy-shape/);
  });

  test('prose / unparseable answers record parse_error and write nothing', async () => {
    routeModel({ fold: () => 'Nothing durable here.' });
    updateCodingMemoryAsync(RUN);
    await flush();
    expect(projectWrite()).toBeUndefined();
    expect(foldRow()).toEqual(expect.objectContaining({ outcome: 'parse_error', budgetTokens: CODING_PROJECT_FOLD_OPS_BUDGET_TOKENS }));
  });
});

describe('user-prefs leg as ops (it re-emitted two lists at 400 tokens — the same echo class)', () => {
  const USER_AT_CAPS: UserCodingMemory = {
    preferences: Array.from({ length: 15 }, (_, i) => item('pref', i, 100)),
    notes: Array.from({ length: 10 }, (_, i) => item('unote', i, 100)),
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
  beforeEach(() => {
    (storeGet as jest.Mock).mockImplementation(async (ns: string[]) => (ns[1] === 'coding-user' ? JSON.parse(JSON.stringify(USER_AT_CAPS)) : null));
  });
  const NEW_PREF = 'prefers pnpm workspaces over npm';
  const whole = { preferences: [NEW_PREF, ...USER_AT_CAPS.preferences.slice(0, 14)], notes: USER_AT_CAPS.notes };

  test('at caps: the ops answer lands (new preference first, oldest evicted) within the same 400 tokens', async () => {
    routeModel({ user: (p, o) => simulate(p, o, whole, { add: { preferences: [NEW_PREF] } }) });
    updateCodingMemoryAsync(RUN);
    await flush();
    const call = callFor(isUserLeg)!;
    expect(call[1].maxTokens).toBe(CODING_USER_FOLD_OPS_BUDGET_TOKENS);
    expect(call[0][0].content).toContain('[P15] pref-14');
    const stored = userWrite()![2];
    expect(stored.preferences[0]).toBe(NEW_PREF);
    expect(stored.preferences).toHaveLength(15);
    expect(stored.preferences).not.toContain(USER_AT_CAPS.preferences[14]);
    expect(stored.notes).toEqual(USER_AT_CAPS.notes);
  });

  test('MEMORY_STATE_OPS_DISABLED=1 restores the whole-object leg — which the same model cannot fit (nothing stored)', async () => {
    process.env.MEMORY_STATE_OPS_DISABLED = '1';
    routeModel({ user: (p, o) => simulate(p, o, whole, { add: { preferences: [NEW_PREF] } }) });
    updateCodingMemoryAsync(RUN);
    await flush();
    const call = callFor(isUserLeg)!;
    expect(call[1].maxTokens).toBe(400);
    expect(call[0][0].content).toContain('Return ONLY valid JSON: {"preferences": ["..."], "notes": ["..."]}');
    expect(userWrite()).toBeUndefined();
  });

  test('{} writes nothing; a mass removal is refused', async () => {
    routeModel({ user: () => '{}' });
    updateCodingMemoryAsync(RUN);
    await flush();
    expect(userWrite()).toBeUndefined();
    jest.clearAllMocks();
    routeModel({ user: () => JSON.stringify({ remove: Array.from({ length: 11 }, (_, i) => `P${i + 1}`) }) });
    updateCodingMemoryAsync(RUN);
    await flush();
    expect(userWrite()).toBeUndefined();
    expect(recordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'memory_shrunk', meta: expect.objectContaining({ store: 'user', mode: 'ops', refused: true }) }));
  });
});

describe('nightly project dream as ops', () => {
  const existing: ProjectCodingMemory = {
    overview: 'A Next.js app',
    commands: ['pnpm test', 'pnpm build', 'pnpm lint'],
    notes: ['uses RSC', 'uses React Server Components for every page', 'deploys to Amplify'],
    updatedAt: '2026-09-20T00:00:00.000Z',
  };
  let stored: ProjectCodingMemory;
  beforeEach(() => {
    stored = JSON.parse(JSON.stringify(existing));
    prismaMock.chatCodingState.findMany.mockImplementation(async (args: any) => (args?.select?.projectId ? [{ projectId: 'p1' }] : [{ id: 's1' }]));
    (storeGet as jest.Mock).mockImplementation(async (ns: string[]) => {
      if (ns[1] === 'coding-project') return JSON.parse(JSON.stringify(stored));
      if (ns[1] === 'coding-session') return { summary: 'Added auth pages; RSC everywhere.', updatedAt: '' };
      return null;
    });
  });
  const dreamRow = () => mockRecordExtractionOutcome.mock.calls.map(c => c[0]).find(r => r.source === 'coding_project_dream');

  test('the dream budget is FIXED and bounded by the spec (never by the stored state)', () => {
    expect(CODING_PROJECT_DREAM_OPS_BUDGET_TOKENS).toBe(4000);
    expect(CODING_PROJECT_DREAM_OPS_BUDGET_TOKENS).toBeGreaterThanOrEqual(maxOpsAnswerChars(PROJECT_MEMORY_OPS_SPEC) * 0.5);
  });

  test('merging duplicates = update one + remove the others; overview refreshed by set; reasoning on, fixed budget', async () => {
    (utilityChat as jest.Mock).mockResolvedValueOnce(JSON.stringify({
      update: { N1: 'uses React Server Components (RSC) for every page' }, remove: ['N2'], set: { overview: 'A Next.js app with auth pages' },
    }));
    expect(await dreamCodingProjects()).toBe(1);
    const call = (utilityChat as jest.Mock).mock.calls[0];
    expect(call[1]).toEqual(expect.objectContaining({ thinking: true, contentOnly: true, maxTokens: CODING_PROJECT_DREAM_OPS_BUDGET_TOKENS }));
    expect(call[0][0].content).toContain('[N2] uses React Server Components for every page');
    expect(call[0][0].content).toContain('UPDATE one of them by its [id]');
    const put = (storePut as jest.Mock).mock.calls.find((c: any[]) => c[0][1] === 'coding-project')![2];
    expect(put.notes).toEqual(['uses React Server Components (RSC) for every page', 'deploys to Amplify']);
    expect(put.overview).toBe('A Next.js app with auth pages');
    expect(put.commands).toEqual(existing.commands);
    expect(put.dreamAt).toEqual(expect.any(String));
    expect(dreamRow()).toEqual(expect.objectContaining({ outcome: 'changed', budgetTokens: CODING_PROJECT_DREAM_OPS_BUDGET_TOKENS }));
    expect(dreamRow().detail).toMatch(/^3 cmds, 2 notes; ops/);
  });

  test('{} is a noop: memory kept (dreamAt stamped), a noop row, nothing counted as dreamt', async () => {
    (utilityChat as jest.Mock).mockResolvedValueOnce('{}');
    expect(await dreamCodingProjects()).toBe(0);
    const put = (storePut as jest.Mock).mock.calls.find((c: any[]) => c[0][1] === 'coding-project')![2];
    expect(put).toEqual(expect.objectContaining({ overview: existing.overview, commands: existing.commands, notes: existing.notes, dreamAt: expect.any(String) }));
    expect(dreamRow()).toEqual(expect.objectContaining({ outcome: 'noop', budgetTokens: CODING_PROJECT_DREAM_OPS_BUDGET_TOKENS }));
  });

  describe('removal-ratio guard (a mass removal is rejected, the memory kept)', () => {
    const big: ProjectCodingMemory = {
      overview: 'A long-lived monorepo',
      commands: Array.from({ length: 12 }, (_, i) => `command ${i}: npx do-thing-${i}`),
      notes: Array.from({ length: 12 }, (_, i) => `note ${i}: a hard-won convention about subsystem ${i}`),
      updatedAt: '2026-09-20T00:00:00.000Z',
    };
    beforeEach(() => { stored = JSON.parse(JSON.stringify(big)); });
    const keptPut = () => (storePut as jest.Mock).mock.calls.find((c: any[]) => c[0][1] === 'coding-project')![2];

    test('an ops answer removing 20 of 25 lines is rejected', async () => {
      const ids = [...Array.from({ length: 10 }, (_, i) => `C${i + 1}`), ...Array.from({ length: 10 }, (_, i) => `N${i + 1}`)];
      (utilityChat as jest.Mock).mockResolvedValueOnce(JSON.stringify({ remove: ids }));
      expect(await dreamCodingProjects()).toBe(0);
      expect(keptPut()).toEqual(expect.objectContaining({ commands: big.commands, notes: big.notes, dreamAt: expect.any(String) }));
      expect(dreamRow()).toEqual(expect.objectContaining({ outcome: 'noop' }));
      expect(dreamRow().detail).toMatch(/^removal guard: 20\/25 lines/);
      // Ticket 585e2688 (log-signal family, 2026-10-30): the guard REFUSING an
      // over-aggressive dream is the guard working — the refusal is the
      // product, and it is already recorded durably on the extraction_outcome
      // row asserted just above. It was a warn, so the sweep filed this
      // designed outcome as a standing defect (24 rows / 13 hours) forever.
      // It is now logClass:'handled' at INFO (never persisted by the warn+
      // transport). Message text unchanged, so greps/audit pins still match.
      expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/would remove 20\/25 lines/), expect.objectContaining({ logClass: 'handled' }));
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringMatching(/would remove 20\/25 lines/));
    });

    test('a whole-object answer that keeps 4 of 25 lines is rejected too (the old shape gets no free pass)', async () => {
      (utilityChat as jest.Mock).mockResolvedValueOnce(JSON.stringify({ overview: big.overview, commands: big.commands.slice(0, 2), notes: big.notes.slice(0, 1) }));
      expect(await dreamCodingProjects()).toBe(0);
      expect(keptPut()).toEqual(expect.objectContaining({ commands: big.commands, notes: big.notes }));
    });

    test('an answer that would empty the memory hits the anti-wipe rule first', async () => {
      const all = [...big.commands.map((_, i) => `C${i + 1}`), ...big.notes.map((_, i) => `N${i + 1}`)];
      (utilityChat as jest.Mock).mockResolvedValueOnce(JSON.stringify({ remove: all, set: { overview: '' } }));
      expect(await dreamCodingProjects()).toBe(0);
      expect(keptPut()).toEqual(expect.objectContaining({ overview: big.overview, commands: big.commands, notes: big.notes }));
      expect(dreamRow().detail).toMatch(/^anti-wipe/);
    });

    test('a consolidation within the ratio applies', async () => {
      (utilityChat as jest.Mock).mockResolvedValueOnce(JSON.stringify({ remove: ['C1', 'C2', 'N1', 'N2'] }));
      expect(await dreamCodingProjects()).toBe(1);
      expect(keptPut().commands).toEqual(big.commands.slice(2));
      expect(projectDreamRemovalRefused(12, 25)).toBe(false);
      expect(projectDreamRemovalRefused(13, 25)).toBe(true);
      expect(PROJECT_DREAM_MAX_REMOVE_RATIO).toBe(0.5);
    });
  });

  test('a truncated / unparseable answer records parse_error with the fixed budget and keeps the memory', async () => {
    (utilityChat as jest.Mock).mockImplementationOnce(async (_m: any[], opts: any) => {
      opts?.onMeta?.({ leg: 'deepseek', model: 'deepseek-flash', finishReason: 'length' });
      return '{"update": {"N1": "uses React Server Comp';
    });
    expect(await dreamCodingProjects()).toBe(0);
    expect(dreamRow()).toEqual(expect.objectContaining({ outcome: 'parse_error', budgetTokens: CODING_PROJECT_DREAM_OPS_BUDGET_TOKENS, leg: 'deepseek', finishReason: 'length' }));
    const put = (storePut as jest.Mock).mock.calls.find((c: any[]) => c[0][1] === 'coding-project')![2];
    expect(put).toEqual(expect.objectContaining({ notes: existing.notes, dreamAt: expect.any(String) }));
  });

  test('MEMORY_STATE_OPS_DISABLED=1 restores the whole-object dream prompt + scaled budget', async () => {
    process.env.MEMORY_STATE_OPS_DISABLED = '1';
    (utilityChat as jest.Mock).mockResolvedValueOnce(JSON.stringify({ overview: 'A Next.js app', commands: ['pnpm test'], notes: ['uses RSC'] }));
    expect(await dreamCodingProjects()).toBe(1);
    const call = (utilityChat as jest.Mock).mock.calls[0];
    expect(call[0][0].content).toContain('Return ONLY valid JSON: {"overview": "...", "commands": ["..."], "notes": ["..."]}');
    expect(call[1].maxTokens).toBe(codingMemoryEchoBudget(JSON.stringify({ overview: existing.overview, commands: existing.commands, notes: existing.notes }).length));
    // the whole-object dream replaces wholesale (no ratio guard on that path)
    const put = (storePut as jest.Mock).mock.calls.find((c: any[]) => c[0][1] === 'coding-project')![2];
    expect(put.notes).toEqual(['uses RSC']);
  });
});
