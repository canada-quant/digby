/**
 * SAA-1.1 PHASE 1 (todo eb328629) — DETERMINISTIC MULTI-PROJECT REPLAY FIXTURES.
 *
 * WHY THIS FILE EXISTS. Phase 1's gate is "zero false-suppressions on events
 * labelled as needing to run", and the owner's 2026-11-03 clarification forbids
 * waiting for production diversity to supply that evidence (live volume,
 * calendar soak and a minimum resolved-batch count are explicitly NOT gates).
 * The measured corpus proves the point: the 14-day replay on box A covered
 * 4,018 recorded rows across 497 source chats but only TWO distinct projects —
 * so a gate that leaned on production would be testing the same two tenants
 * forever. These fixtures supply the missing DIVERSITY deterministically.
 *
 * The recorded-event replay (scripts/framework-audit/probe-saa1-phase1-replay.js,
 * run against the live DB) proves the policy on REAL rows. This file proves it on
 * rows production does not happen to contain — multiple projects, mixed batches,
 * every covered event type, adversarial orderings — with no DB and no clock.
 *
 * THE THREE GATES PINNED HERE:
 *  1. ZERO FALSE-SUPPRESSIONS. No event labelled as needing to run may ever
 *     reach `ignore`, in any project, in any mixture.
 *  2. ROUTINE TYPES STAY ROUTINE. `todo_done` and `schedule_near_cap` still
 *     reach `ignore` when genuinely quiet — the guard must not strand the very
 *     class the policy exists to quiet.
 *  3. MUTATION IS ADMISSION DATA, NOT HINDSIGHT. A `run_completed` whose source
 *     run mutated (or could not be ruled out) stays `candidate`, so it never
 *     enters the precision denominator at all.
 *
 * Everything here is pure: fixed NOW, fixed ids, fixed payloads. No Date.now()
 * outside NOW, no I/O, no env beyond what a case states.
 */

import {
  decideHookSourcePolicy,
  attributeSuppression,
  suppressionPrecision,
  POLICY_COVERED_EVENT_TYPES,
  ROUTINE_EVENT_TYPES,
  HOOK_SOURCE_REASONS,
  type HookSourcePolicyRow,
} from './hook-source-policy';

const NOW = new Date('2026-11-03T20:00:00Z').getTime();
const MIN = 60_000;

/**
 * The event types that mean "a model may genuinely be needed". Deliberately
 * written as a literal list rather than `POLICY_COVERED - ROUTINE`, because a
 * derived list would silently absorb a future type added to the covered set —
 * and silently absorbing is the failure mode this gate exists to prevent.
 */
const NEEDS_TO_RUN: ReadonlyArray<string> = [
  'run_failed',
  'attention_needed',
  'goal_blocked',
  'schedule_cap_skipped',
  'schedule_disabled',
  'ci_failed',
];

/** A project's identity travels in the payload's sourceChatId — the only lane key the policy reads. */
interface ProjectCase {
  project: string;
  sourceChatId: string;
  /** What the batch's rows look like. */
  rows: HookSourcePolicyRow[];
  /** `sourceRunMutated` as the caller established it (tri-state, honestly). */
  mutated?: boolean | null;
  /** The caller's alarm verdict. */
  alarm?: boolean;
  /** Independent of alarm: the triage code flags the caller computed. */
  flags?: Record<string, unknown> | null;
}

function r(
  eventType: string,
  sourceChatId: string,
  over: { id?: string; ageMin?: number; summary?: string } = {},
): HookSourcePolicyRow {
  return {
    id: over.id ?? `${eventType}-${sourceChatId}-${over.ageMin ?? 5}`,
    eventType,
    payload: {
      eventType,
      sourceChatId,
      summary: over.summary ?? `${eventType} in ${sourceChatId}`,
    },
    createdAt: new Date(NOW - (over.ageMin ?? 5) * MIN),
  };
}

/**
 * FOUR PROJECTS, DELIBERATELY DIFFERENT. Production shows two; the matrix covers
 * four tenants with different shapes (a quiet fleet lane, a busy multi-lane
 * project, a project whose run mutated, and a brand-new project with no history)
 * so no PASS can come from one tenant's habits.
 */
const PROJECTS: ReadonlyArray<ProjectCase> = [
  // ── Project ALPHA: the quiet case the policy is FOR. One lane, routine only,
  //    and its run is provably quiet — this is the ONLY shape allowed to ignore.
  {
    project: 'alpha',
    sourceChatId: 'alpha-lane-1',
    rows: [r('run_completed', 'alpha-lane-1', { id: 'a1000001' })],
    mutated: false,
  },
  {
    project: 'alpha',
    sourceChatId: 'alpha-lane-1',
    rows: [r('todo_done', 'alpha-lane-1', { id: 'a1000002' })],
    mutated: null, // todo_done carries no receipts; the guard must not strand it
  },
  {
    project: 'alpha',
    sourceChatId: 'alpha-lane-1',
    rows: [r('schedule_near_cap', 'alpha-lane-1', { id: 'a1000003' })],
    mutated: null,
  },

  // ── Project BETA: same routine shapes, but the run MUTATED. Must not ignore.
  {
    project: 'beta',
    sourceChatId: 'beta-lane-1',
    rows: [r('run_completed', 'beta-lane-1', { id: 'b2000001' })],
    mutated: true,
  },
  {
    project: 'beta',
    sourceChatId: 'beta-lane-1',
    rows: [r('run_completed', 'beta-lane-1', { id: 'b2000002' })],
    mutated: null, // could not rule it out ⇒ unsafe to suppress
  },

  // ── Project GAMMA: the needed-run classes, one project per mix.
  ...NEEDS_TO_RUN.map((et, i) => ({
    project: 'gamma',
    sourceChatId: 'gamma-lane-1',
    rows: [r(et, 'gamma-lane-1', { id: `c30000${String(i).padStart(2, '0')}` })],
    mutated: false,
    alarm: et === 'attention_needed' || et === 'run_failed' || et === 'goal_blocked' || et === 'schedule_disabled',
  })),

  // ── Project DELTA: MIXED batches — the precedence test. A quiet run_completed
  //    riding beside something that needs to run must NOT be suppressed on the
  //    strength of its quiet half.
  {
    project: 'delta',
    sourceChatId: 'delta-lane-1',
    rows: [r('run_completed', 'delta-lane-1', { id: 'd4000001' }), r('run_failed', 'delta-lane-1', { id: 'd4000002' })],
    mutated: false,
    alarm: true,
  },
  {
    project: 'delta',
    sourceChatId: 'delta-lane-1',
    rows: [r('todo_done', 'delta-lane-1', { id: 'd4000003' }), r('goal_blocked', 'delta-lane-1', { id: 'd4000004' })],
    mutated: null,
  },
  {
    project: 'delta',
    sourceChatId: 'delta-lane-1',
    rows: [r('schedule_near_cap', 'delta-lane-1', { id: 'd4000005' }), r('ci_failed', 'delta-lane-1', { id: 'd4000006' })],
    mutated: null,
  },
  // Multi-source routine: quiet on every axis but spread across lanes ⇒ candidate.
  {
    project: 'delta',
    sourceChatId: 'delta-lane-1',
    rows: [r('todo_done', 'delta-lane-1', { id: 'd4000007' }), r('todo_done', 'delta-lane-2', { id: 'd4000008' })],
    mutated: null,
    flags: { distinct_sources: 2 },
  },

  // ── New project with an UNCOVERED type (todo_wake): must fail safe.
  {
    project: 'epsilon',
    sourceChatId: 'epsilon-lane-1',
    rows: [r('todo_wake', 'epsilon-lane-1', { id: 'e5000001' })],
    mutated: null,
  },

  // ── Stale routine: staleness is never permission to drop.
  {
    project: 'epsilon',
    sourceChatId: 'epsilon-lane-1',
    rows: [r('todo_done', 'epsilon-lane-1', { id: 'e5000002', ageMin: 60 * 24 })],
    mutated: null,
  },
];

/** Run one fixture exactly as the emit path does, with alarm defaulting to the case's own value. */
function decide(c: ProjectCase, env: NodeJS.ProcessEnv = {}) {
  return decideHookSourcePolicy(
    {
      rows: c.rows,
      alarm: c.alarm === true,
      flags: (c.flags as never) ?? null,
      sourceRunMutated: c.mutated ?? null,
      now: NOW,
    },
    env,
  );
}

describe('SAA-1.1 Phase 1 · multi-project fixtures — the corpus production does not have', () => {
  it('covers at least four distinct projects, so no verdict rests on one tenant', () => {
    const projects = new Set(PROJECTS.map((c) => c.project));
    expect(projects.size).toBeGreaterThanOrEqual(4);
  });

  it('covers every event type the policy is allowed to make a claim about', () => {
    const seen = new Set<string>();
    for (const c of PROJECTS) for (const row of c.rows) seen.add(String(row.eventType));
    for (const covered of POLICY_COVERED_EVENT_TYPES) {
      expect(seen.has(covered)).toBe(true);
    }
  });
});

describe('SAA-1.1 Phase 1 · GATE 1 — zero false-suppressions on needed-run labels', () => {
  it('NO batch containing a needs-to-run type ever reaches ignore — in any project', () => {
    const offenders: Array<{ project: string; kinds: unknown; reason: string }> = [];
    for (const c of PROJECTS) {
      const d = decide(c);
      const kinds = Object.keys(d.kinds ?? {});
      const carriesNeeded = kinds.some((k) => NEEDS_TO_RUN.includes(k));
      if (carriesNeeded && d.decision === 'ignore') {
        offenders.push({ project: c.project, kinds: d.kinds, reason: d.reason });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('holds even when the caller MIS-REPORTS alarm=false on an alarm-class batch', () => {
    // The strictest possible caller: it never says "alarm". The policy must still
    // refuse to suppress, because precedence reads the flags/type, not just alarm.
    const offenders: string[] = [];
    for (const c of PROJECTS) {
      const d = decide({ ...c, alarm: false });
      const carriesNeeded = Object.keys(d.kinds ?? {}).some((k) => NEEDS_TO_RUN.includes(k));
      if (carriesNeeded && d.decision === 'ignore') offenders.push(c.project);
    }
    expect(offenders).toEqual([]);
  });

  it('an UNCOVERED event type is never suppressed, even on a quiet-looking project', () => {
    const c = PROJECTS.find((p) => p.rows.some((row) => row.eventType === 'todo_wake'))!;
    expect(decide(c).decision).not.toBe('ignore');
  });

  it('a stale batch is never suppressed (staleness is not permission to drop)', () => {
    const stale = PROJECTS.find((p) => p.rows.some((row) => (row as any).createdAt && p.sourceChatId === 'epsilon-lane-1' && (row.id as string) === 'e5000002'))!;
    expect(decide(stale).decision).toBe('candidate');
    expect(decide(stale).reason).toBe('stale_batch');
  });
});

describe('SAA-1.1 Phase 1 · GATE 2 — todo_done / schedule_near_cap stay quietable', () => {
  it('a lone quiet todo_done still reaches ignore', () => {
    const c = PROJECTS.find((p) => (p.rows[0].id as string) === 'a1000002')!;
    const d = decide(c);
    expect(d.decision).toBe('ignore');
    expect(d.reason).toBe('routine_completion');
  });

  it('a lone quiet schedule_near_cap still reaches ignore', () => {
    const c = PROJECTS.find((p) => (p.rows[0].id as string) === 'a1000003')!;
    const d = decide(c);
    expect(d.decision).toBe('ignore');
    expect(d.reason).toBe('routine_completion');
  });

  it('BOTH routine types are in the routine set — the guard cannot silently widen', () => {
    expect(ROUTINE_EVENT_TYPES.has('todo_done')).toBe(true);
    expect(ROUTINE_EVENT_TYPES.has('schedule_near_cap')).toBe(true);
    // And nothing that needs to run is in it.
    for (const t of NEEDS_TO_RUN) expect(ROUTINE_EVENT_TYPES.has(t)).toBe(false);
  });
});

describe('SAA-1.1 Phase 1 · GATE 3 — mutation is admission data, so it never reaches precision', () => {
  it('a run_completed whose run MUTATED is a candidate, never an ignore', () => {
    const c = PROJECTS.find((p) => (p.rows[0].id as string) === 'b2000001')!;
    const d = decide(c);
    expect(d.decision).toBe('candidate');
    expect(d.reason).toBe('source_run_mutated');
  });

  it('UNKNOWN mutation is treated exactly like mutated (we could not rule it out)', () => {
    const c = PROJECTS.find((p) => (p.rows[0].id as string) === 'b2000002')!;
    expect(decide(c).decision).toBe('candidate');
    expect(decide(c).reason).toBe('source_run_mutated');
  });

  it('ONLY the provably-quiet run may ignore — across the whole fixture set', () => {
    for (const c of PROJECTS) {
      const d = decide(c);
      if (d.decision !== 'ignore') continue;
      const kinds = Object.keys(d.kinds ?? {});
      if (kinds.includes('run_completed')) {
        // If a run_completed ever ignores, the caller must have PROVEN quiet.
        expect(c.mutated).toBe(false);
      }
    }
  });

  it('so a mutation-bearing batch contributes NOTHING to the precision denominator', () => {
    // Turn each fixture into the (decision, later-label) pair the grader consumes.
    // An ignore with no harness label is `unresolved` and is EXCLUDED — the trap
    // this pins is that "never ran" must never be counted as "correctly held".
    const decisions = PROJECTS.map((c) => ({ c, d: decide(c) }));
    const ignores = decisions.filter(({ d }) => d.decision === 'ignore');

    for (const { c, d } of ignores) {
      const kinds = Object.keys(d.kinds ?? {});
      // A run_completed MAY ignore — but only when the caller PROVED the run
      // quiet. (An earlier version of this test asserted it could never ignore,
      // which is the opposite of the guard: a provably quiet run is exactly the
      // case §262-276 permits. The rule is the mutation STATE, not the type.)
      if (kinds.includes('run_completed')) {
        expect(c.mutated).toBe(false);
      }
      expect(c.mutated).not.toBe(true);
    }

    // And the mutation-bearing fixtures specifically never produced an ignore.
    for (const { c, d } of decisions) {
      if (c.mutated === true || (c.mutated == null && (c.rows ?? []).some((row) => row.eventType === 'run_completed'))) {
        expect(d.decision).not.toBe('ignore');
      }
    }

    // Unresolved labels ⇒ null precision, never 1.0.
    const verdicts = ignores.map(() => attributeSuppression(null));
    expect(verdicts.every((v) => v === 'unresolved')).toBe(true);
    expect(suppressionPrecision(verdicts)).toBeNull();
    expect(suppressionPrecision([])).toBeNull();
  });

  it('precision is a real ratio only when labels resolve, and unresolved is excluded', () => {
    expect(suppressionPrecision(['would_hold', 'would_hold'])).toBe(1);
    expect(suppressionPrecision(['would_hold', 'would_lose'])).toBe(0.5);
    expect(suppressionPrecision(['unresolved', 'would_lose'])).toBe(0);
    expect(suppressionPrecision(['unresolved'])).toBeNull();
  });
});

describe('SAA-1.1 Phase 1 · the OBSERVE-ONLY verdict, pinned on the fixtures', () => {
  it('every fixture decision is applied:false and mode:observe with the switch absent', () => {
    for (const c of PROJECTS) {
      const d = decide(c, {});
      expect(d.applied).toBe(false);
      expect(d.mode).toBe('observe');
    }
  });

  it('a SET-EMPTY switch value is still OBSERVE-ONLY (only 1/true/on disable)', () => {
    // Measured live this run: HOOK_SOURCE_POLICY_DISABLED="" on the serving box.
    // The helper matches only 1/true/on, so empty keeps observing — the verdict
    // must not be read as "unset == disabled" or "set == disabled".
    for (const val of ['', ' ', '0', 'false', 'off', 'no']) {
      const d = decide(PROJECTS[0], { HOOK_SOURCE_POLICY_DISABLED: val } as NodeJS.ProcessEnv);
      expect(d.mode).toBe('observe');
    }
  });

  it('the switch ON claims nothing: candidate/unclassified and mode off, for EVERY fixture', () => {
    for (const c of PROJECTS) {
      const d = decide(c, { HOOK_SOURCE_POLICY_DISABLED: '1' } as NodeJS.ProcessEnv);
      expect(d.mode).toBe('off');
      expect(d.decision).toBe('candidate');
      expect(d.reason).toBe('unclassified');
      expect(d.applied).toBe(false);
    }
  });

  it('every reason observed across the fixtures is in the closed vocabulary', () => {
    for (const c of PROJECTS) {
      expect(HOOK_SOURCE_REASONS).toContain(decide(c).reason);
    }
  });
});

describe('SAA-1.1 Phase 1 · the fixture matrix is a FLOOR, not an opinion', () => {
  it('reports what the fixtures actually produce, so a future widening is visible', () => {
    const tally = { respond: 0, candidate: 0, ignore: 0 };
    for (const c of PROJECTS) tally[decide(c).decision] += 1;
    // Shape assertions only — deliberately not exact counts, so adding a project
    // case does not break the suite for a non-regression.
    expect(tally.ignore).toBeGreaterThan(0); // the routine class is still quietable
    expect(tally.respond + tally.candidate).toBeGreaterThan(tally.ignore); // safety dominates
  });
});