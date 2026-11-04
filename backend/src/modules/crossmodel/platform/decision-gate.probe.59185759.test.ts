/**
 * decision-gate.ts probeDecisionSpec — the admin/agent Test-button surface behind
 * `test_model_role {role:'decision', candidate:'jev'}`.
 *
 * REPLAY (mishap ticket 59185759-9d11-4f3b-8368-570d53b9b63b, 2026-10-12): a live
 * coding session called that tool 3× in a row and every call answered
 *   ok:false — "TypeSafe Jev did not answer — see the backend log line
 *   (decision-gate[probe]) for the HTTP status / parse error."
 * ADJUDICATION (this ticket's question, "framework or model?"): ENVIRONMENT, not
 * framework. The vendor (api.typesafe.ai) answered HTTP 401
 * authentication_error from 06:33:18Z — the pre-rotation TYPESAFE_API_KEY was
 * revoked in the owner's post-breach credential rotation (parent ticket
 * 638ff4ae, done: rotated key deployed ~07:44Z). The failing session's run
 * executed inside a draining worker that still held the revoked key, so its
 * spec-pinned probes (which ALWAYS call the backend — the latch never skips the
 * admin probe) re-hit the 401 self-referentially; a live probe after recovery
 * answered ok in 117 ms. The failure text itself is unchanged since the
 * original decision-seat commit (4cdfb8bbf) — no framework regression.
 *
 * This suite pins the probe's failure surface so the mishap class stays
 * attributable: a 401 streak fails ok:false with the EXACT tool-facing text,
 * one real HTTP call per ask, a latched→relatched metric trail, no
 * all_legs_failed row and no backend-down alert (a probe is on the admin's own
 * screen), and recovery in the same process answers ok:true + writes the
 * 'recovered' row. Plus the two preflight answers that are CONFIG, not backend
 * failures: the kill switch and a keyless instance.
 */

jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
// The real logger boots env.ts, which process.exit()s a keyless jest.
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' },
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordLoopMetrics: (...a: any[]) => mockRecordLoopMetrics(...a),
}));
jest.mock('../model-endpoints/model-roles.service', () => ({
  resolveRoleModel: jest.fn(async () => 'jev'),
  resolveRoleFallback: jest.fn(async () => ''),
}));
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  resolveRegistryModel: jest.fn(async () => null),
}));
// The store-backed mode row — mocked so no prisma boots here.
const mockStoreGet = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../memory/context-store', () => ({
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: jest.fn(async () => undefined),
}));

import axios from 'axios';
import { recordLoopMetric } from './loop-metrics.service';
import {
  DECISION_GATE_BACKEND_DOWN_KIND,
  clearDecisionAuthLatches,
  clearDecisionBackendCache,
  clearDecisionMemo,
  probeDecisionSpec,
  setDecisionBackendDownAlerter,
  type DecisionBackendDownAlert,
} from './decision-gate';

const post = (axios as any).post as jest.Mock;
const mockRecordLoopMetric = jest.fn();
const mockRecordLoopMetrics = jest.fn();
const ENV_KEYS = ['DECISION_GATE_DISABLED', 'DECISION_GATE_DEFAULT_MODE', 'DECISION_GATE_AUTH_LATCH_MS', 'DECISION_GATE_MEMO_TTL_MS',
  'TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL', 'TYPESAFE_MODEL', 'DEEPSEEK_API_KEY'];
const saved: Record<string, string | undefined> = {};
/** Every loop_metrics row this process recorded, in order (decision rows and backend-down rows interleave). */
const rowsOf = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]);
const alerts: DecisionBackendDownAlert[] = [];

/** The vendor's real 401 body shape (ticket 638ff4ae): TypeSafe answers
 *  {"detail":{"error_type":"authentication_error","message":"Cannot authenticate…"}}. */
const authRejected = () => ({
  response: {
    status: 401,
    data: { detail: { error_type: 'authentication_error', message: 'Cannot authenticate with the server. Please check your API key and try again.' } },
  },
  message: 'Cannot authenticate with the server. Please check your API key and try again.',
});
/** A healthy /systemone answer to the probe's fixed sanity questions (noul + choice). */
const jevSanityBody = () => ({
  data: {
    model: 'jev-1.13.0',
    answers: {
      refund: { noul: 0.98 },
      team: { choice: 'billing', probabilities: { billing: 0.91, technical: 0.06, sales: 0.03 }, confidence: 1 },
    },
    usage: { input_tokens: 5 },
  },
});

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  // Hermeticity contract (2026-09-24): the BARE decision-gate default is 'off'
  // under NODE_ENV='test'. This suite exercises the gate through the 'probe'
  // purpose (always 'act'), and pins the documented override for gate-exercising
  // suites anyway so a later purpose change cannot silence it.
  process.env.DECISION_GATE_DEFAULT_MODE = 'shadow';
  post.mockReset();
  mockRecordLoopMetric.mockReset();
  mockRecordLoopMetrics.mockReset();
  mockStoreGet.mockReset();
  mockStoreGet.mockResolvedValue(null);
  alerts.length = 0;
  setDecisionBackendDownAlerter(async (a) => { alerts.push(a); });
  clearDecisionBackendCache();
  clearDecisionAuthLatches();
  clearDecisionMemo();
});
afterEach(() => {
  setDecisionBackendDownAlerter(null);
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('probeDecisionSpec — mishap 59185759 replay: a 3× HTTP-401 streak on the decision/jev seat', () => {
  it('every spec-pinned probe CALLS the revoked-key backend (the latch never skips the admin probe), fails ok:false with the exact tool-facing text, and never leaks the key', async () => {
    process.env.TYPESAFE_API_KEY = 'fixture-prerotation-revoked';
    post.mockRejectedValue(authRejected());
    for (let i = 1; i <= 3; i++) {
      const r = await probeDecisionSpec('jev');
      expect(r.ok).toBe(false);
      expect(r.target).toBe('built-in TypeSafe Jev (jev)');
      // Ticket c013c318 (2026-10-27): the tester now renders the REAL captured leg
      // error (scrubbed per-leg text from decide()'s onAllLegsFailed) instead of
      // the dead "see the backend log line" message — the HTTP status is IN the
      // tool-facing answer.
      expect(r.error).toBe('TypeSafe Jev did not answer — TypeSafe Jev: HTTP 401 Cannot authenticate with the server. Please check your API key and try again. body: {"detail":{"error_type":"authentication_error","message":"Cannot authenticate with the server. Please check your API key and try again."}}');
      expect(typeof r.latencyMs).toBe('number');
      // Spec-pinned asks always call — one real HTTP POST per probe, no chain, no 401 retry (only 429/529 retry).
      expect(post).toHaveBeenCalledTimes(i);
    }
    // The backend log line the error points at: one decision_gate row per ask, naming the 401.
    const gateRows = rowsOf().filter((r) => r.kind === 'decision_gate');
    expect(gateRows).toHaveLength(3);
    for (const row of gateRows) {
      expect(row.meta).toMatchObject({ purpose: 'probe', ok: false });
      expect(row.meta.legErrors).toEqual([expect.stringContaining('TypeSafe Jev: HTTP 401')]);
    }
    // The metric trail the outage left behind: latched once, relatched per further failed probe.
    const downRows = rowsOf().filter((r) => r.kind === DECISION_GATE_BACKEND_DOWN_KIND);
    expect(downRows.map((r) => r.meta.event)).toEqual(['latched', 'relatched', 'relatched']);
    for (const row of downRows) expect(row.meta).toMatchObject({ spec: 'jev', backend: 'TypeSafe Jev', status: 401, purpose: 'probe' });
    // A probe is its own evidence on the admin's screen: no all_legs_failed row, no backend-down alert.
    expect(rowsOf().some((r) => r.meta?.event === 'all_legs_failed')).toBe(false);
    expect(alerts).toHaveLength(0);
    // Secret hygiene: the revoked key never reaches a row, a leg error or the failure text.
    expect(JSON.stringify(rowsOf())).not.toContain('fixture-prerotation-revoked');
    expect(JSON.stringify(alerts)).not.toContain('fixture-prerotation-revoked');
  });

  it('recovery in the same process (the rotated key answers): ok:true with the sanity detail, and the latch episode closes with a recovered row', async () => {
    process.env.TYPESAFE_API_KEY = 'fixture-rotated-key';
    post.mockRejectedValueOnce(authRejected());   // the outage: vendor rejects the old key
    const down = await probeDecisionSpec('jev');
    expect(down.ok).toBe(false);
    post.mockResolvedValueOnce(jevSanityBody());  // the rotated key serves
    const r = await probeDecisionSpec('jev');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('built-in TypeSafe Jev (jev)');
    expect(r.detail).toMatch(/TypeSafe Jev answered in \d+ ms — refund noul 0\.98, team "billing" \(confidence 1\.00\)/);
    expect(r.detail).not.toContain('NOTE'); // the sanity answers are right — no mis-served-model warning
    // The probe (spec-pinned) is the natural recovery witness: it writes the 'recovered' row the boxes tile clears on.
    const downRows = rowsOf().filter((row) => row.kind === DECISION_GATE_BACKEND_DOWN_KIND);
    expect(downRows.map((row) => row.meta.event)).toEqual(['latched', 'recovered']);
    expect(downRows[1].meta).toMatchObject({ spec: 'jev', backend: 'TypeSafe Jev' });
  });

  it('the two CONFIG answers are distinct from a backend failure: the kill switch, and a keyless instance — both ok:false with latencyMs 0 and zero HTTP calls', async () => {
    process.env.DECISION_GATE_DISABLED = '1';
    expect(await probeDecisionSpec('jev')).toMatchObject({
      ok: false, target: 'built-in TypeSafe Jev (jev)', latencyMs: 0,
      error: 'DECISION_GATE_DISABLED is set on this instance — the gate makes no calls.',
    });
    delete process.env.DECISION_GATE_DISABLED;
    // No TYPESAFE_API_KEY on this instance (beforeEach deleted it): a config answer, not "did not answer".
    expect(await probeDecisionSpec('jev')).toMatchObject({
      ok: false, target: 'built-in TypeSafe Jev (jev)', latencyMs: 0,
      error: '"jev" needs the TYPESAFE_API_KEY environment variable, which is not set on this instance.',
    });
    expect(post).not.toHaveBeenCalled();
    expect(rowsOf()).toHaveLength(0); // no backend was ever asked — nothing to record
  });
});
