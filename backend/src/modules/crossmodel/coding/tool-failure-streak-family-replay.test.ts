/**
 * REPLAY PIN — tool-failure-streak FAMILY, lane 8396c3b0 (2026-10-28): five
 * same-day auto-filed mishaps adjudicated as DESIGNED GUARDS (no framework
 * defect), one replay test per member so the convicting shape stays pinned:
 *
 *  - ticket 23a873fe — set_decision_gate_mode refused/staged 3× (wake_triage
 *    act-refusal is the W6 code cap; wake_effort + supervisor_turn_noop staged
 *    as tier-2 owner questions; owner answered 'flip' and the flips executed).
 *    Replays the PUT-boundary refusal for the W6-capped purpose (the f64b7c1e
 *    describe in decision-gate-modes.test.ts pins the same seam; this pin is
 *    the family's replay anchor).
 *  - ticket 26254049 — verify FAILED 3× at the switches stage (unregistered
 *    FRAMEWORK_PROJECT_SURFACE_DISABLED; count_mismatch 686 vs ledger 685).
 *    The guard's PRIOR true positives (that ticket's exact violation kinds)
 *    must STILL fire: an unregistered backend read is reported, and a count
 *    raise without a ledger line is reported.
 *  - ticket e88596b2 — cancel_schedule ×3 on a narrated/undefined
 *    confirmationId → the referential-grounding pre-flight refused
 *    WITHOUT executing (reason 'ungrounded_id', envelope names the rejected
 *    arg). The narrated id is NOT grounded by its appearance in the brief.
 *  - ticket a39a6b71 — edit_file old_string misses ×3 (not-found + appears-2×
 *    in docker-compose.app.yml). The authored refusal MUST read as a FAILURE
 *    to the derail breaker (looksLikeToolFailure) — the d2e6b0fb blind-spot
 *    class; the hint tail stays inside the failure-marker grammar.
 *  - ticket b642d864 — view_image ×3 on a non-existent ../crop/*.png → the
 *    in-band refusal (no exception, no streak-able crash) carries the
 *    relative-path remedy and the failure shape the breaker recognizes.
 *
 * Member 1 (1ab445cc, the family lead, the one FRAMEWORK defect — getProject
 * exact-id miss on the fleet-standard 8-char project-prefix idiom) is pinned
 * in platform.service.test.ts (getProject describe); its fix shipped via
 * PR #2038 (squash 60796bd8).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// learnings-index.service.ts pulls config/database → config/env, which
// process.exit(1)s without env (edit-file-hint.test.ts discipline).
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'y'.repeat(32) },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSubscriber: { subscribe: jest.fn(), on: jest.fn() },
}));
// Import-time boundary mocks (the tools.ts import graph reaches config/env).
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
  storeGet: (...a: any[]) => mockStoreGet(...a),
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
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' },
  recordLoopMetric: jest.fn(async () => {}),
}));

import { findUngroundedIdArgs, ungroundedIdRefusal } from './tool-preflight';
import { looksLikeToolFailure } from './learnings-index.service';
import { editFileMissDiagnostic } from './edit-file-hint';
import { runViewImage } from './view-image';
import { switchRegistryViolations, SWITCHES, SWITCH_COUNT_LEDGER, type SwitchScanInput } from '../platform/switch-registry';
import { updateDecisionModes } from '../platform/decision-gate-modes';

// ── decision-gate-modes mock wiring (verbatim discipline from
//    decision-gate-modes.test.ts) ──────────────────────────────────────────
const mockStoreGet = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockStorePut = jest.fn(async (..._a: any[]): Promise<any> => undefined);
class FakeAppError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
jest.mock('../../../middleware/error-handler', () => ({ AppError: FakeAppError }));
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' },
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

// ── view_image io ──────────────────────────────────────────────────────────
const WT = '/tmp/family-replay-wt';
const shq = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
const missingShell = (): any => ({
  execShell: jest.fn(async (command: string) => {
    if (command.includes('stat -L -c %s')) return { stdout: '__VIEW_IMAGE_MISSING__\n', stderr: '' };
    throw new Error(`unexpected command: ${command}`);
  }),
  worktree: WT,
  quote: shq,
  userId: 'u1',
});

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['SUPERVISOR_MATERIAL_GATE_DISABLED', 'SUPERVISOR_WAKE_LEDGER_IN_TEST'];
beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  mockStoreGet.mockReset();
  mockStoreGet.mockImplementation(async () => null);
  mockStorePut.mockReset();
  mockRecordLoopMetric.mockReset();
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

// ── ticket 23a873fe — decision-gate W6 cap refusal (designed guard) ────────
describe('ticket 23a873fe: set_decision_gate_mode wake_triage→act is refused by the W6 code cap (the PUT boundary)', () => {
  it('DETECTOR-RECALL REPLAY — the exact refusal envelope from the filed text #1 (409, capped at shadow, the SUPERVISOR_MATERIAL_GATE_DISABLED remedy) still fires', async () => {
    process.env.SUPERVISOR_WAKE_LEDGER_IN_TEST = '1';
    await expect(updateDecisionModes({ wake_triage: 'act' }, 'admin-1')).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/Cannot set wake_triage to act — capped at shadow in code.*Lift the cap on every box with SUPERVISOR_MATERIAL_GATE_DISABLED=1 first/),
    });
    expect(mockStorePut).not.toHaveBeenCalled();
  });
});

// ── ticket 26254049 — switch-registry guard true positives still fire ──────
describe('ticket 26254049: the switches guard still convicts its 9471d338-era true positives', () => {
  const scanWith = (backend: Array<[string, string[]]>, compose: string[] = []): SwitchScanInput => ({
    backend: new Map(backend),
    frontend: new Map(),
    compose: { backend: new Set(compose), worker: new Set(), frontendArgs: new Set() },
    frontendDockerArgs: new Set(),
  });

  it('DETECTOR-RECALL REPLAY — an unregistered backend switch read (the FRAMEWORK_PROJECT_SURFACE_DISABLED leg) is reported', () => {
    const out = switchRegistryViolations(scanWith([['FRAMEWORK_PROJECT_SURFACE_DISABLED_VANISHED', ['backend/src/modules/crossmodel/platform/framework-project.ts']]]), '2026-10-28');
    const hit = out.find((v) => v.kind === 'unregistered' && v.name === 'FRAMEWORK_PROJECT_SURFACE_DISABLED_VANISHED');
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/is not in SWITCHES — run `npm run switches:sync`/);
  });

  it('DETECTOR-RECALL REPLAY — a count raise without a ledger line (the 686-vs-685 leg) is reported; the real registry stays consistent', () => {
    const out = switchRegistryViolations(scanWith([]), '2026-10-28', SWITCHES, [{ on: '2026-10-28', count: SWITCHES.length + 1, why: 'ledger without the switch row — the count_mismatch leg' }]);
    expect(out.some((v) => v.kind === 'count_mismatch')).toBe(true);
    // The shipped registry is self-consistent (the ticket's failing state is gone).
    expect(SWITCH_COUNT_LEDGER[SWITCH_COUNT_LEDGER.length - 1].count).toBe(SWITCHES.length);
  });
});

// ── ticket e88596b2 — referential grounding refuses the narrated id ───────
describe('ticket e88596b2: cancel_schedule confirmationId ungrounded — refused WITHOUT executing', () => {
  it('DETECTOR-RECALL REPLAY — a narrated "cf_9c2f2e8c" absent from readable text is refused with the exact filed envelope; the same id in a prior tool result IS grounded', () => {
    // The incident: the id came from a PRIOR run's staged confirmation card —
    // nothing the run had read contained it. Narration is never a source.
    const bad = findUngroundedIdArgs({ confirmationId: 'cf_9c2f2e8c' }, 'user: cancel the stale confirmation card for cancel_schedule, then finish the checklist.');
    expect(bad).toHaveLength(1); // cf_… is not one of our id shapes and no readable text carries it
    const refusal = JSON.parse(ungroundedIdRefusal('cancel_schedule', bad, null));
    expect(refusal).toMatchObject({ ok: false, tool: 'cancel_schedule', reason: 'ungrounded_id', rejected: [{ key: 'confirmationId', value: 'cf_9c2f2e8c' }] });
    expect(refusal.message).toContain('NOT EXECUTED');
    expect(refusal.message).toContain('you do not need cancel_schedule right now');
    // The designed other side: the SAME id, obtained legitimately (a prior
    // tool result echoing the staged card), IS grounded — no refusal.
    const grounded = findUngroundedIdArgs({ confirmationId: 'cf_9c2f2e8c' }, 'tool result: {"confirmationId":"cf_9c2f2e8c","tool":"cancel_schedule","summary":"staged"}');
    expect(grounded).toHaveLength(0);
  });
});

// ── ticket a39a6b71 — edit_file miss refusals read as FAILURE to the breaker
describe('ticket a39a6b71: edit_file old_string misses — the breaker sees a failure, the hint stays in-grammar', () => {
  it('DETECTOR-RECALL REPLAY — the filed texts ("appears 2×" / "not found" + hint) count as tool failures', () => {
    expect(looksLikeToolFailure('old_string appears 2× in docker-compose.app.yml — it must be unique. Add surrounding context. [edit_file hint: occurrences start at lines: 501, 1422 — widen old_string with surrounding context unique to your target]')).toBe(true);
    expect(looksLikeToolFailure("old_string not found in docker-compose.app.yml. Read the file and match exactly. [edit_file hint: nearest match is 50% similar at lines 500–501: '- FEEDBACK_CLOSE_FALLBACK_TOKEN_DISABLED=${FEEDBACK_CLOSE_F…' — re-read that region and quote it byte-exactly]")).toBe(true);
    // A model's own trailing narration still never counts (marker anchoring).
    expect(looksLikeToolFailure('the tool said old_string appears 2× in x — it must be unique. Add surrounding context.')).toBe(false);
  });

  it('the miss diagnostic fires for the stale-quote class (the incident loop-shape: repeated misses get a WHY)', () => {
    // The file has moved on since the lane's last read; the stale quote still
    // names the OLD sibling line (token-Jaccard 0.5 ≥ the 0.4 probe floor).
    const file = ['- FEEDBACK_CLOSE_FALLBACK_TOKEN_DISABLED=${FEEDBACK_CLOSE_FALLBACK_TOKEN_DISABLED:-}', '- FIX_STATE_EVIDENCE_REPO_DISABLED=${FIX_STATE_EVIDENCE_REPO_DISABLED:-}'].join('\n');
    const stale = '- FEEDBACK_CLOSE_FALLBACK_TOKEN_DISABLED=${FEEDBACK_CLOSE_FALLBACK_TOKEN_DISABLED:-}\n- FEEDBACK_FIX_STATE_FALLBACK_TOKEN_DISABLED=${FEEDBACK_FIX_STATE_FALLBACK_TOKEN_DISABLED:-}';
    const hint = editFileMissDiagnostic(file, stale);
    expect(hint).toContain('nearest');
  });
});

// ── ticket b642d864 — view_image missing file: in-band refusal, no crash ──
describe('ticket b642d864: view_image on a missing ../crop/*.png — in-band refusal with the relative-path remedy', () => {
  it('DETECTOR-RECALL REPLAY — the exact filed refusal text (no such file + the relative-path remedy), failure-shaped, never an exception', async () => {
    const out = await runViewImage(missingShell(), { path: '../crop/d5555_top.png' });
    expect(out).toBe('Tool view_image failed: no such file: ../crop/d5555_top.png (relative paths resolve from the project root — task files often live elsewhere, e.g. /app/…; pass the absolute path).');
    expect(looksLikeToolFailure(out)).toBe(true);
  });
});
