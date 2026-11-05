/**
 * decision-gate.ts — the typed-decision seat: readout math, systemone parsing,
 * modes/thresholds, and decide()'s two backends + fail-open contract.
 */

jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
// The real logger boots env.ts, which process.exit()s a keyless jest.
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' },
  recordLoopMetric: jest.fn(),
}));
jest.mock('../model-endpoints/model-roles.service', () => ({
  resolveRoleModel: jest.fn(async () => 'jev'),
  resolveRoleFallback: jest.fn(async () => ''),
}));
// 2026-09-26: registry decision backends (a self-hosted Laya / JevK5 / a logprobs
// server) resolve through model-endpoints.service — mocked so no prisma boots.
const mockResolveRegistryModel = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...a),
}));
// The store-backed mode row (WI-S) — decision-gate-modes.ts reads it through
// context-store; mocked so no prisma boots here.
const mockStoreGet = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../memory/context-store', () => ({
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: jest.fn(async () => undefined),
}));

import axios from 'axios';
import { recordLoopMetric } from './loop-metrics.service';
import {
  buildReadoutMessages,
  clearDecisionBackendCache,
  clearDecisionMemo,
  confidenceOf,
  decide,
  decisionHashes,
  decisionLegTimeoutMs,
  legShareCap,
  decisionMode,
  decisionModeWithSource,
  decisionOptionThreshold,
  decisionThreshold,
  distributionFromLogits,
  inActBand,
  hashQuestions,
  bucketMinutes,
  memoProjection,
  letterOfToken,
  parseSystemOneAnswers,
  readoutDistribution,
  readoutLetterLogits,
  readoutLetterLogitsDetailed,
  readoutTemperature,
  readoutTemperatureFitted,
  reconstructDecision,
  // 2026-09-26 — open-weight decision backends
  answerLogits,
  backendTemperature,
  backendTemperatureFitted,
  clearDecisionBackendTempsCache,
  fillSystemOneNoulCriteria,
  normalizeStoredBackendTemps,
  refreshDecisionBackendTemps,
  storedBackendTempSync,
  temperAnswer,
  DECISION_STATE_MAX_CHARS,
  SYSTEMONE_DEFAULT_NOUL_CRITERIA,
  recordDecisionOutcome,
  stashDecision,
  READOUT_TOP_LOGPROBS,
  TYPESAFE_DEFAULT_MODEL,
  isActQuestion,
  // Laya follow-up (2026-09-26)
  DECISION_GATE_STATE_KIND,
  clearPendingChallengerOutcomes,
  clearTypedDecisionLatch,
  isTypedDecisionGuardBody,
  latchTypedDecisionSpec,
  typedDecisionLatchView,
  unlatchTypedDecisionSpec,
  isTypedDecisionSpec,
  normalizeSystemOneConfidence,
  parseSystemOneChatResponse,
  pendingChallengerOutcomeCount,
  registryDecisionTransport,
  setDecisionStateSampler,
  stateSampleMaxChars,
  stateSampleRate,
  systemOneBackendLabel,
  // 2026-09-26 audit (gate-runtime-5) — Laya systemone_chat failure telemetry
  challengerErrorText,
  describeUnparsableJson,
  httpErrorBodyText,
  parseSystemOneAnswersDetailed,
  sanitizeNonFiniteJson,
  scrubSecretText,
  // audit budgets-cost-6 (2026-09-26) — the 401/403 auth latch + backend-down alert
  DECISION_GATE_BACKEND_DOWN_KIND,
  DECISION_AUTH_LATCH_DEFAULT_MS,
  authLatchMs,
  clearDecisionAuthLatches,
  decisionAuthLatches,
  setDecisionBackendDownAlerter,
  // DOI-17 (2026-09-28) — the admin latch view
  decisionBackendLatchView,
  formatDecisionLatchView,
  // task-aware pick (2026-10-20)
  ACT_BAND_DEFAULT_THRESHOLD,
  type DecisionQuestion,
} from './decision-gate';
import { TASK_KIND_MIN_P } from './task-kind';
import { actBandWindow, clearActBandWindows, clearDecisionModeCache, refreshDecisionModes } from './decision-gate-modes';
// Pure (crypto + decision-gate-math only): the readiness pairing the challenger rows must never out-count the primary in.
import { pairReadinessRows } from './decision-gate-fit';
import { challengerGraceMs, challengerTimeoutMs, clearDecisionBackendsConfigCache, refreshDecisionBackends } from './decision-gate-backends';
import { censorAbsentLogits, readoutCensorFloor } from './decision-gate-math';

const post = (axios as any).post as jest.Mock;
const ENV_KEYS = ['DECISION_GATE_DISABLED', 'DECISION_GATE_DEFAULT_MODE', 'DECISION_GATE_MODE_AUTO_ROUTE', 'DECISION_GATE_THRESHOLD_AUTO_ROUTE',
  'DECISION_GATE_CHALLENGER_MAX', 'DECISION_GATE_CHALLENGER_GRACE_MS', 'DECISION_GATE_MODE_WAKE_TRIAGE',
  'DECISION_GATE_TEMP', 'DECISION_GATE_TEMP_PROBE', 'DECISION_GATE_TEMP_AUTO_ROUTE', 'DECISION_GATE_DRAIN_TRIAGE_ACT_CAP_DISABLED', 'TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL', 'TYPESAFE_MODEL', 'DEEPSEEK_API_KEY',
  'DECISION_GATE_LEG_TIMEOUT_MS', 'DECISION_GATE_MEMO_TTL_MS', 
  'DECISION_GATE_AUTO_DEMOTE_MIN_N', 'DECISION_GATE_AUTO_DEMOTE_MIN_PRECISION', 'DECISION_GATE_AUTO_DEMOTE_MARGIN', 'DECISION_GATE_AUTO_DEMOTE_MIN_PRECISION_WAKE_TRIAGE',
  'DECISION_GATE_THRESHOLD_WAKE_TRIAGE', 'DECISION_GATE_THRESHOLD_WAKE_TRIAGE_ACK', 'DECISION_GATE_THRESHOLD_WAKE_TRIAGE_ESCALATE_OWNER',
  'DECISION_GATE_MODE_WAKE_TRIAGE', 'DECISION_GATE_TEMP_WAKE_TRIAGE',
  // Laya follow-up (2026-09-26)
  'DECISION_GATE_STATE_SAMPLE_RATE', 'DECISION_GATE_STATE_SAMPLE_RATE_AUTO_ROUTE', 'DECISION_GATE_STATE_SAMPLE_MAX_CHARS', 'DECISION_GATE_STATE_SAMPLE_DISABLED',
  'DECISION_GATE_CHALLENGER_TIMEOUT_MS', 
  // 2026-09-26 audit (gate-runtime-5)
  
  // audit budgets-cost-6 (2026-09-26)
  'DECISION_GATE_AUTH_LATCH_MS', 'DECISION_GATE_MODE_SWEEP_TRIAGE', 'DECISION_GATE_TEMP_SWEEP_TRIAGE',
  // Log-signal f68b611e replay block (lane d37054e9): set/deleted there —
  // registered so the file-level save/restore covers it even if the block
  // moves (review D4).
  'DECISION_GATE_STALL_RECOVERY_DISABLED',
  // Log-signal 22afdd2d block (lane 92dc54d6) + its 0c86f97f sibling: both
  // set/delete a per-purpose mode around a single it — registered here for
  // the same D4 reason.
  'DECISION_GATE_MODE_TURN_PLAN', 'DECISION_GATE_MODE_TASK_KIND'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  // Hermeticity contract (2026-09-24): the BARE decision-gate default is 'off'
  // under NODE_ENV='test' (real provider keys in coding containers must not
  // fire live decide() calls from unit tests — the e580b601/0aeb8844
  // verify-blocker class). This suite EXERCISES the gate, so it opts back in
  // explicitly — the documented override for gate-exercising suites.
  process.env.DECISION_GATE_DEFAULT_MODE = 'shadow';
  post.mockReset();
  (recordLoopMetric as jest.Mock).mockReset();
  mockStoreGet.mockReset();
  mockStoreGet.mockResolvedValue(null);
  mockResolveRegistryModel.mockReset();
  mockResolveRegistryModel.mockResolvedValue(null);
  clearDecisionBackendCache();
  clearDecisionBackendTempsCache();
  clearDecisionBackendsConfigCache();
  clearDecisionModeCache();
  clearDecisionMemo();
  clearActBandWindows();
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const QUESTIONS: Record<string, DecisionQuestion> = {
  refund: { type: 'noul', instructions: 'The customer asks for money back.' },
  team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'money', technical: 'bugs', sales: 'plans' } },
  urgency: { type: 'score', instructions: 'How urgent?', criteria: ['can wait', 'this week', 'today'] },
};

describe('modes and thresholds', () => {
  it('bare default is off under NODE_ENV=test (hermetic suites — real provider keys must not fire live decide() calls); explicit env always wins; kill switch wins', () => {
    // jest sets NODE_ENV='test'; the beforeEach opts THIS suite into 'shadow'
    // (it exercises the gate) — clear it to pin the BARE default first.
    expect(process.env.NODE_ENV).toBe('test');
    delete process.env.DECISION_GATE_DEFAULT_MODE;
    expect(decisionMode('auto_route')).toBe('off');
    // An EXPLICIT mode env still wins over the test default (suites that
    // exercise the gate set these themselves).
    process.env.DECISION_GATE_DEFAULT_MODE = 'shadow';
    expect(decisionMode('auto_route')).toBe('shadow');
    process.env.DECISION_GATE_DEFAULT_MODE = 'act';
    expect(decisionMode('auto_route')).toBe('act');
    process.env.DECISION_GATE_MODE_AUTO_ROUTE = 'off';
    expect(decisionMode('auto_route')).toBe('off');
    process.env.DECISION_GATE_MODE_AUTO_ROUTE = 'nonsense';
    expect(decisionMode('auto_route')).toBe('act'); // falls back to the default mode
    process.env.DECISION_GATE_DISABLED = '1';
    expect(decisionMode('auto_route')).toBe('off');
    expect(decisionMode('probe')).toBe('off');
  });

  it('probe is always act unless disabled', () => {
    process.env.DECISION_GATE_DEFAULT_MODE = 'off';
    expect(decisionMode('probe')).toBe('act');
  });

  it('threshold honours the env override and clamps to [0.5, 1]', () => {
    expect(decisionThreshold('auto_route', 0.7)).toBe(0.7);
    process.env.DECISION_GATE_THRESHOLD_AUTO_ROUTE = '0.95';
    expect(decisionThreshold('auto_route', 0.7)).toBe(0.95);
    process.env.DECISION_GATE_THRESHOLD_AUTO_ROUTE = '0.1';
    expect(decisionThreshold('auto_route', 0.7)).toBe(0.5);
    process.env.DECISION_GATE_THRESHOLD_AUTO_ROUTE = 'x';
    expect(decisionThreshold('auto_route', 0.7)).toBe(0.7);
  });

  it('audit 2026-09-26 (settings-switches-1): a PRESENT-BUT-BLANK threshold env (compose `${VAR:-}` passthrough) is UNSET — the fallback, never 0 → 0.5', () => {
    process.env.DECISION_GATE_THRESHOLD_AUTO_ROUTE = '';
    expect(decisionThreshold('auto_route', 0.7)).toBe(0.7);
    process.env.DECISION_GATE_THRESHOLD_AUTO_ROUTE = '   ';
    expect(decisionThreshold('auto_route', 0.7)).toBe(0.7);
    process.env.DECISION_GATE_THRESHOLD_AUTO_ROUTE_DEEP_RESEARCH = '';
    expect(decisionOptionThreshold('auto_route', 'deep_research', 0.85)).toBe(0.85);
    delete process.env.DECISION_GATE_THRESHOLD_AUTO_ROUTE;
    delete process.env.DECISION_GATE_THRESHOLD_AUTO_ROUTE_DEEP_RESEARCH;
  });

  it('E7: per-option threshold DECISION_GATE_THRESHOLD_<PURPOSE>_<OPTION> overrides one option; otherwise the purpose threshold; clamped', () => {
    expect(decisionOptionThreshold('wake_triage', 'ack', 0.85)).toBe(0.85);
    process.env.DECISION_GATE_THRESHOLD_WAKE_TRIAGE = '0.9';
    expect(decisionOptionThreshold('wake_triage', 'ack', 0.85)).toBe(0.9);
    process.env.DECISION_GATE_THRESHOLD_WAKE_TRIAGE_ACK = '0.95';
    expect(decisionOptionThreshold('wake_triage', 'ack', 0.85)).toBe(0.95);
    expect(decisionOptionThreshold('wake_triage', 'coalesce', 0.85)).toBe(0.9);
    process.env.DECISION_GATE_THRESHOLD_WAKE_TRIAGE_ESCALATE_OWNER = '1.7';
    expect(decisionOptionThreshold('wake_triage', 'escalate-owner', 0.85)).toBe(1); // non-alphanumerics → '_', clamped to 1
    process.env.DECISION_GATE_THRESHOLD_WAKE_TRIAGE_ACK = 'nope';
    expect(decisionOptionThreshold('wake_triage', 'ack', 0.85)).toBe(0.9);
  });

  it('E7/E8: hashQuestions is stable across key order, changes on a reword / option change, and ignores the state', () => {
    const h = hashQuestions(QUESTIONS);
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(hashQuestions({ urgency: QUESTIONS.urgency, team: QUESTIONS.team, refund: QUESTIONS.refund })).toBe(h);
    expect(hashQuestions({ ...QUESTIONS, refund: { type: 'noul', instructions: 'The customer wants money back.' } })).not.toBe(h);
    expect(hashQuestions({ ...QUESTIONS, team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'money', technical: 'bugs' } } })).not.toBe(h);
    expect(hashQuestions({ ...QUESTIONS, refund: { type: 'noul', instructions: 'The customer asks for money back.', criteria: { true: 'yes', false: 'no' } } })).not.toBe(h);
    expect(hashQuestions({})).toMatch(/^[0-9a-f]{12}$/);
  });

  it('readout temperature: per purpose, then global, then 1 — clamped to [0.7, 10] (WI-I: <0.7 only sharpens a saturated readout)', () => {
    expect(readoutTemperature('probe')).toBe(1);
    process.env.DECISION_GATE_TEMP = '1.5';
    expect(readoutTemperature('probe')).toBe(1.5);
    process.env.DECISION_GATE_TEMP_PROBE = '0.8';
    expect(readoutTemperature('probe')).toBe(0.8);
    process.env.DECISION_GATE_TEMP_PROBE = '0.1';
    expect(readoutTemperature('probe')).toBe(0.7);
    process.env.DECISION_GATE_TEMP_PROBE = '50';
    expect(readoutTemperature('probe')).toBe(10);
  });

  describe('store-backed mode (WI-S, 2026-09-25)', () => {
    it('the stored fleet-wide mode wins over the env chain once the cache holds it; "" / unknown values fall back to env', async () => {
      process.env.DECISION_GATE_MODE_AUTO_ROUTE = 'shadow';
      // Cold cache: env answers (no background read under NODE_ENV=test — hermeticity).
      expect(decisionModeWithSource('auto_route')).toEqual({ mode: 'shadow', source: 'env_purpose' });
      expect(mockStoreGet).not.toHaveBeenCalled();
      mockStoreGet.mockResolvedValue({ modes: { auto_route: 'act', wake_triage: 'nonsense', probe: 'off', bogus: 'act' } });
      await refreshDecisionModes();
      expect(mockStoreGet).toHaveBeenCalledWith(['instance', 'decision-gate'], 'modes');
      expect(decisionModeWithSource('auto_route')).toEqual({ mode: 'act', source: 'store' });
      // Invalid stored values are ignored → env chain (this suite's beforeEach sets DECISION_GATE_DEFAULT_MODE=shadow).
      expect(decisionModeWithSource('wake_triage')).toEqual({ mode: 'shadow', source: 'env_default' });
      delete process.env.DECISION_GATE_DEFAULT_MODE;
      expect(decisionModeWithSource('wake_triage')).toEqual({ mode: 'off', source: 'default' }); // bare test default
      // 'probe' can never be stored — always act.
      expect(decisionMode('probe')).toBe('act');
    });

    it('agent-decisions prerequisite 3: a stored act on the registry-CAPPED drain_triage runs shadow (source registry_cap); DECISION_GATE_DRAIN_TRIAGE_ACT_CAP_DISABLED=1 restores the store mode', async () => {
      mockStoreGet.mockResolvedValue({ modes: { drain_triage: 'act', auto_route: 'act' } });
      await refreshDecisionModes();
      expect(decisionModeWithSource('drain_triage')).toEqual({ mode: 'shadow', source: 'registry_cap' });
      expect(decisionMode('drain_triage')).toBe('shadow');
      expect(decisionModeWithSource('auto_route')).toEqual({ mode: 'act', source: 'store' }); // uncapped purposes untouched
      process.env.DECISION_GATE_DRAIN_TRIAGE_ACT_CAP_DISABLED = '1';
      expect(decisionModeWithSource('drain_triage')).toEqual({ mode: 'act', source: 'store' });
    });

    it('DECISION_GATE_DISABLED=1 still wins over a stored act', async () => {
      mockStoreGet.mockResolvedValue({ modes: { auto_route: 'act' } });
      await refreshDecisionModes();
      expect(decisionMode('auto_route')).toBe('act');
      process.env.DECISION_GATE_DISABLED = '1';
      expect(decisionModeWithSource('auto_route')).toEqual({ mode: 'off', source: 'disabled' });
    });

    it('a store read failure keeps the last known modes (fail-open), never throws', async () => {
      mockStoreGet.mockResolvedValue({ modes: { auto_route: 'off' } });
      await refreshDecisionModes();
      expect(decisionMode('auto_route')).toBe('off');
      clearDecisionModeCache();
      mockStoreGet.mockRejectedValue(new Error('db down'));
      await expect(refreshDecisionModes()).resolves.toEqual({});
      expect(decisionModeWithSource('auto_route')).toEqual({ mode: 'shadow', source: 'env_default' });
    });
  });
});

describe('logprob readout math', () => {
  it('maps tokens to option letters', () => {
    expect(letterOfToken(' B')).toBe('B');
    expect(letterOfToken('b.')).toBe('B');
    expect(letterOfToken('The')).toBeNull();
    expect(letterOfToken('')).toBeNull();
    expect(letterOfToken(undefined)).toBeNull();
  });

  it('sums duplicate spellings, zeroes absent letters, and normalizes', () => {
    const d = readoutDistribution(
      [{ token: 'B', logprob: Math.log(0.5) }, { token: ' B', logprob: Math.log(0.2) }, { token: 'A', logprob: Math.log(0.3) }],
      ['no', 'yes'],
      1,
    );
    expect(d.yes).toBeCloseTo(0.7, 5);
    expect(d.no).toBeCloseTo(0.3, 5);
  });

  it('temperature > 1 flattens, < 1 sharpens', () => {
    const top = [{ token: 'A', logprob: Math.log(0.8) }, { token: 'B', logprob: Math.log(0.2) }];
    const flat = readoutDistribution(top, ['x', 'y'], 2);
    const sharp = readoutDistribution(top, ['x', 'y'], 0.5);
    expect(flat.x).toBeLessThan(0.8);
    expect(sharp.x).toBeGreaterThan(0.8);
  });

  it('readoutLetterLogits keeps RAW per-option logprobs keyed by option key; distributionFromLogits is the softmax runtime and the fit share (WI-I)', () => {
    const raw = readoutLetterLogits([{ token: 'B', logprob: Math.log(0.5) }, { token: ' B', logprob: Math.log(0.2) }, { token: 'A', logprob: Math.log(0.3) }, { token: 'C', logprob: -1 }], ['no', 'yes']);
    expect(Object.keys(raw).sort()).toEqual(['no', 'yes']); // 'C' is beyond the option count
    expect(raw.yes).toBeCloseTo(Math.log(0.7), 5);
    expect(raw.no).toBeCloseTo(Math.log(0.3), 5);
    expect(distributionFromLogits(raw, ['no', 'yes'], 1).yes).toBeCloseTo(0.7, 5);
    // A saturated pair (the prod wake_triage shape) becomes GRADED under a fitted T > 1 — strictly inside (0, 1).
    const saturated = { no: -0.0001, yes: -9.2 };
    expect(distributionFromLogits(saturated, ['no', 'yes'], 1).yes).toBeLessThan(0.001);
    const graded = distributionFromLogits(saturated, ['no', 'yes'], 4);
    expect(graded.yes).toBeGreaterThan(0.05);
    expect(graded.yes).toBeLessThan(0.5);
    // An option absent from the top-k has zero mass at any temperature.
    expect(distributionFromLogits({ no: -0.5 }, ['no', 'yes'], 3).yes).toBe(0);
    expect(() => distributionFromLogits({}, ['no', 'yes'], 1)).toThrow(/no option logits/);
  });

  it('ignores letters beyond the option count and throws when none match', () => {
    const d = readoutDistribution([{ token: 'C', logprob: -0.1 }, { token: 'A', logprob: -2 }], ['x', 'y'], 1);
    // 'C' is beyond the option count (no key), but it still BOUNDS the absent
    // 'y': E2 censors y to lowest-listed − 1 = −3 instead of −∞, so x keeps
    // the argmax with e^-2 / (e^-2 + e^-3) of the mass — not exactly 1.
    expect(d.x).toBeCloseTo(Math.exp(-2) / (Math.exp(-2) + Math.exp(-3)), 6);
    expect(d.y).toBeGreaterThan(0);
    expect(d.x).toBeGreaterThan(d.y);
    expect(() => readoutDistribution([{ token: 'The', logprob: -0.1 }], ['x', 'y'], 1)).toThrow(/no option letters/);
  });

  it('renders the state, question and lettered options; noul is A=no / B=yes', () => {
    const msgs = buildReadoutMessages({ a: 1 }, QUESTIONS.refund, { keys: ['no', 'yes'], lines: ['A. no — nope', 'B. yes — yep'] });
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].content).toContain('STATE:\n{\n "a": 1\n}');
    expect(msgs[1].content).toContain('QUESTION: The customer asks for money back.');
    expect(msgs[1].content).toContain('A. no — nope\nB. yes — yep');
  });
});

describe('systemone answer parsing', () => {
  it('accepts the TypeSafe shapes and renormalizes probabilities', () => {
    const out = parseSystemOneAnswers({
      refund: { type: 'noul', noul: 0.97 },
      team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9, technical: 0.05, sales: 0.05 }, confidence: 0.9 },
      urgency: { type: 'score', score: 1.43, probabilities: { '0': 0, '1': 0.57, '2': 0.43 }, confidence: 0.35, legend: {} },
    }, QUESTIONS);
    expect(out.refund).toEqual({ type: 'noul', noul: 0.97 });
    expect(out.team).toMatchObject({ type: 'choice', choice: 'billing', confidence: 0.9 });
    expect(out.urgency).toMatchObject({ type: 'score', score: 1.43, confidence: 0.35 });
  });

  it('derives choice/confidence and score from probabilities when the server omits them', () => {
    const out = parseSystemOneAnswers({
      refund: { noul: '0.2' },
      team: { probabilities: { billing: 1, technical: 3, sales: 0 } },
      urgency: { probabilities: { '0': 0, '1': 1, '2': 1 } },
    }, QUESTIONS);
    expect(out.refund).toEqual({ type: 'noul', noul: 0.2 });
    expect(out.team).toMatchObject({ type: 'choice', choice: 'technical' });
    expect((out.team as any).confidence).toBeCloseTo(0.75, 5);
    expect((out.urgency as any).score).toBeCloseTo(1.5, 5);
  });

  it('rejects missing or malformed answers', () => {
    expect(() => parseSystemOneAnswers({}, QUESTIONS)).toThrow(/no answer for "refund"/);
    expect(() => parseSystemOneAnswers({ refund: { noul: 'x' }, team: {}, urgency: {} }, QUESTIONS)).toThrow(/numeric noul/);
    expect(() => parseSystemOneAnswers({ refund: { noul: 1 }, team: { probabilities: { billing: 'a' } }, urgency: {} }, QUESTIONS)).toThrow(/per-option probabilities/);
  });

  it('confidenceOf: noul distance from 0.5, choice/score their own field', () => {
    expect(confidenceOf({ type: 'noul', noul: 0.1 })).toBeCloseTo(0.9, 5);
    expect(confidenceOf({ type: 'choice', choice: 'a', probabilities: { a: 0.6, b: 0.4 }, confidence: 0.6 })).toBe(0.6);
    expect(confidenceOf(null)).toBe(0);
  });
});

describe('decide()', () => {
  it('returns null without calling any backend when the purpose is off', async () => {
    process.env.DECISION_GATE_MODE_AUTO_ROUTE = 'off';
    process.env.TYPESAFE_API_KEY = 'k';
    expect(await decide('s', QUESTIONS, { purpose: 'auto_route' })).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('returns null silently (no call, no telemetry row) when no backend is servable', async () => {
    const r = await decide('s', QUESTIONS, { purpose: 'auto_route' });
    expect(r).toBeNull();
    expect(post).not.toHaveBeenCalled();
    expect(recordLoopMetric).not.toHaveBeenCalled();
  });

  it('rejects invalid questions without a call', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    const r = await decide('s', { bad: { type: 'choice', instructions: 'x', criteria: { only: 'one' } } }, { purpose: 'auto_route' });
    expect(r).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('TypeSafe backend: posts the systemone body, parses answers, records the row', async () => {
    process.env.TYPESAFE_API_KEY = 'secret-key';
    post.mockResolvedValueOnce({ data: {
      model: 'jev-1.13.0',
      answers: {
        refund: { type: 'noul', noul: 0.98 },
        team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.96, technical: 0.03, sales: 0.01 }, confidence: 0.96 },
        urgency: { type: 'score', score: 1.9, probabilities: { '0': 0.05, '1': 0, '2': 0.95 }, confidence: 0.9 },
      },
      usage: { input_tokens: 275, output_tokens: 0 },
    } });
    const r = await decide({ message: 'refund me' }, QUESTIONS, { purpose: 'auto_route', sessionId: 'chat1' });
    expect(r).not.toBeNull();
    expect(r!.backend).toBe('TypeSafe Jev');
    expect(r!.answers.team).toMatchObject({ choice: 'billing' });
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body, cfg] = post.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    // E4: the request id is PINNED to the versioned model, never the moving alias.
    expect(TYPESAFE_DEFAULT_MODEL).toBe('jev-1.13.0');
    expect(body).toEqual({ model: 'jev-1.13.0', state: { message: 'refund me' }, questions: QUESTIONS });
    expect(cfg.headers.Authorization).toBe('Bearer secret-key');
    const row = (recordLoopMetric as jest.Mock).mock.calls[0][0];
    expect(row.sessionId).toBe('chat1');
    // E4: the id the server ANSWERED with rides the row; E2: systemone is calibrated; E3: the hashes ride every row.
    expect(row.meta).toMatchObject({ purpose: 'auto_route', mode: 'shadow', ok: true, backend: 'TypeSafe Jev', inputTokens: 275, modelId: 'jev-1.13.0', calibrated: true });
    expect(row.meta.stateHash).toMatch(/^[0-9a-f]{16}$/);
    // questionsHash is the canonical hashQuestions() key (12 hex; E3 dedupe + E7/E8 partition share it).
    expect(row.meta.questionsHash).toMatch(/^[0-9a-f]{12}$/);
    expect(r!).toMatchObject({ calibrated: true, modelId: 'jev-1.13.0', stateHash: row.meta.stateHash, questionsHash: row.meta.questionsHash });
    // 2026-09-26: a systemone row keeps the per-option probabilities (4 dp) — the fit derives log p from them (the row carries no logits at T = 1).
    expect(row.meta.answers.team).toEqual({ choice: 'billing', confidence: 0.96, probabilities: { billing: 0.96, technical: 0.03, sales: 0.01 } });
    expect(row.meta).toMatchObject({ backendSpec: 'jev', backendKind: 'systemone' });
    expect(row.meta.logits).toBeUndefined();
    expect(row.meta.temperature).toBeUndefined();
    expect(row.meta.stateTruncated).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('refund me'); // the state never lands in telemetry
    // E7/E8: the request-shape partition key rides every decision row.
    expect(row.meta.questionsHash).toBe(hashQuestions(QUESTIONS));
  });

  it('TypeSafe backend: honours TYPESAFE_BASE_URL / TYPESAFE_MODEL and retries once on 429', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    process.env.TYPESAFE_BASE_URL = 'https://ai-gateway.vercel.sh/typesafe/v1/';
    process.env.TYPESAFE_MODEL = 'typesafe-ai/jev';
    post.mockRejectedValueOnce({ response: { status: 429 } });
    post.mockResolvedValueOnce({ data: { answers: { refund: { noul: 0.5 }, team: { probabilities: { billing: 1, technical: 0, sales: 0 } }, urgency: { probabilities: { '0': 1, '1': 0, '2': 0 } } } } });
    const r = await decide('s', QUESTIONS, { purpose: 'auto_route', timeoutMs: 5000 });
    expect(r!.backend).toBe('TypeSafe Jev');
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][0]).toBe('https://ai-gateway.vercel.sh/typesafe/v1/systemone');
    expect(post.mock.calls[0][1].model).toBe('typesafe-ai/jev');
  });

  it('falls through the chain: TypeSafe fails → DeepSeek readout answers', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    process.env.DEEPSEEK_API_KEY = 'd';
    post.mockRejectedValueOnce({ response: { status: 500 }, message: 'boom' });
    // Three readout calls (one per question), any order — answer by option letter.
    post.mockImplementation(async (_url: string, payload: any) => {
      const content: string = payload.messages[1].content;
      let top: Array<{ token: string; logprob: number }>;
      if (content.includes('money back')) top = [{ token: 'B', logprob: Math.log(0.9) }, { token: 'A', logprob: Math.log(0.1) }];
      else if (content.includes('Which team')) top = [{ token: 'A', logprob: Math.log(0.8) }, { token: 'B', logprob: Math.log(0.15) }, { token: 'C', logprob: Math.log(0.05) }];
      else top = [{ token: 'C', logprob: Math.log(0.7) }, { token: 'B', logprob: Math.log(0.3) }];
      return { data: { choices: [{ logprobs: { content: [{ token: top[0].token, logprob: top[0].logprob, top_logprobs: top }] } }], usage: { prompt_tokens: 100 } } };
    });
    const r = await decide({ m: 'x' }, QUESTIONS, { purpose: 'auto_route', timeoutMs: 5000 });
    expect(r).not.toBeNull();
    expect(r!.backend).toBe('DeepSeek logprob readout');
    expect((r!.answers.refund as any).noul).toBeCloseTo(0.9, 5);
    expect(r!.answers.team).toMatchObject({ choice: 'billing' });
    // E2: level 0 was absent from the 2-entry top-k → censored to log(0.3) − 1
    // (mass 0.3/e), so the expected level is (0.3·1 + 0.7·2) / (1 + 0.3/e) —
    // no longer the exactly-1.7 that zero mass gave.
    expect((r!.answers.urgency as any).score).toBeCloseTo((0.3 + 1.4) / (1 + 0.3 / Math.E), 5);
    expect(r!.usage).toEqual({ input_tokens: 300, output_tokens: 3 });
    // The readout call shape: one token, logprobs, thinking OFF, temperature 0.
    const readoutCall = post.mock.calls[1];
    expect(readoutCall[0]).toBe('https://api.deepseek.com/chat/completions');
    expect(readoutCall[1]).toMatchObject({ model: 'deepseek-flash', max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: 20, thinking: { type: 'disabled' } });
    expect(READOUT_TOP_LOGPROBS).toBeGreaterThanOrEqual(5); // the temperature fit needs every option letter's logprob
    expect(readoutCall[2].headers.Authorization).toBe('Bearer d');
    // WI-H: the decision row names the failed first leg — the fall-through is no longer invisible.
    const row = (recordLoopMetric as jest.Mock).mock.calls[0][0];
    expect(row.meta).toMatchObject({ ok: true, backend: 'DeepSeek logprob readout', legIndex: 1, modeSource: 'env_default' });
    expect(row.meta.legErrors).toHaveLength(1);
    expect(row.meta.legErrors[0]).toContain('TypeSafe Jev: HTTP 500');
    expect(row.meta.failedLegMs === undefined || row.meta.failedLegMs >= 0).toBe(true);
    // WI-I: the raw per-option logprobs ride the row, keyed by OPTION KEY (pairs with the outcome's actual).
    expect(row.meta.logits.refund.yes).toBeCloseTo(Math.log(0.9), 3);
    expect(row.meta.logits.refund.no).toBeCloseTo(Math.log(0.1), 3);
    expect(Object.keys(row.meta.logits.team).sort()).toEqual(['billing', 'sales', 'technical']);
    // E2: level 0 was absent from the (2-entry, not full) top-k → CENSORED to lowest − 1 nat, not omitted (−∞).
    expect(row.meta.logits.urgency).toEqual({ '0': Number((Math.log(0.3) - 1).toFixed(4)), '1': Number(Math.log(0.3).toFixed(4)), '2': Number(Math.log(0.7).toFixed(4)) });
    expect(row.meta.censored).toEqual({ urgency: ['0'] });
    // The censored option carries real (small) mass, so the score is no longer exactly the two-option value.
    expect((r!.answers.urgency as any).probabilities['0']).toBeGreaterThan(0);
    expect((r!.answers.urgency as any).probabilities['0']).toBeLessThan(0.15);
    // E2: a readout with NO fitted per-purpose temperature is uncalibrated — in shadow that changes nothing.
    expect(row.meta.calibrated).toBe(false);
    expect(r!.calibrated).toBe(false);
    expect(r!.mode).toBe('shadow');
  });

  it('WI-H: first leg 429s twice (retry exhausted) → readout answers; row carries legErrors naming the 429 and legIndex=1', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    process.env.DEEPSEEK_API_KEY = 'd';
    post.mockRejectedValueOnce({ response: { status: 429 } });
    post.mockRejectedValueOnce({ response: { status: 429 } });
    post.mockImplementation(async () => ({ data: { choices: [{ logprobs: { content: [{ token: 'A', logprob: Math.log(0.6), top_logprobs: [{ token: 'A', logprob: Math.log(0.6) }, { token: 'B', logprob: Math.log(0.4) }] }] } }], usage: { prompt_tokens: 10 } } }));
    const r = await decide('s', { refund: QUESTIONS.refund }, { purpose: 'auto_route', timeoutMs: 5000 });
    expect(r!.backend).toBe('DeepSeek logprob readout');
    expect(post).toHaveBeenCalledTimes(3); // 429, retry 429, readout
    const row = (recordLoopMetric as jest.Mock).mock.calls[0][0];
    expect(row.meta.legIndex).toBe(1);
    expect(row.meta.legErrors).toEqual([expect.stringContaining('TypeSafe Jev: HTTP 429')]);
    expect(JSON.stringify(row.meta.legErrors)).not.toContain('Bearer k');
  });

  it('a TypeSafe row carries NO logits / legErrors (systemone is calibrated server-side; nothing fell through)', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    post.mockResolvedValueOnce({ data: { answers: { refund: { noul: 0.5 }, team: { probabilities: { billing: 1, technical: 0, sales: 0 } }, urgency: { probabilities: { '0': 1, '1': 0, '2': 0 } } } } });
    await decide('s', QUESTIONS, { purpose: 'auto_route', timeoutMs: 5000 });
    const row = (recordLoopMetric as jest.Mock).mock.calls[0][0];
    expect(row.meta.logits).toBeUndefined();
    expect(row.meta.legErrors).toBeUndefined();
    expect(row.meta.legIndex).toBeUndefined();
  });

  it('probe spec: calls exactly that backend, no chain', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    process.env.DEEPSEEK_API_KEY = 'd';
    post.mockRejectedValue({ response: { status: 401 }, message: 'nope' });
    const r = await decide('s', QUESTIONS, { purpose: 'probe', spec: 'jev', timeoutMs: 2000 });
    expect(r).toBeNull();
    expect(post).toHaveBeenCalledTimes(1); // no DeepSeek leg for a spec-pinned call
    const row = (recordLoopMetric as jest.Mock).mock.calls[0][0];
    expect(row.meta.error).toContain('TypeSafe Jev');
    expect(row.meta.error).not.toContain('Bearer k');
    // All-legs-fail path: the error field carries the joined text and (review 2026-09-26, additive) legErrors names
    // every failed leg, so the readiness comparison counts one failure per backend during a full outage; no legIndex.
    expect(row.meta.legErrors).toEqual([expect.stringContaining('TypeSafe Jev: HTTP 401')]);
    expect(JSON.stringify(row.meta.legErrors)).not.toContain('Bearer k');
    expect(row.meta.legIndex).toBeUndefined();
    expect(row.meta.ok).toBe(false);
  });

  it('recordDecisionOutcome computes agreement in the question vocabulary', () => {
    const decision = { id: 'abc', mode: 'shadow' as const, backend: 'x', ms: 5, answers: {
      refund: { type: 'noul' as const, noul: 0.8 },
      team: { type: 'choice' as const, choice: 'billing', probabilities: { billing: 0.7, technical: 0.3 }, confidence: 0.7 },
    } };
    recordDecisionOutcome(decision, 'auto_route', { question: 'refund', actual: true, acted: false });
    recordDecisionOutcome(decision, 'auto_route', { question: 'team', actual: 'technical', acted: false });
    recordDecisionOutcome(null, 'auto_route', { question: 'team', actual: 'technical', acted: false });
    const calls = (recordLoopMetric as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toMatchObject({ value: 1, meta: { phase: 'outcome', id: 'abc', question: 'refund', agreed: true, actual: true } });
    expect(calls[1][0]).toMatchObject({ value: 0, meta: { phase: 'outcome', question: 'team', agreed: false, actual: 'technical', confidence: 0.7 } });
    // E1: the choice keeps its per-option probabilities on the outcome row (compactAnswers drops them on the decision row).
    expect(calls[1][0].meta.predicted).toEqual({ choice: 'billing', confidence: 0.7, probabilities: { billing: 0.7, technical: 0.3 } });
    expect(calls[0][0].meta.predicted).toEqual({ noul: 0.8 });
  });

  it('E1: the outcome row carries the REAL act cutoff (thresholdUsed), whether the answer sat in the act band, and agreement AT that cutoff — not only the 0.5 rule', () => {
    const saved = process.env.DECISION_GATE_THRESHOLD_WAKE_TRIAGE;
    delete process.env.DECISION_GATE_THRESHOLD_WAKE_TRIAGE;
    try {
      const wake = (noul: number) => ({ id: 'w', mode: 'shadow' as const, backend: 'TypeSafe Jev', ms: 1, answers: { needs_turn_now: { type: 'noul' as const, noul } } });
      // noul 0.07 ≤ 0.15 → in the park band; the woken run then ACTED (actual true) → a false park at the cutoff.
      recordDecisionOutcome(wake(0.07), 'wake_triage', { question: 'needs_turn_now', actual: true, acted: false });
      // noul 0.07, run was a no-op → agreed both ways.
      recordDecisionOutcome(wake(0.07), 'wake_triage', { question: 'needs_turn_now', actual: false, acted: false });
      // noul 0.3 → argmax 'no' agrees at 0.5, but OUTSIDE the act band: no agreedAtCutoff (the gate would not have parked).
      recordDecisionOutcome(wake(0.3), 'wake_triage', { question: 'needs_turn_now', actual: false, acted: false });
      // acted rows (actual null) carry the band + threshold but no agreement of either kind.
      recordDecisionOutcome(wake(0.05), 'wake_triage', { question: 'needs_turn_now', actual: null, acted: true });
      const calls = (recordLoopMetric as jest.Mock).mock.calls.map(c => c[0].meta);
      expect(calls[0]).toMatchObject({ agreed: false, thresholdUsed: 0.85, inActBand: true, agreedAtCutoff: false });
      expect(calls[1]).toMatchObject({ agreed: true, thresholdUsed: 0.85, inActBand: true, agreedAtCutoff: true });
      expect(calls[2]).toMatchObject({ agreed: true, thresholdUsed: 0.85, inActBand: false });
      expect(calls[2].agreedAtCutoff).toBeUndefined();
      expect(calls[3]).toMatchObject({ acted: true, thresholdUsed: 0.85, inActBand: true });
      expect(calls[3].agreed).toBeUndefined();
      expect(calls[3].agreedAtCutoff).toBeUndefined();
      // The env override the consumer reads (DECISION_GATE_THRESHOLD_<PURPOSE>) moves the recorded cutoff too.
      process.env.DECISION_GATE_THRESHOLD_WAKE_TRIAGE = '0.95';
      recordDecisionOutcome(wake(0.07), 'wake_triage', { question: 'needs_turn_now', actual: true, acted: false });
      expect((recordLoopMetric as jest.Mock).mock.calls[4][0].meta).toMatchObject({ thresholdUsed: 0.95, inActBand: false });
      // Choice purposes: in band at confidence ≥ τ (0.7 for auto_route), agreement = the acted choice vs the heuristic.
      const route = { id: 'r', mode: 'shadow' as const, backend: 'TypeSafe Jev', ms: 1, answers: { level: { type: 'choice' as const, choice: 'thinking', probabilities: { thinking: 0.72, single_thinking: 0.28 }, confidence: 0.72 } } };
      recordDecisionOutcome(route, 'auto_route', { question: 'level', actual: 'single_thinking', acted: false });
      expect((recordLoopMetric as jest.Mock).mock.calls[5][0].meta).toMatchObject({ agreed: false, thresholdUsed: 0.7, inActBand: true, agreedAtCutoff: false, predicted: { probabilities: { thinking: 0.72, single_thinking: 0.28 } } });
    } finally {
      if (saved === undefined) delete process.env.DECISION_GATE_THRESHOLD_WAKE_TRIAGE; else process.env.DECISION_GATE_THRESHOLD_WAKE_TRIAGE = saved;
    }
  });
});

/* WI-C (2026-09-25): deferred outcomes — a decision made at delivery / fire /
 * pre-audit time is stashed, rides the run, and is labelled at finalize with
 * agreement computed against the STORED answer (possibly in another process). */
describe('deferred outcomes (WI-C)', () => {
  const decision = { id: 'd1', mode: 'shadow' as const, backend: 'TypeSafe Jev', ms: 12, answers: {
    needs_turn_now: { type: 'noul' as const, noul: 0.08 },
  } };

  it('stashDecision → JSON round trip → reconstructDecision keeps id/mode/backend/answers and recordDecisionOutcome computes agreed', () => {
    const stash = stashDecision(decision, 'wake_triage');
    expect(stash).toMatchObject({ id: 'd1', purpose: 'wake_triage', mode: 'shadow', backend: 'TypeSafe Jev' });
    expect(typeof stash!.decidedAt).toBe('string');
    const rebuilt = reconstructDecision(JSON.parse(JSON.stringify(stash)));
    expect(rebuilt).toMatchObject({ id: 'd1', purpose: 'wake_triage', mode: 'shadow', backend: 'TypeSafe Jev', ms: 0 });
    // The woken run took an action (actual true) against a "no turn needed" answer → disagreed.
    recordDecisionOutcome(rebuilt, 'wake_triage', { question: 'needs_turn_now', actual: true, acted: false, note: 'finalized' });
    // The woken run was a no-op (actual false) → agreed.
    recordDecisionOutcome(rebuilt, 'wake_triage', { question: 'needs_turn_now', actual: false, acted: false });
    const calls = (recordLoopMetric as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toMatchObject({ value: 0, meta: { phase: 'outcome', id: 'd1', purpose: 'wake_triage', backend: 'TypeSafe Jev', agreed: false, actual: true, acted: false } });
    expect(calls[1][0]).toMatchObject({ value: 1, meta: { phase: 'outcome', id: 'd1', agreed: true, actual: false } });
  });

  it('stashDecision(null) is null; reconstructDecision rejects garbage, a bad mode, and answer-less stashes; malformed answers are dropped', () => {
    expect(stashDecision(null, 'wake_triage')).toBeNull();
    expect(stashDecision(undefined, 'wake_triage')).toBeNull();
    expect(reconstructDecision(null)).toBeNull();
    expect(reconstructDecision('nope')).toBeNull();
    expect(reconstructDecision({ id: 'x', purpose: 'wake_triage', mode: 'weird', answers: { q: { type: 'noul', noul: 0.5 } } })).toBeNull();
    expect(reconstructDecision({ id: 'x', purpose: 'wake_triage', mode: 'shadow', answers: {} })).toBeNull();
    expect(reconstructDecision({ id: '', purpose: 'wake_triage', mode: 'shadow', answers: { q: { type: 'noul', noul: 0.5 } } })).toBeNull();
    const partial = reconstructDecision({ id: 'x', purpose: 'delta_material', mode: 'act', answers: { good: { type: 'noul', noul: 0.9 }, bad: { type: 'noul', noul: 'high' }, c: { type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: 1 } } });
    expect(partial).not.toBeNull();
    expect(Object.keys(partial!.answers).sort()).toEqual(['c', 'good']);
    expect(partial!.backend).toBe('unknown');
    // A reconstruct from a null stash makes recordDecisionOutcome the existing no-op.
    recordDecisionOutcome(reconstructDecision(undefined), 'wake_triage', { question: 'needs_turn_now', actual: true, acted: false });
    expect(recordLoopMetric).not.toHaveBeenCalled();
  });
});

/* E2 / E3 / E4 / E12 (2026-09-25, DECISION_MODEL_ENHANCEMENTS §4): act only on
 * a calibrated backend, per-leg budgets, censored readout letters, memoised
 * identical asks with stateHash / questionsHash stamps, the pinned model id,
 * and the act-band feed of the auto-demotion window. */
describe('E2 — act only on a calibrated backend; per-leg budgets; censored readout letters', () => {
  const NOUL_ONLY: Record<string, DecisionQuestion> = { refund: QUESTIONS.refund };
  const readoutOk = (yes = 0.02) => post.mockImplementation(async () => ({ data: { model: 'deepseek-flash', choices: [{ logprobs: { content: [{ token: 'A', logprob: Math.log(1 - yes), top_logprobs: [{ token: 'A', logprob: Math.log(1 - yes) }, { token: 'B', logprob: Math.log(yes) }] }] } }], usage: { prompt_tokens: 10 } } }));

  it('act purpose, Jev leg fails → the readout answers but comes back as mode SHADOW (uncalibrated); the row names the downgrade', async () => {
    process.env.DECISION_GATE_MODE_AUTO_ROUTE = 'act';
    process.env.TYPESAFE_API_KEY = 'k';
    process.env.DEEPSEEK_API_KEY = 'd';
    post.mockRejectedValueOnce({ response: { status: 500 }, message: 'boom' });
    readoutOk();
    const r = await decide('s', NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 5000 });
    expect(r).not.toBeNull();
    expect(r!.backend).toBe('DeepSeek logprob readout');
    expect(r!.calibrated).toBe(false);
    expect(r!.mode).toBe('shadow'); // ← no consumer acts on this
    expect(r!.modelId).toBe('deepseek-flash');
    const row = (recordLoopMetric as jest.Mock).mock.calls[0][0];
    expect(row.meta).toMatchObject({ mode: 'shadow', requestedMode: 'act', modeDowngrade: 'uncalibrated', calibrated: false, legIndex: 1, modelId: 'deepseek-flash' });
  });

  it('a readout with a FITTED per-purpose temperature is calibrated → act stays act; the global DECISION_GATE_TEMP does not count', async () => {
    process.env.DECISION_GATE_MODE_AUTO_ROUTE = 'act';
    process.env.DEEPSEEK_API_KEY = 'd';
    process.env.DECISION_GATE_TEMP = '2';
    expect(readoutTemperatureFitted('auto_route')).toBe(false);
    readoutOk();
    const r1 = await decide('s', NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 5000 });
    expect(r1!.mode).toBe('shadow');
    clearDecisionMemo();
    process.env.DECISION_GATE_TEMP_AUTO_ROUTE = '2.5';
    expect(readoutTemperatureFitted('auto_route')).toBe(true);
    const r2 = await decide('s', NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 5000 });
    expect(r2!.calibrated).toBe(true);
    expect(r2!.mode).toBe('act');
    const row = (recordLoopMetric as jest.Mock).mock.calls[1][0];
    expect(row.meta).toMatchObject({ mode: 'act', calibrated: true });
    expect(row.meta.modeDowngrade).toBeUndefined();
  });

  it('a systemone answer under act is calibrated and stays act', async () => {
    process.env.DECISION_GATE_MODE_AUTO_ROUTE = 'act';
    process.env.TYPESAFE_API_KEY = 'k';
    post.mockResolvedValueOnce({ data: { model: 'jev-1.13.0', answers: { refund: { noul: 0.03 } } } });
    const r = await decide('s', NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 5000 });
    expect(r).toMatchObject({ mode: 'act', calibrated: true, backend: 'TypeSafe Jev', modelId: 'jev-1.13.0' });
  });

  it('per-leg budget: a NON-final leg gets min(remaining, DECISION_GATE_LEG_TIMEOUT_MS); the LAST leg gets the whole remaining deadline; 0 = whole deadline everywhere', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    process.env.DEEPSEEK_API_KEY = 'd';
    expect(decisionLegTimeoutMs()).toBe(2000); // owner 2026-09-28: 1000 → 2000
    post.mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout' });
    readoutOk();
    await decide('s', NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 5000 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][2].timeout).toBeLessThanOrEqual(2000); // Jev leg capped
    expect(post.mock.calls[0][2].timeout).toBeGreaterThan(1600);
    expect(post.mock.calls[1][2].timeout).toBeGreaterThan(3000); // readout (last leg) gets the rest
    // A caller budget SMALLER than the leg cap is honoured as-is.
    clearDecisionMemo(); post.mockReset();
    post.mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout' });
    readoutOk();
    await decide('s2', NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 600 });
    expect(post.mock.calls[0][2].timeout).toBeLessThanOrEqual(600);
    // 0 → pre-E2: every leg gets the whole deadline.
    process.env.DECISION_GATE_LEG_TIMEOUT_MS = '0';
    expect(decisionLegTimeoutMs()).toBe(0);
    clearDecisionMemo(); post.mockReset();
    post.mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout' });
    readoutOk();
    await decide('s3', NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 5000 });
    expect(post.mock.calls[0][2].timeout).toBeGreaterThan(4000);
    process.env.DECISION_GATE_LEG_TIMEOUT_MS = '250';
    expect(decisionLegTimeoutMs()).toBe(250);
    process.env.DECISION_GATE_LEG_TIMEOUT_MS = 'nonsense';
    expect(decisionLegTimeoutMs()).toBe(0);
  });

  it('firing 42: a non-final leg can never eat more than HALF the remaining budget — a 1200 ms compute_policy ask caps Jev at ~600 ms so the readout keeps a reachable share', async () => {
    // The pure arithmetic, position-independently.
    expect(legShareCap(1000, 1200)).toBe(600); // the incident: Jev was allowed 1000 of 1200
    expect(legShareCap(1000, 1500)).toBe(750); // auto_route / imessage_send budgets
    expect(legShareCap(1000, 4000)).toBe(1000); // ≥2 s budgets: byte-identical to before
    expect(legShareCap(1000, 300)).toBe(150); // a tiny budget half-shares uniformly (150/150) — still better than an absolute cap that starves the tail to ~0
    expect(legShareCap(1000, 120)).toBe(60); // sub-100 budgets: the share tracks the budget, never the absolute cap
    expect(legShareCap(0, 1200)).toBe(0); // uncapped mode is untouched
    // The live shape: a 1200 ms ask, Jev hangs, the readout (last leg) answers
    // INSIDE the budget instead of all_legs_failed.
    process.env.TYPESAFE_API_KEY = 'k';
    process.env.DEEPSEEK_API_KEY = 'd';
    clearDecisionMemo(); post.mockReset();
    post.mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 600ms exceeded' });
    readoutOk();
    const r = await decide('s42', NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 1200 });
    expect(r).not.toBeNull();
    expect(r!.backend).toBe('DeepSeek logprob readout');
    expect(post.mock.calls[0][2].timeout).toBeLessThanOrEqual(600); // Jev capped at half
    expect(post.mock.calls[0][2].timeout).toBeGreaterThan(450);
    expect(post.mock.calls[1][2].timeout).toBeGreaterThan(450); // the readout keeps the other half
    // The failure row that fired the 14 alerts no longer exists: the ask ANSWERS.
    const failed = recordLoopMetric as jest.Mock;
    expect(failed).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'decision_gate', meta: expect.objectContaining({ purpose: 'auto_route', ok: false, legErrors: expect.any(Array) }) }));
  });

  it('censoring: absent option letters take the list floor (20th-ranked when the top-k is full, else lowest − 1 nat) and are named', () => {
    // Short list (not full): floor = lowest − 1.
    const d = readoutLetterLogitsDetailed([{ token: 'A', logprob: -0.05 }, { token: 'the', logprob: -3 }], ['no', 'yes']);
    expect(d.logits.no).toBeCloseTo(-0.05, 6);
    expect(d.logits.yes).toBeCloseTo(-4, 6); // −3 (lowest listed) − 1
    expect(d.censored).toEqual(['yes']);
    // The censored option now carries mass strictly inside (0, 1) — a fittable, non-saturated noul.
    const p = distributionFromLogits(d.logits, ['no', 'yes'], 1).yes;
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(0.05);
    // Full list (20 entries): floor = the 20th-ranked logprob itself.
    const full = Array.from({ length: 20 }, (_, i) => ({ token: i === 0 ? 'A' : `t${i}`, logprob: -0.01 - i }));
    const f = readoutLetterLogitsDetailed(full, ['no', 'yes']);
    expect(f.logits.yes).toBeCloseTo(-19.01, 6);
    expect(f.censored).toEqual(['yes']);
    expect(readoutCensorFloor(-19.01, 20, 20)).toBeCloseTo(-19.01, 6);
    expect(readoutCensorFloor(-3, 2, 20)).toBe(-4);
    expect(censorAbsentLogits({ a: -1 }, ['a', 'b', 'c'], -9)).toEqual({ logits: { a: -1, b: -9, c: -9 }, censored: ['b', 'c'] });
    // A censored option can never outrank a listed one.
    expect(f.logits.yes).toBeLessThanOrEqual(f.logits.no);
  });
});

describe('E3 — memoised identical asks + stateHash / questionsHash stamps', () => {
  const NOUL_ONLY: Record<string, DecisionQuestion> = { refund: QUESTIONS.refund };
  const jevOk = () => post.mockResolvedValue({ data: { model: 'jev-1.13.0', answers: { refund: { noul: 0.91 } }, usage: { input_tokens: 40 } } });

  it('an identical ask inside the TTL answers from the memo: no backend call, its own row with cached:true + cachedFrom, same hashes; a different state calls again', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    jevOk();
    const r1 = await decide({ a: 1 }, NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 5000 });
    const r2 = await decide({ a: 1 }, NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 5000, sessionId: 'c2' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(r2!.cached).toBe(true);
    expect(r2!.id).not.toBe(r1!.id); // fresh id → outcomes still pair 1:1
    expect(r2!.answers).toEqual(r1!.answers);
    expect(r2).toMatchObject({ backend: 'TypeSafe Jev', calibrated: true, modelId: 'jev-1.13.0', stateHash: r1!.stateHash, questionsHash: r1!.questionsHash });
    const rows = (recordLoopMetric as jest.Mock).mock.calls.map(c => c[0]);
    expect(rows).toHaveLength(2);
    expect(rows[0].meta.cached).toBeUndefined();
    expect(rows[1]).toMatchObject({ sessionId: 'c2', meta: { phase: 'decision', ok: true, cached: true, cachedFrom: r1!.id, stateHash: r1!.stateHash, questionsHash: r1!.questionsHash, backend: 'TypeSafe Jev' } });
    expect(rows[1].meta.logits).toBeUndefined(); // a cached row never feeds the fit twice
    // Different state → new call; same state, different question → new call.
    await decide({ a: 2 }, NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 5000 });
    expect(post).toHaveBeenCalledTimes(2);
    await decide({ a: 1 }, { refund: { ...QUESTIONS.refund, instructions: 'reworded' } }, { purpose: 'auto_route', timeoutMs: 5000 });
    expect(post).toHaveBeenCalledTimes(3);
    // A different purpose with the same state + questions is a different key.
    await decide({ a: 1 }, NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
    expect(post).toHaveBeenCalledTimes(4);
  });

  it('hashes are deterministic per (purpose, questions, state) and change with any of them', () => {
    const h1 = decisionHashes('auto_route', QUESTIONS, { x: 1 });
    const h2 = decisionHashes('auto_route', QUESTIONS, { x: 1 });
    expect(h1).toEqual(h2);
    expect(h1.stateHash).toMatch(/^[0-9a-f]{16}$/);
    expect(h1.memoHash).toBe(h1.stateHash); // nothing volatile in {x:1} → the projection is the state itself
    expect(h1.memoKey).toBe(`auto_route|${h1.questionsHash}|${h1.memoHash}`);
    expect(decisionHashes('auto_route', QUESTIONS, { x: 2 }).stateHash).not.toBe(h1.stateHash);
    expect(decisionHashes('auto_route', QUESTIONS, { x: 2 }).questionsHash).toBe(h1.questionsHash);
    expect(decisionHashes('wake_triage', QUESTIONS, { x: 1 }).memoKey).not.toBe(h1.memoKey);
  });

  /* E3b (2026-09-25): the memo key is a MEMO-STABLE projection, not the
   * exact state — live, the wake_triage memo never hit (0 cached rows / 37
   * min) because the state carried whole-minute ages and the batch count. */
  describe('E3b — memo key over a memo-stable projection; meta.stateHash stays exact, meta.memoHash is the memo key', () => {
    it('bucketMinutes: 0–5 / 5–15 / 15–60 / 60+ / unknown', () => {
      expect([0, 4.9, 5, 14, 15, 59, 60, 1e6].map(bucketMinutes)).toEqual(['0-5m', '0-5m', '5-15m', '5-15m', '15-60m', '15-60m', '60m+', '60m+']);
      expect(bucketMinutes(NaN)).toBe('unknown');
    });

    it('memoProjection (generic fallback) buckets *_min / *_minutes / *_ago / age-token numerics, drops *_at / *At / timestamp / *_ts keys, and leaves everything else (page, usage, message, strings, arrays, nested) alone', () => {
      const state = {
        events: 3, page: 2, usage: 7, stage: 1, message: 'hi',
        oldest_event_age_min: 65, newest_event_age_min: 3, age: 20, ended_min_ago: 12, wait_minutes: 16, retry_ago: 0,
        created_at: '2026-09-25T00:00:00Z', triagedAt: 'x', timestamp: 1, last_ts: 2, updatedAt: new Date(0),
        nested: { last_run: { ended_min_ago: 4, status: 'completed', finished_at: 'now' }, list: [{ age_min: 30, id: 'a' }, 'keep'] },
        n: null, dt: new Date(0),
      };
      expect(memoProjection(state)).toEqual({
        events: 3, page: 2, usage: 7, stage: 1, message: 'hi',
        oldest_event_age_min: '60m+', newest_event_age_min: '0-5m', age: '15-60m', ended_min_ago: '5-15m', wait_minutes: '15-60m', retry_ago: '0-5m',
        nested: { last_run: { ended_min_ago: '0-5m', status: 'completed' }, list: [{ age_min: '15-60m', id: 'a' }, 'keep'] },
        n: null, dt: '[date]',
      });
      // Strings and scalars pass through; a string 'age' field is not bucketed.
      expect(memoProjection('plain text state')).toBe('plain text state');
      expect(memoProjection({ age: 'old' })).toEqual({ age: 'old' });
      expect(memoProjection(null)).toBeNull();
    });

    it('decisionHashes: an explicit memoState keys the memo; the generic projection is the fallback', () => {
      const a = decisionHashes('wake_triage', QUESTIONS, { ids: ['e1'], oldest_event_age_min: 5 });
      const b = decisionHashes('wake_triage', QUESTIONS, { ids: ['e1'], oldest_event_age_min: 6 });
      expect(a.stateHash).not.toBe(b.stateHash);
      expect(a.memoHash).toBe(b.memoHash); // generic fallback: both ages bucket to 5-15m
      expect(a.memoKey).toBe(b.memoKey);
      const c = decisionHashes('wake_triage', QUESTIONS, { ids: ['e1'], oldest_event_age_min: 6 }, { ids: ['e1'] });
      const d = decisionHashes('wake_triage', QUESTIONS, { ids: ['e1'], oldest_event_age_min: 40 }, { ids: ['e1'] });
      expect(c.memoHash).toBe(d.memoHash); // explicit memoState wins over the (differing) generic buckets
      expect(c.memoHash).not.toBe(a.memoHash);
      expect(decisionHashes('wake_triage', QUESTIONS, { ids: ['e1'], oldest_event_age_min: 6 }, { ids: ['e1', 'e2'] }).memoHash).not.toBe(c.memoHash);
    });

    it('decide(): a re-ask whose exact state differs only in a bucketed age is a memo hit; the rows stamp the exact stateHash AND the shared memoHash; memo:false never reads or writes', async () => {
      process.env.TYPESAFE_API_KEY = 'k';
      jevOk();
      const r1 = await decide({ ids: ['e1'], oldest_event_age_min: 5 }, NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
      const r2 = await decide({ ids: ['e1'], oldest_event_age_min: 6 }, NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
      expect(post).toHaveBeenCalledTimes(1);
      expect(r2).toMatchObject({ cached: true, memoHash: r1!.memoHash });
      expect(r2!.stateHash).not.toBe(r1!.stateHash);
      const rows = (recordLoopMetric as jest.Mock).mock.calls.map(c => c[0]);
      expect(rows[0].meta).toMatchObject({ stateHash: r1!.stateHash, memoHash: r1!.memoHash });
      expect(rows[1].meta).toMatchObject({ cached: true, cachedFrom: r1!.id, stateHash: r2!.stateHash, memoHash: r1!.memoHash });
      // Explicit memoState: a different exact state with the same memoState hits.
      const r3 = await decide({ ids: ['e1'], oldest_event_age_min: 40 }, NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000, memoState: { ids: ['e1'] } });
      expect(post).toHaveBeenCalledTimes(2);
      const r4 = await decide({ ids: ['e1'], oldest_event_age_min: 90 }, NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000, memoState: { ids: ['e1'] } });
      expect(post).toHaveBeenCalledTimes(2);
      expect(r4).toMatchObject({ cached: true, memoHash: r3!.memoHash });
      // memo:false — never served, never stored.
      await decide({ ids: ['e1'], oldest_event_age_min: 90 }, NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000, memoState: { ids: ['e1'] }, memo: false });
      expect(post).toHaveBeenCalledTimes(3);
      clearDecisionMemo();
      await decide({ ids: ['e9'] }, NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000, memo: false });
      expect((await decide({ ids: ['e9'] }, NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 }))!.cached).toBeUndefined();
      expect(post).toHaveBeenCalledTimes(5);
    });
  });

  it('the memo never serves a failed ask, expires by TTL, and is skipped for probe specs', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    post.mockRejectedValueOnce({ response: { status: 500 }, message: 'boom' });
    expect(await decide('s', NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 5000 })).toBeNull();
    jevOk();
    expect((await decide('s', NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 5000 }))!.cached).toBeUndefined();
    expect(post).toHaveBeenCalledTimes(2);
    // TTL: an entry older than the TTL is a miss.
    process.env.DECISION_GATE_MEMO_TTL_MS = '1';
    clearDecisionMemo();
    await decide('t', NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 5000 });
    await new Promise(r => setTimeout(r, 5));
    expect((await decide('t', NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 5000 }))!.cached).toBeUndefined();
    expect(post).toHaveBeenCalledTimes(4);
    delete process.env.DECISION_GATE_MEMO_TTL_MS;
    // Probe (spec-pinned) asks never memoise.
    await decide('u', NOUL_ONLY, { purpose: 'probe', spec: 'jev', timeoutMs: 5000 });
    await decide('u', NOUL_ONLY, { purpose: 'probe', spec: 'jev', timeoutMs: 5000 });
    expect(post).toHaveBeenCalledTimes(6);
    // A spec ask that OPTS IN (memo:true — the label window's repeated
    // identical sends) memoises under a spec-scoped key: the second identical
    // ask is a hit, and a seat-chain ask of the same state is NOT served from it.
    await decide('w', NOUL_ONLY, { purpose: 'auto_route', spec: 'jev', memo: true, timeoutMs: 5000 });
    expect((await decide('w', NOUL_ONLY, { purpose: 'auto_route', spec: 'jev', memo: true, timeoutMs: 5000 }))!.cached).toBe(true);
    expect(post).toHaveBeenCalledTimes(7);
    expect((await decide('w', NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 5000 }))!.cached).toBeUndefined();
    expect(post).toHaveBeenCalledTimes(8);
  });

  it('a memo hit under act on an uncalibrated readout is still downgraded to shadow', async () => {
    process.env.DECISION_GATE_MODE_AUTO_ROUTE = 'act';
    process.env.DEEPSEEK_API_KEY = 'd';
    post.mockImplementation(async () => ({ data: { choices: [{ logprobs: { content: [{ token: 'A', logprob: -0.02, top_logprobs: [{ token: 'A', logprob: -0.02 }, { token: 'B', logprob: -4 }] }] } }] } }));
    expect((await decide('w', NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 5000 }))!.mode).toBe('shadow');
    const hit = await decide('w', NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 5000 });
    expect(hit).toMatchObject({ cached: true, calibrated: false, mode: 'shadow' });
    expect((recordLoopMetric as jest.Mock).mock.calls[1][0].meta).toMatchObject({ cached: true, mode: 'shadow', requestedMode: 'act', modeDowngrade: 'uncalibrated' });
  });

  it('stateHash / questionsHash / calibrated ride the outcome row directly and through a stash round trip', () => {
    const decision = { id: 'd9', mode: 'shadow' as const, backend: 'TypeSafe Jev', ms: 5, calibrated: true, stateHash: 'abcdef0123456789', questionsHash: '0123456789abcdef', answers: { refund: { type: 'noul' as const, noul: 0.8 } } };
    recordDecisionOutcome(decision, 'auto_route', { question: 'refund', actual: true, acted: false });
    const stash = stashDecision(decision, 'wake_triage');
    expect(stash).toMatchObject({ calibrated: true, stateHash: 'abcdef0123456789', questionsHash: '0123456789abcdef' });
    const rebuilt = reconstructDecision(JSON.parse(JSON.stringify(stash)));
    expect(rebuilt).toMatchObject({ calibrated: true, stateHash: 'abcdef0123456789', questionsHash: '0123456789abcdef' });
    recordDecisionOutcome(rebuilt, 'wake_triage', { question: 'refund', actual: false, acted: false });
    const rows = (recordLoopMetric as jest.Mock).mock.calls.map(c => c[0]);
    expect(rows[0].meta).toMatchObject({ phase: 'outcome', calibrated: true, stateHash: 'abcdef0123456789', questionsHash: '0123456789abcdef' });
    expect(rows[1].meta).toMatchObject({ phase: 'outcome', id: 'd9', stateHash: 'abcdef0123456789' });
    // A pre-E3 stash (no hashes) still reconstructs and records without them.
    const old = reconstructDecision({ id: 'x', purpose: 'wake_triage', mode: 'shadow', answers: { q: { type: 'noul', noul: 0.5 } } });
    expect(old!.stateHash).toBeUndefined();
    expect(old!.calibrated).toBeUndefined();
  });
});

describe('E4 — the answering model id', () => {
  it('TYPESAFE_MODEL overrides the pin; the id the server answers with is recorded even when it differs from the request', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    process.env.TYPESAFE_MODEL = 'jev-latest';
    post.mockResolvedValueOnce({ data: { model: 'jev-1.14.0', answers: { refund: { noul: 0.5 } } } });
    const r = await decide('s', { refund: QUESTIONS.refund }, { purpose: 'auto_route', timeoutMs: 5000 });
    expect(post.mock.calls[0][1].model).toBe('jev-latest');
    expect(r!.modelId).toBe('jev-1.14.0');
    expect((recordLoopMetric as jest.Mock).mock.calls[0][0].meta.modelId).toBe('jev-1.14.0');
    // No model in the body → no modelId on the row (never invented).
    clearDecisionMemo();
    post.mockResolvedValueOnce({ data: { answers: { refund: { noul: 0.5 } } } });
    const r2 = await decide('s2', { refund: QUESTIONS.refund }, { purpose: 'auto_route', timeoutMs: 5000 });
    expect(r2!.modelId).toBeUndefined();
    expect((recordLoopMetric as jest.Mock).mock.calls[1][0].meta.modelId).toBeUndefined();
  });
});

describe('E12 — act-band membership feeds the auto-demotion window', () => {
  it('inActBand: acted rows always; noul purposes on the LOW side at 1 − τ; choice purposes on confidence ≥ τ; env threshold honoured', () => {
    expect(inActBand('wake_triage', { type: 'noul', noul: 0.5 }, true)).toBe(true);
    expect(inActBand('wake_triage', { type: 'noul', noul: 0.15 }, false)).toBe(true);   // ≤ 1 − 0.85
    expect(inActBand('wake_triage', { type: 'noul', noul: 0.16 }, false)).toBe(false);
    expect(inActBand('wake_triage', { type: 'noul', noul: 0.98 }, false)).toBe(false);  // confident YES is not the act side
    expect(inActBand('memory_extract', { type: 'noul', noul: 0.2 }, false)).toBe(true); // 0.8 default → ≤ 0.2
    expect(inActBand('browser_driver', { type: 'choice', choice: 'cloud', probabilities: { cloud: 0.7, local: 0.3 }, confidence: 0.7 }, false)).toBe(true);
    expect(inActBand('browser_driver', { type: 'choice', choice: 'cloud', probabilities: { cloud: 0.6, local: 0.4 }, confidence: 0.6 }, false)).toBe(false);
    expect(inActBand('probe', { type: 'noul', noul: 0.01 }, false)).toBe(false);
    expect(inActBand('wake_triage', undefined, false)).toBe(false);
    process.env.DECISION_GATE_THRESHOLD_WAKE_TRIAGE = '0.95';
    expect(inActBand('wake_triage', { type: 'noul', noul: 0.1 }, false)).toBe(false);
    expect(inActBand('wake_triage', { type: 'noul', noul: 0.05 }, false)).toBe(true);
  });

  it('recordDecisionOutcome feeds ONLY labelled act-band outcomes on the act question from ACT-mode decisions into the purpose window', () => {
    const low = { id: 'a', mode: 'act' as const, backend: 'TypeSafe Jev', ms: 1, calibrated: true, answers: { needs_turn_now: { type: 'noul' as const, noul: 0.05 } } };
    const high = { ...low, id: 'b', answers: { needs_turn_now: { type: 'noul' as const, noul: 0.9 } } };
    recordDecisionOutcome(low, 'wake_triage', { question: 'needs_turn_now', actual: false, acted: true });  // in band, agreed
    recordDecisionOutcome(low, 'wake_triage', { question: 'needs_turn_now', actual: true, acted: false });  // in band, disagreed
    recordDecisionOutcome(high, 'wake_triage', { question: 'needs_turn_now', actual: true, acted: false }); // NOT in band (confident yes)
    recordDecisionOutcome(low, 'wake_triage', { question: 'needs_turn_now', actual: null, acted: true });   // unlabelled → not fed
    // Incident 2026-09-26 00:24:40Z: a SHADOW-mode decision's label never enters the window (47 shadow-era labels demoted a 4-minute-old flip).
    const shadow = { ...low, id: 'c', mode: 'shadow' as const };
    recordDecisionOutcome(shadow, 'wake_triage', { question: 'needs_turn_now', actual: true, acted: false });
    recordDecisionOutcome(shadow, 'wake_triage', { question: 'needs_turn_now', actual: false, acted: false });
    // The decision-time code-flag nouls of a wake batch (facts of the batch, always agreed) are not the act question — they never pad the window.
    const flag = { ...low, id: 'd', answers: { addressed_to_supervisor: { type: 'noul' as const, noul: 0.05 } } };
    recordDecisionOutcome(flag, 'wake_triage', { question: 'addressed_to_supervisor', actual: false, acted: false });
    expect(actBandWindow('wake_triage')).toMatchObject({ n: 2, precision: 0.5 });
    expect(actBandWindow('self_audit').n).toBe(0);
  });

  it('review 2026-09-26: a multi-label purpose feeds the window ONLY through its OUTCOME_LABEL_FOR_FIT row — compute_policy facts / thumbs / reask_5m / revision_material / checker_skipped_material rows and tool_intent next_call rows never enter it', () => {
    // Audit 2026-09-26 (tests-gaps-5): compute_policy is EXEMPT from the per-process
    // window by default (its labels come from two processes) — lift the exemption
    // here to pin the label filter itself; the default is pinned below.
    process.env.DECISION_GATE_AUTO_DEMOTE_EXEMPT_PURPOSES = '';
    const cp = { id: 'cp', mode: 'act' as const, backend: 'TypeSafe Jev', ms: 1, calibrated: true, answers: { depth: { type: 'choice' as const, choice: 'simple_lookup', confidence: 0.95, probabilities: { simple_lookup: 0.95, ordinary: 0.03, contestable: 0.01, unclear: 0.01 } }, stakes: { type: 'noul' as const, noul: 0.05 } } };
    for (const label of ['facts', 'thumbs', 'reask_5m', 'revision_material', 'checker_skipped_material']) {
      recordDecisionOutcome(cp, 'compute_policy', { question: 'depth', actual: 'contestable', acted: false, label }); // in band, disagreed — five secondary rows
    }
    expect(actBandWindow('compute_policy').n).toBe(0);
    recordDecisionOutcome(cp, 'compute_policy', { question: 'depth', actual: 'simple_lookup', acted: false, label: 'escalated' });
    recordDecisionOutcome(cp, 'compute_policy', { question: 'depth', actual: 'contestable', acted: false, label: 'escalated' });
    recordDecisionOutcome(cp, 'compute_policy', { question: 'depth', actual: 'simple_lookup', acted: false }); // no label ⇒ the single-label shape still counts
    expect(actBandWindow('compute_policy').n).toBe(3);
    expect(actBandWindow('compute_policy').precision).toBeCloseTo(2 / 3, 6);
    // Every row was still RECORDED — the filter is on the precision window, never on the telemetry.
    expect((recordLoopMetric as jest.Mock).mock.calls.filter(c => c[0].meta.phase === 'outcome' && c[0].meta.purpose === 'compute_policy')).toHaveLength(8);
    const ti = { ...cp, id: 'ti', answers: { intended_tool: { type: 'choice' as const, choice: 'option_1', confidence: 0.9, probabilities: { option_1: 0.9, option_2: 0.1 } } } };
    recordDecisionOutcome(ti, 'tool_intent', { question: 'intended_tool', actual: 'option_2', acted: false, label: 'next_call' });
    expect(actBandWindow('tool_intent').n).toBe(0);
    recordDecisionOutcome(ti, 'tool_intent', { question: 'intended_tool', actual: 'option_1', acted: false, label: 'regex' });
    expect(actBandWindow('tool_intent')).toMatchObject({ n: 1, precision: 1 });
    delete process.env.DECISION_GATE_AUTO_DEMOTE_EXEMPT_PURPOSES;
  });

  it('audit 2026-09-26 (tests-gaps-5): compute_policy is EXEMPT from the in-memory auto-demote window by default (its labels are written by two processes; the DB-backed ruler demotes it) — DECISION_GATE_AUTO_DEMOTE_EXEMPT_PURPOSES overrides', () => {
    const cp = { id: 'cp2', mode: 'act' as const, backend: 'TypeSafe Jev', ms: 1, calibrated: true, answers: { depth: { type: 'choice' as const, choice: 'simple_lookup', confidence: 0.95, probabilities: { simple_lookup: 0.95, ordinary: 0.03, contestable: 0.01, unclear: 0.01 } }, stakes: { type: 'noul' as const, noul: 0.05 } } };
    recordDecisionOutcome(cp, 'compute_policy', { question: 'depth', actual: 'contestable', acted: false, label: 'escalated' });
    expect(actBandWindow('compute_policy').n).toBe(0);
    process.env.DECISION_GATE_AUTO_DEMOTE_EXEMPT_PURPOSES = 'wake_triage';
    recordDecisionOutcome(cp, 'compute_policy', { question: 'depth', actual: 'contestable', acted: false, label: 'escalated' });
    expect(actBandWindow('compute_policy').n).toBe(1);
    delete process.env.DECISION_GATE_AUTO_DEMOTE_EXEMPT_PURPOSES;
  });

  it('audit 2026-09-26 (telemetry-readiness-2): the compute_policy act band is the CONSUMER rule — confident ordinary / unclear are never in band; simple_lookup needs low stakes; contestable needs high stakes', () => {
    process.env.DECISION_GATE_AUTO_DEMOTE_EXEMPT_PURPOSES = '';
    const mk = (choice: string, confidence: number, stakes: number) => ({ id: `cp-${choice}-${stakes}`, mode: 'act' as const, backend: 'TypeSafe Jev', ms: 1, calibrated: true, answers: { depth: { type: 'choice' as const, choice, confidence, probabilities: { [choice]: confidence } }, stakes: { type: 'noul' as const, noul: stakes } } });
    recordDecisionOutcome(mk('ordinary', 0.99, 0.1), 'compute_policy', { question: 'depth', actual: 'ordinary', acted: false, label: 'escalated' });
    recordDecisionOutcome(mk('unclear', 0.99, 0.1), 'compute_policy', { question: 'depth', actual: 'ordinary', acted: false, label: 'escalated' });
    recordDecisionOutcome(mk('simple_lookup', 0.9, 0.5), 'compute_policy', { question: 'depth', actual: 'simple_lookup', acted: false, label: 'escalated' });
    recordDecisionOutcome(mk('contestable', 0.75, 0.1), 'compute_policy', { question: 'depth', actual: 'contestable', acted: false, label: 'escalated' });
    expect(actBandWindow('compute_policy').n).toBe(0);
    recordDecisionOutcome(mk('simple_lookup', 0.9, 0.05), 'compute_policy', { question: 'depth', actual: 'simple_lookup', acted: false, label: 'escalated' });
    recordDecisionOutcome(mk('contestable', 0.75, 0.9), 'compute_policy', { question: 'depth', actual: 'contestable', acted: false, label: 'escalated' });
    expect(actBandWindow('compute_policy')).toMatchObject({ n: 2, precision: 1 });
    const rows = (recordLoopMetric as jest.Mock).mock.calls.map(c => c[0]).filter(m => m.meta.phase === 'outcome' && m.meta.purpose === 'compute_policy');
    expect(rows.map((r: any) => r.meta.inActBand)).toEqual([false, false, false, false, true, true]);
    expect(rows[5].meta.thresholdUsed).toBe(0.7);
    delete process.env.DECISION_GATE_AUTO_DEMOTE_EXEMPT_PURPOSES;
  });

  it('isActQuestion: the ACT_POLICIES question only; "*" purposes and purposes without a policy count every question', () => {
    expect(isActQuestion('wake_triage', 'needs_turn_now')).toBe(true);
    expect(isActQuestion('wake_triage', 'addressed_to_supervisor')).toBe(false);
    expect(isActQuestion('wake_triage', 'disposition')).toBe(false);
    expect(isActQuestion('auto_route', 'level')).toBe(true);
    expect(isActQuestion('memory_extract', 'anything')).toBe(true);   // '*'
    expect(isActQuestion('probe', 'anything')).toBe(true);            // no policy → never silently off
  });
});

// ── 2026-09-26: open-weight decision backends (plan A + B — adapter tolerance, per-backend calibration, backend identity) ──

describe('2026-09-26 — systemone adapter tolerance (Laya / JevK5 / NeoHorse wire shapes)', () => {
  it('parses a Laya score `distribution` LIST, array probabilities in option / level order, a noul given as probabilities.{true|yes} or [no, yes] — and still rejects a noul with neither', () => {
    const out = parseSystemOneAnswers({
      refund: { type: 'noul', probabilities: { true: 0.9, false: 0.1 } },                      // Laya: no `noul`, criteria-keyed probabilities
      team: { type: 'choice', probabilities: [0.2, 0.7, 0.1] },                                 // index → option order (billing, technical, sales)
      urgency: { type: 'score', score: 1.6, distribution: [0.1, 0.2, 0.7], confidence: 0.7, legend: { '0': 'can wait' } }, // Laya: `distribution`, not `probabilities`
    }, QUESTIONS);
    expect(out.refund).toEqual({ type: 'noul', noul: 0.9 });
    expect(out.team).toMatchObject({ type: 'choice', choice: 'technical' });
    expect((out.team as any).confidence).toBeCloseTo(0.7, 12);
    expect((out.team as any).probabilities.billing).toBeCloseTo(0.2, 12);
    expect((out.team as any).probabilities.technical).toBeCloseTo(0.7, 12);
    expect((out.team as any).probabilities.sales).toBeCloseTo(0.1, 12);
    expect(out.urgency).toMatchObject({ type: 'score', score: 1.6, confidence: 0.7 });
    expect((out.urgency as any).probabilities['2']).toBeCloseTo(0.7, 12);
    expect(Object.keys((out.urgency as any).probabilities)).toEqual(['0', '1', '2']);
    // Unnormalised yes/no renormalise; a lone `yes` is taken as is; the readout's [no, yes] order for an array.
    const N = { refund: QUESTIONS.refund };
    expect(parseSystemOneAnswers({ refund: { probabilities: { yes: 3, no: 1 } } }, N).refund).toEqual({ type: 'noul', noul: 0.75 });
    expect(parseSystemOneAnswers({ refund: { probabilities: { yes: 0.4 } } }, N).refund).toEqual({ type: 'noul', noul: 0.4 });
    expect(parseSystemOneAnswers({ refund: { probabilities: [0.25, 0.75] } }, N).refund).toEqual({ type: 'noul', noul: 0.75 });
    // An explicit numeric noul still wins over probabilities; the TypeSafe shapes parse as before.
    expect(parseSystemOneAnswers({ refund: { noul: 0.2, probabilities: { true: 0.9 } } }, N).refund).toEqual({ type: 'noul', noul: 0.2 });
    expect(() => parseSystemOneAnswers({ refund: { probabilities: { maybe: 1 } } }, N)).toThrow(/numeric noul/);
    expect(() => parseSystemOneAnswers({ refund: { noul: 1 }, team: { probabilities: 'x' }, urgency: {} }, QUESTIONS)).toThrow(/per-option probabilities/);
  });

  it('fillSystemOneNoulCriteria fills ONLY nouls without criteria (a copy; explicit criteria and other types untouched; nothing to fill = the same object)', () => {
    const filled = fillSystemOneNoulCriteria(QUESTIONS);
    expect(filled).not.toBe(QUESTIONS);
    expect((filled.refund as any).criteria).toEqual(SYSTEMONE_DEFAULT_NOUL_CRITERIA);
    expect(filled.team).toBe(QUESTIONS.team);
    expect(filled.urgency).toBe(QUESTIONS.urgency);
    expect((QUESTIONS.refund as any).criteria).toBeUndefined(); // the caller's questions are never mutated
    const explicit = { q: { type: 'noul' as const, instructions: 'x', criteria: { true: 'T', false: 'F' } } };
    expect(fillSystemOneNoulCriteria(explicit)).toBe(explicit);
  });

  it('a REGISTRY systemone backend (Laya) gets the stock noul criteria on the wire, a response without `model` is fine, the row carries backendSpec / backendKind and is NOT presumed calibrated; the built-in jev body is untouched', async () => {
    mockResolveRegistryModel.mockResolvedValue({ url: 'http://laya:8000/v1/chat/completions', baseUrl: 'http://laya:8000/v1', apiKey: undefined, model: 'typed-decisions', label: 'laya', supportsVision: false, coding: false, matryoshka: false, thinkingOff: false, providerShape: 'systemone' });
    const answer = { answers: { refund: { noul: 0.9 }, team: { probabilities: { billing: 0.9, technical: 0.05, sales: 0.05 } }, urgency: { distribution: [0.1, 0.2, 0.7] } } }; // no `model`
    post.mockResolvedValue({ data: answer });
    const r = await decide({ message: 'refund me' }, QUESTIONS, { purpose: 'auto_route', spec: 'laya:typed-decisions', memo: false, timeoutMs: 5000 });
    expect(r).not.toBeNull();
    expect(r).toMatchObject({ backend: 'laya (systemone)', backendSpec: 'laya:typed-decisions', calibrated: false, mode: 'shadow' });
    expect(r!.modelId).toBeUndefined();
    const [url, body, cfg] = post.mock.calls[0];
    expect(url).toBe('http://laya:8000/v1/systemone');
    expect(cfg.headers.Authorization).toBeUndefined();
    expect(body.model).toBe('typed-decisions');
    expect(body.questions.refund).toEqual({ ...QUESTIONS.refund, criteria: SYSTEMONE_DEFAULT_NOUL_CRITERIA });
    expect(body.questions.team).toBe(QUESTIONS.team);
    const row = (recordLoopMetric as jest.Mock).mock.calls[0][0];
    expect(row.meta).toMatchObject({ ok: true, backend: 'laya (systemone)', backendSpec: 'laya:typed-decisions', backendKind: 'systemone', calibrated: false, mode: 'shadow' });
    expect(row.meta.modelId).toBeUndefined();
    // The fill is a wire detail: the questions hash (the partition / dedupe key) is the caller's.
    expect(row.meta.questionsHash).toBe(hashQuestions(QUESTIONS));
    expect(row.meta.answers.team.probabilities).toEqual({ billing: 0.9, technical: 0.05, sales: 0.05 });
    // The built-in jev never gets the fill (the reference server's body stays byte-identical).
    process.env.TYPESAFE_API_KEY = 'k';
    await decide({ message: 'refund me' }, QUESTIONS, { purpose: 'auto_route', spec: 'jev', memo: false, timeoutMs: 5000 });
    expect(post.mock.calls[1][1].questions).toBe(QUESTIONS);
    expect(post.mock.calls[1][1].questions.refund.criteria).toBeUndefined();
  });
});

describe('2026-09-26 — per-backend calibration + temperature (store temps, registry `calibrated`, tempering a systemone answer)', () => {
  const laya = (extra: Record<string, unknown> = {}) => mockResolveRegistryModel.mockResolvedValue({ url: 'http://laya:8000/v1/chat/completions', baseUrl: 'http://laya:8000/v1', apiKey: 'lk', model: 'typed-decisions', label: 'laya', supportsVision: false, coding: false, matryoshka: false, thinkingOff: false, providerShape: 'systemone', ...extra });
  const NOUL_ONLY: Record<string, DecisionQuestion> = { refund: QUESTIONS.refund };
  const withTemps = (temps: Record<string, number>) => mockStoreGet.mockImplementation(async (_ns: string[], key: string) => (key === 'backends' ? { purposes: {}, temps } : null));

  it('temperAnswer / answerLogits: T = 1 is the identity; a noul 0.9 at T = 2 → 0.75; a choice keeps its argmax and re-derives confidence; a score re-derives its expected level; p = 0 floors at 1e-6', () => {
    const noul = { type: 'noul' as const, noul: 0.9 };
    expect(temperAnswer(noul, 1)).toBe(noul);
    expect((temperAnswer(noul, 2) as any).noul).toBeCloseTo(0.75, 9);
    expect(answerLogits(noul).no).toBeCloseTo(Math.log(0.1), 12);
    expect(answerLogits(noul).yes).toBeCloseTo(Math.log(0.9), 12);
    const choice = { type: 'choice' as const, choice: 'billing', probabilities: { billing: 0.9, technical: 0.05, sales: 0.05 }, confidence: 0.9 };
    const t = temperAnswer(choice, 2) as any;
    expect(t.choice).toBe('billing');
    expect(t.confidence).toBeCloseTo(Math.sqrt(0.9) / (Math.sqrt(0.9) + 2 * Math.sqrt(0.05)), 9);
    expect(t.probabilities.technical).toBeCloseTo(Math.sqrt(0.05) / (Math.sqrt(0.9) + 2 * Math.sqrt(0.05)), 9);
    const score = { type: 'score' as const, score: 1.6, probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 }, confidence: 0.7 };
    const ts = temperAnswer(score, 10) as any; // near-flat → expected level near 1
    expect(ts.score).toBeGreaterThan(1);
    expect(ts.score).toBeLessThan(1.6);
    expect(ts.confidence).toBeCloseTo(Math.max(...Object.values(ts.probabilities as Record<string, number>)), 12);
    expect(answerLogits({ type: 'choice', choice: 'a', probabilities: { a: 1, b: 0 }, confidence: 1 })).toEqual({ a: 0, b: Math.log(1e-6) });
  });

  it('backendTemperature / backendTemperatureFitted: the store temps (30 s cache, sync read) for any backend; the per-purpose env key for a logprob readout ONLY; the built-in jev never fitted by env; the store kill switch; normalizeStoredBackendTemps drops garbage', async () => {
    expect(normalizeStoredBackendTemps({ temps: { 'laya:x|auto_route': 1.5, 'jev|wake_triage': '2', bad: 3, 'a|b': 0, 'c|d': 'nope' } })).toEqual({ 'laya:x|auto_route': 1.5, 'jev|wake_triage': 2 });
    expect(normalizeStoredBackendTemps(null)).toEqual({});
    // Cold cache under jest: nothing read (hermeticity — never a live store read), env applies.
    expect(storedBackendTempSync('laya:typed-decisions', 'auto_route')).toBeNull();
    expect(mockStoreGet).not.toHaveBeenCalled();
    process.env.DECISION_GATE_TEMP_AUTO_ROUTE = '2.5';
    expect(backendTemperature('deepseek-flash', 'auto_route', 'logit')).toBe(2.5);
    expect(backendTemperatureFitted('deepseek-flash', 'auto_route', 'logit')).toBe(true);
    expect(backendTemperature('laya:typed-decisions', 'auto_route', 'systemone')).toBe(1);          // env temps were fitted for the readout — never a systemone server
    expect(backendTemperatureFitted('laya:typed-decisions', 'auto_route', 'systemone')).toBe(false);
    expect(backendTemperatureFitted('jev', 'auto_route', 'systemone')).toBe(false);
    withTemps({ 'laya:typed-decisions|auto_route': 2, 'deepseek-flash|auto_route': 0.5 });
    await refreshDecisionBackendTemps();
    expect(storedBackendTempSync('laya:typed-decisions', 'auto_route')).toBe(2);
    expect(backendTemperature('laya:typed-decisions', 'auto_route', 'systemone')).toBe(2);
    expect(backendTemperatureFitted('laya:typed-decisions', 'auto_route', 'systemone')).toBe(true);
    expect(backendTemperature('deepseek-flash', 'auto_route', 'logit')).toBe(0.7); // store wins over env, clamped to the readout floor
    expect(backendTemperature('deepseek-flash', 'wake_triage', 'logit')).toBe(1);  // another purpose: no store key, no env → 1
    // A store read failure is fail-open (an empty map when nothing was known, else the last known map).
    clearDecisionBackendTempsCache();
    mockStoreGet.mockRejectedValue(new Error('db down'));
    await expect(refreshDecisionBackendTemps()).resolves.toEqual({});
  });

  it('act purpose on a plain registry systemone server → uncalibrated, downgraded to shadow; the same server flagged `calibrated:true` → act; a fitted store temperature → act AND the answer is tempered (meta.answers tempered + meta.logits = raw log p + meta.temperature)', async () => {
    process.env.DECISION_GATE_MODE_AUTO_ROUTE = 'act';
    laya();
    post.mockResolvedValue({ data: { model: 'laya-typed-decisions-v0.3', answers: { refund: { noul: 0.9 } } } });
    const r1 = await decide('s', NOUL_ONLY, { purpose: 'auto_route', spec: 'laya:typed-decisions', memo: false, timeoutMs: 5000 });
    expect(r1).toMatchObject({ mode: 'shadow', calibrated: false, backendSpec: 'laya:typed-decisions', modelId: 'laya-typed-decisions-v0.3' });
    expect((recordLoopMetric as jest.Mock).mock.calls[0][0].meta).toMatchObject({ mode: 'shadow', requestedMode: 'act', modeDowngrade: 'uncalibrated', calibrated: false, backendKind: 'systemone' });
    // The admin asserted calibration on the registry model.
    laya({ calibrated: true });
    const r2 = await decide('s', NOUL_ONLY, { purpose: 'auto_route', spec: 'laya:typed-decisions', memo: false, timeoutMs: 5000 });
    expect(r2).toMatchObject({ mode: 'act', calibrated: true });
    expect((r2!.answers.refund as any).noul).toBe(0.9);
    expect((recordLoopMetric as jest.Mock).mock.calls[1][0].meta.temperature).toBeUndefined();
    // A fitted temperature for (spec, purpose) in the store: calibrated, and the probabilities are re-calibrated.
    laya();
    withTemps({ 'laya:typed-decisions|auto_route': 2 });
    await refreshDecisionBackendTemps();
    const r3 = await decide('s', NOUL_ONLY, { purpose: 'auto_route', spec: 'laya:typed-decisions', memo: false, timeoutMs: 5000 });
    expect(r3).toMatchObject({ mode: 'act', calibrated: true });
    expect((r3!.answers.refund as any).noul).toBeCloseTo(0.75, 9);
    const row = (recordLoopMetric as jest.Mock).mock.calls[2][0];
    expect(row.meta.answers.refund.noul).toBe(0.75);
    expect(row.meta.logits).toEqual({ refund: { no: Number(Math.log(0.1).toFixed(4)), yes: Number(Math.log(0.9).toFixed(4)) } });
    expect(row.meta.censored).toBeUndefined();
    expect(row.meta).toMatchObject({ temperature: 2, calibrated: true, mode: 'act' });
    // The per-purpose env temperature (fitted for the readout) never tempers a systemone server.
    clearDecisionBackendTempsCache();
    process.env.DECISION_GATE_TEMP_AUTO_ROUTE = '2';
    const r4 = await decide('s', NOUL_ONLY, { purpose: 'auto_route', spec: 'laya:typed-decisions', memo: false, timeoutMs: 5000 });
    expect(r4).toMatchObject({ mode: 'shadow', calibrated: false });
    expect((r4!.answers.refund as any).noul).toBe(0.9);
  });

  it('zero change when nothing new is configured: the built-in chain — jev calibrated, the readout uncalibrated until its per-purpose env temperature — behaves as before, with only the additive backendSpec / backendKind stamps', async () => {
    process.env.DECISION_GATE_MODE_AUTO_ROUTE = 'act';
    process.env.TYPESAFE_API_KEY = 'k';
    process.env.DEEPSEEK_API_KEY = 'd';
    post.mockResolvedValueOnce({ data: { model: 'jev-1.13.0', answers: { refund: { noul: 0.03 } } } });
    const j = await decide('s', NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 5000 });
    expect(j).toMatchObject({ mode: 'act', calibrated: true, backend: 'TypeSafe Jev', backendSpec: 'jev' });
    expect((j!.answers.refund as any).noul).toBe(0.03);
    const jrow = (recordLoopMetric as jest.Mock).mock.calls[0][0];
    expect(jrow.meta).toMatchObject({ backendSpec: 'jev', backendKind: 'systemone', calibrated: true });
    expect(jrow.meta.logits).toBeUndefined();
    expect(jrow.meta.temperature).toBeUndefined();
    clearDecisionMemo();
    post.mockReset();
    post.mockRejectedValueOnce({ response: { status: 500 }, message: 'boom' });
    post.mockImplementation(async () => ({ data: { model: 'deepseek-flash', choices: [{ logprobs: { content: [{ token: 'A', logprob: Math.log(0.98), top_logprobs: [{ token: 'A', logprob: Math.log(0.98) }, { token: 'B', logprob: Math.log(0.02) }] }] } }], usage: { prompt_tokens: 10 } } }));
    const d = await decide('s', NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 5000 });
    expect(d).toMatchObject({ mode: 'shadow', calibrated: false, backend: 'DeepSeek logprob readout', backendSpec: 'deepseek-flash' });
    const drow = (recordLoopMetric as jest.Mock).mock.calls[1][0];
    expect(drow.meta).toMatchObject({ backendSpec: 'deepseek-flash', backendKind: 'logit', calibrated: false, legIndex: 1 });
    expect(drow.meta.answers.refund).toEqual({ noul: 0.02 }); // readout rows: no probabilities on answers (logits carry them), as before
    expect(drow.meta.logits.refund.yes).toBeCloseTo(Math.log(0.02), 3);
  });
});

describe('2026-09-26 — per-backend state cap (maxStateChars) + meta.stateTruncated', () => {
  const NOUL_ONLY: Record<string, DecisionQuestion> = { refund: QUESTIONS.refund };

  it('a registry systemone model with maxStateChars cuts the state at that cap (never above DECISION_STATE_MAX_CHARS) and stamps stateTruncated; a small state under no cap stamps nothing', async () => {
    mockResolveRegistryModel.mockResolvedValue({ url: 'http://laya:8000/v1/chat/completions', baseUrl: 'http://laya:8000/v1', apiKey: undefined, model: 'typed-decisions', label: 'laya', supportsVision: false, coding: false, matryoshka: false, thinkingOff: false, providerShape: 'systemone', maxStateChars: 300 });
    post.mockResolvedValue({ data: { answers: { refund: { noul: 0.5 } } } });
    const r = await decide('x'.repeat(1000), NOUL_ONLY, { purpose: 'auto_route', spec: 'laya:typed-decisions', memo: false, timeoutMs: 5000 });
    expect(r!.stateTruncated).toBe(true);
    const sent: string = post.mock.calls[0][1].state;
    expect(sent.startsWith('x'.repeat(300))).toBe(true);
    expect(sent).toContain('[state truncated at 300 chars]');
    expect(sent.length).toBeLessThan(400);
    const row = (recordLoopMetric as jest.Mock).mock.calls[0][0];
    expect(row.meta).toMatchObject({ stateTruncated: true, stateChars: 1000 }); // stateChars stays the caller-side length
    // An object state under the cap is sent as the object (TypeSafe's named fields), untruncated.
    const r2 = await decide({ m: 'short' }, NOUL_ONLY, { purpose: 'auto_route', spec: 'laya:typed-decisions', memo: false, timeoutMs: 5000 });
    expect(r2!.stateTruncated).toBeUndefined();
    expect(post.mock.calls[1][1].state).toEqual({ m: 'short' });
    expect((recordLoopMetric as jest.Mock).mock.calls[1][0].meta.stateTruncated).toBeUndefined();
    // A cap above the global one is the global one.
    mockResolveRegistryModel.mockResolvedValue({ url: 'http://laya:8000/v1/chat/completions', baseUrl: 'http://laya:8000/v1', apiKey: undefined, model: 'typed-decisions', label: 'laya', supportsVision: false, coding: false, matryoshka: false, thinkingOff: false, providerShape: 'systemone', maxStateChars: 9_999_999 });
    clearDecisionBackendCache();
    await decide('y'.repeat(DECISION_STATE_MAX_CHARS + 100), NOUL_ONLY, { purpose: 'auto_route', spec: 'laya:typed-decisions', memo: false, timeoutMs: 5000 });
    expect(post.mock.calls[2][1].state).toContain(`[state truncated at ${DECISION_STATE_MAX_CHARS} chars]`);
  });

  it('a registry logprob readout honours the same cap in its STATE block and stamps stateTruncated', async () => {
    mockResolveRegistryModel.mockResolvedValue({ url: 'http://vllm:8000/v1/chat/completions', baseUrl: 'http://vllm:8000/v1', apiKey: undefined, model: 'qwen3-4b', label: 'vllm', supportsVision: false, coding: false, matryoshka: false, thinkingOff: false, providerShape: 'openai_chat', maxStateChars: 250 });
    post.mockImplementation(async () => ({ data: { choices: [{ logprobs: { content: [{ token: 'A', logprob: Math.log(0.6), top_logprobs: [{ token: 'A', logprob: Math.log(0.6) }, { token: 'B', logprob: Math.log(0.4) }] }] } }], usage: { prompt_tokens: 10 } } }));
    const r = await decide('z'.repeat(800), NOUL_ONLY, { purpose: 'auto_route', spec: 'vllm:qwen3-4b', memo: false, timeoutMs: 5000 });
    expect(r).toMatchObject({ backend: 'vllm logprob readout', backendSpec: 'vllm:qwen3-4b', stateTruncated: true });
    const content: string = post.mock.calls[0][1].messages[1].content;
    expect(content).toContain('[state truncated at 250 chars]');
    expect(content).not.toContain('z'.repeat(251));
    expect((recordLoopMetric as jest.Mock).mock.calls[0][0].meta).toMatchObject({ stateTruncated: true, backendKind: 'logit' });
  });
});

describe('2026-09-26 — backendSpec rides every row and the stash', () => {
  it('decision row, memo-hit row, outcome row, stash → reconstruct → outcome row all carry backendSpec; a pre-change stash reconstructs without it', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    post.mockResolvedValueOnce({ data: { model: 'jev-1.13.0', answers: { refund: { noul: 0.1 }, team: { probabilities: { billing: 0.9, technical: 0.05, sales: 0.05 } }, urgency: { probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 } } } } });
    const r = await decide({ m: 'x' }, QUESTIONS, { purpose: 'wake_triage', timeoutMs: 5000 });
    expect(r!.backendSpec).toBe('jev');
    const hit = await decide({ m: 'x' }, QUESTIONS, { purpose: 'wake_triage', timeoutMs: 5000 });
    expect(hit).toMatchObject({ cached: true, backendSpec: 'jev' });
    const row = (i: number) => (recordLoopMetric as jest.Mock).mock.calls[i][0];
    expect(row(0).meta).toMatchObject({ backendSpec: 'jev', backendKind: 'systemone' });
    expect(row(1).meta).toMatchObject({ cached: true, backendSpec: 'jev', backendKind: 'systemone' });
    expect(row(1).meta.answers.team.probabilities).toEqual({ billing: 0.9, technical: 0.05, sales: 0.05 }); // the memo hit replays the systemone probabilities too
    recordDecisionOutcome(r, 'wake_triage', { question: 'refund', actual: false, acted: false });
    expect(row(2).meta).toMatchObject({ phase: 'outcome', backend: 'TypeSafe Jev', backendSpec: 'jev' });
    const stash = stashDecision(r, 'wake_triage');
    expect(stash!.backendSpec).toBe('jev');
    const rebuilt = reconstructDecision(JSON.parse(JSON.stringify(stash)));
    expect(rebuilt!.backendSpec).toBe('jev');
    recordDecisionOutcome(rebuilt, 'wake_triage', { question: 'refund', actual: true, acted: false });
    expect(row(3).meta).toMatchObject({ phase: 'outcome', backendSpec: 'jev', agreed: false });
    const old = reconstructDecision({ id: 'x', purpose: 'wake_triage', mode: 'shadow', backend: 'TypeSafe Jev', answers: { q: { type: 'noul', noul: 0.5 } } });
    expect(old!.backendSpec).toBeUndefined();
    recordDecisionOutcome(old, 'wake_triage', { question: 'q', actual: true, acted: false });
    expect(row(4).meta.backendSpec).toBeUndefined();
  });
});

// ── Open-weight decision-model plan C (2026-09-26): per-purpose primary + challengers ──
// The store row is read through the (mocked) context-store like the modes row;
// suites prime it with refreshDecisionBackends(). Only built-in specs are used
// here (a registry spec would dynamic-import the prisma-backed registry).

const primeBackends = async (row: any) => {
  mockStoreGet.mockImplementation(async (_ns: string[], key: string) => (key === 'backends' ? row : null));
  await refreshDecisionBackends();
};
const jevBody = (noul = 0.9) => ({ data: { model: 'jev-1.13.0', answers: { refund: { noul } }, usage: { input_tokens: 5 } } });
const readoutBody = (yes = 0.2) => ({ data: { model: 'deepseek-flash', choices: [{ logprobs: { content: [{ token: 'A', logprob: Math.log(1 - yes), top_logprobs: [{ token: 'A', logprob: Math.log(1 - yes) }, { token: 'B', logprob: Math.log(yes) }] }] } }], usage: { prompt_tokens: 10 } } });
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const isSystemone = (url: string) => url.includes('/systemone');
const NOUL_ONLY: Record<string, DecisionQuestion> = { refund: QUESTIONS.refund };
const rowsOf = () => (recordLoopMetric as jest.Mock).mock.calls.map((c) => c[0]);

describe('plan C — per-purpose primary chain', () => {
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = 'k';
    process.env.DEEPSEEK_API_KEY = 'd';
    post.mockImplementation(async (url: string) => (isSystemone(url) ? jevBody() : readoutBody()));
  });

  it('no backends row → the seat chain, byte-identical (jev answers first, the readout is the fallback), no challenger call, no challengers on the result', async () => {
    const r = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
    expect(r).toMatchObject({ backend: 'TypeSafe Jev', calibrated: true });
    expect(r!.challengers).toBeUndefined();
    expect(post).toHaveBeenCalledTimes(1);
    expect(rowsOf()).toHaveLength(1);
    expect(rowsOf()[0].meta.challenger).toBeUndefined();
    expect(mockStoreGet).not.toHaveBeenCalled(); // under test the cold cache is never read live
  });

  it('a configured primary leads THAT purpose\'s chain (the seat model becomes its fallback); other purposes keep the seat chain — the chain cache is keyed by purpose', async () => {
    await primeBackends({ purposes: { wake_triage: { primary: 'deepseek-flash' } } });
    const r1 = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
    expect(r1!.backend).toBe('DeepSeek logprob readout');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions');
    const r2 = await decide('s', NOUL_ONLY, { purpose: 'auto_route', timeoutMs: 5000 });
    expect(r2!.backend).toBe('TypeSafe Jev');
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][0]).toBe('https://api.typesafe.ai/v1/systemone');
    // The primary row is a plain decision row (the core branch stamps backendSpec on it; nothing here marks it a challenger).
    expect(rowsOf()[0].meta).toMatchObject({ ok: true, backend: 'DeepSeek logprob readout', mode: 'shadow' });
    expect(rowsOf()[0].meta.legIndex).toBeUndefined();
  });

  it('a dead configured primary falls through to the seat model — the row names the failed leg (WI-H legErrors) like any fall-through', async () => {
    await primeBackends({ purposes: { wake_triage: { primary: 'deepseek-flash' } } });
    post.mockImplementation(async (url: string) => { if (isSystemone(url)) return jevBody(); throw { response: { status: 503 }, message: 'down' }; });
    const r = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
    expect(r!.backend).toBe('TypeSafe Jev');
    expect(rowsOf()[0].meta).toMatchObject({ legIndex: 1, legErrors: [expect.stringContaining('DeepSeek logprob readout: HTTP 503')] });
  });

  it('a `spec` ask ignores the per-purpose primary', async () => {
    await primeBackends({ purposes: { wake_triage: { primary: 'deepseek-flash' } } });
    const r2 = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', spec: 'jev', timeoutMs: 5000 });
    expect(r2!.backend).toBe('TypeSafe Jev');
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('plan C — challengers: parallel, grace-bounded, never answer, own rows + stash + outcome rows, never feed auto-demote, kill switches', () => {
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = 'k';
    process.env.DEEPSEEK_API_KEY = 'd';
  });

  it('a challenger starts in parallel with the primary from t0 (settles BEFORE a slower primary), records its OWN decision row (id ~c0, challenger:true, primaryId, backendSpec, mode shadow, its own logits) and rides DecideResult.challengers — answers / backend / mode come from the primary alone', async () => {
    await primeBackends({ defaultChallengers: ['deepseek-flash'] });
    post.mockImplementation((url: string) => (isSystemone(url) ? sleep(60).then(() => jevBody(0.9)) : Promise.resolve(readoutBody(0.2))));
    const r = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000, sessionId: 'chat1' });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.map((c) => c[0]).sort()).toEqual(['https://api.deepseek.com/chat/completions', 'https://api.typesafe.ai/v1/systemone']);
    // The PRIMARY answered: Jev's 0.9, not the readout's 0.2.
    expect(r).toMatchObject({ backend: 'TypeSafe Jev', mode: 'shadow', calibrated: true, modelId: 'jev-1.13.0' });
    expect((r!.answers.refund as any).noul).toBeCloseTo(0.9, 5);
    expect(r!.challengers).toHaveLength(1);
    const c = r!.challengers![0];
    expect(c).toMatchObject({ id: `${r!.id}~c0`, spec: 'deepseek-flash', backend: 'DeepSeek logprob readout', ok: true, calibrated: false, modelId: 'deepseek-flash' });
    expect((c.answers!.refund as any).noul).toBeCloseTo(0.2, 5);
    // Parallel: the challenger settled before the 60 ms primary did.
    expect(c.ms).toBeLessThan(r!.ms);
    expect(r!.ms).toBeGreaterThanOrEqual(55);
    // Rows: the primary's decision row first, then the challenger's own.
    const rows = rowsOf();
    expect(rows).toHaveLength(2);
    expect(rows[0].meta).toMatchObject({ phase: 'decision', id: r!.id, backend: 'TypeSafe Jev', ok: true });
    expect(rows[0].meta.challenger).toBeUndefined();
    expect(rows[1].sessionId).toBe('chat1');
    expect(rows[1].meta).toMatchObject({
      phase: 'decision', id: `${r!.id}~c0`, challenger: true, primaryId: r!.id, purpose: 'wake_triage', mode: 'shadow', ok: true,
      backend: 'DeepSeek logprob readout', backendSpec: 'deepseek-flash', calibrated: false, modelId: 'deepseek-flash',
      stateHash: rows[0].meta.stateHash, questionsHash: rows[0].meta.questionsHash, memoHash: rows[0].meta.memoHash,
    });
    expect(rows[1].meta.logits.refund.yes).toBeCloseTo(Math.log(0.2), 3);
    expect(rows[1].meta.answers).toEqual({ refund: { noul: 0.2 } });
  });

  it('challengers never run on a memo hit, a `spec` ask or a probe; DECISION_GATE_CHALLENGER_MAX=0 stops them; they are never memoised', async () => {
    await primeBackends({ defaultChallengers: ['deepseek-flash'] });
    post.mockImplementation(async (url: string) => (isSystemone(url) ? jevBody() : readoutBody()));
    const r1 = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(r1!.challengers).toHaveLength(1);
    // Memo hit: no primary call, no challenger call, no challengers on the result.
    const r2 = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
    expect(r2!.cached).toBe(true);
    expect(r2!.challengers).toBeUndefined();
    expect(post).toHaveBeenCalledTimes(2);
    // A spec ask and a probe: exactly one call each.
    post.mockClear();
    await decide('s3', NOUL_ONLY, { purpose: 'wake_triage', spec: 'jev', timeoutMs: 5000 });
    expect(post).toHaveBeenCalledTimes(1);
    post.mockClear();
    await decide('s4', NOUL_ONLY, { purpose: 'probe', timeoutMs: 5000 });
    expect(post).toHaveBeenCalledTimes(1);
    // Cap 0.
    post.mockClear();
    clearDecisionBackendCache();
    process.env.DECISION_GATE_CHALLENGER_MAX = '0';
    const r6 = await decide('s6', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(r6!.challengers).toBeUndefined();
  });

  it('challengers:false (2026-10-04, offline replays) skips the challenger asks for that call only', async () => {
    await primeBackends({ defaultChallengers: ['deepseek-flash'] });
    post.mockImplementation(async (url: string) => (isSystemone(url) ? jevBody() : readoutBody()));
    const r = await decide('replay-1', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000, memo: false, challengers: false });
    expect(post).toHaveBeenCalledTimes(1);
    expect(r!.challengers).toBeUndefined();
    post.mockClear();
    const r2 = await decide('live-1', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000, memo: false });
    expect(post).toHaveBeenCalledTimes(2);
    expect(r2!.challengers).toHaveLength(1);
  });

  it('the configured primary is never its own challenger; a challenger equal to the seat FALLBACK leg still runs (that is the comparison the owner wants)', async () => {
    await primeBackends({ purposes: { wake_triage: { primary: 'deepseek-flash', challengers: ['deepseek-flash', 'jev'] } } });
    post.mockImplementation(async (url: string) => (isSystemone(url) ? jevBody() : readoutBody()));
    const r = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
    expect(r!.backend).toBe('DeepSeek logprob readout');
    expect(r!.challengers!.map((c) => c.spec)).toEqual(['jev']);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('the primary failing on every leg still yields null (challengers never answer for it) — their rows are still recorded', async () => {
    await primeBackends({ defaultChallengers: ['deepseek-flash'] });
    // Chain = jev → deepseek (fallback); jev 500s, the readout FALLBACK leg 500s too, but the readout CHALLENGER answers.
    let readoutCalls = 0;
    post.mockImplementation(async (url: string) => {
      if (isSystemone(url)) throw { response: { status: 500 }, message: 'jev down' };
      readoutCalls += 1;
      if (readoutCalls === 1) return readoutBody(0.3); // the challenger (started first)
      throw { response: { status: 502 }, message: 'readout leg down' };
    });
    const r = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
    expect(r).toBeNull();
    // budgets-cost-6 (2026-09-26): an all-legs-failed ask also writes a decision_gate_backend_down row — only the decision rows are read here.
    const rows = rowsOf().filter((x) => x.kind === 'decision_gate');
    expect(rows.map((x) => !!x.meta.challenger)).toEqual([false, true]);
    expect(rows[0].meta.ok).toBe(false);
    expect(rows[1].meta).toMatchObject({ challenger: true, backendSpec: 'deepseek-flash' });
  });

  it('stash → JSON → reconstruct keeps the ok challengers; recordDecisionOutcome emits ONE extra outcome row per challenger (challenger:true, primaryId, agreement against ITS answer, `acted` mirroring the ask\'s + primaryActed) and NEVER feeds the act-band window', () => {
    const decision = {
      id: 'p1', mode: 'act' as const, backend: 'TypeSafe Jev', ms: 5, calibrated: true, stateHash: 'abcd', questionsHash: 'q1',
      answers: { needs_turn_now: { type: 'noul' as const, noul: 0.05 } },
      challengers: [
        { id: 'p1~c0', spec: 'deepseek-flash', backend: 'DeepSeek logprob readout', ok: true, ms: 3, calibrated: false, answers: { needs_turn_now: { type: 'noul' as const, noul: 0.9 } } },
        { id: 'p1~c1', spec: 'laya:typed-decisions', backend: 'laya (systemone)', ok: false, ms: 9, calibrated: true, error: 'challenger_timeout' },
      ],
    };
    const stash = stashDecision(decision, 'wake_triage')!;
    expect(stash.challengers).toHaveLength(1); // failed challengers have nothing to pair
    const rebuilt = reconstructDecision(JSON.parse(JSON.stringify(stash)))!;
    expect(rebuilt.challengers).toEqual([expect.objectContaining({ id: 'p1~c0', spec: 'deepseek-flash', backend: 'DeepSeek logprob readout', ok: true, calibrated: false })]);
    // A malformed stashed challenger is dropped, never throws.
    expect(reconstructDecision({ ...stash, challengers: [{ id: 'x' }, 7, null] })!.challengers).toBeUndefined();
    recordDecisionOutcome(rebuilt, 'wake_triage', { question: 'needs_turn_now', actual: false, acted: false, sessionId: 'chat1', note: 'n' });
    const rows = rowsOf();
    expect(rows).toHaveLength(2);
    expect(rows[0].meta).toMatchObject({ phase: 'outcome', id: 'p1', mode: 'act', backend: 'TypeSafe Jev', agreed: true, acted: false });
    expect(rows[0].meta.challenger).toBeUndefined();
    expect(rows[1].sessionId).toBe('chat1');
    expect(rows[1].meta).toMatchObject({
      phase: 'outcome', id: 'p1~c0', challenger: true, primaryId: 'p1', purpose: 'wake_triage', mode: 'shadow', backend: 'DeepSeek logprob readout', backendSpec: 'deepseek-flash',
      calibrated: false, stateHash: 'abcd', questionsHash: 'q1', question: 'needs_turn_now', predicted: { noul: 0.9 }, actual: false, agreed: false, acted: false, primaryActed: false, note: 'n',
    });
    expect(rows[1].value).toBe(0);
    expect(typeof rows[1].meta.thresholdUsed).toBe('number');
    // E12: only the PRIMARY's in-band act-mode label entered the window — the challenger's disagreement did not.
    expect(actBandWindow('wake_triage')).toMatchObject({ n: 1, precision: 1 });
    // An unlabelled outcome (actual null) gives the challenger row no `agreed` either; an ACTED ask stamps acted:true
    // on the challenger row too — `acted` is the ask's, so the readiness pairing drops both sides together.
    (recordLoopMetric as jest.Mock).mockReset();
    recordDecisionOutcome(rebuilt, 'wake_triage', { question: 'needs_turn_now', actual: null, acted: true });
    expect(rowsOf()[1].meta.agreed).toBeUndefined();
    expect(rowsOf()[1].meta).toMatchObject({ challenger: true, acted: true, primaryActed: true });
    // A challenger that did not answer THIS question gets no row.
    (recordLoopMetric as jest.Mock).mockReset();
    recordDecisionOutcome(rebuilt, 'wake_triage', { question: 'disposition', actual: 'ack', acted: false });
    expect(rowsOf()).toHaveLength(1);
  });

  it('reviewer 2026-09-26: on an ACT purpose a challenger can never out-count the primary in the readiness pairing — `acted` rides the ask, so the asks the gate acted on are excluded from BOTH sides (before the fix: challenger n=5 vs primary n=2, and the most-rows stamp went to the challenger)', () => {
    (recordLoopMetric as jest.Mock).mockReset();
    clearActBandWindows();
    // Five wake_triage asks; the primary (Jev, act mode) acted on three — those carry a label (as auto_route's
    // heuristic level does) but acted:true, which pairReadinessRows drops as biased. The challenger answered all five.
    const asks = [
      { acted: true, actual: false }, { acted: false, actual: true }, { acted: true, actual: false }, { acted: false, actual: false }, { acted: true, actual: false },
    ];
    asks.forEach((ask, i) => {
      const decision = {
        id: `p${i}`, mode: 'act' as const, backend: 'TypeSafe Jev', ms: 5, calibrated: true, stateHash: `state-${i}`, questionsHash: 'q1',
        answers: { needs_turn_now: { type: 'noul' as const, noul: ask.acted ? 0.05 : 0.5 } },
        challengers: [{ id: `p${i}~c0`, spec: 'laya:typed-decisions', backend: 'laya (systemone)', ok: true, ms: 3, calibrated: true, answers: { needs_turn_now: { type: 'noul' as const, noul: 0.4 } } }],
      };
      recordDecisionOutcome(decision, 'wake_triage', { question: 'needs_turn_now', actual: ask.actual, acted: ask.acted });
    });
    const rows = rowsOf().map((r, i) => ({ meta: r.meta, sessionId: r.sessionId ?? null, createdAt: new Date(1_700_000_000_000 + i * 1000) }));
    expect(rows).toHaveLength(10);
    // Row-level: every challenger outcome row carries the ASK's acted — equal to its primary's.
    const byId = new Map<string, any>(rows.map(r => [String(r.meta.id), r.meta]));
    asks.forEach((ask, i) => {
      expect(byId.get(`p${i}~c0`)).toMatchObject({ challenger: true, primaryId: `p${i}`, acted: ask.acted, primaryActed: ask.acted });
      expect(byId.get(`p${i}~c0`).acted).toBe(byId.get(`p${i}`).acted);
    });
    // Pairing: the primary keeps its two non-acted labels; the challenger holds at most as many (equal here — the core
    // branch's pairing may keep challenger outcome rows out of the labelled samples altogether, which is ≤ as well).
    const groups = pairReadinessRows(rows);
    const primary = groups.find(g => g.backend === 'TypeSafe Jev' && g.purpose === 'wake_triage')!;
    const challenger = groups.find(g => g.backend === 'laya (systemone)' && g.purpose === 'wake_triage');
    expect(primary.samples).toHaveLength(2);
    expect(challenger?.samples.length ?? 0).toBeLessThanOrEqual(primary.samples.length);
    // E12: only the PRIMARY's in-band act-mode labels entered the window (the three acted asks; the challenger's never do).
    expect(actBandWindow('wake_triage')).toMatchObject({ n: 3, precision: 1 });
  });
});

// ── Laya follow-up (2026-09-26): systemone_chat transport, confidence normalisation, sampled state, detached challengers ──
// Scope: scratchpad/laya/followup-scope.md — the wire dialect below is the one probed live on llm.cql.ca `agx-laya`.

const LAYA_REG = {
  url: 'https://llm.cql.ca/v1/chat/completions', baseUrl: 'https://llm.cql.ca/v1', apiKey: 'sk-cql', model: 'agx-laya', label: 'cql-litellm',
  supportsVision: false, coding: false, matryoshka: false, thinkingOff: false, providerShape: 'openai_chat', decision: 'systemone_chat' as const, maxStateChars: 3800,
};
/** The live envelope: an OpenAI chat completion whose message content is the JSON string { model, state_kind, result: { model, answers, usage } }. */
const layaEnvelope = (answers: any, extra: any = {}) => ({
  data: {
    id: 'chatcmpl-1', model: 'agx-laya',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ model: 'laya-typed-decisions', state_kind: 'str', result: { model: 'laya-rl-agent', answers, usage: { input_tokens: 42, output_tokens: 0 } }, ...extra }) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 42, completion_tokens: 0 },
  },
});

describe('Laya follow-up — systemone_chat transport (parse + decide)', () => {
  it('parseSystemOneChatResponse: the live envelope (JSON string in content → .result.answers, model from result.model, usage from result), an unwrapped top-level answers, an already-parsed object, a text-parts array; clear errors otherwise', () => {
    const live = layaEnvelope({ refund: { type: 'noul', noul: 0.91, confidence: 0.82, answer_confidence: 0.82, action: { act_probability: 0.91 } } });
    const p = parseSystemOneChatResponse(live.data);
    expect(p.answers).toEqual({ refund: expect.objectContaining({ noul: 0.91 }) });
    expect(p.modelId).toBe('laya-rl-agent');
    expect(p.usage).toEqual({ input_tokens: 42, output_tokens: 0 });
    // Unwrapped: top-level answers, model from the content, usage from the completion's own usage.
    const unwrapped = { model: 'agx-laya', choices: [{ message: { content: JSON.stringify({ model: 'laya-typed-decisions', answers: { refund: { noul: 0.2 } } }) } }], usage: { prompt_tokens: 7, completion_tokens: 0 } };
    expect(parseSystemOneChatResponse(unwrapped)).toEqual({ answers: { refund: { noul: 0.2 } }, usage: { input_tokens: 7, output_tokens: 0 }, modelId: 'laya-typed-decisions' });
    // Already-parsed object content + a text-parts array.
    expect(parseSystemOneChatResponse({ choices: [{ message: { content: { result: { answers: { a: { noul: 1 } } } } } }] }).answers).toEqual({ a: { noul: 1 } });
    expect(parseSystemOneChatResponse({ choices: [{ message: { content: [{ type: 'text', text: '{"answers":' }, { type: 'text', text: '{"a":{"noul":0.5}}}' }] } }] }).answers).toEqual({ a: { noul: 0.5 } });
    expect(() => parseSystemOneChatResponse({ choices: [{ message: { content: '' } }] })).toThrow('no message content');
    expect(() => parseSystemOneChatResponse({ choices: [{ message: { content: 'not json' } }] })).toThrow('not JSON');
    expect(() => parseSystemOneChatResponse({ choices: [{ message: { content: '{"x":1}' } }] })).toThrow('no answers object');
  });

  it('a model flagged decision:"systemone_chat" on an OpenAI-compatible endpoint (prod cql-litellm:agx-laya) resolves to the chat transport: POST <baseUrl>/chat/completions { model, messages:[user state], questions } (noul criteria filled, no logprobs), label "typed decisions via chat completions", row backendKind systemone + probabilities; the state is cut at maxStateChars; an UNFLAGGED model on the same endpoint stays the logprob readout', async () => {
    mockResolveRegistryModel.mockImplementation(async (spec: string) => (spec === 'cql-litellm:agx-laya' ? LAYA_REG : spec === 'cql-litellm:agx-chat' ? { ...LAYA_REG, model: 'agx-chat', decision: undefined, maxStateChars: undefined } : null));
    post.mockImplementation(async (_url: string, body: any) => {
      if (body?.questions) return layaEnvelope({ refund: { type: 'noul', noul: 0.9, confidence: 0.8 }, team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.7, technical: 0.2, sales: 0.1 }, confidence: 0.55 } });
      return readoutBody(0.2);
    });
    const r = await decide({ message: 'x'.repeat(5000) }, { refund: QUESTIONS.refund, team: QUESTIONS.team }, { purpose: 'wake_triage', spec: 'cql-litellm:agx-laya', timeoutMs: 5000 });
    expect(r).toMatchObject({ backend: 'cql-litellm (typed decisions via chat completions)', backendSpec: 'cql-litellm:agx-laya', modelId: 'laya-rl-agent', stateTruncated: true, calibrated: false });
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body, cfg] = post.mock.calls[0];
    expect(url).toBe('https://llm.cql.ca/v1/chat/completions');
    expect(body.model).toBe('agx-laya');
    expect(body.messages).toEqual([{ role: 'user', content: expect.stringContaining('…[state truncated at 3800 chars]') }]);
    expect(body.messages[0].content.length).toBeLessThan(3900);
    expect(body.questions.refund.criteria).toEqual(SYSTEMONE_DEFAULT_NOUL_CRITERIA);
    expect(body.questions.team).toEqual(QUESTIONS.team);
    expect(body.state).toBeUndefined();
    expect(body.logprobs).toBeUndefined();
    expect(cfg.headers.Authorization).toBe('Bearer sk-cql');
    expect(rowsOf()[0].meta).toMatchObject({ backendKind: 'systemone', backendSpec: 'cql-litellm:agx-laya', stateTruncated: true, modelId: 'laya-rl-agent', answers: { team: { choice: 'billing', probabilities: { billing: 0.7 } } } });
    // Unflagged: the readout — logprobs body, "logprob readout" label, backendKind logit.
    (recordLoopMetric as jest.Mock).mockReset(); post.mockClear(); clearDecisionMemo();
    const r2 = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', spec: 'cql-litellm:agx-chat', timeoutMs: 5000 });
    expect(r2!.backend).toBe('cql-litellm logprob readout');
    expect(post.mock.calls[0][1]).toMatchObject({ logprobs: true, max_tokens: 1 });
    expect(rowsOf()[0].meta.backendKind).toBe('logit');
    // The pure helpers behind it.
    expect(registryDecisionTransport({ providerShape: 'openai_chat', decision: 'systemone_chat' })).toBe('chat');
    expect(registryDecisionTransport({ providerShape: 'systemone_chat' })).toBe('chat');
    expect(registryDecisionTransport({ providerShape: 'systemone', decision: 'systemone_chat' })).toBe('systemone');
    expect(registryDecisionTransport({ providerShape: 'openai_chat' })).toBeNull();
    expect(systemOneBackendLabel('laya', 'systemone')).toBe('laya (systemone)');
    expect(systemOneBackendLabel('cql-litellm', 'openai_chat', 'systemone_chat')).toBe('cql-litellm (typed decisions via chat completions)');
  });

  it('ticket 2df5ed65 — a DECISION-KIND registry model (unflagged, id heuristic or explicit kind) resolves to the CHAT transport, never the logprob readout: a plain chat call draws the typed-decision usage-guide 400 on such a model. An explicit kind:"chat" self-heals the heuristic.', async () => {
    // The incident shape: an `agx-laya` route on an openai_chat row with NO
    // decision flag — modelKindOf reads kind 'decision' (id heuristic). The
    // old registryDecisionTransport returned null → the logprob readout's
    // plain chat call → the gateway's usage-guide 400 → "broken" seat Test.
    // (kind is what resolveRegistryModel actually returns — modelKindOf.)
    mockResolveRegistryModel.mockImplementation(async (spec: string) => (spec === 'cql-litellm:agx-laya' ? { ...LAYA_REG, decision: undefined, kind: 'decision' } : null));
    post.mockImplementation(async (_url: string, body: any) => {
      if (body?.questions) return layaEnvelope({ refund: { type: 'noul', noul: 0.9, confidence: 0.8 }, team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.7, technical: 0.2, sales: 0.1 }, confidence: 0.55 } });
      throw { response: { status: 400, data: { error: { message: 'agx-laya is a typed-decision model, not a chat model. Send "questions" in the request body.' } } }, message: 'Request failed with status code 400' };
    });
    const r = await decide({ message: 'refund question' }, { refund: QUESTIONS.refund, team: QUESTIONS.team }, { purpose: 'wake_triage', spec: 'cql-litellm:agx-laya', timeoutMs: 5000 });
    expect(r).toMatchObject({ backend: 'cql-litellm (typed decisions via chat completions)', backendSpec: 'cql-litellm:agx-laya', modelId: 'laya-rl-agent' });
    // The call carried the questions map (the decision shape), not logprobs.
    expect(post.mock.calls[0][1].questions).toBeDefined();
    expect(post.mock.calls[0][1].logprobs).toBeUndefined();
    // The pure helpers: kind drives the chat transport; the explicit kind
    // override still wins (self-heal path); shape beats kind on systemone.
    expect(registryDecisionTransport({ providerShape: 'openai_chat', kind: 'decision' })).toBe('chat');
    expect(registryDecisionTransport({ providerShape: 'openai_chat', decision: undefined, kind: 'decision' })).toBe('chat');
    expect(registryDecisionTransport({ providerShape: 'openai_chat' })).toBeNull();
    expect(registryDecisionTransport({ providerShape: 'systemone', kind: 'decision' })).toBe('systemone');
    expect(systemOneBackendLabel('cql-litellm', 'openai_chat', undefined, 'decision')).toBe('cql-litellm (typed decisions via chat completions)');
    expect(systemOneBackendLabel('cql-litellm', 'openai_chat')).toBe('cql-litellm (systemone)');
  });

  it('a non-JSON chat answer is a leg error (fail-open: null, the row names it), never a throw', async () => {
    mockResolveRegistryModel.mockResolvedValue(LAYA_REG);
    post.mockResolvedValue({ data: { choices: [{ message: { content: 'Sorry, I cannot do that.' } }] } });
    const r = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', spec: 'cql-litellm:agx-laya', timeoutMs: 5000 });
    expect(r).toBeNull();
    expect(rowsOf()[0].meta).toMatchObject({ ok: false, error: expect.stringContaining('not JSON') });
  });
});

// ── Ticket 3c18284e (2026-10-20): the typed-decision guard self-heal ──
// `agx-laya` on the cql-llm gateway is a typed-decision service BY DESIGN: a bare chat
// completion 400s in ~30 ms with the guard body verbatim ("agx-laya is a typed-decision
// model, not a chat model. Send \"questions\" … or \"preset\" …") — the guard fires BEFORE
// logprobs is considered, so an unflagged registry logit leg can never succeed. The runtime
// now LEARNS it: the 400-with-guard-body latches the spec and the SAME leg is retried over
// the systemone chat transport (the questions shape — the model's native contract).
describe('3c18284e — typed-decision guard: leg self-heal + spec latch', () => {
  const NOUL_ONLY: Record<string, DecisionQuestion> = { refund: QUESTIONS.refund };
  /** The owner's unflagged cql-llm registration (no decision flag — exactly the ticket's scenario). */
  const CQL_LLM_AGX = { ...LAYA_REG, label: 'cql-llm', decision: undefined };
  /** The guard 400 verbatim (the ticket's probe lane quoted this body). */
  const guardError = () => Object.assign(new Error('Request failed with status code 400'), {
    response: { status: 400, data: { error: { message: 'litellm.BadRequestError: agx-laya is a typed-decision model, not a chat model. Send "questions": {key: {...}} ... or "preset": ...' } } },
  });
  beforeEach(() => { clearTypedDecisionLatch(); clearDecisionAuthLatches(); });
  afterEach(() => { delete process.env.DECISION_GATE_AUTH_LATCH_MS; });

  it('isTypedDecisionGuardBody matches the verbatim guard body and nothing else', () => {
    expect(isTypedDecisionGuardBody('litellm.BadRequestError: agx-laya is a typed-decision model, not a chat model. Send "questions"')).toBe(true);
    expect(isTypedDecisionGuardBody('some other 400: invalid model')).toBe(false);
    expect(isTypedDecisionGuardBody('')).toBe(false);
    expect(isTypedDecisionGuardBody(undefined as unknown as string)).toBe(false);
  });

  it('THE FIX: an unflagged cql-llm:agx-laya logit leg 400s with the guard body → the SAME ask answers over the chat transport (questions shape, no logprobs), the row carries typedDecisionHeal + backendKind systemone, and the spec is LATCHED so the next ask never sends a bare completion', async () => {
    mockResolveRegistryModel.mockImplementation(async (spec: string) => (spec === 'cql-llm:agx-laya' ? CQL_LLM_AGX : null));
    let bareCalls = 0;
    post.mockImplementation(async (_url: string, body: any) => {
      if (body?.questions) return layaEnvelope({ refund: { type: 'noul', noul: 0.9, confidence: 0.8 } });
      bareCalls += 1;
      throw guardError(); // a bare completion (logprobs) can NEVER succeed — 400 by design
    });
    // Ask 1: the logit leg 400s with the guard → the heal retries over the chat transport and answers.
    const r1 = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', spec: 'cql-llm:agx-laya', timeoutMs: 5000 });
    expect(r1).toMatchObject({ backendSpec: 'cql-llm:agx-laya', modelId: 'laya-rl-agent' });
    expect(bareCalls).toBe(2); // the logit leg sends ONE bare completion PER QUESTION (a prefill each) — both 400 with the guard
    expect(isTypedDecisionSpec('cql-llm:agx-laya')).toBe(true);
    const row1 = rowsOf().find(x => x.meta.phase === 'decision')!;
    expect(row1.meta).toMatchObject({
      ok: true, backend: 'cql-llm (typed decisions via chat completions)', backendSpec: 'cql-llm:agx-laya',
      backendKind: 'systemone', typedDecisionHeal: true,
      answers: { refund: { noul: 0.9 } },
    });
    // The heal call itself went to the chat route with the questions shape — never logprobs.
    const healCall = post.mock.calls.find((c: any[]) => c[1]?.questions);
    expect(healCall).toBeTruthy();
    expect(healCall![1]).toMatchObject({ model: 'agx-laya' });
    expect(healCall![1].logprobs).toBeUndefined();
    expect(healCall![1].questions.refund.criteria).toEqual(SYSTEMONE_DEFAULT_NOUL_CRITERIA);
    // Ask 2 (fresh memo): NO bare completion — the latched spec resolves the chat transport directly.
    clearDecisionMemo();
    (recordLoopMetric as jest.Mock).mockReset(); post.mockClear();
    const r2 = await decide('s2', NOUL_ONLY, { purpose: 'wake_triage', spec: 'cql-llm:agx-laya', timeoutMs: 5000 });
    expect(r2).toMatchObject({ backend: 'cql-llm (typed decisions via chat completions)', backendSpec: 'cql-llm:agx-laya' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]?.questions).toBeTruthy();
    expect(post.mock.calls[0][1]?.logprobs).toBeUndefined();
    expect(bareCalls).toBe(2); // unchanged from ask 1 — the second ask never sent a bare completion
    expect(rowsOf().find(x => x.meta.phase === 'decision')!.meta.typedDecisionHeal).toBeUndefined(); // ask 2 was NOT a heal
  });

  it('a guard-shaped 400 does NOT touch a systemone leg (already the chat/systemone transport) — the plain error path stands', async () => {
    mockResolveRegistryModel.mockResolvedValue(LAYA_REG); // flagged decision:'systemone_chat'
    post.mockRejectedValue(guardError());
    const r = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', spec: 'cql-litellm:agx-laya', timeoutMs: 5000 });
    expect(r).toBeNull(); // the guard never fires on the questions shape; this is the mock's generic rejection — the plain error path
    expect(isTypedDecisionSpec('cql-litellm:agx-laya')).toBe(false); // never latched from a systemone leg
    // The all-legs-failed row is backend-agnostic (no backendKind) — it only names the error.
    expect(rowsOf().find(x => x.meta.phase === 'decision')!.meta).toMatchObject({ ok: false });
  });

  it('a NON-guard 400 on a registry logit leg (any other bad request) does not latch and does not heal — the pre-3c18284e behaviour stands', async () => {
    mockResolveRegistryModel.mockResolvedValue(CQL_LLM_AGX);
    post.mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: { error: { message: 'litellm.BadRequestError: logprobs is not supported for this model' } } },
    }));
    const r = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', spec: 'cql-llm:agx-laya', timeoutMs: 5000 });
    expect(r).toBeNull();
    expect(isTypedDecisionSpec('cql-llm:agx-laya')).toBe(false);
    const row = rowsOf().find(x => x.meta.phase === 'decision')!;
    expect(row.meta.ok).toBe(false);
    expect(row.meta.typedDecisionHeal).toBeUndefined();
    expect(row.meta.error).toEqual(expect.stringContaining('HTTP 400'));
  });

  it('when the heal call itself fails, the leg error names the failed heal and the ask fails open (null) with both errors on the row — never a partial answer', async () => {
    mockResolveRegistryModel.mockResolvedValue(CQL_LLM_AGX);
    post.mockImplementation(async (_url: string, body: any) => {
      if (body?.questions) throw Object.assign(new Error('Request failed with status code 502'), { response: { status: 502, data: 'bad gateway' } });
      throw guardError();
    });
    const r = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', spec: 'cql-llm:agx-laya', timeoutMs: 5000 });
    expect(r).toBeNull();
    const row = rowsOf().find(x => x.meta.phase === 'decision')!;
    expect(row.meta.ok).toBe(false);
    expect(row.meta.error).toEqual(expect.stringContaining('heal via typed-decision chat transport failed'));
    expect(row.meta.error).toEqual(expect.stringContaining('HTTP 400'));
    // Review condition 7: pin BOTH leg errors by count — the stringContaining pair alone was
    // satisfiable by errors[0] alone. Order: the FAILED HEAL first (errors.push inside the heal
    // catch runs before the outer catch pushes the guard 400), then the guard 400 on the logit leg.
    expect(row.meta.legErrors).toHaveLength(2);
    expect(row.meta.legErrors[0]).toEqual(expect.stringContaining('heal via typed-decision chat transport failed'));
    expect(row.meta.legErrors[0]).toEqual(expect.stringContaining('HTTP 502'));
    expect(row.meta.legErrors[1]).toEqual(expect.stringContaining('HTTP 400'));
  });

  // ── Review condition 7: the CHAIN path (no opts.spec) ─────────────────────────
  // The five tests above are spec-pinned, which bypasses resolveBackendChain and the
  // auth latch — these pin the two runtime defects the review proved (stale chain cache,
  // half-open probe leak) plus the latch's picker surface.

  it('CHAIN path (no spec): ask 1 heals and ask 2 within the old 30 s chain TTL answers over the chat transport — the latch DROPS every cached chain (review condition 3)', async () => {
    mockResolveRegistryModel.mockImplementation(async (spec: string) => (spec === 'cql-llm:agx-laya' ? CQL_LLM_AGX : null));
    // The purpose's PRIMARY is the registry spec: a stored backends row drives the chain
    // (primeBackends — the cold-cache-under-test read path never touches the store).
    await primeBackends({ purposes: { wake_triage: { primary: 'cql-llm:agx-laya' } } });
    let bareCalls = 0;
    post.mockImplementation(async (_url: string, body: any) => {
      if (body?.questions) return layaEnvelope({ refund: { type: 'noul', noul: 0.9, confidence: 0.8 } });
      bareCalls += 1;
      throw guardError();
    });
    // Ask 1 (chain path): the chain resolves the logit leg, it 400s with the guard, the heal answers.
    const r1 = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000, memo: false });
    expect(r1).toMatchObject({ backendSpec: 'cql-llm:agx-laya' });
    expect(rowsOf().find(x => x.meta.phase === 'decision')!.meta).toMatchObject({ typedDecisionHeal: true, backendKind: 'systemone' });
    const bareAfterAsk1 = bareCalls; // whatever the readout's internal prefill/retry sent — ask 2 must add ZERO
    // Ask 2 immediately (well inside the old 30 s TTL): the chain cache was DROPPED by the
    // latch, so the re-resolved chain carries the chat-transport leg — NO bare completion,
    // and the suppression that used to fail this ask open is gone.
    (recordLoopMetric as jest.Mock).mockReset(); post.mockClear();
    const r2 = await decide('s2', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000, memo: false });
    expect(r2).toMatchObject({ backendSpec: 'cql-llm:agx-laya' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]?.questions).toBeTruthy();
    expect(post.mock.calls[0][1]?.logprobs).toBeUndefined();
    expect(bareCalls).toBe(bareAfterAsk1); // unchanged — ask 2 never sent a bare completion
    const row2 = rowsOf().find(x => x.meta.phase === 'decision')!;
    expect(row2.meta.typedDecisionHeal).toBeUndefined(); // ask 2 was the chat transport from the start
    expect(row2.meta.ok).toBe(true);
  });

  it('CHAIN path + auth latch: a half-open 401 probe that heals does NOT leak the probe — ask 4 still calls the backend (review condition 4)', async () => {
    // The auth-latch cooldown is shortened so the probe window is testable.
    process.env.DECISION_GATE_AUTH_LATCH_MS = '10000';
    mockResolveRegistryModel.mockImplementation(async (spec: string) => (spec === 'cql-llm:agx-laya' ? CQL_LLM_AGX : null));
    await primeBackends({ purposes: { wake_triage: { primary: 'cql-llm:agx-laya' } } });
    let bareCalls = 0;
    let authUp = false;
    post.mockImplementation(async (_url: string, body: any) => {
      if (body?.questions) return layaEnvelope({ refund: { type: 'noul', noul: 0.8, confidence: 0.8 } });
      bareCalls += 1;
      if (!authUp) throw Object.assign(new Error('Request failed with status code 401'), { response: { status: 401, data: { error: { message: 'bad key' } } } });
      throw guardError();
    });
    const ask = (i: number) => decide(`s${i}`, NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000, memo: false });
    // Ask 1: the logit leg 401s → latched, fail-open null.
    const r1 = await ask(1);
    expect(r1).toBeNull();
    // Ask 2 (inside the cooldown): SKIPPED with the attributable latch error — no calls.
    (recordLoopMetric as jest.Mock).mockReset(); post.mockClear();
    const r2 = await ask(2);
    expect(r2).toBeNull();
    expect(post).toHaveBeenCalledTimes(0);
    expect(rowsOf().find(x => x.meta.phase === 'decision')!.meta.legErrors[0]).toEqual(expect.stringContaining('latched (HTTP 401'));
    // Past the cooldown (fake clock): ask 3 carries the half-open PROBE. The key is
    // restored BUT the readout leg still 400s with the guard — the HEAL answers over the
    // chat transport and must CLOSE the probe (noteBackendAuthRecovered), not leak it.
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now');
    spy.mockReturnValue(now + 11_000); // past the 10 s cooldown
    authUp = true; bareCalls = 0;
    (recordLoopMetric as jest.Mock).mockReset(); post.mockClear(); // ask 3's row must be the FIRST one rowsOf() finds
    const r3 = await ask(3);
    spy.mockRestore();
    expect(r3).toMatchObject({ backendSpec: 'cql-llm:agx-laya' });
    expect(rowsOf().find(x => x.meta.phase === 'decision')!.meta).toMatchObject({ typedDecisionHeal: true, backendKind: 'systemone' });
    // Ask 4 (immediately — the probe released, NOT held): the backend is CALLED again
    // (the chat-transport leg now), never "latched (HTTP 401 …)"-skipped.
    (recordLoopMetric as jest.Mock).mockReset(); post.mockClear();
    const r4 = await ask(4);
    expect(r4).toMatchObject({ backendSpec: 'cql-llm:agx-laya' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]?.questions).toBeTruthy();
    const row4 = rowsOf().find(x => x.meta.phase === 'decision')!;
    expect(row4.meta.ok).toBe(true);
    expect(JSON.stringify(row4.meta.legErrors ?? [])).not.toContain('latched');
  });

  it('the heal row is calibrated under the HEAL kind (systemone): a readout env temperature does NOT authorize the heal (review condition 5)', async () => {
    mockResolveRegistryModel.mockImplementation(async (spec: string) => (spec === 'cql-llm:agx-laya' ? CQL_LLM_AGX : null));
    post.mockImplementation(async (_url: string, body: any) => {
      if (body?.questions) return layaEnvelope({ refund: { type: 'noul', noul: 0.9, confidence: 0.8 } });
      throw guardError();
    });
    // A fitted READOUT temperature for this purpose would have stamped the old code's heal
    // row calibrated:true (act) — the very next (systemone) ask refuses.
    process.env.DECISION_GATE_TEMP_WAKE_TRIAGE = '2.5';
    process.env.DECISION_GATE_MODE_WAKE_TRIAGE = 'act';
    const r1 = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', spec: 'cql-llm:agx-laya', timeoutMs: 5000, memo: false });
    const row1 = rowsOf().find(x => x.meta.phase === 'decision')!;
    // The heal row and the latched ask agree: UNcalibrated → shadow + downgrade, no row-to-row flip.
    expect(row1.meta).toMatchObject({ typedDecisionHeal: true, backendKind: 'systemone', calibrated: false, mode: 'shadow', modeDowngrade: 'uncalibrated' });
    expect(r1).toMatchObject({ mode: 'shadow', downgraded: true });
    (recordLoopMetric as jest.Mock).mockReset();
    const r2 = await decide('s2', NOUL_ONLY, { purpose: 'wake_triage', spec: 'cql-llm:agx-laya', timeoutMs: 5000, memo: false });
    const row2 = rowsOf().find(x => x.meta.phase === 'decision')!;
    expect(row2.meta).toMatchObject({ calibrated: false, mode: 'shadow', modeDowngrade: 'uncalibrated' });
    expect(r2).toMatchObject({ mode: 'shadow', downgraded: true });
  });

  it('the latch surface: typedDecisionLatchView lists the learned specs; unlatchTypedDecisionSpec forgets ONE; clearTypedDecisionLatch forgets ALL (review condition 6)', () => {
    expect(latchTypedDecisionSpec('cql-llm:agx-laya')).toBeUndefined();
    latchTypedDecisionSpec('other:some-model');
    const view = typedDecisionLatchView();
    expect(view.specs.map((s: any) => s.spec)).toEqual(['cql-llm:agx-laya', 'other:some-model']);
    expect(view.max).toBe(64);
    expect(new Date(view.specs[0].firstSeenAt).toString()).not.toBe('Invalid Date');
    expect(unlatchTypedDecisionSpec('other:some-model')).toBe(true);
    expect(unlatchTypedDecisionSpec('never-latched:x')).toBe(false);
    expect(typedDecisionLatchView().specs.map((s: any) => s.spec)).toEqual(['cql-llm:agx-laya']);
    clearTypedDecisionLatch();
    expect(typedDecisionLatchView().specs).toEqual([]);
  });
});

describe('Laya follow-up — confidence normalisation for NON-jev systemone backends', () => {
  it('normalizeSystemOneConfidence: choice → probabilities[choice], score → max level probability, noul untouched; the raw values are reported only for the questions that moved', () => {
    const { answers, raw } = normalizeSystemOneConfidence({
      refund: { type: 'noul', noul: 0.9 },
      team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.7, technical: 0.2, sales: 0.1 }, confidence: 0.3 },
      urgency: { type: 'score', score: 1.4, probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 }, confidence: 0.2 },
      same: { type: 'choice', choice: 'a', probabilities: { a: 0.6, b: 0.4 }, confidence: 0.6 },
    });
    expect(answers.team).toMatchObject({ confidence: 0.7, choice: 'billing' });
    expect(answers.urgency).toMatchObject({ confidence: 0.5, score: 1.4 });
    expect(answers.refund).toEqual({ type: 'noul', noul: 0.9 });
    expect(answers.same).toMatchObject({ confidence: 0.6 });
    expect(raw).toEqual({ team: 0.3, urgency: 0.2 });
  });

  it('a registry systemone backend (Laya, either transport) gets the max-prob confidence + meta.confidenceRaw / confidenceNormalized on its row; the built-in jev keeps its own', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    const layaAnswers = { team: { choice: 'billing', probabilities: { billing: 0.7, technical: 0.2, sales: 0.1 }, confidence: 0.3 } };
    mockResolveRegistryModel.mockResolvedValue({ ...LAYA_REG, providerShape: 'systemone', decision: undefined, maxStateChars: undefined, label: 'laya', model: 'typed-decisions', baseUrl: 'http://laya:8000/v1' });
    post.mockImplementation(async () => ({ data: { model: 'laya', answers: layaAnswers } }));
    const r = await decide('s', { team: QUESTIONS.team }, { purpose: 'auto_route', spec: 'laya:typed-decisions', timeoutMs: 5000 });
    expect((r!.answers.team as any).confidence).toBeCloseTo(0.7, 9);
    expect(rowsOf()[0].meta).toMatchObject({ confidenceNormalized: true, confidenceRaw: { team: 0.3 }, answers: { team: { confidence: 0.7 } } });
    // The built-in jev: untouched — its confidence 0.3 stays, no confidenceRaw.
    (recordLoopMetric as jest.Mock).mockReset(); clearDecisionMemo();
    const r2 = await decide('s', { team: QUESTIONS.team }, { purpose: 'auto_route', spec: 'jev', timeoutMs: 5000 });
    expect((r2!.answers.team as any).confidence).toBeCloseTo(0.3, 9);
    expect(rowsOf()[0].meta.confidenceRaw).toBeUndefined();
    expect(rowsOf()[0].meta.confidenceNormalized).toBeUndefined();
  });
});

describe('Laya follow-up — sampled state persistence (opt-in)', () => {
  beforeEach(() => { process.env.TYPESAFE_API_KEY = 'k'; post.mockImplementation(async () => jevBody(0.9)); });
  afterEach(() => setDecisionStateSampler(null));
  const stateRows = () => rowsOf().filter(x => x.kind === DECISION_GATE_STATE_KIND);

  it('rate 0 (the default) writes nothing; DECISION_GATE_STATE_SAMPLE_RATE draws by the sampler; the row carries id / purpose / questionsHash / stateChars / state / questions / backendSpec; never on a memo hit; the per-purpose rate wins; probes never sample; DECISION_GATE_STATE_SAMPLE_DISABLED=1 is the hard switch', async () => {
    expect(stateSampleRate('wake_triage')).toBe(0);
    await decide('s0', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
    expect(stateRows()).toHaveLength(0);
    process.env.DECISION_GATE_STATE_SAMPLE_RATE = '0.5';
    expect(stateSampleRate('wake_triage')).toBe(0.5);
    setDecisionStateSampler(() => 0.7); // ≥ rate → not drawn
    clearDecisionMemo();
    await decide('s1', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
    expect(stateRows()).toHaveLength(0);
    setDecisionStateSampler(() => 0.2); // < rate → drawn
    clearDecisionMemo();
    const state = { chat: 'c1', events: [1, 2] };
    const r2 = await decide(state, NOUL_ONLY, { purpose: 'wake_triage', sessionId: 'chat-1', timeoutMs: 5000 });
    const rows = stateRows();
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(state, null, 1);
    expect(rows[0]).toMatchObject({ kind: 'decision_gate_state', sessionId: 'chat-1', value: text.length, meta: { id: r2!.id, purpose: 'wake_triage', questionsHash: r2!.questionsHash, stateChars: text.length, state: text, questions: NOUL_ONLY, backendSpec: 'jev', backendKind: 'systemone', sampleRate: 0.5 } });
    expect(rows[0].meta.stateSampleTruncated).toBeUndefined();
    // A memo hit of the same ask never writes a state row (no backend saw the state).
    await decide(state, NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
    expect(stateRows()).toHaveLength(1);
    // The per-purpose rate wins over the global one; probes never sample.
    process.env.DECISION_GATE_STATE_SAMPLE_RATE_AUTO_ROUTE = '0';
    expect(stateSampleRate('auto_route')).toBe(0);
    process.env.DECISION_GATE_STATE_SAMPLE_RATE_AUTO_ROUTE = '1';
    expect(stateSampleRate('auto_route')).toBe(1);
    expect(stateSampleRate('probe')).toBe(0);
    // Hard switch.
    process.env.DECISION_GATE_STATE_SAMPLE_DISABLED = '1';
    expect(stateSampleRate('auto_route')).toBe(0);
    expect(stateSampleRate('wake_triage')).toBe(0);
  });

  it('the stored state is cut at DECISION_GATE_STATE_SAMPLE_MAX_CHARS (default 12000; clamped ≥ 500) and the row says so; a string state is stored verbatim; the decision row itself is unchanged', async () => {
    process.env.DECISION_GATE_STATE_SAMPLE_RATE = '1';
    expect(stateSampleMaxChars()).toBe(12_000);
    process.env.DECISION_GATE_STATE_SAMPLE_MAX_CHARS = '100';
    expect(stateSampleMaxChars()).toBe(500);
    const big = 'y'.repeat(2000);
    await decide(big, NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
    const row = rowsOf().find(x => x.kind === DECISION_GATE_STATE_KIND)!;
    expect(row.meta.state).toBe('y'.repeat(500));
    expect(row.meta).toMatchObject({ stateSampleTruncated: true, stateSampledChars: 500, stateChars: 2000 });
    const decisionRow = rowsOf().find(x => x.kind === 'decision_gate')!;
    expect(decisionRow.meta.state).toBeUndefined();
    expect(decisionRow.meta.stateChars).toBe(2000);
  });
});

describe('Laya follow-up — detached challengers: zero added latency, own timeout, late outcome pairing', () => {
  beforeEach(() => { process.env.TYPESAFE_API_KEY = 'k'; process.env.DEEPSEEK_API_KEY = 'd'; clearPendingChallengerOutcomes(); });

  it('defaults: grace 0, timeout 20000 (audit 2026-10-06 T6-6; 5000 under DECISION_GATE_CHALLENGER_LONG_TIMEOUT_DISABLED=1) clamped 500..60000', () => {
    expect(challengerGraceMs()).toBe(0);
    expect(challengerTimeoutMs()).toBe(20_000);
    process.env.DECISION_GATE_CHALLENGER_LONG_TIMEOUT_DISABLED = '1';
    try { expect(challengerTimeoutMs()).toBe(5000); } finally { delete process.env.DECISION_GATE_CHALLENGER_LONG_TIMEOUT_DISABLED; }
    process.env.DECISION_GATE_CHALLENGER_TIMEOUT_MS = '100';
    expect(challengerTimeoutMs()).toBe(500);
    process.env.DECISION_GATE_CHALLENGER_TIMEOUT_MS = '999999';
    expect(challengerTimeoutMs()).toBe(60_000);
    process.env.DECISION_GATE_CHALLENGER_TIMEOUT_MS = 'x';
    expect(challengerTimeoutMs()).toBe(20_000);
    process.env.DECISION_GATE_CHALLENGER_GRACE_MS = '20';
    expect(challengerGraceMs()).toBe(20);
  });

  it('decide() returns as soon as the primary answers (no wait); the slow challenger is returned PENDING, records its row when it settles (ok:true, its own ms) and the SAME result object is completed in place — a stash taken after the settle carries it, one taken before omits it', async () => {
    await primeBackends({ defaultChallengers: ['deepseek-flash'] });
    post.mockImplementation((url: string) => (isSystemone(url) ? Promise.resolve(jevBody()) : sleep(150).then(() => readoutBody(0.2))));
    const t = Date.now();
    const r = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
    expect(Date.now() - t).toBeLessThan(120);
    expect(r!.backend).toBe('TypeSafe Jev');
    expect(r!.challengers).toHaveLength(1);
    const c = r!.challengers![0];
    expect(c).toMatchObject({ id: `${r!.id}~c0`, spec: 'deepseek-flash', ok: false, pending: true });
    expect(rowsOf()).toHaveLength(1); // only the primary's row so far
    expect(stashDecision(r, 'wake_triage')!.challengers).toBeUndefined(); // pending → not stashed
    await sleep(250);
    expect(c.pending).toBeUndefined();
    expect(c).toMatchObject({ ok: true, answers: { refund: { type: 'noul' } }, backend: 'DeepSeek logprob readout' });
    expect(c.ms).toBeGreaterThanOrEqual(140);
    expect(rowsOf()).toHaveLength(2);
    expect(rowsOf()[1].meta).toMatchObject({ phase: 'decision', id: `${r!.id}~c0`, challenger: true, primaryId: r!.id, ok: true, backendSpec: 'deepseek-flash', mode: 'shadow' });
    expect(stashDecision(r, 'wake_triage')!.challengers).toHaveLength(1);
  });

  it('a challenger slower than DECISION_GATE_CHALLENGER_TIMEOUT_MS records ok:false challenger_timeout when its OWN deadline expires — after decide() returned, independent of the caller deadline; the late answer never lands', async () => {
    process.env.DECISION_GATE_CHALLENGER_TIMEOUT_MS = '100'; // clamps to 500
    await primeBackends({ defaultChallengers: ['deepseek-flash'] });
    post.mockImplementation((url: string) => (isSystemone(url) ? Promise.resolve(jevBody()) : sleep(900).then(() => readoutBody())));
    const t = Date.now();
    const r = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
    expect(Date.now() - t).toBeLessThan(120);
    const c = r!.challengers![0];
    expect(c.pending).toBe(true);
    await sleep(650);
    expect(c.pending).toBeUndefined();
    expect(c).toMatchObject({ ok: false, error: 'challenger_timeout' });
    expect(rowsOf()).toHaveLength(2);
    expect(rowsOf()[1].meta).toMatchObject({ challenger: true, ok: false, error: 'challenger_timeout', backendSpec: 'deepseek-flash', primaryId: r!.id });
    await sleep(400);
    expect(rowsOf()).toHaveLength(2); // the 900 ms answer is dropped
  });

  it('late outcome pairing (in-process): the outcome labelled while the challenger is still pending lands on the challenger when it settles (registry entry consumed); a challenger settled BEFORE the outcome pairs at once through the mutated result (nothing parked); a timed-out challenger consumes its entry without a row', async () => {
    await primeBackends({ defaultChallengers: ['deepseek-flash'] });
    post.mockImplementation((url: string) => (isSystemone(url) ? Promise.resolve(jevBody(0.9)) : sleep(150).then(() => readoutBody(0.2))));
    const outcomes = () => rowsOf().filter(x => x.meta?.phase === 'outcome');
    const r = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
    recordDecisionOutcome(r, 'wake_triage', { question: 'refund', actual: true, acted: false });
    expect(pendingChallengerOutcomeCount()).toBe(1);
    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0].meta).toMatchObject({ id: r!.id, agreed: true });
    await sleep(250);
    expect(pendingChallengerOutcomeCount()).toBe(0);
    expect(outcomes()).toHaveLength(2);
    expect(outcomes()[1].meta).toMatchObject({ id: `${r!.id}~c0`, challenger: true, primaryId: r!.id, backendSpec: 'deepseek-flash', actual: true, agreed: false, acted: false, primaryActed: false });
    // Settled before the outcome: pairs immediately — nothing parked.
    (recordLoopMetric as jest.Mock).mockReset(); clearDecisionMemo();
    const r2 = await decide('s2', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
    await sleep(250);
    recordDecisionOutcome(r2, 'wake_triage', { question: 'refund', actual: false, acted: false });
    expect(pendingChallengerOutcomeCount()).toBe(0);
    expect(outcomes().map(x => x.meta.id)).toEqual([r2!.id, `${r2!.id}~c0`]);
    // A timed-out challenger: the parked outcome is consumed, no outcome row for it.
    process.env.DECISION_GATE_CHALLENGER_TIMEOUT_MS = '500';
    post.mockImplementation((url: string) => (isSystemone(url) ? Promise.resolve(jevBody(0.9)) : sleep(900).then(() => readoutBody(0.2))));
    (recordLoopMetric as jest.Mock).mockReset(); clearDecisionMemo();
    const r3 = await decide('s3', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
    recordDecisionOutcome(r3, 'wake_triage', { question: 'refund', actual: true, acted: false });
    expect(pendingChallengerOutcomeCount()).toBe(1);
    await sleep(650);
    expect(pendingChallengerOutcomeCount()).toBe(0);
    expect(outcomes().map(x => x.meta.id)).toEqual([r3!.id]);
    expect(rowsOf().find(x => x.meta?.id === `${r3!.id}~c0`)!.meta).toMatchObject({ phase: 'decision', ok: false, error: 'challenger_timeout' });
  });

  it('HONEST GAP: a stash serialised to another process while the challenger was pending carries no challenger — its later settle records a decision row only (reconstructDecision yields no challengers to pair)', async () => {
    await primeBackends({ defaultChallengers: ['deepseek-flash'] });
    post.mockImplementation((url: string) => (isSystemone(url) ? Promise.resolve(jevBody(0.9)) : sleep(150).then(() => readoutBody(0.2))));
    const r = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
    const carried = JSON.parse(JSON.stringify(stashDecision(r, 'wake_triage')));
    await sleep(250);
    const rebuilt = reconstructDecision(carried)!;
    expect(rebuilt.challengers).toBeUndefined();
    recordDecisionOutcome(rebuilt, 'wake_triage', { question: 'refund', actual: true, acted: false });
    expect(rowsOf().filter(x => x.meta?.phase === 'outcome').map(x => x.meta.id)).toEqual([r!.id]);
    expect(rowsOf().filter(x => x.meta?.phase === 'decision').map(x => x.meta.id)).toEqual([r!.id, `${r!.id}~c0`]);
  });
});

// ── 2026-09-26 (audit, telemetry-readiness-9): the sender segment rides every row and the stash ──
describe('2026-09-26 (audit) — the sender segment rides every decision_gate row and the stash; excludeFromFit rows never feed the act-band window', () => {
  it('decide({segment}) stamps meta.segment on the decision row and the memo-hit row (never the state / hashes); the result, stash and reconstruct carry it; the outcome rows stamp it ROW-OWN, outside the 12-key extra budget', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    post.mockResolvedValueOnce({ data: { model: 'jev-1.13.0', answers: { refund: { noul: 0.1 }, team: { probabilities: { billing: 0.9, technical: 0.05, sales: 0.05 } }, urgency: { probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 } } } } });
    const r = await decide({ m: 'x' }, QUESTIONS, { purpose: 'compute_policy', timeoutMs: 5000, segment: 'supervisor' });
    expect(r!.segment).toBe('supervisor');
    const hit = await decide({ m: 'x' }, QUESTIONS, { purpose: 'compute_policy', timeoutMs: 5000, segment: 'supervisor' });
    expect(hit).toMatchObject({ cached: true, segment: 'supervisor' });
    const row = (i: number) => (recordLoopMetric as jest.Mock).mock.calls[i][0];
    expect(row(0).meta).toMatchObject({ phase: 'decision', purpose: 'compute_policy', segment: 'supervisor' });
    expect(row(1).meta).toMatchObject({ phase: 'decision', cached: true, segment: 'supervisor' });
    // the segment is a ROW stamp only: the state sent to the backend and the hashes are untouched (the memo hit proves the key)
    expect(row(1).meta.stateHash).toBe(row(0).meta.stateHash);
    expect(JSON.stringify(post.mock.calls[0][1])).not.toContain('supervisor');
    // a consumer's 12-key extra (a full compute_policy facts row) still leaves meta.segment on the outcome row
    const extra = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i]));
    recordDecisionOutcome(r, 'compute_policy', { question: 'refund', actual: false, acted: false, extra });
    expect(row(2).meta).toMatchObject({ phase: 'outcome', segment: 'supervisor', k11: 11 });
    const stash = stashDecision(r, 'compute_policy');
    expect(stash!.segment).toBe('supervisor');
    const rebuilt = reconstructDecision(JSON.parse(JSON.stringify(stash)));
    expect(rebuilt!.segment).toBe('supervisor');
    recordDecisionOutcome(rebuilt, 'compute_policy', { question: 'refund', actual: true, acted: false });
    expect(row(3).meta).toMatchObject({ phase: 'outcome', segment: 'supervisor' });
    // an older stash / an ask without a segment writes NO key (human rows pool exactly as before)
    const old = reconstructDecision({ id: 'x', purpose: 'compute_policy', mode: 'shadow', answers: { q: { type: 'noul', noul: 0.5 } } });
    expect(old!.segment).toBeUndefined();
    recordDecisionOutcome(old, 'compute_policy', { question: 'q', actual: true, acted: false });
    expect(row(4).meta).not.toHaveProperty('segment');
    // a garbage segment is dropped; a long one is bounded to 40 chars
    expect(reconstructDecision({ id: 'y', purpose: 'compute_policy', mode: 'shadow', segment: 42, answers: { q: { type: 'noul', noul: 0.5 } } })).not.toHaveProperty('segment');
    expect(reconstructDecision({ id: 'y', purpose: 'compute_policy', mode: 'shadow', segment: 'z'.repeat(60), answers: { q: { type: 'noul', noul: 0.5 } } })!.segment).toHaveLength(40);
  });

  it('the all-legs-failed row and the invalid-questions row carry the segment too', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    post.mockRejectedValue(new Error('boom'));
    expect(await decide({ m: 'y' }, QUESTIONS, { purpose: 'compute_policy', timeoutMs: 2000, segment: 'machine' })).toBeNull();
    // budgets-cost-6: the all-legs-failed ask also writes the backend_down / latch rows AFTER its decision row — find the decision row itself.
    const rows = (recordLoopMetric as jest.Mock).mock.calls.map(c => c[0].meta);
    expect(rows.filter(m => m.phase === 'decision').at(-1)).toMatchObject({ phase: 'decision', ok: false, segment: 'machine' });
    (recordLoopMetric as jest.Mock).mockReset();
    await decide('s', { bad: { type: 'choice', instructions: 'x', criteria: { only: 'one' } } }, { purpose: 'compute_policy', segment: 'machine' });
    expect((recordLoopMetric as jest.Mock).mock.calls[0][0].meta).toMatchObject({ ok: false, segment: 'machine' });
  });

  it('excludeFromFit: the outcome row is stamped and an in-band, labelled ACT-mode row still never enters the act-band window', () => {
    // compute_policy is EXEMPT from the per-process auto-demote by default (the worker window closer judges it —
    // unify-routing H1); un-exempt it here so the window itself is what this test measures.
    process.env.DECISION_GATE_AUTO_DEMOTE_EXEMPT_PURPOSES = '';
    // simple_lookup is in the compound band only with LOW stakes (telemetry-readiness-2) — the fixture carries it.
    const decision = { id: 'ex1', backend: 'TypeSafe Jev', ms: 1, mode: 'act' as const, calibrated: true, answers: { depth: { type: 'choice' as const, choice: 'simple_lookup', confidence: 0.95, probabilities: { simple_lookup: 0.95 } }, stakes: { type: 'noul' as const, noul: 0.05 } } };
    recordDecisionOutcome(decision, 'compute_policy', { question: 'depth', actual: 'ordinary', acted: false, label: 'escalated', excludeFromFit: true });
    const meta = (recordLoopMetric as jest.Mock).mock.calls[0][0].meta;
    expect(meta).toMatchObject({ phase: 'outcome', excludeFromFit: true, inActBand: true, agreed: false, label: 'escalated' });
    expect(actBandWindow('compute_policy').n).toBe(0);
    recordDecisionOutcome(decision, 'compute_policy', { question: 'depth', actual: 'ordinary', acted: false, label: 'escalated' });
    expect((recordLoopMetric as jest.Mock).mock.calls[1][0].meta).not.toHaveProperty('excludeFromFit');
    expect(actBandWindow('compute_policy').n).toBe(1);
    delete process.env.DECISION_GATE_AUTO_DEMOTE_EXEMPT_PURPOSES;
  });
});

// ── 2026-09-26 audit (gate-runtime-5): Laya systemone_chat transport — failure telemetry ──
// Prod (30 h): checker_route 14/14 Laya challenger rows failed `chat response content is not
// JSON: {"model": "laya-typed-decisions", …` (a well-formed head); a key-free probe inside
// admin-backend-green reproduced it — the Python-serialised envelope carries NaN on the
// `needs_live_web` noul beside a VALID `depth` answer. 20 more rows read `HTTP 400 Request
// failed with status code 400` with the body dropped. Both are measurement loss (Laya is a
// detached challenger, grace 0) — these pins make the rows diagnosable and keep the valid answer.

describe('2026-09-26 audit gate-runtime-5 — Laya systemone_chat failure telemetry', () => {
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = 'k';
    process.env.DEEPSEEK_API_KEY = 'd';
  });
  const CHECKER_Q: Record<string, DecisionQuestion> = {
    depth: { type: 'choice', instructions: 'How much cross-checking?', criteria: { simple_lookup: 'a', ordinary: 'b', contestable: 'c', unclear: 'd' } },
    needs_live_web: { type: 'noul', instructions: 'Needs the live web.', criteria: { true: 't', false: 'f' } },
  };
  /** The reproduced envelope (case A / D of the probe): `depth` valid, `needs_live_web` all-NaN. */
  const NAN_CONTENT = '{"model": "laya-typed-decisions", "state_kind": "str", "result": {"model": "laya-rl-agent", "answers": {"depth": {"type": "choice", "choice": "ordinary", "probabilities": {"simple_lookup": 0.1, "ordinary": 0.6, "contestable": 0.2, "unclear": 0.1}, "confidence": 0.6, "answer_confidence": 0.6, "action": {"act_probability": 0.6}}, "needs_live_web": {"type": "noul", "noul": NaN, "confidence": NaN, "answer_confidence": NaN, "action": {"act_probability": NaN}}}, "usage": {"input_tokens": 120, "output_tokens": 0}}}';
  const nanEnvelope = () => ({ data: { id: 'chatcmpl-nan', model: 'agx-laya', choices: [{ index: 0, message: { role: 'assistant', content: NAN_CONTENT }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 0 } } });
  const http400 = (message = 'Request failed with status code 400') => ({
    response: { status: 400, data: { error: { message: 'questions[needs_live_web].criteria: invalid; token sk-abcdefgh12345678 rejected', type: 'invalid_request_error' } } },
    message,
  });

  it('sanitizeNonFiniteJson: NaN / Infinity / -Infinity in VALUE position → null (counted); the same words inside strings are untouched', () => {
    const r = sanitizeNonFiniteJson('{"a": NaN, "b": [Infinity, -Infinity], "c": "NaN is a word", "d": {"e":NaN}}');
    expect(r.replaced).toBe(4);
    expect(JSON.parse(r.text)).toEqual({ a: null, b: [null, null], c: 'NaN is a word', d: { e: null } });
    expect(sanitizeNonFiniteJson('{"ok": 1}')).toEqual({ text: '{"ok": 1}', replaced: 0 });
  });

  it('parseSystemOneChatResponse: the reproduced envelope PARSES after sanitising (nonFiniteTokens 4, needs_live_web.noul null, depth intact); a truncated envelope names the parser error + tail', () => {
    const p = parseSystemOneChatResponse(nanEnvelope().data);
    expect(p.nonFiniteTokens).toBe(4);
    expect(p.modelId).toBe('laya-rl-agent');
    expect((p.answers as any).depth.choice).toBe('ordinary');
    expect((p.answers as any).needs_live_web.noul).toBeNull();
    // Truncated stream: parser message + head + TAIL (the truncation tell), and never a NaN claim.
    const cut = NAN_CONTENT.slice(0, 300);
    const msg = describeUnparsableJson(cut, new SyntaxError('Unexpected end of JSON input'));
    expect(msg).toContain('Unexpected end of JSON input; head: {"model": "laya-typed-decisions"');
    expect(msg).toContain(` … tail: ${cut.slice(-120)}`);
    expect(msg).not.toContain('non-finite');
    // A literal "NaN" INSIDE a string is never blamed (value position only).
    expect(describeUnparsableJson('{"note": "NaN is a word", "x": ', new SyntaxError('bad'))).toContain('bad; head:');
    // The live path: the parser's own message (Node-version wording) + head + tail, never the bare 80-char head.
    let live = '';
    try { parseSystemOneChatResponse({ choices: [{ message: { content: cut } }] }); } catch (e: any) { live = String(e.message); }
    expect(live).toMatch(/^chat response content is not JSON: .+JSON.+; head: \{"model": "laya-typed-decisions"/);
    expect(live).toContain(` … tail: ${cut.slice(-120)}`);
    // Plain garbage still reads as before.
    expect(() => parseSystemOneChatResponse({ choices: [{ message: { content: 'not json' } }] })).toThrow('not JSON');
  });

  it('parseSystemOneAnswersDetailed({censor:true}) keeps the valid `depth` and CENSORS the NaN `needs_live_web` (key → reason); throws when NO question parses; parseSystemOneAnswers stays strict', () => {
    const answers = JSON.parse(sanitizeNonFiniteJson(NAN_CONTENT).text).result.answers;
    const d = parseSystemOneAnswersDetailed(answers, CHECKER_Q, { censor: true });
    expect(Object.keys(d.answers)).toEqual(['depth']);
    expect(d.answers.depth).toMatchObject({ type: 'choice', choice: 'ordinary', confidence: 0.6 });
    expect(d.censored).toEqual({ needs_live_web: 'answer "needs_live_web" has no numeric noul' });
    // Nothing valid → the first error, as before.
    expect(() => parseSystemOneAnswersDetailed({ needs_live_web: { noul: null } }, { needs_live_web: CHECKER_Q.needs_live_web }, { censor: true })).toThrow('has no numeric noul');
    expect(() => parseSystemOneAnswersDetailed({}, CHECKER_Q, { censor: true })).toThrow('no answer for "depth"');
    // Strict paths.
    expect(() => parseSystemOneAnswers(answers, CHECKER_Q)).toThrow('answer "needs_live_web" has no numeric noul');
    expect(() => parseSystemOneAnswersDetailed(answers, CHECKER_Q)).toThrow('has no numeric noul');
    // A fully valid set censors nothing.
    expect(parseSystemOneAnswersDetailed({ depth: answers.depth, needs_live_web: { noul: 0.3 } }, CHECKER_Q, { censor: true }).censored).toEqual({});
  });

  it('decide(): Laya answering the NaN envelope as the PRIMARY (spec) returns the partial answers (depth only) with meta.censoredAnswers + nonFiniteTokens on the row — no more "not JSON" failure rows; as a CHALLENGER the row reads ok:true with the same stamps', async () => {
    mockResolveRegistryModel.mockImplementation(async (spec: string) => (spec === 'cql-litellm:agx-laya' ? LAYA_REG : null));
    post.mockImplementation(async (url: string) => (isSystemone(url) ? jevBody() : nanEnvelope()));
    const r = await decide({ message: 'is the 2026 budget out yet?' }, CHECKER_Q, { purpose: 'checker_route', spec: 'cql-litellm:agx-laya', timeoutMs: 5000 });
    expect(r).not.toBeNull();
    expect(Object.keys(r!.answers)).toEqual(['depth']);
    expect((r!.answers.depth as any).choice).toBe('ordinary');
    expect(r!.answers.needs_live_web).toBeUndefined();
    expect(rowsOf()).toHaveLength(1);
    expect(rowsOf()[0].meta).toMatchObject({
      ok: true, backendSpec: 'cql-litellm:agx-laya', backendKind: 'systemone', modelId: 'laya-rl-agent',
      censoredAnswers: { needs_live_web: 'answer "needs_live_web" has no numeric noul' }, nonFiniteTokens: 4,
    });
    expect(rowsOf()[0].meta.answers.needs_live_web).toBeUndefined();
    expect(rowsOf()[0].meta.error).toBeUndefined();
    // Challenger path (the prod configuration: defaultChallengers ['cql-litellm:agx-laya'], primary jev).
    (recordLoopMetric as jest.Mock).mockReset(); post.mockClear(); clearDecisionMemo();
    await primeBackends({ defaultChallengers: ['cql-litellm:agx-laya'] });
    const r2 = await decide({ message: 'is the 2026 budget out yet?' }, { refund: QUESTIONS.refund, needs_live_web: CHECKER_Q.needs_live_web, depth: CHECKER_Q.depth }, { purpose: 'checker_route', timeoutMs: 5000 });
    expect(r2!.backend).toBe('TypeSafe Jev');
    await sleep(30);
    const crow = rowsOf().find((x) => x.meta?.challenger);
    expect(crow).toBeDefined();
    // jevBody answers only `refund`; the NaN envelope answers depth (+ censored needs_live_web) — refund is censored ("no answer") but the row is ok.
    expect(crow.meta).toMatchObject({ ok: true, backendSpec: 'cql-litellm:agx-laya', nonFiniteTokens: 4, censoredAnswers: { needs_live_web: expect.stringContaining('no numeric noul'), refund: expect.stringContaining('no answer for "refund"') } });
    expect(crow.meta.error).toBeUndefined();
  });

  it('HTTP ≥ 400: the challenger row and the primary leg error carry a scrubbed (Bearer / sk-) ≤ 300-char head of the response body — prod\'s "HTTP 400 Request failed with status code 400" rows had none; no status / 2xx / empty body → none; caps hold', async () => {
    // Pure helpers.
    expect(httpErrorBodyText(http400())).toBe('{"error":{"message":"questions[needs_live_web].criteria: invalid; token sk-••• rejected","type":"invalid_request_error"}}');
    expect(challengerErrorText(http400())).toBe('HTTP 400 Request failed with status code 400 body: {"error":{"message":"questions[needs_live_web].criteria: invalid; token sk-••• rejected","type":"invalid_request_error"}}');
    expect(httpErrorBodyText({ response: { status: 400, data: '  plain   text\n body Bearer abc ' } })).toBe('plain text body Bearer •••');
    expect(httpErrorBodyText({ response: { status: 400, data: Buffer.from('buf body') } })).toBe('buf body');
    expect(httpErrorBodyText({ response: { status: 400, data: 'x'.repeat(1000) } })).toHaveLength(300);
    expect(httpErrorBodyText({ response: { status: 200, data: { ok: 1 } } })).toBe('');
    expect(httpErrorBodyText({ message: 'ECONNRESET' })).toBe('');
    expect(httpErrorBodyText({ response: { status: 500, data: '' } })).toBe('');
    expect(httpErrorBodyText(null)).toBe('');
    expect(challengerErrorText({ response: { status: 500 }, message: 'boom' })).toBe('HTTP 500 boom');
    expect(scrubSecretText('Authorization: Bearer abc.def key=sk-proj-1234567890 sk-x')).toBe('Authorization: Bearer ••• key=sk-••• sk-x');
    // Primary leg (Laya as the spec): the all-legs-failed row's error + legErrors carry the body, scrubbed.
    mockResolveRegistryModel.mockImplementation(async (spec: string) => (spec === 'cql-litellm:agx-laya' ? LAYA_REG : null));
    post.mockRejectedValue(http400());
    const r = await decide('s', NOUL_ONLY, { purpose: 'wake_triage', spec: 'cql-litellm:agx-laya', timeoutMs: 5000 });
    expect(r).toBeNull();
    const row = rowsOf()[0].meta;
    expect(row.ok).toBe(false);
    expect(row.error).toContain('HTTP 400 Request failed with status code 400 body: {"error":{"message":"questions[needs_live_web].criteria: invalid; token sk-••• rejected"');
    expect(row.legErrors[0]).toContain('body: {"error":');
    expect(JSON.stringify(row)).not.toContain('sk-abcdefgh');
    // Challenger (detached default): its row carries the body too.
    (recordLoopMetric as jest.Mock).mockReset(); post.mockReset(); clearDecisionMemo();
    await primeBackends({ defaultChallengers: ['deepseek-flash'] });
    post.mockImplementation(async (url: string) => { if (isSystemone(url)) return jevBody(); throw http400('Request failed with status code 400 Bearer zzz'); });
    const r2 = await decide('s2', NOUL_ONLY, { purpose: 'wake_triage', timeoutMs: 5000 });
    expect(r2!.backend).toBe('TypeSafe Jev');
    await sleep(30);
    const crow = rowsOf().find((x) => x.meta?.challenger);
    expect(crow.meta).toMatchObject({ ok: false, error: expect.stringContaining('HTTP 400 Request failed with status code 400 Bearer ••• body: {"error":{"message":"questions[needs_live_web].criteria: invalid; token sk-••• rejected"') });
    expect(JSON.stringify(crow)).not.toContain('sk-abcdefgh');
    expect(JSON.stringify(crow)).not.toContain('Bearer zzz');
  });
});

/**
 * audit budgets-cost-6 (2026-09-26) — a TypeSafe 401/403 (revoked key, exhausted
 * quota) used to be neither latched nor cooled down: every ask re-hit Jev, fell
 * through to the uncalibrated readout, and the act purposes silently ran their
 * pre-gate path with one throttled warn per 5 min (prod 06:34–06:40Z: 43 rows).
 * Pinned: the latch (one /systemone post while latched), the attributable
 * 'latched (…)' leg error, the act → shadow `downgraded:true` result flag, ONE
 * decision_gate_backend_down row + ONE alert per episode, the half-open probe
 * (one ask probes, a concurrent one skips), re-latch / recovery / fail-open
 * release, the Test-button bypass, the all-legs-failed streak alert, and both
 * kill switches.
 */
describe('auth latch + backend-down alert (audit budgets-cost-6, 2026-09-26)', () => {
  const Q: Record<string, DecisionQuestion> = { needs_turn: { type: 'noul', instructions: 'Does the lane need a turn now?' } };
  const readout = { data: { choices: [{ logprobs: { content: [{ token: 'B', logprob: Math.log(0.8), top_logprobs: [{ token: 'B', logprob: Math.log(0.8) }, { token: 'A', logprob: Math.log(0.2) }] }] } }], usage: { prompt_tokens: 10 } } };
  const jevOk = { data: { answers: { needs_turn: { noul: 0.9 } }, model: 'jev-1.13.0' } };
  const http = (status: number) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
  const alerter = jest.fn(async (_a: any) => undefined);
  const rows = () => (recordLoopMetric as jest.Mock).mock.calls.map(c => c[0]);
  const downRows = () => rows().filter(r => r.kind === DECISION_GATE_BACKEND_DOWN_KIND).map(r => r.meta);
  const decisionRows = () => rows().filter(r => r.kind === 'decision_gate' && r.meta?.phase === 'decision').map(r => r.meta);
  const jevPosts = () => post.mock.calls.filter(c => String(c[0]).endsWith('/systemone'));
  const readoutPosts = () => post.mock.calls.filter(c => String(c[0]).includes('deepseek'));
  let nowSpy: jest.SpyInstance<number, []> | null = null;
  const base = Date.now();
  const setNow = (ms: number) => { nowSpy?.mockRestore(); nowSpy = jest.spyOn(Date, 'now').mockReturnValue(ms); };
  const tick = () => new Promise(r => setImmediate(r));

  beforeEach(() => {
    process.env.DECISION_GATE_MODE_SWEEP_TRIAGE = 'act';
    process.env.TYPESAFE_API_KEY = 'revoked-key';
    process.env.DEEPSEEK_API_KEY = 'd';
    alerter.mockClear();
    setDecisionBackendDownAlerter(alerter);
    clearDecisionAuthLatches();
  });
  afterEach(() => {
    setDecisionBackendDownAlerter(null);
    nowSpy?.mockRestore();
    nowSpy = null;
    clearDecisionAuthLatches();
  });

  const ask = (i = 0) => decide({ lane: 'x', i }, Q, { purpose: 'sweep_triage', timeoutMs: 4000, memo: false });

  it('a 403 LATCHES Jev: 5 asks → ONE /systemone post, 5 readouts; the later rows say "latched (HTTP 403 …)"; the act purpose comes back downgraded (mode shadow + downgraded:true); ONE backend_down row + ONE alert', async () => {
    post.mockImplementation(async (url: string) => { if (String(url).endsWith('/systemone')) throw http(403); return readout; });
    const results = [] as any[];
    for (let i = 0; i < 5; i++) results.push(await ask(i));
    expect(jevPosts()).toHaveLength(1);
    expect(readoutPosts()).toHaveLength(5);
    for (const r of results) {
      expect(r).toMatchObject({ backend: 'DeepSeek logprob readout', calibrated: false, mode: 'shadow', downgraded: true });
    }
    const d = decisionRows();
    expect(d).toHaveLength(5);
    expect(d[0].legErrors).toEqual([expect.stringContaining('TypeSafe Jev: HTTP 403')]);
    for (const m of d.slice(1)) {
      expect(m).toMatchObject({ ok: true, mode: 'shadow', requestedMode: 'act', modeDowngrade: 'uncalibrated', legIndex: 1 });
      expect(m.legErrors).toEqual([expect.stringMatching(/^TypeSafe Jev: latched \(HTTP 403 at \d{4}-.*; re-probe at \d{4}-.*\)$/)]);
    }
    expect(downRows()).toEqual([expect.objectContaining({ event: 'latched', spec: 'jev', backend: 'TypeSafe Jev', status: 403, purpose: 'sweep_triage', cooldownMs: DECISION_AUTH_LATCH_DEFAULT_MS, relatches: 0 })]);
    // The alert seam fires once, asynchronously, with the episode's facts.
    await tick();
    expect(alerter).toHaveBeenCalledTimes(1);
    expect(alerter.mock.calls[0][0]).toMatchObject({ event: 'latched', spec: 'jev', backend: 'TypeSafe Jev', status: 403, purpose: 'sweep_triage' });
    expect(decisionAuthLatches()).toEqual([expect.objectContaining({ spec: 'jev', status: 403, probing: false, relatches: 0 })]);
    // No key text leaks into the rows.
    expect(JSON.stringify(rows())).not.toContain('revoked-key');
  });

  it('half-open: after the cooldown exactly ONE ask probes (a concurrent ask still skips); a successful probe clears the latch and records "recovered"', async () => {
    setNow(base);
    post.mockImplementation(async (url: string) => { if (String(url).endsWith('/systemone')) throw http(403); return readout; });
    await ask();
    expect(jevPosts()).toHaveLength(1);
    // Inside the cooldown: still latched.
    setNow(base + authLatchMs() - 1000);
    await ask(1);
    expect(jevPosts()).toHaveLength(1);
    // Past the cooldown: the FIRST ask carries the probe; a SECOND ask launched while it is in flight skips.
    setNow(base + authLatchMs() + 1000);
    let resolveJev: (() => void) | null = null;
    post.mockImplementation((url: string) => {
      if (String(url).endsWith('/systemone')) return new Promise(r => { resolveJev = () => r(jevOk); });
      return Promise.resolve(readout);
    });
    const p1 = ask(2);
    for (let i = 0; i < 200 && jevPosts().length < 2; i++) await tick(); // the probe's /systemone post is in flight
    expect(decisionAuthLatches()).toEqual([expect.objectContaining({ probing: true })]);
    const r2 = await ask(3);
    expect(r2!.backend).toBe('DeepSeek logprob readout');
    expect(jevPosts()).toHaveLength(2); // the probe only — the concurrent ask never posted to /systemone
    resolveJev!();
    const r1 = await p1;
    expect(r1).toMatchObject({ backend: 'TypeSafe Jev', mode: 'act', calibrated: true });
    expect(r1!.downgraded).toBeUndefined();
    expect(decisionAuthLatches()).toEqual([]);
    expect(downRows().map(m => m.event)).toEqual(['latched', 'recovered']);
    expect(downRows()[1]).toMatchObject({ spec: 'jev', status: 403, relatches: 0 });
    expect(downRows()[1].downMs).toBeGreaterThanOrEqual(authLatchMs());
    // The next ask calls Jev again as normal.
    post.mockImplementation(async () => jevOk);
    expect((await ask(4))!.backend).toBe('TypeSafe Jev');
    expect(jevPosts()).toHaveLength(3);
  });

  it('a probe that 403s again RE-LATCHES (relatched row, relatches 1, no second alert); a probe that fails for any other reason RELEASES the latch (fail-open)', async () => {
    setNow(base);
    post.mockImplementation(async (url: string) => { if (String(url).endsWith('/systemone')) throw http(403); return readout; });
    await ask();
    setNow(base + authLatchMs() + 1);
    await ask(1); // the probe: 403 again
    expect(jevPosts()).toHaveLength(2);
    expect(decisionAuthLatches()).toEqual([expect.objectContaining({ relatches: 1, probing: false })]);
    expect(downRows().map(m => m.event)).toEqual(['latched', 'relatched']);
    await tick();
    expect(alerter).toHaveBeenCalledTimes(1);
    // Next cooldown: the probe hits a 500 → the latch is released, the following ask calls Jev straight away.
    setNow(base + 2 * authLatchMs() + 2);
    post.mockImplementation(async (url: string) => { if (String(url).endsWith('/systemone')) throw http(500); return readout; });
    await ask(2);
    expect(decisionAuthLatches()).toEqual([]);
    await ask(3);
    expect(jevPosts()).toHaveLength(4);
    expect(downRows().map(m => m.event)).toEqual(['latched', 'relatched']); // a release is not a recovery row
  });

  it('a spec-pinned ask (the admin Test button) ALWAYS calls the backend, and its success ends the episode', async () => {
    post.mockImplementation(async (url: string) => { if (String(url).endsWith('/systemone')) throw http(403); return readout; });
    await ask();
    expect(decisionAuthLatches()).toHaveLength(1);
    post.mockImplementation(async () => jevOk);
    const probe = await decide('s', Q, { purpose: 'probe', spec: 'jev', timeoutMs: 2000 });
    expect(probe!.backend).toBe('TypeSafe Jev');
    expect(jevPosts()).toHaveLength(2);
    expect(decisionAuthLatches()).toEqual([]);
    expect(downRows().map(m => m.event)).toEqual(['latched', 'recovered']);
  });

  it('a 401 on the READOUT leg latches the readout too (the same key shape) — the next ask skips it with an attributable leg error and makes no call', async () => {
    delete process.env.TYPESAFE_API_KEY;
    post.mockRejectedValue(http(401));
    expect(await ask()).toBeNull();
    expect(readoutPosts()).toHaveLength(1);
    expect(await ask(1)).toBeNull();
    expect(readoutPosts()).toHaveLength(1);
    const d = decisionRows();
    expect(d[1]).toMatchObject({ ok: false, legErrors: [expect.stringContaining('DeepSeek logprob readout: latched (HTTP 401')] });
    expect(decisionAuthLatches()).toEqual([expect.objectContaining({ spec: 'deepseek-flash', status: 401 })]);
  });

  it('all legs failed: a backend_down row per ask (streak counted), the alert on the 3rd inside 5 min, never for the probe purpose; the 429 retry is untouched', async () => {
    post.mockRejectedValue(http(500));
    expect(await ask()).toBeNull();
    expect(await ask(1)).toBeNull();
    await tick();
    expect(alerter).not.toHaveBeenCalled();
    expect(await ask(2)).toBeNull();
    await tick();
    expect(downRows().map(m => [m.event, m.streak])).toEqual([['all_legs_failed', 1], ['all_legs_failed', 2], ['all_legs_failed', 3]]);
    expect(downRows()[2]).toMatchObject({ purpose: 'sweep_triage', legErrors: [expect.stringContaining('TypeSafe Jev: HTTP 500'), expect.stringContaining('DeepSeek logprob readout: HTTP 500')] });
    expect(alerter).toHaveBeenCalledTimes(1);
    expect(alerter.mock.calls[0][0]).toMatchObject({ event: 'all_legs_failed', purpose: 'sweep_triage', streak: 3 });
    // The admin Test button's failures never count or alert.
    (recordLoopMetric as jest.Mock).mockClear();
    expect(await decide('s', Q, { purpose: 'probe', spec: 'jev', timeoutMs: 2000 })).toBeNull();
    expect(downRows()).toEqual([]);
    // The 429/529 retry is untouched: a 429 is retried once, never latched.
    (recordLoopMetric as jest.Mock).mockClear(); post.mockReset();
    post.mockRejectedValueOnce(http(429)).mockRejectedValueOnce(http(429)).mockResolvedValue(readout);
    await ask(3);
    expect(jevPosts()).toHaveLength(2);
    expect(decisionAuthLatches()).toEqual([]);
  });

  it('authLatchMs: default 90 s, env clamped to [10 s, 10 min]; a bad value falls back', () => {
    expect(authLatchMs()).toBe(90_000);
    process.env.DECISION_GATE_AUTH_LATCH_MS = '5000';
    expect(authLatchMs()).toBe(10_000);
    process.env.DECISION_GATE_AUTH_LATCH_MS = '3600000';
    expect(authLatchMs()).toBe(600_000);
    process.env.DECISION_GATE_AUTH_LATCH_MS = 'x';
    expect(authLatchMs()).toBe(90_000);
  });

  it('clearDecisionBackendCache (the admin seat / endpoint mutation hook) drops every latch so a key change re-probes at once', async () => {
    post.mockImplementation(async (url: string) => { if (String(url).endsWith('/systemone')) throw http(403); return readout; });
    await ask();
    expect(decisionAuthLatches()).toHaveLength(1);
    clearDecisionBackendCache();
    expect(decisionAuthLatches()).toEqual([]);
    await ask(1);
    expect(jevPosts()).toHaveLength(2);
  });

  // DOI-17 (2026-09-28): the admin Model roles page renders the latch state —
  // the view is pure over the latch map, per PROCESS.
  it('formatDecisionLatchView renders ISO times, holding / remaining against `now`, newest first; decisionBackendLatchView reads the live map', async () => {
    const now = Date.parse('2026-09-28T10:00:30.000Z');
    const t0 = now - 30_000;
    const view = formatDecisionLatchView([
      { key: 'a::m', spec: 'jev', backend: 'TypeSafe Jev', status: 403, since: t0, at: t0, until: t0 + 90_000, probing: false, relatches: 0 },
      { key: 'b::m', spec: 'lite:laya', backend: 'Laya', status: 401, since: t0 - 200_000, at: t0 + 10_000, until: now - 1, probing: false, relatches: 2 },
    ], now);
    expect(view.scope).toBe('process');
    expect(view.at).toBe('2026-09-28T10:00:30.000Z');
    expect(view.cooldownMs).toBe(DECISION_AUTH_LATCH_DEFAULT_MS);
    expect(view.latches.map(l => l.backend)).toEqual(['Laya', 'TypeSafe Jev']); // newest `at` first
    expect(view.latches[1]).toMatchObject({ spec: 'jev', status: 403, since: '2026-09-28T10:00:00.000Z', until: '2026-09-28T10:01:30.000Z', holding: true, remainingMs: 60_000, relatches: 0 });
    expect(view.latches[0]).toMatchObject({ spec: 'lite:laya', status: 401, holding: false, remainingMs: 0, relatches: 2 });
    // A half-open probe in flight still reads as holding (asks keep skipping).
    expect(formatDecisionLatchView([{ key: 'c::m', spec: 'jev', backend: 'J', status: 403, since: t0, at: t0, until: now - 1, probing: true, relatches: 0 }], now).latches[0].holding).toBe(true);

    // Live map: a real 403 latch shows up in the view.
    post.mockImplementation(async (url: string) => { if (String(url).endsWith('/systemone')) throw http(403); return readout; });
    await ask();
    const live = decisionBackendLatchView();
    expect(live.latches).toEqual([expect.objectContaining({ spec: 'jev', status: 403, holding: true })]);
  });
});

// Task-aware model pick (2026-10-20): task_kind is a pure evidence key — act-capped in code, never retired.
describe('task_kind — the act-band threshold is the classifier bar; a stored / env act runs shadow', () => {
  it('ACT_BAND_DEFAULT_THRESHOLD.task_kind == TASK_KIND_MIN_P; the band is confidence ≥ τ on the kind question', () => {
    expect(ACT_BAND_DEFAULT_THRESHOLD.task_kind).toBe(TASK_KIND_MIN_P);
    const kind = (confidence: number) => ({ type: 'choice' as const, choice: 'writing', probabilities: { writing: confidence, code: 1 - confidence }, confidence });
    expect(inActBand('task_kind', kind(0.5), false)).toBe(true);
    expect(inActBand('task_kind', kind(0.49), false)).toBe(false);
  });

  it('decisionModeWithSource: env act → shadow (registry_cap); the env default shadow stays shadow', () => {
    const saved = process.env.DECISION_GATE_MODE_TASK_KIND;
    try {
      expect(decisionModeWithSource('task_kind')).toEqual({ mode: 'shadow', source: 'env_default' });
      process.env.DECISION_GATE_MODE_TASK_KIND = 'act';
      expect(decisionModeWithSource('task_kind')).toEqual({ mode: 'shadow', source: 'registry_cap' });
    } finally {
      if (saved === undefined) delete process.env.DECISION_GATE_MODE_TASK_KIND; else process.env.DECISION_GATE_MODE_TASK_KIND = saved;
    }
  });
});

// ── Log-signal family lane d37054e9 — ticket f68b611e (2026-10-24) ─────────────
// 126 rows/24h of the compute_policy fall-through warn. Adjudication (lane
// d37054e9): NOT a framework defect. The prod 'decision' seat resolves to
// llm-cql:agx-laya (the owner's AGX box, mid-rebuild — standing directive
// oq_63f66), so a compute_policy ask (1200 ms budget, COMPUTE_POLICY_TIMEOUT_MS)
// spends its first leg on that dead gateway inside the legShareCap half-share
// (~599 ms — the exact fingerprint numbers), falls through to the built-in
// TypeSafe Jev, and the ask is ANSWERED. The warn is the designed WI-H
// visibility for that silent backend swap; a TIMEOUT is deliberately NOT
// latched (DECISION_AUTH_LATCH_STATUSES covers 401/403 only — a transient
// provider must keep being probed), and warnFallThroughThrottled bounds the
// rows to ONE per 5 min per process. This block pins that contract so a
// future pass cannot "fix" the warn into silence or latch timeouts into a
// dead chain.
//
// UPDATED by family lane 3556c8a4 (ticket d883ae45, 2026-11-03): the emit site
// is now TAGGED logClass:'external'. The original d37054e9 note said it "stays
// untagged — a real fall-through must stay sweep-visible". Keeping it visible
// was right; leaving it UNTAGGED never achieved that, it achieved the opposite
// of what was wanted — after three separate lanes adjudicated this same class
// a designed non-defect (f68b611e here, 0c86f97f task_kind, 22afdd2d
// turn_plan), the hourly sweep was still fingerprinting it as a framework fault
// and re-filing it weekly (29 rows / 12 distinct hours on d883ae45 alone), i.e.
// the untagged warn produced tickets, not visibility. Visibility is preserved
// where it can actually be read: every instance stays on loop_metrics
// decision_gate meta.legErrors — the very row this message points at — so a
// real degradation is still measurable and alertable. What the tag removes is
// only the sweep's misreading of a DESIGNED backend swap as an internal fault.
describe('compute_policy fall-through — log-signal f68b611e (designed WI-H visibility, 5-min throttle, no timeout latch)', () => {
  beforeEach(() => {
    process.env.DECISION_GATE_DEFAULT_MODE = 'shadow';
    process.env.DECISION_GATE_STALL_RECOVERY_DISABLED = '1'; // plain leg loop — the stall timer cannot eat the mock budget
    process.env.TYPESAFE_API_KEY = 'k';
    process.env.DEEPSEEK_API_KEY = 'd';
    post.mockImplementation(async (url: string) => { if (isSystemone(url)) return jevBody(); throw { response: { status: 503 }, message: 'down' }; });
  });
  afterEach(() => {
    delete process.env.DECISION_GATE_DEFAULT_MODE;
    delete process.env.DECISION_GATE_STALL_RECOVERY_DISABLED;
    clearDecisionMemo();
    clearDecisionBackendCache();
    mockResolveRegistryModel.mockReset();
    mockResolveRegistryModel.mockImplementation(async () => null);
  });

  it('a dead first leg falls through to TypeSafe Jev — the row carries legIndex/legErrors naming the failed leg (the designed trace)', async () => {
    await primeBackends({ purposes: { compute_policy: { primary: 'deepseek-flash' } } });
    const r = await decide('s', NOUL_ONLY, { purpose: 'compute_policy', timeoutMs: 5000 });
    expect(r!.backend).toBe('TypeSafe Jev');
    expect(rowsOf()[0].meta).toMatchObject({ legIndex: 1, legErrors: [expect.stringContaining('DeepSeek logprob readout: HTTP 503')] });
  });

  it('the fall-through warn is THROTTLED to one per 5 min per process — the fingerprint rows are one per window, not per ask', async () => {
    await primeBackends({ purposes: { compute_policy: { primary: 'deepseek-flash' } } });
    const loggerMock = require('../../../utils/logger').default as { warn: jest.Mock };
    loggerMock.warn.mockClear();
    // The throttle state (lastFallThroughWarnAt) is module-level: earlier
    // suites in this file (and this block's own first test) already fired the
    // warn at REAL Date.now(), and an ABSOLUTE frozen timestamp goes stale
    // once real time passes it (the warn would suppress forever — review D1).
    // Freeze the clock RELATIVE — capture real now BEFORE the spy (calling
    // Date.now() inside the mock would recurse into the spy itself) and hold
    // it 10 min ahead, so the first ask here always re-arms the throttle with
    // a positive >5-min gap, forever, independent of the wall clock.
    const realNow = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => realNow + 10 * 60_000);
    try {
      for (let i = 0; i < 3; i++) {
        clearDecisionMemo();
        await decide('s', NOUL_ONLY, { purpose: 'compute_policy', timeoutMs: 5000 });
      }
    } finally {
      nowSpy.mockRestore();
    }
    const fallWarns = loggerMock.warn.mock.calls.filter((c: any[]) => String(c[0]?.message ?? '').includes('decision-gate[compute_policy]: earlier leg(s) failed'));
    expect(fallWarns).toHaveLength(1);
    expect(String(fallWarns[0][0]?.message)).toContain('TypeSafe Jev answered');
    expect(String(fallWarns[0][0]?.message)).toContain('(further fall-throughs in loop_metrics decision_gate meta.legErrors)');
    // d883ae45: the row is TAGGED external so the sweep stops filing a
    // designed backend swap as a framework fault (isNonFaultLogRow).
    expect(fallWarns[0][0]?.logClass).toBe('external');
  });

  it('a timing-out first leg is retried on EVERY ask (deliberately unlatched — timeouts are not in DECISION_AUTH_LATCH_STATUSES) while the chain still answers', async () => {
    // The prod shape: the registry decision leg (llm-cql:agx-laya over the
    // dead gateway) times out inside its leg share; the built-in Jev answers.
    await primeBackends({ purposes: { compute_policy: { primary: 'llm-cql:agx-laya' } } });
    mockResolveRegistryModel.mockImplementation(async (spec: string) => (spec === 'llm-cql:agx-laya' ? LAYA_REG : null));
    post.mockImplementation(async (url: string) => {
      if (String(url).includes('llm.cql.ca')) {
        const err: any = new Error('timeout of 599ms exceeded');
        err.code = 'ECONNABORTED';
        throw err;
      }
      return jevBody();
    });
    const r1 = await decide('s', NOUL_ONLY, { purpose: 'compute_policy', timeoutMs: 1200 });
    clearDecisionMemo();
    const r2 = await decide('s', NOUL_ONLY, { purpose: 'compute_policy', timeoutMs: 1200 });
    expect(r1!.backend).toBe('TypeSafe Jev');
    expect(r2!.backend).toBe('TypeSafe Jev');
    // The dead leg was attempted on BOTH asks — no cross-ask timeout latch exists (by design).
    const layaCalls = post.mock.calls.filter((c: any[]) => String(c[0]).includes('llm.cql.ca')).length;
    expect(layaCalls).toBe(2);
  });

  it('the leg budget math reproduces the fingerprint numbers: legShareCap(2000, ~1190..1198) = 595..599', () => {
    // The 595-599 ms timeouts in the prod rows are the half-share of the
    // 1200 ms compute_policy ask under DECISION_LEG_TIMEOUT_DEFAULT_MS=2000 —
    // the designed cap that keeps the fallback leg reachable, not a bug.
    expect(legShareCap(2000, 1198)).toBe(599);
    expect(legShareCap(2000, 1190)).toBe(595);
    expect(legShareCap(2000, 2400)).toBe(1200); // the half-share binds until remaining ≥ 2× the leg cap…
    expect(legShareCap(2000, 4000)).toBe(2000); // …then the absolute leg timeout binds (a long ask gets the full 2 s leg).
  });
});

// ── Log-signal family lane f02ac12e — ticket 0c86f97f (2026-10-26) ─────────────
// The task_kind sibling of the f68b611e compute_policy fall-through class:
// 14 rows/24h (Oct 24) of
//   decision-gate[task_kind]: earlier leg(s) failed, TypeSafe Jev answered —
//   llm-cql (typed decisions via chat completions): timeout timeout of
//   567ms exceeded (further fall-throughs in loop_metrics decision_gate meta.legErrors)
// Adjudication (lane f02ac12e, 2026-10-26): NOT a framework defect — same
// owner-side root cause as f68b611e. The prod 'decision' seat's per-purpose
// chain carries llm-cql:agx-laya (the owner's AGX box, mid-rebuild — standing
// directive oq_63f66) as an earlier leg; a task_kind ask spends that leg on
// the dead gateway inside its legShareCap share (~567-599 ms — the exact
// fingerprint numbers), falls through to the built-in TypeSafe Jev, and the
// ask is ANSWERED. The warn is the designed WI-H visibility for that silent
// backend swap; a TIMEOUT is deliberately NOT latched (DECISION_AUTH_LATCH_STATUSES
// covers 401/403 only — a transient provider must keep being probed), and
// warnFallThroughThrottled bounds the rows to ONE per 5 min per process.
// task_kind itself is act-capped in code (PURPOSE_ACT_CAPS) — the purpose
// NEVER gates anything, so the fall-through cannot degrade a gate act; it
// only degrades the model-pick evidence key (the task-aware pick runs the
// pre-gate path meanwhile). This block pins that contract for task_kind so
// a future pass cannot "fix" the warn into silence or latch timeouts into a
// dead chain.
describe('task_kind fall-through — log-signal 0c86f97f (designed WI-H visibility, 5-min throttle, no timeout latch)', () => {
  beforeEach(() => {
    process.env.DECISION_GATE_DEFAULT_MODE = 'shadow';
    process.env.DECISION_GATE_STALL_RECOVERY_DISABLED = '1'; // plain leg loop — the stall timer cannot eat the mock budget
    process.env.TYPESAFE_API_KEY = 'k';
    process.env.DEEPSEEK_API_KEY = 'd';
    post.mockImplementation(async (url: string) => { if (isSystemone(url)) return jevBody(); throw { response: { status: 503 }, message: 'down' }; });
  });
  afterEach(() => {
    delete process.env.DECISION_GATE_DEFAULT_MODE;
    delete process.env.DECISION_GATE_STALL_RECOVERY_DISABLED;
    clearDecisionMemo();
    clearDecisionBackendCache();
    mockResolveRegistryModel.mockReset();
    mockResolveRegistryModel.mockImplementation(async () => null);
  });

  it('REPLAYS the prod row: the registry leg times out inside its share, TypeSafe Jev answers, and the warn IS the fingerprint (label + timeout form)', async () => {
    // The prod registry entry's label is 'llm-cql' (the endpoint's real label
    // — the existing LAYA_REG fixture in this file uses 'cql-litellm', a
    // different endpoint name; this pin needs the PROD label verbatim).
    const LAYA_REG_PROD = { ...LAYA_REG, label: 'llm-cql' };
    await primeBackends({ purposes: { task_kind: { primary: 'llm-cql:agx-laya' } } });
    mockResolveRegistryModel.mockImplementation(async (spec: string) => (spec === 'llm-cql:agx-laya' ? LAYA_REG_PROD : null));
    post.mockImplementation(async (url: string) => {
      if (String(url).includes('llm.cql.ca')) {
        // The prod shape: axios ECONNABORTED with the leg-share timeout in
        // the message — the "timeout timeout of 567ms exceeded" fingerprint.
        const err: any = new Error('timeout of 567ms exceeded');
        err.code = 'ECONNABORTED';
        throw err;
      }
      return jevBody();
    });
    // The throttle state is module-level; freeze the clock RELATIVE so the
    // first ask here always re-arms it (the f68b611e D1 lesson). Hold it a
    // FULL HOUR ahead — the f68b611e block earlier in this file stamps
    // lastFallThroughWarnAt at its own realNow+10min, so a +10min hold here
    // would still sit inside the 5-min window of that stamp on a full-file
    // run; +60min clears any prior stamp.
    const loggerMock = require('../../../utils/logger').default as { warn: jest.Mock };
    loggerMock.warn.mockClear();
    const realNow = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => realNow + 60 * 60_000);
    try {
      const r = await decide('s', NOUL_ONLY, { purpose: 'task_kind', timeoutMs: 1200 });
      expect(r!.backend).toBe('TypeSafe Jev');
    } finally {
      nowSpy.mockRestore();
    }
    const fallWarns = loggerMock.warn.mock.calls.filter((c: any[]) => String(c[0]?.message ?? '').includes('decision-gate[task_kind]: earlier leg(s) failed'));
    expect(fallWarns).toHaveLength(1);
    // The exact prod label: systemOneBackendLabel's chat-transport form.
    expect(String(fallWarns[0][0]?.message)).toContain('TypeSafe Jev answered — llm-cql (typed decisions via chat completions)');
    // The exact prod leg-error form: "timeout" (the ECONNABORTED prefix) then
    // the axios message, scrubbed to the row cap.
    expect(String(fallWarns[0][0]?.message)).toMatch(/: timeout timeout of 56[0-9]ms exceeded \(further fall-throughs in loop_metrics decision_gate meta\.legErrors\)/);
    // d883ae45: TAGGED external — the sweep stops filing the designed swap.
    expect(fallWarns[0][0]?.logClass).toBe('external');
  });

  it("the leg-share budget produces the fingerprint numbers: the dead leg's timeout < the ask's total budget, so the Jev fallback stays reachable", () => {
    // legShareCap(2000, ~1130..1198) = 565..599 — the ~567ms in the prod rows
    // is the half-share of a ~1134ms task_kind ask under
    // DECISION_LEG_TIMEOUT_DEFAULT_MS=2000 (the designed cap that keeps the
    // fallback leg reachable), not a bug.
    expect(legShareCap(2000, 1198)).toBe(599);
    expect(legShareCap(2000, 1134)).toBe(567);
    expect(legShareCap(2000, 4000)).toBe(2000);
  });

  it('task_kind is act-capped in code — the fall-through degrades an evidence key, never a gate act', () => {
    // The act-capped purpose can NEVER be flipped to act (registry_cap) —
    // pin the actual vocabulary the modes module exposes.
    const saved = process.env.DECISION_GATE_MODE_TASK_KIND;
    try {
      expect(decisionModeWithSource('task_kind')).toEqual({ mode: 'shadow', source: 'env_default' });
      process.env.DECISION_GATE_MODE_TASK_KIND = 'act';
      expect(decisionModeWithSource('task_kind')).toEqual({ mode: 'shadow', source: 'registry_cap' });
    } finally {
      if (saved === undefined) delete process.env.DECISION_GATE_MODE_TASK_KIND; else process.env.DECISION_GATE_MODE_TASK_KIND = saved;
    }
    // The throttle bound: one fall-through warn per 5 min per process.
    const src = require('fs').readFileSync(require('path').join(__dirname, 'decision-gate.ts'), 'utf8');
    const at = src.indexOf('function warnFallThroughThrottled');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 400)).toContain('if (Date.now() - lastFallThroughWarnAt < 5 * 60_000) return;');
    // A TIMEOUT is deliberately NOT in the auth-latch statuses — the dead
    // leg keeps being probed on every ask (the f68b611e contract).
    expect(src).not.toMatch(/DECISION_AUTH_LATCH_STATUSES[^;]*timeout/i);
  });
});

// ── Log-signal family lane 92dc54d6 — ticket 22afdd2d (2026-10-26) ──────────────
// The turn_plan sibling of the f68b611e (compute_policy) / 0c86f97f (task_kind)
// fall-through class: 7 rows/24h (Oct 25, 12:58–22:18Z) of
//   decision-gate[turn_plan]: earlier leg(s) failed, TypeSafe Jev answered —
//   llm-cql (typed decisions via chat completions): timeout timeout of
//   598ms exceeded (further fall-throughs in loop_metrics decision_gate meta.legErrors)
// Adjudication (lane 92dc54d6, 2026-10-27): NOT a framework defect — the SAME
// owner-side root cause as f68b611e (the llm.cql.ca gateway leg on the
// decision seat's per-purpose chain times out inside its legShareCap share
// ~598 ms, the built-in TypeSafe Jev answers, and the ask is ANSWERED). What
// makes this member its own pin: turn_plan is THE live act purpose (the only
// purpose in act today; NOT act-capped in PURPOSE_ACT_CAPS), so the contract
// matters most here — a dead earlier leg must never block a live gate:
// decide() FAILS OPEN to the built-in Jev and the verdict still lands. The
// warn is the designed WI-H visibility for that silent backend swap; a
// TIMEOUT is deliberately unlatched (DECISION_AUTH_LATCH_STATUSES covers
// 401/403 only), and warnFallThroughThrottled bounds the rows to ONE per
// 5 min per process. This block pins that contract for turn_plan so a future
// pass cannot "fix" the warn into silence, latch timeouts into a dead chain,
// or let a failed earlier leg fail anything closed.
describe('turn_plan fall-through — log-signal 22afdd2d (designed WI-H visibility on the LIVE act purpose, fail-open, no timeout latch)', () => {
  beforeEach(() => {
    process.env.DECISION_GATE_DEFAULT_MODE = 'shadow';
    process.env.DECISION_GATE_STALL_RECOVERY_DISABLED = '1'; // plain leg loop — the stall timer cannot eat the mock budget
    process.env.TYPESAFE_API_KEY = 'k';
    process.env.DEEPSEEK_API_KEY = 'd';
    post.mockImplementation(async (url: string) => { if (isSystemone(url)) return jevBody(); throw { response: { status: 503 }, message: 'down' }; });
  });
  afterEach(() => {
    delete process.env.DECISION_GATE_DEFAULT_MODE;
    delete process.env.DECISION_GATE_STALL_RECOVERY_DISABLED;
    delete process.env.DECISION_GATE_MODE_TURN_PLAN;
    clearDecisionMemo();
    clearDecisionBackendCache();
    mockResolveRegistryModel.mockReset();
    mockResolveRegistryModel.mockImplementation(async () => null);
  });

  it('REPLAYS the prod row: the registry leg times out inside its share, TypeSafe Jev answers, and the warn IS the fingerprint (label + 598ms timeout form)', async () => {
    const LAYA_REG_PROD = { ...LAYA_REG, label: 'llm-cql' };
    await primeBackends({ purposes: { turn_plan: { primary: 'llm-cql:agx-laya' } } });
    mockResolveRegistryModel.mockImplementation(async (spec: string) => (spec === 'llm-cql:agx-laya' ? LAYA_REG_PROD : null));
    post.mockImplementation(async (url: string) => {
      if (String(url).includes('llm.cql.ca')) {
        const err: any = new Error('timeout of 598ms exceeded');
        err.code = 'ECONNABORTED';
        throw err;
      }
      return jevBody();
    });
    // The throttle state is module-level; freeze the clock RELATIVE so the
    // first ask here always re-arms it (the f68b611e D1 lesson). +120 min
    // clears the task_kind block's +60 min stamp on a full-file run.
    const loggerMock = require('../../../utils/logger').default as { warn: jest.Mock };
    loggerMock.warn.mockClear();
    const realNow = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => realNow + 120 * 60_000);
    try {
      const r = await decide('s', NOUL_ONLY, { purpose: 'turn_plan', timeoutMs: 1200 });
      expect(r!.backend).toBe('TypeSafe Jev');
    } finally {
      nowSpy.mockRestore();
    }
    const fallWarns = loggerMock.warn.mock.calls.filter((c: any[]) => String(c[0]?.message ?? '').includes('decision-gate[turn_plan]: earlier leg(s) failed'));
    expect(fallWarns).toHaveLength(1);
    expect(String(fallWarns[0][0]?.message)).toContain('TypeSafe Jev answered — llm-cql (typed decisions via chat completions)');
    expect(String(fallWarns[0][0]?.message)).toMatch(/: timeout timeout of 59[0-9]ms exceeded \(further fall-throughs in loop_metrics decision_gate meta\.legErrors\)/);
    // d883ae45: TAGGED external — the sweep stops filing the designed swap.
    expect(fallWarns[0][0]?.logClass).toBe('external');
  });

  it('the leg budget math reproduces the fingerprint numbers: legShareCap(2000, ~1196) = 598 — the half-share of a ~1196ms turn_plan ask', () => {
    // The 598 ms in the prod rows is the half-share of the ask's remaining
    // budget under DECISION_LEG_TIMEOUT_DEFAULT_MS=2000 (the designed cap
    // that keeps the Jev fallback leg reachable), not a bug.
    expect(legShareCap(2000, 1196)).toBe(598);
    expect(legShareCap(2000, 1198)).toBe(599);
    expect(legShareCap(2000, 4000)).toBe(2000);
  });

  it('turn_plan is the LIVE act purpose (not act-capped like task_kind), and a dead earlier leg still FAILS OPEN — the verdict lands either way', async () => {
    process.env.DECISION_GATE_MODE_TURN_PLAN = 'act';
    try {
      // turn_plan is NOT in PURPOSE_ACT_CAPS (drain_triage / self_audit /
      // tool_intent / task_kind): a per-purpose act takes effect — unlike
      // task_kind, which the 0c86f97f block shows is registry-capped to shadow.
      expect(decisionModeWithSource('turn_plan')).toEqual({ mode: 'act', source: 'env_purpose' });
    } finally {
      delete process.env.DECISION_GATE_MODE_TURN_PLAN;
    }
    const LAYA_REG_PROD = { ...LAYA_REG, label: 'llm-cql' };
    await primeBackends({ purposes: { turn_plan: { primary: 'llm-cql:agx-laya' } } });
    mockResolveRegistryModel.mockImplementation(async (spec: string) => (spec === 'llm-cql:agx-laya' ? LAYA_REG_PROD : null));
    post.mockImplementation(async (url: string) => {
      if (String(url).includes('llm.cql.ca')) {
        const err: any = new Error('timeout of 598ms exceeded');
        err.code = 'ECONNABORTED';
        throw err;
      }
      return jevBody();
    });
    clearDecisionMemo();
    const r = await decide('s', NOUL_ONLY, { purpose: 'turn_plan', timeoutMs: 1200 });
    // FAIL-OPEN on the live act purpose: the dead earlier leg never blocks
    // the verdict — the built-in Jev answered.
    expect(r!.backend).toBe('TypeSafe Jev');
    // The shared throttle + unlatch contracts (the f68b611e / 0c86f97f pins).
    const src = require('fs').readFileSync(require('path').join(__dirname, 'decision-gate.ts'), 'utf8');
    const at = src.indexOf('function warnFallThroughThrottled');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 400)).toContain('if (Date.now() - lastFallThroughWarnAt < 5 * 60_000) return;');
    expect(src).not.toMatch(/DECISION_AUTH_LATCH_STATUSES[^;]*timeout/i);
  });
});
