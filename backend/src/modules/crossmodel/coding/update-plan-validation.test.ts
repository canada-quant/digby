/**
 * update_plan strict input validation (2026-09-30, TB 2.1 bench trace, GLM-5.3
 * lead): the model sent `steps` as an array of NUMBERS and the tool "accepted"
 * it — applyPlan filtered every step away and silently wiped the stored plan.
 * Pins: numbers / null / empty strings / text-less objects / a non-array steps
 * / non-string acceptance criteria are REJECTED with the `{ "ok": false … }`
 * envelope (a derail-streak failure) and NOTHING is written; plain strings are
 * coerced to {text}; step objects pass through with their other fields; an
 * omitted steps keeps the stored plan.
 *
 * Boundary mocks mirror tools.test.ts / run-command-publish-guard.v1-27.test.ts.
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
// In-memory context store — the observable seam for "was anything written".
const mockStore = new Map<string, any>();
const mockStorePut: jest.Mock = jest.fn(async (ns: string[], key: string, v: any) => { mockStore.set([...ns, key].join('|'), v); });
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => mockStore.get([...ns, key].join('|')) ?? null),
  storePut: (...a: any[]) => mockStorePut(...a),
}));
jest.mock('./coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
  clearSessionMemory: jest.fn(async () => {}),
  buildSessionMemoryInventory: jest.fn(async () => ''),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: {
    CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits',
    MERGE_SIZE_GUARD: 'merge_size_guard', GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss',
  },
}));
jest.mock('./code-index.service', () => ({
  __esModule: true,
  searchCodeSemantic: jest.fn(async () => []),
  syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })),
  kickCodeIndexSync: jest.fn(),
}));
// learnings-index.service (the REAL looksLikeToolFailure classifier) imports the
// unified memory service → config/database → config/env (process.exit at import).
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async () => {}),
  memSearch: jest.fn(async () => []),
}));
// update_plan's success path fire-and-forgets the session-title refresh (→ prisma → config/env).
jest.mock('../platform/session-titles', () => ({
  __esModule: true,
  refreshSessionTitle: jest.fn(async () => {}),
}));
// …and the plan → todo reconcile (audit 2026-10-08 W5-4; lane-todos → prisma → config/env) the same way.
jest.mock('./lane-todos', () => ({
  __esModule: true,
  reconcileLaneTodosFromPlan: jest.fn(async () => []),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeCodingTool, ToolContext, CODING_TOOL_SCHEMA } from './tools';
import { getPlan, validatePlanUpdate, renderPlanValidationFailure, UPDATE_PLAN_EXPECTED_SHAPE } from './plan.service';
import { looksLikeToolFailure } from './learnings-index.service';

const SID = 'sess-up';
let worktree = '';

const mkCtx = () => ({
  worktree, sessionId: SID, userId: 'u1', runId: 'run-1', permissionMode: 'auto',
  emit: jest.fn(), alwaysAllow: new Set<string>(),
  requestApproval: async () => 'allow' as const,
  execShell: jest.fn(async () => ({ stdout: '', stderr: '' })),
  userTurnAt: new Date(),
}) as unknown as ToolContext;

const seed = async () => {
  const out = await executeCodingTool(mkCtx(), 'update_plan', {
    goal: 'Ship the fix',
    acceptance_criteria: ['tests green'],
    steps: [{ text: 'Inspect /app', status: 'in_progress' }, { text: 'Implement', status: 'pending' }],
  });
  expect(out).toMatch(/^Plan updated \(0\/2 done\)/);
  mockStorePut.mockClear();
};

beforeEach(() => {
  mockStore.clear(); mockStorePut.mockClear();
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'update-plan-'));
});
afterEach(() => {
  fs.rmSync(worktree, { recursive: true, force: true });
});

describe('validatePlanUpdate (pure)', () => {
  it('numbers are rejected, each bad index named', () => {
    const v = validatePlanUpdate({ steps: [1, 2, 3] });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.problems).toEqual(['steps[0] is a number (1)', 'steps[1] is a number (2)', 'steps[2] is a number (3)']);
  });

  it('plain strings are coerced to {text} (status left to the default), with a note', () => {
    const v = validatePlanUpdate({ steps: ['Inspect /app', { text: 'Implement', status: 'in_progress' }] });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.update.steps).toEqual([{ text: 'Inspect /app' }, { text: 'Implement', status: 'in_progress' }]);
    expect(v.notes).toHaveLength(1);
    expect(v.notes[0]).toContain('steps[0] was a plain string');
  });

  it('step objects are kept as-is (other fields pass through) and the args are not copied', () => {
    const args = { goal: 'g', steps: [{ text: 'a', status: 'completed', note: 'done in abc', id: 7 }] };
    const v = validatePlanUpdate(args);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.update).toBe(args);
    expect(v.notes).toEqual([]);
  });

  it('empty / null / text-less / nested-array steps are rejected', () => {
    const v = validatePlanUpdate({ steps: ['', '   ', null, {}, { content: 'x', status: 'pending' }, { text: '' }, { text: 5 }, ['a'], true] });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.problems).toEqual([
      'steps[0] is an empty string',
      'steps[1] is an empty string',
      'steps[2] is null',
      'steps[3] is an empty object',
      'steps[4] is an object with no "text" (keys: content, status)',
      'steps[5] is an object whose "text" is an empty string',
      'steps[6] is an object whose "text" is a number (5)',
      'steps[7] is an array',
      'steps[8] is a boolean (true)',
    ]);
  });

  it('a present non-array steps is rejected (a JSON-encoded array gets a hint)', () => {
    const asString = validatePlanUpdate({ steps: '[{"text":"a"}]' });
    expect(asString.ok).toBe(false);
    if (!asString.ok) expect(asString.problems[0]).toMatch(/^steps is a string, not an array \(it looks like a JSON-encoded array/);
    const asObject = validatePlanUpdate({ steps: { text: 'a' } });
    expect(asObject.ok).toBe(false);
    const asNumber = validatePlanUpdate({ steps: 3 });
    expect(asNumber.ok).toBe(false);
  });

  it('acceptance_criteria entries must be non-empty strings (numbers are NOT coerced); a non-array is rejected', () => {
    const v = validatePlanUpdate({ acceptance_criteria: ['tests green', 2, ''], steps: [{ text: 'a' }] });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.problems).toEqual(['acceptance_criteria[1] is a number (2)', 'acceptance_criteria[2] is an empty string']);
    expect(validatePlanUpdate({ acceptance_criteria: 'tests green', steps: [] }).ok).toBe(false);
  });

  it('a non-string goal and non-object args are rejected', () => {
    expect(validatePlanUpdate({ goal: 42, steps: [{ text: 'a' }] }).ok).toBe(false);
    expect(validatePlanUpdate(null).ok).toBe(false);
    expect(validatePlanUpdate([{ text: 'a' }]).ok).toBe(false);
  });

  it('omitted (undefined / null) fields are accepted — the stored values are kept by applyPlan', () => {
    expect(validatePlanUpdate({ goal: 'only the goal' }).ok).toBe(true);
    expect(validatePlanUpdate({ goal: 'g', steps: null, acceptance_criteria: null }).ok).toBe(true);
    expect(validatePlanUpdate({ steps: [] }).ok).toBe(true);
  });

  it('the rejection envelope is a failure shape, names the indices and shows the expected shape', () => {
    const out = renderPlanValidationFailure(['steps[0] is a number (1)', 'steps[1] is a number (2)']);
    expect(looksLikeToolFailure(out)).toBe(true);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('invalid_plan_update');
    expect(parsed.message).toContain('nothing was written');
    expect(parsed.message).toContain('steps[0] is a number (1); steps[1] is a number (2)');
    expect(parsed.message).toContain(UPDATE_PLAN_EXPECTED_SHAPE);
    expect(parsed.expected.steps[0]).toEqual({ text: 'Inspect /app', status: 'in_progress' });
  });

  it('a long problem list is capped in the message paragraph', () => {
    const many = Array.from({ length: 12 }, (_, i) => `steps[${i}] is a number (${i})`);
    const parsed = JSON.parse(renderPlanValidationFailure(many));
    expect(parsed.message).toContain('; and 4 more.');
    expect(parsed.problems).toHaveLength(12);
  });
});

describe('update_plan tool (executor)', () => {
  it('numbers are rejected with the ok:false envelope and NOTHING is written — the stored plan survives', async () => {
    await seed();
    const ctx = mkCtx();
    const out = await executeCodingTool(ctx, 'update_plan', { steps: [1, 2, 3] });
    expect(out).toMatch(/^\{\s*"ok":\s*false/);
    expect(looksLikeToolFailure(out)).toBe(true);
    expect(JSON.parse(out).message).toContain('steps[0] is a number (1)');
    expect(mockStorePut).not.toHaveBeenCalled();
    expect((ctx.emit as jest.Mock)).not.toHaveBeenCalledWith('plan_update', expect.anything());
    const plan = await getPlan(SID);
    expect(plan?.steps.map(s => s.text)).toEqual(['Inspect /app', 'Implement']);
    expect(plan?.version).toBe(1);
  });

  it('a non-array steps and a bad acceptance criterion are rejected without a write', async () => {
    await seed();
    for (const bad of [{ steps: 'Inspect then implement' }, { steps: [{ text: 'a' }], acceptance_criteria: [7] }]) {
      const out = await executeCodingTool(mkCtx(), 'update_plan', bad);
      expect(looksLikeToolFailure(out)).toBe(true);
    }
    expect(mockStorePut).not.toHaveBeenCalled();
    expect((await getPlan(SID))?.version).toBe(1);
  });

  it('plain strings are coerced and stored as pending steps; the result says so', async () => {
    const out = await executeCodingTool(mkCtx(), 'update_plan', { goal: 'g', steps: ['Inspect /app', { text: 'Implement', status: 'in_progress' }] });
    expect(out).toMatch(/^Plan updated \(0\/2 done\)\nNOTE: steps\[0\] was a plain string/);
    const plan = await getPlan(SID);
    expect(plan?.steps).toEqual([
      { id: 1, text: 'Inspect /app', status: 'pending', note: undefined },
      { id: 2, text: 'Implement', status: 'in_progress', note: undefined },
    ]);
  });

  it('valid step objects behave exactly as before; a goal-only update keeps the stored steps', async () => {
    await seed();
    const out = await executeCodingTool(mkCtx(), 'update_plan', {
      steps: [{ text: 'Inspect /app', status: 'completed', note: 'read it' }, { text: 'Implement', status: 'in_progress' }],
    });
    expect(out).toBe('Plan updated (1/2 done)\nGOAL: Ship the fix\n  [x] 1 Inspect /app\n  [>] 2 Implement');
    const goalOnly = await executeCodingTool(mkCtx(), 'update_plan', { goal: 'Ship the fix, v2' });
    expect(goalOnly).toBe('Plan updated (1/2 done)\nGOAL: Ship the fix, v2\n  [x] 1 Inspect /app\n  [>] 2 Implement');
  });
});

/**
 * Ticket 17a0b383 (derail breaker, session 0037460b): a lane sent steps[3] as
 * {"in_progress": "<the step text>"} — the status as the KEY, no "text" — three
 * times and tripped the 3× tool-failure streak. That shape is unambiguous, so it
 * is normalised to {text, status}; every other text-less object stays rejected
 * with today's message. Kill switch UPDATE_PLAN_STATUS_KEY_SHORTHAND_DISABLED=1.
 */
describe('update_plan status-keyed shorthand (ticket 17a0b383)', () => {
  const SW = 'UPDATE_PLAN_STATUS_KEY_SHORTHAND_DISABLED';
  let savedSw: string | undefined;
  beforeEach(() => { savedSw = process.env[SW]; delete process.env[SW]; });
  afterEach(() => { if (savedSw === undefined) delete process.env[SW]; else process.env[SW] = savedSw; });

  const INCIDENT = {
    steps: [
      { text: 'Read the code', status: 'completed' },
      { text: 'Write the failing test', status: 'completed' },
      { text: 'Implement the fix', status: 'completed' },
      { in_progress: 'Run the verify chain and commit' },
    ],
  };

  it('the incident shape {"in_progress": "<text>"} is normalised to {text, status} with a teaching note', () => {
    const v = validatePlanUpdate(INCIDENT);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.update.steps?.[3]).toEqual({ text: 'Run the verify chain and commit', status: 'in_progress' });
    expect(v.update.steps?.slice(0, 3)).toEqual(INCIDENT.steps.slice(0, 3));
    expect(v.notes).toHaveLength(1);
    expect(v.notes[0]).toBe('a status was used as a step\'s key — stored as {"text": <the value>, "status": <the key>}: steps[3] ({"in_progress": …}) → status "in_progress"; send {"text": …, "status": …} step objects.');
    // The caller's args are not mutated.
    expect(INCIDENT.steps[3]).toEqual({ in_progress: 'Run the verify chain and commit' });
  });

  it('every canonical status works as the key (spelling-normalised), and a string "note" rides along', () => {
    const v = validatePlanUpdate({
      steps: [
        { pending: 'a' }, { completed: 'b', note: 'done in abc123' }, { blocked: 'c', note: 'waiting on CI' }, { 'In-Progress': ' d ' },
      ],
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.update.steps).toEqual([
      { text: 'a', status: 'pending' },
      { text: 'b', status: 'completed', note: 'done in abc123' },
      { text: 'c', status: 'blocked', note: 'waiting on CI' },
      { text: ' d ', status: 'in_progress' },
    ]);
    expect(v.notes).toHaveLength(1);
    // Review fix (round 2): each step is named with ITS OWN stored status (the first cut named steps[0]'s for all),
    // and the raw key the model sent is quoted as sent ("In-Progress" → status "in_progress").
    expect(v.notes[0]).toContain('steps[0] ({"pending": …}) → status "pending", steps[1] ({"completed": …}) → status "completed", steps[2] ({"blocked": …}) → status "blocked"');
    expect(v.notes[0]).toContain('steps[3] ({"In-Progress": …}) → status "in_progress"; send');
    // {"blocked": "c", "note": "waiting on CI"} already carries its reason in "note" — no "taken as the text" clause.
    expect(v.notes[0]).not.toContain('blocker reason');
  });

  it('mixed statuses: the NOTE names each shorthand step with its own stored status (never the first step\'s for all)', () => {
    const v = validatePlanUpdate({ steps: [{ completed: 'a' }, { text: 'plain', status: 'pending' }, { in_progress: 'b' }] });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.update.steps).toEqual([
      { text: 'a', status: 'completed' },
      { text: 'plain', status: 'pending' },
      { text: 'b', status: 'in_progress' },
    ]);
    expect(v.notes).toEqual([
      'a status was used as a step\'s key — stored as {"text": <the value>, "status": <the key>}: steps[0] ({"completed": …}) → status "completed", steps[2] ({"in_progress": …}) → status "in_progress"; send {"text": …, "status": …} step objects.',
    ]);
    expect(v.notes[0]).not.toMatch(/steps\[2\] \(\{"in_progress": …\}\) → status "completed"/);
  });

  it('a "blocked" key: the NOTE says its value was taken as the step TEXT (a model may have meant a blocker reason)', () => {
    const v = validatePlanUpdate({ steps: [{ blocked: 'waiting on CI' }, { pending: 'Ship it' }] });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.update.steps).toEqual([
      { text: 'waiting on CI', status: 'blocked' },
      { text: 'Ship it', status: 'pending' },
    ]);
    expect(v.notes[0]).toContain('steps[0] ({"blocked": …}) → status "blocked" with that value taken as the step TEXT, not a blocker reason (a reason goes in "note"), steps[1] ({"pending": …}) → status "pending"; send');
    // Only the blocked step carries the clause.
    expect(v.notes[0].match(/blocker reason/g)).toHaveLength(1);
    const noBlocked = validatePlanUpdate({ steps: [{ pending: 'Ship it' }] });
    expect(noBlocked.ok && noBlocked.notes[0]).not.toContain('blocker reason');
  });

  it('ambiguous shapes stay rejected with TODAY\'S message', () => {
    const v = validatePlanUpdate({
      steps: [
        { in_progress: 'a', pending: 'b' }, // two status keys
        { in_progress: 5 }, // non-string value
        { in_progress: '   ' }, // empty value
        { doing: 'a' }, // a synonym, not a canonical status key
        { content: 'a' }, // unknown key
        { in_progress: 'a', id: 3 }, // an extra unknown key
        { in_progress: 'a', note: 7 }, // a non-string note
        { in_progress: 'a', status: 'pending' }, // a conflicting status field
        { note: 'only a note' }, // no status key at all
      ],
    });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.problems).toEqual([
      'steps[0] is an object with no "text" (keys: in_progress, pending)',
      'steps[1] is an object with no "text" (keys: in_progress)',
      'steps[2] is an object with no "text" (keys: in_progress)',
      'steps[3] is an object with no "text" (keys: doing)',
      'steps[4] is an object with no "text" (keys: content)',
      'steps[5] is an object with no "text" (keys: in_progress, id)',
      'steps[6] is an object with no "text" (keys: in_progress, note)',
      'steps[7] is an object with no "text" (keys: in_progress, status)',
      'steps[8] is an object with no "text" (keys: note)',
    ]);
  });

  it('a step object WITH "text" is untouched even when it also carries a status-named key', () => {
    const args = { steps: [{ text: 'a', status: 'pending', completed: 'stray' }] };
    const v = validatePlanUpdate(args);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.update).toBe(args);
    expect(v.notes).toEqual([]);
  });

  it('the executor stores the incident shape with that status (no failure envelope)', async () => {
    const ctx = mkCtx();
    const out = await executeCodingTool(ctx, 'update_plan', { goal: 'Ship the fix', ...INCIDENT });
    expect(looksLikeToolFailure(out)).toBe(false);
    expect(out).toMatch(/^Plan updated \(3\/4 done\)\nNOTE: a status was used as a step's key — .*steps\[3\] \(\{"in_progress": …\}\) → status "in_progress"/);
    expect(out).toContain('  [>] 4 Run the verify chain and commit');
    const plan = await getPlan(SID);
    expect(plan?.steps[3]).toEqual({ id: 4, text: 'Run the verify chain and commit', status: 'in_progress', note: undefined });
    expect((ctx.emit as jest.Mock)).toHaveBeenCalledWith('plan_update', expect.anything());
  });

  it('the update_plan schema states the step shape in one clause (status is a value, never a key)', () => {
    const t = CODING_TOOL_SCHEMA.find((x: any) => x.function.name === 'update_plan') as any;
    expect(t.function.parameters.properties.steps.description).toContain('each {"text": "…", "status": "pending"} — the status is a value, never a key');
  });

  it('kill switch UPDATE_PLAN_STATUS_KEY_SHORTHAND_DISABLED=1 restores the rejection byte-for-byte', async () => {
    process.env[SW] = '1';
    const v = validatePlanUpdate(INCIDENT);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.problems).toEqual(['steps[3] is an object with no "text" (keys: in_progress)']);
    await seed();
    const out = await executeCodingTool(mkCtx(), 'update_plan', INCIDENT);
    expect(out).toBe(renderPlanValidationFailure(['steps[3] is an object with no "text" (keys: in_progress)']));
    expect(mockStorePut).not.toHaveBeenCalled();
    expect((await getPlan(SID))?.version).toBe(1);
  });
});

describe('plan step status synonyms (2026-10-01)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { normalizeStatus } = require('./plan.service');
  it('maps common spellings to the canonical status', () => {
    expect(normalizeStatus('done')).toBe('completed');
    expect(normalizeStatus('Complete')).toBe('completed');
    expect(normalizeStatus(' finished ')).toBe('completed');
    expect(normalizeStatus('in-progress')).toBe('in_progress');
    expect(normalizeStatus('active')).toBe('in_progress');
    expect(normalizeStatus('todo')).toBe('pending');
    expect(normalizeStatus('on hold')).toBe('blocked');
  });
  it('keeps canonical values and falls back to pending for unknowns', () => {
    expect(normalizeStatus('completed')).toBe('completed');
    expect(normalizeStatus('blocked')).toBe('blocked');
    expect(normalizeStatus(undefined)).toBe('pending');
    expect(normalizeStatus('zzz')).toBe('pending');
  });
});
