/**
 * Pure functions of the finish_run SHADOW readout (scripts/framework-audit/finish-run-readout.js,
 * build 2026-10-08 F): the per-seat "valid finish within one nudge" bar (Wilson 95 %), the
 * agreement cells per detector + detector-only per 200 valid finishes, and the deterministic BLIND
 * rejection sample. The probe is plain CommonJS (it runs from /app inside the backend container),
 * so it is required by path here.
 */

import path from 'path';

const probe: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'finish-run-readout.js'));

const row = (seat: string, source: string, valid: boolean, extra: Record<string, unknown> = {}) => ({
  id: `${seat}-${source}-${Math.random()}`, sessionId: 'chat12345678', runId: null, createdAt: '2026-10-09T10:00:00Z',
  meta: { seat, source, valid, offered: true, nudge: { outcome: source === 'model' ? 'not_needed' : source === 'nudged' ? 'called' : 'prose', ms: source === 'model' ? undefined : 1200 }, claims: 1, verified: valid ? 1 : 0, unverified: valid ? 0 : 1, ...extra },
});

describe('finish-run-readout — the per-seat bar', () => {
  it('valid within one nudge = (model | nudged) ∧ valid; auto-finished runs count against the seat', () => {
    const rows = [
      ...Array.from({ length: 19 }, () => row('glm-5.3', 'model', true, { stepsAfterCall: 1, callToEndMs: 30_000 })),
      row('glm-5.3', 'nudged', false, { rejected: [{ type: 'pr_opened', ref: '67', reason: 'no_receipt' }] }),
      row('kimi-k3', 'nudged', true), row('kimi-k3', 'auto', false),
    ];
    const out = probe.aggregate(rows);
    expect(out.seats['glm-5.3'].validWithinOneNudge).toMatchObject({ k: 19, n: 20, p: 0.95 });
    expect(out.seats['glm-5.3'].meetsBar).toBe(true);
    expect(out.seats['glm-5.3'].meetsBarAtLowerBound).toBe(false); // n=20 is not enough evidence
    expect(out.seats['glm-5.3'].rejectReasons).toEqual({ no_receipt: 1 });
    expect(out.seats['glm-5.3']).toMatchObject({ stepsAfterCallP50: 1, callToEndMsP50: 30_000 });
    expect(out.seats['kimi-k3'].validWithinOneNudge).toMatchObject({ k: 1, n: 2, p: 0.5 });
    expect(out.seats['kimi-k3'].source).toEqual({ nudged: 1, auto: 1 });
    expect(out.allSeatsMeetBar).toBe(false);
    expect(probe.wilson(0, 0)).toEqual({ k: 0, n: 0, p: null, lo: null, hi: null });
  });
});

describe('finish-run-readout — type repairs (build 2026-10-09 FR)', () => {
  it('a repaired finish counts as valid; its repairs are tallied from->to, parse-repair strings are ignored', () => {
    const out = probe.aggregate([
      row('kimi-k3', 'nudged', true, { claims: 2, verified: 0, unverified: 0, repaired: 2, repairs: ['trailing_commas', { from: 'ticket_update', to: 'state_update', ref: 'save_supervisor_state', reason: 'wrong_type' }, { from: 'ticket_update', to: 'message_sent', ref: '82613275', reason: 'wrong_type' }] }),
      row('kimi-k3', 'nudged', false, { repaired: 1, repairs: [{ from: 'ticket_update', to: 'state_update', ref: 'daee2916', reason: 'wrong_type' }], rejected: [{ type: 'schedule_armed', ref: '06eb2bf9', reason: 'observed_only', suggestType: 'verify' }] }),
    ]);
    expect(out.seats['kimi-k3']).toMatchObject({ repaired: 3, typeRepairs: { 'ticket_update->state_update': 2, 'ticket_update->message_sent': 1 }, rejectReasons: { observed_only: 1 } });
    expect(out.seats['kimi-k3'].validWithinOneNudge).toMatchObject({ k: 1, n: 2 });
  });
});

describe('finish-run-readout — agreement', () => {
  it('cells per detector, and detector-only convictions per 200 VALID finishes', () => {
    const a = probe.agreement([
      { meta: { detector: 'evidence_guard', cell: 'both_clean' } },
      { meta: { detector: 'evidence_guard', cell: 'both_clean' } },
      { meta: { detector: 'evidence_guard', cell: 'both_clean' } },
      { meta: { detector: 'evidence_guard', cell: 'detector_only', detectorKinds: ['future_dated'] } },
      { meta: { detector: 'action_verifier', cell: 'finish_only', finishRejectedTypes: ['ticket_update'] } },
    ]);
    expect(a.evidence_guard).toMatchObject({ rows: 4, validFinishes: 4, detectorOnlyPer200ValidFinishes: 50, detectorKinds: { future_dated: 1 } });
    expect(a.action_verifier).toMatchObject({ rows: 1, validFinishes: 0, detectorOnlyPer200ValidFinishes: null, finishOnlyTypes: { ticket_update: 1 } });
  });
});

describe('finish-run-readout — the blind rejection sample', () => {
  it('one entry per rejected claim, deterministic, capped, with no detector verdict and an empty label', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: `r${i}`, sessionId: `chat${i}abcdefgh`, runId: `run${i}xyz`, createdAt: '2026-10-09T10:00:00Z',
      meta: { seat: 'glm-5.3', source: 'model', rejected: [{ type: 'push', ref: `abc${i}def0`, reason: 'no_receipt', originCheckable: true, nearest: ['aaaa1111 git_push sha=ff'] }, { type: 'pr_opened', ref: String(i), reason: 'wrong_type', suggestType: 'pr_merged' }] },
    }));
    const a = probe.blindSample(rows, 50);
    const b = probe.blindSample(rows, 50);
    expect(a.rejectedClaims).toBe(60);
    expect(a.sample).toHaveLength(50);
    expect(a.sample).toEqual(b.sample); // deterministic
    expect(a.sample[0]).toEqual(expect.objectContaining({ label: null, seat: 'glm-5.3', chat: expect.any(String), reason: expect.any(String) }));
    expect(JSON.stringify(a.sample)).not.toContain('detector');
  });
});
