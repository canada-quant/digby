/**
 * Depth UX seam contract — the SERVER half (compute policy, 2026-09-26). The
 * client suite (frontend/lib/depth-ux-contract.test.ts) proves the client READS
 * exactly the names in frontend/lib/depth-ux-contract.json; this suite proves
 * the harness WRITES them — the SSE event type + states, the fixed progress
 * keys + their field, the chip kinds + field names, the next-rung vocabulary,
 * the request param and the persisted metadata keys. A rename on either side
 * fails CI here instead of failing silently on the wire.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate', COMPUTE_POLICY: 'compute_policy', UX_TTFT: 'ux_ttft' },
  recordLoopMetric: jest.fn(),
}));
jest.mock('../platform/supervisor.service', () => ({ __esModule: true, classifySupervisorNote: () => 'supervisor_note' }));
import * as fs from 'fs';
import * as path from 'path';
import {
  CHECK_STATES, PROGRESS_KEYS, ETA_TEXT, keyedProgress, depthChipFor, checkStateForLateOutcome, depthMetadataFor, escalationPlan, attachGuestStateChips,
} from './compute-policy-wiring';
import { streamQuerySchema } from '../crossmodel.validation';
import { presetPlan } from '../platform/compute-policy-gate';
import { depthBudgetFor } from '../platform/depth-budget';

const FIXTURE = path.resolve(__dirname, '../../../../../frontend/lib/depth-ux-contract.json');
const contract = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as {
  sse: {
    checkStateEvent: string; checkStates: string[]; checkStateFields: Record<string, string>;
    progressEvent: string; progressKeyField: string; progressKeys: string[];
    chipsField: string; chipsCarriers: string[]; chipKinds: string[]; escalateChipFields: Record<string, string>; nextRungs: string[];
    depthField: string; depthCarriers: string[];
  };
  request: { escalationParam: string };
  assistantMetadata: Record<string, string>;
  userMetadata: Record<string, string>;
  pollWhile: { legacyFlag: string; checkState: string };
  machineOrigins: string[];
};

const SERVICE_SRC = fs.readFileSync(path.resolve(__dirname, 'chat-agent.service.ts'), 'utf8');
const MSG = '11111111-1111-4111-8111-111111111111';

describe('depth-ux seam contract — the harness writes the fixture\'s names', () => {
  it('check_state: the event type and the state vocabulary', () => {
    expect(contract.sse.checkStateEvent).toBe('check_state');
    expect([...CHECK_STATES].sort()).toEqual([...contract.sse.checkStates].sort());
    // the payload the harness sends carries exactly the fixture's field names
    const updated = checkStateForLateOutcome('revised', ['price 12 → 14']);
    expect(Object.keys(updated).sort()).toEqual([contract.sse.checkStateFields.state, contract.sse.checkStateFields.changed].sort());
    expect(SERVICE_SRC).toContain(`send('${contract.sse.checkStateEvent}', checkState)`);
    // 'revisionId' rides the late-crosscheck payload under the fixture's name
    expect(contract.sse.checkStateFields.revisionId).toBe('revisionId');
    expect(contract.pollWhile.checkState).toBe('checking');
    expect(CHECK_STATES).toContain(contract.pollWhile.checkState);
  });

  it('progress: the FIXED key set rides data.key with server-side text (never model prose)', () => {
    expect(contract.sse.progressEvent).toBe('progress');
    expect([...PROGRESS_KEYS].sort()).toEqual([...contract.sse.progressKeys].sort());
    for (const key of PROGRESS_KEYS) {
      const p = keyedProgress(key);
      expect(p[contract.sse.progressKeyField]).toBe(key);
      expect(typeof p.message).toBe('string');
      expect(p.message.length).toBeGreaterThan(0);
    }
  });

  it('chips: kinds, the escalate chip\'s field names, the rung vocabulary, and the carriers', () => {
    const escalate = depthChipFor({ guest: false, machine: false, messageId: MSG, nextRung: 'verify' })!;
    const signin = depthChipFor({ guest: true, machine: false, messageId: null, nextRung: null })!;
    expect([escalate.kind, signin.kind].sort()).toEqual([...contract.sse.chipKinds].sort());
    const f = contract.sse.escalateChipFields;
    expect(Object.keys(escalate).sort()).toEqual(Object.values(f).sort());
    expect((escalate as any)[f.escalationOf]).toBe(MSG);
    expect((escalate as any)[f.nextRung]).toBe('verify');
    expect(typeof (escalate as any)[f.etaText]).toBe('string');
    expect(Object.keys(ETA_TEXT).sort()).toEqual([...contract.sse.nextRungs].sort());
    // chips ride the followups event AND the complete payload under the fixture's field
    for (const carrier of contract.sse.chipsCarriers) {
      expect(SERVICE_SRC).toMatch(new RegExp(`send\\('${carrier}', \\{[\\s\\S]{0,240}?${contract.sse.chipsField}: liveChips`));
    }
    // machine runs never get a chip; a guest gets the sign-in affordance
    expect(depthChipFor({ guest: false, machine: true, messageId: MSG, nextRung: 'verify' })).toBeNull();
  });

  it('depth: the complete payload carries the persisted metadata.depth under the fixture\'s field (audit sse-ui-restore-14)', () => {
    expect(contract.sse.depthField).toBe('depth');
    expect(contract.sse.depthCarriers).toEqual(['complete']);
    // the SAME object the row persists (`depth: depthMetadataFor(` above) rides the complete frame
    expect(SERVICE_SRC).toMatch(new RegExp(`send\\('complete', \\{[\\s\\S]{0,700}?\\n\\s+${contract.sse.depthField}: metadata\\.depth,`));
  });

  it('guest state: attachGuestStateChips pins the guest chip on the LAST assistant message only (the reloaded tab hydrates the same control)', () => {
    const history = [
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
    ];
    const out = attachGuestStateChips(history, { disabled: false });
    expect(out[1]).toEqual({ role: 'assistant', content: 'a1' });
    expect(out[3]).toEqual({ role: 'assistant', content: 'a2', chips: [{ kind: 'signin_deeper', label: 'Sign in for a deeper look' }] });
    expect(out[0]).toBe(history[0]);
    expect(attachGuestStateChips(history, { disabled: true })).toBe(history);
    expect(attachGuestStateChips([{ role: 'user', content: 'q' }], { disabled: false })).toEqual([{ role: 'user', content: 'q' }]);
    expect(attachGuestStateChips([], { disabled: false })).toEqual([]);
  });

  it('request: the stream schema accepts the fixture\'s escalation param (uuid) and refuses garbage', () => {
    const param = contract.request.escalationParam;
    expect(param).toBe('escalationOf');
    const ok = streamQuerySchema.safeParse({ query: { message: 'x', [param]: MSG } });
    expect(ok.success).toBe(true);
    expect((ok as any).data.query[param]).toBe(MSG);
    expect(streamQuerySchema.safeParse({ query: { message: 'x', [param]: 'not-a-uuid' } }).success).toBe(false);
  });

  it('assistant metadata: check / depth / chips / origin are the persisted keys; the escalation echo + legacy flag too', () => {
    const m = contract.assistantMetadata;
    expect(m).toEqual({ check: 'check', depth: 'depth', chips: 'chips', origin: 'origin' });
    // depthMetadataFor is what lands under metadata.depth
    const plan = presetPlan('thinking');
    const depth = depthMetadataFor(plan, depthBudgetFor(plan));
    expect(depth.plan).toMatchObject({ preset: 'thinking', spawnChecker: true, checkerWaitMs: 0, council: 'none', source: 'preset' });
    expect(SERVICE_SRC).toMatch(/\n\s+depth: depthMetadataFor\(/);
    expect(SERVICE_SRC).toMatch(/check: \{ \.\.\.checkState, at: /);
    expect(SERVICE_SRC).toMatch(/\{ chips \}/);
    expect(SERVICE_SRC).toContain(`${contract.pollWhile.legacyFlag}: true`);
    expect(SERVICE_SRC).toContain(`${contract.userMetadata.escalationOf}: args.escalation.ofMessageId`);
  });

  it('escalation plans carry the rung the budget reads', () => {
    expect(escalationPlan('verify', 90_000)).toMatchObject({ source: 'escalation', rung: 'verify', spawnChecker: true, checkerWaitMs: 90_000 });
    expect(escalationPlan('research', 90_000)).toMatchObject({ source: 'escalation', rung: 'research', council: 'background' });
    expect(depthBudgetFor(escalationPlan('verify', 90_000))).toMatchObject({ checker: true, council: false });
    expect(depthBudgetFor(escalationPlan('research', 90_000))).toMatchObject({ checker: false, council: true });
  });

  it('machine origins: the harness stamps one of the fixture\'s origins on machine rows', () => {
    for (const origin of contract.machineOrigins) expect(typeof origin).toBe('string');
    expect(contract.machineOrigins).toEqual(['schedule', 'hook', 'machine', 'agent', 'webhook']);
    expect(SERVICE_SRC).toContain("origin: args.messageOrigin && args.messageOrigin !== 'user' ? args.messageOrigin : 'machine'");
  });
});
