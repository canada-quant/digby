/**
 * SAA-1.1 PHASE 1 (todo eb328629) — the deterministic trigger-admission policy.
 *
 * These pin the THREE things that make an observe-only suppression emitter
 * worth its name, and they are the same three Phase 0 got wrong the first time:
 *
 *  1. OBSERVE-ONLY BY TYPE. `applied` is the literal `false`, so no call site
 *     can read a decision as a suppression. A `@ts-expect-error` proves the type
 *     actually rejects an apply — not that we remembered not to write one.
 *  2. The FAIL-SAFE is the default. Anything the policy cannot classify is
 *     `candidate`, which is exactly today's behaviour, so a bug here cannot
 *     suppress a wake that should have run.
 *  3. The LATER LABEL is a harness fact, never a model claim — and an
 *     unresolved batch is EXCLUDED from precision rather than counted as a win.
 *     That last one is the trap: counting "never ran" as "correctly held" would
 *     make a broken emitter look like a perfect policy.
 */

import {
  HOOK_SOURCE_POLICY_OBSERVE,
  HOOK_SOURCE_POLICY_MAX_IGNORE_AGE_MIN,
  ROUTINE_EVENT_TYPES,
  POLICY_COVERED_EVENT_TYPES,
  HOOK_SOURCE_REASONS,
  decideHookSourcePolicy,
  hookSourcePolicyDisabled,
  hookSourcePolicyMetricMeta,
  attributeSuppression,
  suppressionPrecision,
  type HookSourcePolicyRow,
  type HookSourcePolicyInput,
} from './hook-source-policy';
import { LOOP_METRIC_KINDS } from './loop-metric-kinds';

const NOW = new Date('2026-11-02T20:00:00Z').getTime();
const MIN = 60_000;

function row(over: Partial<HookSourcePolicyRow> & { summary?: string } = {}): HookSourcePolicyRow {
  const { summary, ...rest } = over;
  return {
    id: 'abcdef12-3456-7890-abcd-ef1234567890',
    eventType: 'run_completed',
    payload: { eventType: 'run_completed', sourceChatId: 'chat-0001', summary: summary ?? 'Coding run completed.' },
    createdAt: new Date(NOW - 5 * MIN),
    ...rest,
  };
}

const flags = (over: Record<string, unknown> = {}) => ({
  any_row_is_question_or_request: false,
  any_row_addressed_to_supervisor: false,
  any_row_reports_failure_or_block: false,
  any_row_guard_replaced_final: false,
  any_row_owner_facing: false,
  distinct_sources: 1,
  ...over,
});

/**
 * Test helper: `alarm` is REQUIRED on the real input (so a production caller
 * cannot forget it), but every case here means "not alarm-class" except where
 * it says otherwise — so default it false and let each case state only what it
 * is actually about.
 */
const saa = (
  input: Omit<HookSourcePolicyInput, 'alarm'> & { alarm?: boolean },
  env: NodeJS.ProcessEnv = {},
) => decideHookSourcePolicy({ alarm: false, ...input }, env);

describe('SAA-1.1 observe-only is a TYPE invariant, not a promise', () => {
  it('every decision carries applied:false, whichever way it went', () => {
    const paths = [
      saa({ rows: [row()], flags: flags(), now: NOW }, {}),
      saa({ rows: [row()], alarm: true, flags: flags(), now: NOW }, {}),
      saa({ rows: [row()], flags: flags({ any_row_reports_failure_or_block: true }), now: NOW }, {}),
      saa({ rows: [], flags: flags(), now: NOW }, {}),
    ];
    for (const d of paths) expect(d.applied).toBe(false);
  });

  it('the type REFUSES an applied suppression (@ts-expect-error, not a comment)', () => {
    const d = saa({ rows: [row()], flags: flags(), now: NOW }, {});
    // @ts-expect-error — applied is the literal false; no call site can set it true
    const bad: true = d.applied;
    void bad;
  });

  it('the metric kind is REGISTERED (a kind the telemetry reader does not know reads as known:false)', () => {
    expect(HOOK_SOURCE_POLICY_OBSERVE).toBe('hook_source_policy_observe');
    expect(LOOP_METRIC_KINDS.HOOK_SOURCE_POLICY_OBSERVE).toBe(HOOK_SOURCE_POLICY_OBSERVE);
  });
});

describe('SAA-1.1 kill switch — off is off, and it claims nothing', () => {
  it.each(['1', 'true', 'on', ' TRUE '])('HOOK_SOURCE_POLICY_DISABLED=%p disables', (v) => {
    expect(hookSourcePolicyDisabled({ HOOK_SOURCE_POLICY_DISABLED: v })).toBe(true);
  });
  it.each(['', '0', 'false', 'off', undefined])('%p leaves it observing', (v) => {
    expect(hookSourcePolicyDisabled({ HOOK_SOURCE_POLICY_DISABLED: v as any })).toBe(false);
  });

  it('under the switch the verdict is candidate/unclassified and NO metric row is written', () => {
    const d = saa({ rows: [row()], flags: flags(), now: NOW }, { HOOK_SOURCE_POLICY_DISABLED: '1' });
    expect(d.mode).toBe('off');
    expect(d.decision).toBe('candidate');
    expect(hookSourcePolicyMetricMeta(d)).toBeNull();
  });
});

describe('SAA-1.1 precedence — a mixed batch can never be ignored on its quiet half', () => {
  it('an alarm row wins over a routine row in the SAME batch', () => {
    const d = saa(
      {
        rows: [row(), row({ id: 'b', eventType: 'attention_needed' })],
        alarm: true,
        flags: flags({ distinct_sources: 1 }),
        now: NOW,
      },
      {},
    );
    expect(d.decision).toBe('respond');
    expect(d.reason).toBe('alarm_class');
  });

  // The FLAG KEY is the full `any_row_…` name. Spelling it bare in the table
  // silently set nothing and the batch fell through to `ignore` — caught here
  // because the assertion is on the DECISION, not on `reason` alone.
  it.each([
    ['any_row_guard_replaced_final', 'guard_replaced_final'],
    ['any_row_reports_failure_or_block', 'failure_or_block'],
    ['any_row_owner_facing', 'owner_facing'],
    ['any_row_is_question_or_request', 'question_or_request'],
  ])('%s ⇒ respond (%s), even on a routine_completed batch', (flag, reason) => {
    const d = saa({ rows: [row()], flags: flags({ [flag]: true }), now: NOW }, {});
    expect(d.decision).toBe('respond');
    expect(d.reason).toBe(reason);
  });

  it('a report-up is a CANDIDATE, not a respond — the class wake-cadence-5 stopped waking for', () => {
    const d = saa({ rows: [row()], flags: flags({ any_row_addressed_to_supervisor: true }), now: NOW }, {});
    expect(d.decision).toBe('candidate');
    expect(d.reason).toBe('addressed_to_supervisor');
  });
});

describe('SAA-1.1 fail-safe — anything unclassifiable is today\'s behaviour', () => {
  it('an empty batch is a candidate, not an ignore', () => {
    const d = saa({ rows: [], flags: flags(), now: NOW }, {});
    expect(d.decision).toBe('candidate');
  });

  it('an event type the policy does not cover keeps the whole batch a candidate', () => {
    // A future event type must OPT IN, never be swept into `ignore`.
    const d = saa({ rows: [row({ eventType: 'brand_new_event' })], flags: flags(), now: NOW }, {});
    expect(d.decision).toBe('candidate');
    expect(d.reason).toBe('unclassified');
    expect(POLICY_COVERED_EVENT_TYPES.has('brand_new_event')).toBe(false);
  });

  it('one non-routine row keeps a covered batch a candidate', () => {
    const d = saa(
      { rows: [row(), row({ id: 'b', eventType: 'schedule_cap_skipped' })], flags: flags(), now: NOW },
      {},
    );
    expect(d.decision).toBe('candidate');
    expect(ROUTINE_EVENT_TYPES.has('schedule_cap_skipped')).toBe(false);
  });

  it('a stale batch is never ignored — staleness is not permission to drop', () => {
    const old = row({ createdAt: new Date(NOW - (HOOK_SOURCE_POLICY_MAX_IGNORE_AGE_MIN + 60) * MIN) });
    // sourceRunMutated:false isolates the STALENESS rule — otherwise the (earlier,
    // also-candidate) source-run guard answers first and this never exercises it.
    const d = saa({ rows: [old], flags: flags(), sourceRunMutated: false, now: NOW }, {});
    expect(d.decision).toBe('candidate');
    expect(d.reason).toBe('stale_batch');
  });

  it('a multi-source routine batch is a candidate, a single-source one is an ignore', () => {
    // SAA-1.1 Phase 1 (2026-11-03): a run_completed batch is only ignorable when
    // the source run is PROVABLY quiet — `sourceRunMutated: false`. The batch
    // shape alone no longer earns an ignore (see the source-run mutation tests).
    const one = saa({ rows: [row()], flags: flags({ distinct_sources: 1 }), sourceRunMutated: false, now: NOW }, {});
    expect(one.decision).toBe('ignore');
    expect(one.reason).toBe('routine_completion');
    const many = saa({ rows: [row(), row({ id: 'b' })], flags: flags({ distinct_sources: 3 }), sourceRunMutated: false, now: NOW }, {});
    expect(many.decision).toBe('candidate');
    expect(many.reason).toBe('routine_multi_source');
  });

  // ── SAA-1.1 Phase 1 (2026-11-03): THE SOURCE-RUN MUTATION GUARD ──────────
  // Measured defect: hook 15ba91cf sent the same lone run_completed into the same
  // chat twice; one wake mutated four things, the other did not, and both
  // summaries read identically. The summary cannot separate them — the run's own
  // tool receipts can, and they exist before the wake is processed.
  describe('a run_completed batch is ignorable only when its run is provably quiet', () => {
    it('a run that MUTATED is never ignored', () => {
      const d = saa({ rows: [row()], flags: flags(), sourceRunMutated: true, now: NOW }, {});
      expect(d.decision).toBe('candidate');
      expect(d.reason).toBe('source_run_mutated');
    });

    it('UNKNOWN (null/absent) is treated like mutated — we could not rule it out', () => {
      const absent = saa({ rows: [row()], flags: flags(), now: NOW }, {});
      expect(absent.decision).toBe('candidate');
      expect(absent.reason).toBe('source_run_mutated');
      const explicitNull = saa({ rows: [row()], flags: flags(), sourceRunMutated: null, now: NOW }, {});
      expect(explicitNull.decision).toBe('candidate');
      expect(explicitNull.reason).toBe('source_run_mutated');
    });

    it('only an explicit false reaches the ignore', () => {
      const d = saa({ rows: [row()], flags: flags(), sourceRunMutated: false, now: NOW }, {});
      expect(d.decision).toBe('ignore');
      expect(d.reason).toBe('routine_completion');
    });

    it('the guard is scoped to run_completed — a quiet todo_done batch still ignores', () => {
      // todo_done carries no source-run receipts, so the guard must not strand it.
      const d = saa({
        rows: [row({ eventType: 'todo_done', payload: { eventType: 'todo_done', sourceChatId: 'chat-0001', summary: 'done' } })],
        flags: flags(), sourceRunMutated: true, now: NOW,
      }, {});
      expect(d.decision).toBe('ignore');
      expect(d.reason).toBe('routine_completion');
    });

    it('the mutation reason is in the closed vocabulary', () => {
      expect(HOOK_SOURCE_REASONS).toContain('source_run_mutated');
    });
  });

  it('a malformed row cannot throw the emit path', () => {
    expect(() => saa({ rows: [null as any, {}, { payload: 'nonsense' as any }], flags: null, now: NOW }, {})).not.toThrow();
  });
});

describe('SAA-1.1 the metric row carries counts and ids, never the prose', () => {
  it('meta is null for a candidate (the fail-safe writes nothing)', () => {
    const d = saa({ rows: [row()], flags: flags({ any_row_addressed_to_supervisor: true }), now: NOW }, {});
    expect(hookSourcePolicyMetricMeta(d)).toBeNull();
  });

  it('an ignore batch writes the documented key shape and no prose', () => {
    const secret = 'ROUTINE PROSE THAT MUST NOT BE IN THE ROW';
    // sourceRunMutated:false = a provably quiet source run, which is the ONLY
    // state in which an ignore (and therefore a meta row) exists at all now.
    const d = saa({ rows: [row({ summary: secret })], flags: flags(), sourceRunMutated: false, now: NOW }, {});
    const meta: any = hookSourcePolicyMetricMeta(d);
    expect(meta).not.toBeNull();
    expect(Object.keys(meta).sort()).toEqual(['decision', 'ids', 'kinds', 'reason', 'rows', 'sources']);
    expect(meta).toMatchObject({ decision: 'ignore', reason: 'routine_completion', rows: 1, sources: 1 });
    // The house rule: a telemetry row must not carry the object it measured.
    expect(JSON.stringify(meta)).not.toContain(secret);
    expect(meta.ids[0]).toHaveLength(8);
  });

  it('a respond batch is recorded too — the false-negative side needs it', () => {
    const d = saa({ rows: [row()], alarm: true, flags: flags(), now: NOW }, {});
    const meta: any = hookSourcePolicyMetricMeta(d);
    expect(meta).toMatchObject({ decision: 'respond', reason: 'alarm_class' });
  });

  it('every reason the policy can emit is in the closed vocabulary', () => {
    const seen = new Set<string>();
    const cases = [
      saa({ rows: [row()], alarm: true, flags: flags(), now: NOW }, {}),
      saa({ rows: [row()], flags: flags({ any_row_guard_replaced_final: true }), now: NOW }, {}),
      saa({ rows: [row()], flags: flags({ any_row_reports_failure_or_block: true }), now: NOW }, {}),
      saa({ rows: [row()], flags: flags({ any_row_owner_facing: true }), now: NOW }, {}),
      saa({ rows: [row()], flags: flags({ any_row_is_question_or_request: true }), now: NOW }, {}),
      saa({ rows: [row()], flags: flags({ any_row_addressed_to_supervisor: true }), now: NOW }, {}),
      saa({ rows: [row()], flags: flags(), now: NOW }, {}),
      saa({ rows: [row(), row({ id: 'b' })], flags: flags({ distinct_sources: 2 }), now: NOW }, {}),
      saa({ rows: [row({ createdAt: new Date(NOW - 10_000 * MIN) })], flags: flags(), now: NOW }, {}),
      saa({ rows: [row({ eventType: 'weird' })], flags: flags(), now: NOW }, {}),
    ];
    for (const d of cases) seen.add(d.reason);
    for (const r of seen) expect(HOOK_SOURCE_REASONS).toContain(r);
    // and the sample actually exercised most of them
    expect(seen.size).toBeGreaterThanOrEqual(8);
  });
});

describe('SAA-1.1 the LATER label — harness verdict, and unresolved is NOT a success', () => {
  it('acted ⇒ would_lose; not acted ⇒ would_hold; never delivered ⇒ unresolved', () => {
    expect(attributeSuppression({ delivered: true, acted: true })).toBe('would_lose');
    expect(attributeSuppression({ delivered: true, acted: false })).toBe('would_hold');
    expect(attributeSuppression({ delivered: false, acted: false })).toBe('unresolved');
    expect(attributeSuppression(null)).toBe('unresolved');
  });

  it('THE TRAP: unresolved batches are EXCLUDED from precision, never counted as correct', () => {
    // A batch that never ran proves nothing. Counting it as "correctly held"
    // would make a broken emitter look like a perfect policy.
    expect(suppressionPrecision(['would_hold', 'unresolved', 'unresolved'])).toBe(1);
    expect(suppressionPrecision(['would_hold', 'would_lose', 'unresolved'])).toBe(0.5);
  });

  it('an empty or all-unresolved window returns null, never 1.0 and never 0', () => {
    expect(suppressionPrecision([])).toBeNull();
    expect(suppressionPrecision(['unresolved', 'unresolved'])).toBeNull();
  });
});