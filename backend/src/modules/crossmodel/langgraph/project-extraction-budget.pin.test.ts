// project-extraction-budget.pin.test.ts — Framework Operator pin (2026-09-23 firing 7).
// PROD INCIDENT CLASS (memory_extraction telemetry, post-f7b0d29f window 00:39Z→03:56Z):
// the project extraction node still ran 10 parse_errors / 59 calls (16.9 % — the
// charter threshold is 10 %) with cut-off-mid-string tails, ALL on the largest
// stored states:
//   CanLaw 12,395 B (10 decisions + 10 open items — every array at its legal cap;
//   item LENGTH was the growth vector: one "decision" carried a paragraph of ids),
//   three more states at 9.1–9.7 kB, five at 4–8 kB.
// Root cause: the prompt ECHOES the full existing state back inside maxTokens —
// a fixed 4000-token budget cannot hold a 12.4k-char echo (~6k output tokens),
// so JSON.parse threw and the state silently kept as-is (the parse_error return
// precedes any write). This is the SECOND raise on this node (768→2000→4000 all
// truncated the largest states) — the fix is structural, not another guess:
//   1. projectExtractionBudget(shownChars) scales the budget with the state the
//      model must echo (floor 4000, ceiling 8000, ~0.5 tokens/char + headroom).
//   2. clampProjectStateItems bounds every saved state to ≤180 chars/item
//      so an unbounded echo can never form again — the array CAP alone never bounded item length.
//   3. The prompt embeds at most PROJECT_STATE_EMBED_MAX_CHARS (told when
//      partial) and the budget actually used is recorded in the metric
//      (budgetTokens) for live audit.
// The behavioral tests import the real module through the machine-run suite's
// proven mock header (prisma/redis/env-heavy transitive imports all stubbed).

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFindUnique: jest.Mock = jest.fn();
const mockUpsert: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { userMemory: { findUnique: (...a: any[]) => mockFindUnique(...a), upsert: (...a: any[]) => mockUpsert(...a) } },
}));
jest.mock('../context.service', () => ({
  __esModule: true,
  default: {},
  capHistoryToCharBudget: jest.fn(),
  MACHINE_WAKE_HISTORY_CHAR_BUDGET: 0,
  MACHINE_WAKE_MAX_PAIRS: 0,
}));

const mockUtilityChat: jest.Mock = jest.fn();
jest.mock('../../../utils/utility-llm', () => ({ utilityChat: (...a: any[]) => mockUtilityChat(...a) }));

const mockMemStore: jest.Mock = jest.fn();
const mockEnforceScopeCap: jest.Mock = jest.fn(async () => {});
jest.mock('../memory/unified-memory.service', () => ({
  memStore: (...a: any[]) => mockMemStore(...a),
  enforceScopeCap: (...a: any[]) => mockEnforceScopeCap(...a),
}));

// Env-heavy transitive imports (user-facts → config/redis → config/env exits
// the process without env vars).
jest.mock('../memory/user-facts.service', () => ({
  selectRelevantFacts: jest.fn(),
  syncUserFactRows: jest.fn(),
}));
const mockRecordExtraction: jest.Mock = jest.fn();
jest.mock('../memory/memory-audit', () => ({
  recordMemoryMutation: jest.fn(),
  recordExtractionOutcome: (...a: any[]) => mockRecordExtraction(...a),
  parseModelJson: (text: unknown) => { const raw = String(text ?? '').replace(/```json\n?|\n?```/g, '').trim(); if (!raw) return null; try { return JSON.parse(raw); } catch {} const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a, b + 1)); } catch {} } return null; },
  countVisibleFacts: (facts: Record<string, unknown>) => Object.keys(facts || {}).filter((k) => !k.startsWith('__')).length,
}));
jest.mock('../memory/episodic.service', () => ({ buildEpisodicBlock: jest.fn() }));
jest.mock('../memory-relevance', () => ({
  filterFactsByRelevance: jest.fn(),
  isTextRelevantToMessage: jest.fn(),
}));

const mockStoreGet: jest.Mock = jest.fn();
const mockStorePut: jest.Mock = jest.fn();
jest.mock('../memory/context-store', () => ({
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: (...a: any[]) => mockStorePut(...a),
}));
const mockGetMerged: jest.Mock = jest.fn();
jest.mock('../platform/folder-inheritance', () => ({ getMergedProjectStoreState: (...a: any[]) => mockGetMerged(...a) }));

import {
  clampProjectStateItems,
  projectExtractionBudget,
  runUpdateContextPipeline,
  PROJECT_OPS_BUDGET_TOKENS,
} from './memory.graph';

describe('projectExtractionBudget — the echo must fit the budget (2026-09-23 class)', () => {
  test('floor 4000 (fa915ba0), scales past it for big states, ceiling 8000', () => {
    expect(projectExtractionBudget(0)).toBe(4000);        // fresh project — floor
    expect(projectExtractionBudget(2000)).toBe(4000);     // small state
    expect(projectExtractionBudget(6000)).toBe(4000);     // 6000*0.5+1000=4000 → floor
    expect(projectExtractionBudget(10000)).toBe(6000);    // CanLaw-scale compact state
    expect(projectExtractionBudget(12395)).toBe(7200);    // the measured live state
    expect(projectExtractionBudget(40000)).toBe(8000);    // ceiling — mis-extracted state
  });
});

describe('clampProjectStateItems — item LENGTH is the growth vector; bound it on save', () => {
  test('items >180 chars are elided head+tail; short items untouched', () => {
    const long = 'X'.repeat(400);
    const clamped = clampProjectStateItems({ summary: 'short', recentDecisions: [long, 'keep me'], openItems: [], entities: { people: [long], amounts: [], places: [], topics: [] } });
    expect(clamped.recentDecisions[0].length).toBeLessThanOrEqual(180);
    expect(clamped.recentDecisions[0]).toContain('…');
    expect(clamped.recentDecisions[1]).toBe('keep me');
    expect(clamped.entities.people[0].length).toBeLessThanOrEqual(180);
    // A ballooned summary is elided to ≤600 chars, head+tail.
    const sum = clampProjectStateItems({ summary: 'Y'.repeat(900), recentDecisions: [], openItems: [], entities: {} });
    expect(sum.summary.length).toBeLessThanOrEqual(600);
    expect(sum.summary).toContain('…');
  });
});

describe('extractProjectStateNode through the pipeline — budget, clamp, telemetry', () => {
  const bigState = {
    summary: 'CanLaw is an AI-assisted legal project managed under project-level supervision, focused on maintaining operations and shipping its roadmap.',
    recentDecisions: Array.from({ length: 10 }, (_, i) => `decision ${i} ${'x'.repeat(500)}`),
    entities: { people: [], amounts: [], places: [], topics: ['legal', 'bench'] },
    openItems: Array.from({ length: 10 }, (_, i) => `open ${i} ${'y'.repeat(500)}`),
    lastUpdated: '2026-09-23T03:00:00.000Z',
  };
  const WAKE = '[MACHINE-TRIGGERED RUN — a scheduled firing] Run the audit and report findings with evidence.';
  const FINAL = 'Audit complete. All criteria verified with fresh probes: deploy wave succeeded, boxes on the new sha, zero failed runs, zero parse errors after the budget fix landed. Every completion claim cites a this-run artifact.';

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMerged.mockResolvedValue(null);
    // The UPDATE path is leaf-only (writes never pin inherited state): the
    // project state loads via storeGet([projectId,'context'],'state').
    mockStoreGet.mockImplementation(async (ns: string[]) => (ns && ns[1] === 'context' ? bigState : null));
    mockStorePut.mockResolvedValue(undefined);
    mockMemStore.mockResolvedValue(1);
  });

  afterEach(() => { delete process.env.MEMORY_STATE_OPS_DISABLED; });

  // The scaled ECHO budget is the legacy whole-object path — live behind MEMORY_STATE_OPS_DISABLED=1
  // since the 2026-10-20 per-item ops (the ops answer no longer echoes the state; pinned below).
  test('legacy (MEMORY_STATE_OPS_DISABLED=1): sends the scaled budget and records budgetTokens; saved state is clamped', async () => {
    process.env.MEMORY_STATE_OPS_DISABLED = '1';
    mockUtilityChat.mockResolvedValue(JSON.stringify(bigState)); // echo back — the parse must succeed
    await runUpdateContextPipeline({ userId: 'u1', chatId: 'c1', projectId: 'p1', userMessage: WAKE, synthesis: FINAL, machineRun: true });
    const projCall = mockUtilityChat.mock.calls.find((c) => c[0][0].content.includes('maintaining a project knowledge base'));
    expect(projCall).toBeTruthy();
    // The call used the scaled budget, not a fixed 4000.
    expect(projCall[1].maxTokens).toBe(projectExtractionBudget(Math.min(JSON.stringify(bigState).length, 12000)));
    expect(projCall[1].maxTokens).toBeGreaterThan(4000);
    expect(projCall[1].timeout).toBe(45000);
    // Telemetry carries the budget on success. NOTE (firing 8): this asserts the
    // CALLER's argument; the real recorder's persistence is pinned separately in
    // memory-audit.extraction-tokens.pin.test.ts (the seam the 8c052480 drop hid in).
    const outcomes = mockRecordExtraction.mock.calls.map((c) => c[0]);
    const proj = outcomes.find((o) => o.source === 'project');
    expect(proj.outcome).toBe('changed');
    expect(proj.budgetTokens).toBe(projCall[1].maxTokens);
    // What was SAVED is clamped — every item ≤180 chars.
    const saved = mockStorePut.mock.calls.find((c) => String(c[0][1]) === 'context')?.[2] as any;
    expect(saved.recentDecisions.every((d: string) => d.length <= 180)).toBe(true);
    expect(saved.openItems.every((d: string) => d.length <= 180)).toBe(true);
  });

  test('2026-10-20 per-item ops: a FIXED budget whatever the state size, the answer carries only the change, saved state clamped', async () => {
    mockUtilityChat.mockResolvedValue('{"add": {"recentDecisions": ["adopt the det-v2 scorer for every bench run"]}, "remove": ["O1"]}');
    await runUpdateContextPipeline({ userId: 'u1', chatId: 'c1', projectId: 'p1', userMessage: WAKE, synthesis: FINAL, machineRun: true });
    const projCall = mockUtilityChat.mock.calls.find((c) => c[0][0].content.includes('maintaining a project knowledge base'));
    expect(projCall[1].maxTokens).toBe(PROJECT_OPS_BUDGET_TOKENS);
    expect(projCall[0][0].content).toContain('[D1] decision 0');
    expect(projCall[0][0].content).not.toContain('Return ONLY valid JSON:\n{\n  "summary"');
    const proj = mockRecordExtraction.mock.calls.map((c) => c[0]).find((o) => o.source === 'project');
    expect(proj.outcome).toBe('changed');
    expect(proj.budgetTokens).toBe(PROJECT_OPS_BUDGET_TOKENS);
    expect(proj.detail).toMatch(/^ops set=0 add=1 upd=0 rm=1/);
    const saved = mockStorePut.mock.calls.find((c) => String(c[0][1]) === 'context')?.[2] as any;
    expect(saved.recentDecisions[0]).toBe('adopt the det-v2 scorer for every bench run');
    expect(saved.recentDecisions).toHaveLength(10); // the oldest was evicted past the cap
    expect(saved.openItems).toHaveLength(9);
    expect(saved.openItems.some((d: string) => d.startsWith('open 0 '))).toBe(false);
    expect(saved.recentDecisions.every((d: string) => d.length <= 180)).toBe(true);
  });

  test('a truncated echo (parse_error) keeps the existing state, clamped', async () => {
    mockUtilityChat.mockResolvedValue('{"summary": "CanLaw is an AI-assisted legal project mana'); // cut mid-string
    await runUpdateContextPipeline({ userId: 'u1', chatId: 'c1', projectId: 'p1', userMessage: WAKE, synthesis: FINAL, machineRun: true });
    const outcomes = mockRecordExtraction.mock.calls.map((c) => c[0]);
    const proj = outcomes.find((o) => o.source === 'project');
    expect(proj.outcome).toBe('parse_error');
    // Fallback = existing state, STILL clamped on save (it shrinks over time).
    const saved = mockStorePut.mock.calls.find((c) => String(c[0][1]) === 'context')?.[2] as any;
    expect(saved.recentDecisions.every((d: string) => d.length <= 180)).toBe(true);
  });
});
