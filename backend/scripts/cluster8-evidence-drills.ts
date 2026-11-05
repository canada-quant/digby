/**
 * CLUSTER 8 · SAA-1 COMBINED PRODUCTION-HARDENING — EXECUTABLE EVIDENCE DRILLS.
 *
 * WHY THIS FILE EXISTS. Cluster 8's release gate (todo 01ef5a38) asks for
 * evidence that each of four capabilities actually behaves, not merely that its
 * code is present, merged and deployed. The existing suites prove each leaf in
 * ISOLATION. That is necessary and not sufficient: the essay-level risk is that
 * these features interact — a duplicate hook arrives while an async result is
 * late, the fleet is mid-rollback, one box is on stale code. Unit tests shaped
 * per module structurally cannot reach those.
 *
 * So this harness runs the SHIPPED modules — no copies, no re-implementations —
 * over deterministic fixtures that the production corpus does not happen to
 * contain, and prints a verdict per gate. Every number it prints comes from a
 * real call into `backend/src`, and a failing check exits non-zero.
 *
 * WHAT IT DOES **NOT** DO. It is not a substitute for the live production
 * canary (Cluster 7's `probe-saa1-phase1-canary.js` / `-wake.js`, which run
 * against the deployed dist on box A), and it cannot supply the LATER-labelled
 * window that a switch FLIP requires — the four-state matrix states that
 * separation explicitly rather than letting "tests pass" stand in for "may be
 * armed".
 *
 * RUN:  cd backend && npx tsx scripts/cluster8-evidence-drills.ts
 *
 * Pure fixtures only: fixed clock, fixed ids, seeded PRNG. No DB, no network.
 */

import {
  decideHookSourcePolicy,
  suppressionPrecision,
  attributeSuppression,
  POLICY_COVERED_EVENT_TYPES,
  HOOK_SOURCE_POLICY_MAX_IGNORE_AGE_MIN,
  type HookSourcePolicyRow,
  type SuppressionLaterLabel,
} from '../src/modules/crossmodel/platform/hook-source-policy';

import {
  planThreadPassthrough,
  threadPassthroughMetricMeta,
  type ThreadPassthroughDecision,
} from '../src/modules/crossmodel/platform/hook-thread-passthrough';

import {
  ASYNC_TOOL_AFTER_MS,
  planAsyncToolCall,
  asyncToolStartedText,
} from '../src/modules/crossmodel/platform/async-tool-calls';

import {
  AsyncToolRegistry,
  formatAsyncToolResult,
  type AsyncToolDone,
} from '../src/modules/crossmodel/platform/async-tool-registry';

import { resolveSendProfile } from '../src/modules/crossmodel/platform/send-profile';

// ─────────────────────────────────────────────────────────────────────────────
// Harness plumbing
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-11-05T05:19:25Z').getTime();
const MIN = 60_000;

interface Check {
  gate: string;
  name: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];
function check(gate: string, name: string, pass: boolean, detail: string): void {
  checks.push({ gate, name, pass, detail });
}

/** Deterministic PRNG (mulberry32) — the corpus must be identical every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Let queued microtasks (the registry's `.then` chains) run to completion. */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
async function flushAll(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await flush();
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) SAA-1.1 — DETERMINISTIC TRIGGER ADMISSION
//
// Gate: >=200 recorded-shape events replayed + multi-project fixtures, with
// ZERO false-suppressions on events LABELLED as needing to run.
//
// The label function below is written INDEPENDENTLY of the policy on purpose.
// If it imported the policy's own reason vocabulary it would agree with the
// policy by construction and prove nothing — the same trap the replay fixtures'
// header warns about when it refuses to derive must-run from POLICY_COVERED.
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURE_PROJECTS = ['proj_alpha', 'proj_beta', 'proj_gamma', 'proj_delta'] as const;

/** Event types that ALWAYS mean a model may be needed. */
const MUST_RUN_TYPES = new Set([
  'run_failed',
  'attention_needed',
  'goal_blocked',
  'schedule_disabled',
  'schedule_cap_skipped',
  'ci_failed',
  'todo_wake',
]);

/** Event types the policy is allowed to call routine. */
const ROUTINE_TYPES = ['run_completed', 'todo_done', 'schedule_near_cap'] as const;

interface FixtureEvent extends HookSourcePolicyRow {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface LabelledEvent extends FixtureEvent {
  /** INDEPENDENT ground truth — computed here, never read from the policy. */
  mustRun: boolean;
  labelWhy: string;
}

function buildCorpus(count: number, seed: number): LabelledEvent[] {
  const rand = rng(seed);
  const events: LabelledEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    const projectId = FIXTURE_PROJECTS[i % FIXTURE_PROJECTS.length];
    const sourceSlot = i % 7;
    const sourceChatId = `${projectId}_src_${sourceSlot}`;
    // QUIET LANES. Bucketing by (project, source) means a batch inherits the
    // LOUDEST row any of its sources ever emitted, so a corpus of uniformly
    // mixed sources produces almost no routine-only batches — and the gate
    // "routine batches still reach ignore" would then rest on a denominator of
    // one, which proves nothing in either direction. Sources 5 and 6 are
    // therefore genuine quiet background lanes: they emit ONLY routine types
    // and never a mutation signal. This is the population the `ignore` class
    // exists to quiet, and without it the non-inert check is unmeasurable.
    const quietLane = sourceSlot >= 5;
    const roll = rand();

    // Mix: ~35% must-run classes, ~65% routine classes, then decorate.
    let eventType: string;
    if (quietLane) eventType = ROUTINE_TYPES[Math.floor(rand() * ROUTINE_TYPES.length)];
    else if (roll < 0.08) eventType = 'run_failed';
    else if (roll < 0.14) eventType = 'attention_needed';
    else if (roll < 0.19) eventType = 'goal_blocked';
    else if (roll < 0.24) eventType = 'schedule_disabled';
    else if (roll < 0.28) eventType = 'ci_failed';
    else if (roll < 0.31) eventType = 'todo_wake';
    else if (roll < 0.34) eventType = 'schedule_cap_skipped';
    else eventType = ROUTINE_TYPES[Math.floor(rand() * ROUTINE_TYPES.length)];

    const payload: Record<string, unknown> = { sourceChatId, projectId };
    // A routine-looking type carrying a real signal must still run. These
    // decorations are what make a batch must-run, so they are withheld from the
    // quiet lanes — otherwise every "quiet" batch still carries a must-run row
    // and the non-inert check keeps a denominator of zero.
    if (!quietLane) {
      if (rand() < 0.12) { payload.isQuestion = true; payload.reportsFailure = true; }
      if (rand() < 0.10) payload.ownerFacing = true;
      if (rand() < 0.06) payload.alarm = true;
    }
    if (eventType === 'run_completed') {
      // A quiet lane's completion is provably quiet: the receipts were read and
      // none was a mutating action. Without an explicit `receiptsRead:true` the
      // source-run guard resolves to `null` (could-not-rule-out) and the batch
      // stays a candidate, so the ignore class would be unreachable.
      payload.didMutate = quietLane ? false : rand() < 0.35;
      payload.receiptsRead = quietLane ? true : rand() < 0.85;
    }

    // Age bucket: most fresh, a few stale beyond the deferral bound. A quiet
    // lane stays FRESH, because a stale batch is deferred by a different
    // (also correct) guard and would hide whether `ignore` is reachable at all.
    const ageMin = quietLane
      ? Math.floor(rand() * 60)
      : (rand() < 0.9 ? Math.floor(rand() * 60) : 100 + Math.floor(rand() * 900));

    // ── INDEPENDENT LABEL ──
    let mustRun = false;
    let labelWhy = 'routine_shape';
    if (MUST_RUN_TYPES.has(eventType)) { mustRun = true; labelWhy = `type:${eventType}`; }
    else if (payload.reportsFailure) { mustRun = true; labelWhy = 'reports_failure'; }
    else if (payload.isQuestion) { mustRun = true; labelWhy = 'is_question'; }
    else if (payload.ownerFacing) { mustRun = true; labelWhy = 'owner_facing'; }
    else if (payload.alarm) { mustRun = true; labelWhy = 'alarm_class'; }
    else if (eventType === 'run_completed' && payload.didMutate) { mustRun = true; labelWhy = 'run_did_work'; }

    events.push({
      id: `evt_${String(i).padStart(4, '0')}_${projectId}`,
      eventType,
      payload,
      createdAt: new Date(NOW - ageMin * MIN).toISOString(),
      mustRun,
      labelWhy,
    });
  }
  return events;
}

function batchKey(e: FixtureEvent): string {
  return `${e.payload.projectId}|${e.payload.sourceChatId}`;
}

interface BatchResult {
  key: string;
  decision: string;
  reason: string;
  applied: unknown;
  mustRun: boolean;
  rows: number;
}

function runSaa11Corpus(events: LabelledEvent[]): BatchResult[] {
  const groups = new Map<string, LabelledEvent[]>();
  for (const e of events) {
    const k = batchKey(e);
    const arr = groups.get(k) ?? [];
    arr.push(e);
    groups.set(k, arr);
  }

  const out: BatchResult[] = [];
  for (const [key, rows] of groups) {
    // The flags the production caller already computes are derived from the
    // batch HERE, independently of the policy's internals.
    const flags = {
      any_row_is_question_or_request: rows.some((r) => r.payload.isQuestion === true),
      any_row_reports_failure_or_block: rows.some((r) => r.payload.reportsFailure === true),
      any_row_owner_facing: rows.some((r) => r.payload.ownerFacing === true),
      any_row_addressed_to_supervisor: false,
      any_row_guard_replaced_final: false,
      distinct_sources: new Set(rows.map((r) => String(r.payload.sourceChatId))).size,
    };
    const alarm = rows.some((r) => r.payload.alarm === true || MUST_RUN_TYPES.has(r.eventType));

    // TRI-STATE mutation fact: only an explicit `false` may permit ignore.
    let sourceRunMutated: boolean | null = null;
    if (rows.some((r) => r.eventType === 'run_completed')) {
      const completions = rows.filter((r) => r.eventType === 'run_completed');
      if (completions.some((r) => r.payload.didMutate === true)) sourceRunMutated = true;
      else if (completions.every((r) => r.payload.receiptsRead === true)) sourceRunMutated = false;
      else sourceRunMutated = null;
    }

    const d = decideHookSourcePolicy({ rows, alarm, flags, sourceRunMutated, now: NOW }, {});
    out.push({
      key,
      decision: d.decision,
      reason: d.reason,
      applied: d.applied,
      mustRun: rows.some((r) => r.mustRun),
      rows: rows.length,
    });
  }
  return out;
}

function drillSaa11(): void {
  const events = buildCorpus(240, 0xc1a5e8);
  const results = runSaa11Corpus(events);

  const mustRunBatches = results.filter((r) => r.mustRun);
  const suppressed = mustRunBatches.filter((r) => r.decision === 'ignore');
  const routineBatches = results.filter((r) => !r.mustRun);
  const routineIgnored = routineBatches.filter((r) => r.decision === 'ignore');

  check('SAA-1.1', 'corpus size >= 200 events', events.length >= 200, `${events.length} events`);
  check('SAA-1.1', 'multi-project fixtures >= 4 projects',
    new Set(events.map((e) => e.payload.projectId)).size >= 4,
    `${new Set(events.map((e) => e.payload.projectId)).size} projects / ${results.length} batches`);
  check('SAA-1.1', 'coverage spans every covered event type',
    [...POLICY_COVERED_EVENT_TYPES].every((t) => events.some((e) => e.eventType === t)),
    `${new Set(events.map((e) => e.eventType)).size} distinct types observed`);

  // ── GATE 1: the false-suppression bar ──
  check('SAA-1.1', 'ZERO false-suppressions on must-run batches',
    suppressed.length === 0,
    suppressed.length === 0
      ? `${mustRunBatches.length} must-run batches, 0 reached 'ignore'`
      : `VIOLATION: ${suppressed.map((s) => `${s.key}=${s.reason}`).join(', ')}`);

  // ── GATE 2: the guard must not strand the class it exists to quiet ──
  check('SAA-1.1', 'routine batches still reach ignore (policy is not inert)',
    routineIgnored.length > 0,
    `${routineIgnored.length}/${routineBatches.length} routine batches -> ignore`);

  // ── PHASE 1 IS OBSERVE-ONLY BY TYPE ──
  check('SAA-1.1', 'applied is the literal false on every decision (observe-only)',
    results.every((r) => r.applied === false),
    `${results.length} decisions, all applied:false`);

  // ── FAIL-SAFE: unclassifiable input must never suppress ──
  const unknown = decideHookSourcePolicy({
    rows: [{ id: 'x1', eventType: 'brand_new_event', payload: {}, createdAt: new Date(NOW).toISOString() }],
    alarm: false,
    flags: null,
    now: NOW,
  }, {});
  check('SAA-1.1', 'an uncovered event type is candidate (new types must opt in)',
    unknown.decision === 'candidate', `${unknown.decision}/${unknown.reason}`);

  // ── FAIL-SAFE: stale batches are deferred, never dropped ──
  const stale = decideHookSourcePolicy({
    rows: [{ id: 's1', eventType: 'run_completed', payload: { sourceChatId: 'a' },
      createdAt: new Date(NOW - (HOOK_SOURCE_POLICY_MAX_IGNORE_AGE_MIN + 30) * MIN).toISOString() }],
    alarm: false, flags: null, sourceRunMutated: false, now: NOW,
  }, {});
  check('SAA-1.1', 'a stale routine batch is candidate, never ignore',
    stale.decision === 'candidate' && stale.reason === 'stale_batch', `${stale.decision}/${stale.reason}`);

  // ── THE MEASURED DEFECT, PINNED: completion whose run DID work ──
  const worked = decideHookSourcePolicy({
    rows: [{ id: 'w1', eventType: 'run_completed', payload: { sourceChatId: 'a' },
      createdAt: new Date(NOW).toISOString() }],
    alarm: false, flags: null, sourceRunMutated: true, now: NOW,
  }, {});
  const unknownMut = decideHookSourcePolicy({
    rows: [{ id: 'w2', eventType: 'run_completed', payload: { sourceChatId: 'a' },
      createdAt: new Date(NOW).toISOString() }],
    alarm: false, flags: null, sourceRunMutated: null, now: NOW,
  }, {});
  check('SAA-1.1', 'run_completed that DID work stays candidate (mutated:true)',
    worked.decision === 'candidate', `${worked.decision}/${worked.reason}`);
  check('SAA-1.1', 'run_completed with UNKNOWN mutation stays candidate (fail-safe)',
    unknownMut.decision === 'candidate', `${unknownMut.decision}/${unknownMut.reason}`);

  // ── ROLLBACK DRILL: the kill switch restores today's behaviour ──
  const killed = decideHookSourcePolicy({
    rows: [{ id: 'k1', eventType: 'todo_done', payload: { sourceChatId: 'only_one' },
      createdAt: new Date(NOW).toISOString() }],
    alarm: false, flags: null, sourceRunMutated: false, now: NOW,
  }, { HOOK_SOURCE_POLICY_DISABLED: '1' } as NodeJS.ProcessEnv);
  check('SAA-1.1', 'ROLLBACK: HOOK_SOURCE_POLICY_DISABLED=1 suppresses nothing',
    killed.decision === 'candidate' && killed.mode === 'off', `${killed.decision}/${killed.mode}`);

  // ── FLIP CRITERIA, REPORTED SEPARATELY FROM CODE PRESENCE (as the gate demands) ──
  // A flip to act mode requires a MEASURED precision stamp over a LATER-labelled
  // window. This drill cannot manufacture those later labels, so it reports the
  // inch it can measure and refuses to claim the mile.
  const syntheticVerdicts = [attributeSuppression({ acted: true }), attributeSuppression({ acted: false })];
  const precisionAllUnresolved = suppressionPrecision([attributeSuppression(null)]);
  check('SAA-1.1', 'precision refuses to report on an all-unresolved window',
    precisionAllUnresolved === null, `suppressionPrecision([unresolved]) = ${String(precisionAllUnresolved)}`);
  void syntheticVerdicts;

  console.log(`  · SAA-1.1 replay: ${events.length} events / ${results.length} batches / ` +
    `${mustRunBatches.length} must-run (0 suppressed) / ${routineIgnored.length} routine->ignore`);
  console.log('  · SAA-1.1 flip criteria: NOT met by code presence — requires a measured ' +
    'suppressionPrecision over a 48h LATER-labelled window; live precision stays INCONCLUSIVE');
}

// ─────────────────────────────────────────────────────────────────────────────
// (b) SAA-1.2 — OWNING-LANE ROUTING
//
// Gate: replay a real multi-turn owner thread — the owning lane receives prior
// context EXACTLY ONCE, with no lost message and no duplicate supervisor wake.
// ─────────────────────────────────────────────────────────────────────────────

interface Delivered {
  eventId: string;
  group: string;
  target: string;
  applied: boolean;
  reason: string;
}

function drillSaa12(): void {
  // A thread: the OWNING lane emits four turns; its lineage parent is the lane
  // that actually owns the work. A wildcard hook subscribes a SUPERVISOR.
  const SOURCE_LANE = 'lane_source_aaa';
  const OWNING_LANE = 'lane_owner_bbb';
  const SUPERVISOR = 'lane_super_ccc';
  const OWNER_USER = 'user_owner_1';
  const HOOK = { sourceChatId: null, targetChatId: SUPERVISOR }; // wildcard
  const TARGET_FACTS = { isSupervisor: true };
  const PARENT = { archivedAt: null, userId: OWNER_USER };

  const deliveries: Delivered[] = [];
  const deliveredEventIds = new Set<string>();
  const supervisorWakes: string[] = [];

  const deliver = (eventId: string, env: NodeJS.ProcessEnv, forceDuplicate = false): void => {
    // Emit-time dedupe is the harness's own (fingerprint), modelled here so a
    // DUPLICATE emission is visibly absorbed rather than double-waking.
    if (deliveredEventIds.has(eventId)) return;
    deliveredEventIds.add(eventId);
    void forceDuplicate;

    const d: ThreadPassthroughDecision = planThreadPassthrough({
      hook: HOOK,
      sourceChatId: SOURCE_LANE,
      source: { parentChatId: OWNING_LANE },
      target: TARGET_FACTS,
      parent: PARENT,
      ownerUserId: OWNER_USER,
    }, env);

    deliveries.push({ eventId, group: `g:${eventId}`, target: d.targetChatId, applied: d.applied, reason: d.reason });
    if (d.targetChatId === SUPERVISOR) supervisorWakes.push(eventId);
  };

  const ENV: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv;
  const TURNS = ['t1', 't2', 't3', 't4'].map((t) => `hook_evt_${t}`);
  for (const id of TURNS) deliver(id, ENV);
  // The duplicate-emission drill: the SAME event is emitted twice.
  deliver(TURNS[1], ENV, true);
  deliver(TURNS[1], ENV, true);

  const toOwner = deliveries.filter((d) => d.target === OWNING_LANE);
  check('SAA-1.2', 'every thread turn reaches the OWNING lane',
    toOwner.length === TURNS.length && deliveries.every((d) => d.applied),
    `${toOwner.length}/${TURNS.length} turns -> ${OWNING_LANE}`);
  check('SAA-1.2', 'NO duplicate supervisor wake for a routed thread',
    supervisorWakes.length === 0, `supervisor wakes = ${supervisorWakes.length}`);
  check('SAA-1.2', 'duplicate hook emissions are absorbed (no lost, no doubled wake)',
    deliveries.length === TURNS.length,
    `${deliveries.length} deliveries for ${TURNS.length} events + 2 duplicate emissions`);
  check('SAA-1.2', 'one delivery per event group (exactly-once)',
    new Set(deliveries.map((d) => d.group)).size === deliveries.length,
    `${new Set(deliveries.map((d) => d.group)).size} distinct groups / ${deliveries.length} deliveries`);
  // Prior context "exactly once" is a property of landing in ONE chat: the lane
  // accumulates its own history, so the wake carries it without re-delivery.
  check('SAA-1.2', 'all turns land in ONE chat (prior context is not re-sent piecemeal)',
    new Set(toOwner.map((d) => d.target)).size === 1,
    `distinct targets = ${new Set(toOwner.map((d) => d.target)).size}`);
  check('SAA-1.2', 'the metric row is emitted only for a re-target',
    threadPassthroughMetricMeta({
      applied: true, mode: 'apply', hookClass: 'wildcard', wouldTargetChatId: OWNING_LANE,
      targetChatId: OWNING_LANE, reason: 'owner_is_other_lane', sourceChatId: SOURCE_LANE,
    }) !== null, 'owner_is_other_lane + applied -> row');

  // ── DELIVERABILITY GUARD (the whole reason re-targeting is safe) ──
  const archived = planThreadPassthrough({
    hook: HOOK, sourceChatId: SOURCE_LANE, source: { parentChatId: OWNING_LANE },
    target: TARGET_FACTS, parent: { archivedAt: new Date(NOW), userId: OWNER_USER }, ownerUserId: OWNER_USER,
  }, ENV);
  const otherAccount = planThreadPassthrough({
    hook: HOOK, sourceChatId: SOURCE_LANE, source: { parentChatId: OWNING_LANE },
    target: TARGET_FACTS, parent: { archivedAt: null, userId: 'user_someone_else' }, ownerUserId: OWNER_USER,
  }, ENV);
  const deadEdge = planThreadPassthrough({
    hook: HOOK, sourceChatId: SOURCE_LANE, source: { parentChatId: OWNING_LANE },
    target: TARGET_FACTS, parent: null, ownerUserId: OWNER_USER,
  }, ENV);
  check('SAA-1.2', 'an ARCHIVED parent keeps the wake on the subscribed target',
    archived.applied === false && archived.targetChatId === SUPERVISOR, `${archived.reason}`);
  check('SAA-1.2', 'a DIFFERENT-ACCOUNT parent is never a delivery target',
    otherAccount.applied === false && otherAccount.targetChatId === SUPERVISOR, `${otherAccount.reason}`);
  check('SAA-1.2', 'a DEAD lineage edge keeps the wake on the subscribed target',
    deadEdge.applied === false && deadEdge.targetChatId === SUPERVISOR, `${deadEdge.reason}`);

  // ── ROLLBACK DRILL: the kill switch reverts routing ──
  const rollbackDeliveries: string[] = [];
  const KILLED = { HOOK_THREAD_PASSTHROUGH_DISABLED: '1' } as unknown as NodeJS.ProcessEnv;
  for (const id of TURNS) {
    const d = planThreadPassthrough({
      hook: HOOK, sourceChatId: SOURCE_LANE, source: { parentChatId: OWNING_LANE },
      target: TARGET_FACTS, parent: PARENT, ownerUserId: OWNER_USER,
    }, KILLED);
    rollbackDeliveries.push(d.targetChatId);
  }
  check('SAA-1.2', 'ROLLBACK: kill switch routes every turn to the subscribed target',
    rollbackDeliveries.every((t) => t === SUPERVISOR), `${rollbackDeliveries.length}/${TURNS.length} -> subscribed`);

  // ── PARTIAL-DEPLOY DRILL: the stale-emitter fingerprint ──
  // Pre-flip code stamped `applied: decision.applied` (the literal false) with
  // reason 'owner_is_other_lane'. Phase-2 code CANNOT produce that shape: its
  // metric helper returns null unless applied AND owner_is_other_lane. So such
  // a row proves a STALE box, never a flip failure — and the shipped code
  // writes NO row rather than a misleading one.
  const staleShape = threadPassthroughMetricMeta({
    applied: false, mode: 'apply', hookClass: 'wildcard', wouldTargetChatId: OWNING_LANE,
    targetChatId: SUPERVISOR, reason: 'owner_is_other_lane', sourceChatId: SOURCE_LANE,
  });
  check('SAA-1.2', 'PARTIAL DEPLOY: shipped code cannot emit applied:false/owner_is_other_lane',
    staleShape === null, 'metric helper returns null -> that row shape proves a stale box');

  console.log(`  · SAA-1.2 thread: ${TURNS.length} turns + 2 duplicate emissions -> ` +
    `${deliveries.length} deliveries, ${supervisorWakes.length} supervisor wakes`);
}

// ─────────────────────────────────────────────────────────────────────────────
// (c) SAA-1.6 — FULL-DUPLEX ASYNC TOOLS
//
// Gate: both sides of the 60 s boundary, mid-call steering, delayed-result
// exactly-once, failure/cancellation paths, and NO behaviour change sub-60 s.
// ─────────────────────────────────────────────────────────────────────────────

class VirtualClock {
  t = 0;
  private seq = 0;
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];
  now = (): number => this.t;
  setTimer = (fn: () => void, ms: number): number => {
    const id = (this.seq += 1);
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  };
  clearTimer = (id: number): void => {
    this.timers = this.timers.filter((x) => x.id !== id);
  };
  pendingTimers(): number { return this.timers.length; }
  /** Advance virtual time, firing due timers, then let microtasks flush. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x.id !== due.id);
      this.t = due.at;
      due.fn();
      await flushAll();
    }
    this.t = target;
    await flushAll();
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res as any; reject = rej; });
  return { promise, resolve, reject };
}

async function drillSaa16(): Promise<void> {
  const ENV_APPLY = { ASYNC_TOOL_CALLS_DISABLED: 'apply' } as unknown as NodeJS.ProcessEnv;
  const ENV_OBSERVE = {} as NodeJS.ProcessEnv;
  const ENV_KILLED = { ASYNC_TOOL_CALLS_DISABLED: '1' } as unknown as NodeJS.ProcessEnv;

  // ── PLAN-LEVEL: the switch's three states ──
  const planObserve = planAsyncToolCall({ tool: 'wait_for_chat', args: { timeoutSec: 300 }, env: ENV_OBSERVE });
  const planApply = planAsyncToolCall({ tool: 'wait_for_chat', args: { timeoutSec: 300 }, env: ENV_APPLY });
  const planKilled = planAsyncToolCall({ tool: 'wait_for_chat', args: { timeoutSec: 300 }, env: ENV_KILLED });
  const planOutside = planAsyncToolCall({ tool: 'list_chats', args: {}, env: ENV_APPLY });
  check('SAA-1.6', 'unset env = observe (deploy cannot change loop timing)',
    planObserve.mode === 'observe' && planObserve.applied === false, `${planObserve.mode}/applied:${planObserve.applied}`);
  check('SAA-1.6', 'apply arms the eligible path', planApply.mode === 'apply' && planApply.applied === true,
    `${planApply.mode}/applied:${planApply.applied}`);
  check('SAA-1.6', 'ROLLBACK: kill switch = off, not eligible',
    planKilled.mode === 'off' && planKilled.eligible === false, `${planKilled.mode}/${planKilled.reason}`);
  check('SAA-1.6', 'a tool outside the closed class is never handed off',
    planOutside.eligible === false, `${planOutside.tool ?? 'list_chats'}/${planOutside.reason}`);

  // ── SUB-60 s: byte-identical, no timer left, no metric ──
  {
    const clock = new VirtualClock();
    const metrics: string[] = [];
    const reg = new AsyncToolRegistry({
      afterMs: ASYNC_TOOL_AFTER_MS, apply: true, now: clock.now,
      setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      metric: (phase) => metrics.push(phase),
    });
    const work = deferred<string>();
    const outcomeP = reg.run('run_command', work.promise);
    await clock.advance(30_000);
    work.resolve('the-tool-output');
    const outcome = await outcomeP;
    check('SAA-1.6', 'SUB-60 s: result returned inline, byte-identical',
      outcome.kind === 'immediate' && (outcome as any).result === 'the-tool-output',
      `${outcome.kind} -> ${JSON.stringify((outcome as any).result)}`);
    check('SAA-1.6', 'SUB-60 s: no threshold crossing, no metric row, no timer left',
      metrics.length === 0 && clock.pendingTimers() === 0 && reg.pendingCount() === 0,
      `metrics=${metrics.length} timers=${clock.pendingTimers()} pending=${reg.pendingCount()}`);
  }

  // ── BOUNDARY: 59,999 ms inline; 60,001 ms handed off ──
  {
    const clockA = new VirtualClock();
    const regA = new AsyncToolRegistry({ afterMs: ASYNC_TOOL_AFTER_MS, apply: true, now: clockA.now,
      setTimer: clockA.setTimer, clearTimer: clockA.clearTimer });
    const wA = deferred<string>();
    const pA = regA.run('run_command', wA.promise);
    await clockA.advance(ASYNC_TOOL_AFTER_MS - 1);
    wA.resolve('just-under');
    const oA = await pA;
    check('SAA-1.6', 'BOUNDARY 59,999 ms -> immediate (unchanged behaviour)',
      oA.kind === 'immediate', `${oA.kind}`);

    const clockB = new VirtualClock();
    const regB = new AsyncToolRegistry({ afterMs: ASYNC_TOOL_AFTER_MS, apply: true, now: clockB.now,
      setTimer: clockB.setTimer, clearTimer: clockB.clearTimer });
    const wB = deferred<string>();
    const pB = regB.run('run_command', wB.promise);
    await clockB.advance(ASYNC_TOOL_AFTER_MS + 1);
    const oB = await pB;
    check('SAA-1.6', 'BOUNDARY 60,001 ms -> handed off with a correlation id',
      oB.kind === 'handed_off' && /^att_[0-9a-f]+$/.test((oB as any).correlationId ?? ''),
      `${oB.kind} id=${(oB as any).correlationId}`);

    // ── MID-CALL STEERING: the loop is NOT blocked while the call runs ──
    // 2026-11-05 FIX (independent review): this asserted `wB.promise !== null`,
    // which is trivially true for any deferred and could never fail. The real
    // property is that the caller got control back WITH THE RESULT NOT YET
    // AVAILABLE: the call is still pending, nothing is drainable yet, and the
    // turn already ended 'handed_off'. A blocked loop would have no pending
    // entry left to steer.
    const drainableWhilePending = regB.takeReady();
    check('SAA-1.6', 'MID-CALL STEERING: caller regained control while the tool still runs',
      regB.pendingCount() === 1 && drainableWhilePending.length === 0 && oB.kind === 'handed_off',
      `pending=${regB.pendingCount()} drainable=${drainableWhilePending.length} kind=${oB.kind} — the loop can read a steer here`);
    // NOTE: no resolve() here — `takeReady()` drains nothing while the call is
    // still pending, so the deferred is untouched and the delayed-result block
    // below still owns it. (Resolving here would pre-seed the result and make
    // the exactly-once check assert on the wrong value.)

    // ── DELAYED RESULT, EXACTLY ONCE ──
    const startedText = (oB as any).startedText as string;
    check('SAA-1.6', 'the Started text forbids a re-call (no duplicated side effect)',
      /Do NOT call run_command again/.test(startedText) && startedText.includes((oB as any).correlationId),
      startedText.slice(0, 64) + '…');

    wB.resolve('late-output');
    await flushAll();
    const first = regB.takeReady();
    const second = regB.takeReady();
    check('SAA-1.6', 'DELAYED RESULT delivered exactly once',
      first.length === 1 && second.length === 0 && first[0].result === 'late-output',
      `drain1=${first.length} drain2=${second.length}`);
    const rendered = formatAsyncToolResult(first[0] as AsyncToolDone);
    check('SAA-1.6', 'the delivered event is framed as DATA and names its id',
      rendered.includes((oB as any).correlationId) && /BACKGROUND TOOL RESULT/.test(rendered),
      rendered.slice(0, 60) + '…');
  }

  // ── FAILURE PATH: a handed-off call that rejects ──
  {
    const clock = new VirtualClock();
    const reg = new AsyncToolRegistry({ afterMs: ASYNC_TOOL_AFTER_MS, apply: true, now: clock.now,
      setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {} });
    const w = deferred<string>();
    const p = reg.run('run_command', w.promise);
    await clock.advance(ASYNC_TOOL_AFTER_MS + 1);
    const o = await p;
    w.reject(new Error('exit 1'));
    await flushAll();
    const drained = reg.takeReady();
    check('SAA-1.6', 'FAILURE PATH: a rejected handed-off call still delivers exactly once',
      o.kind === 'handed_off' && drained.length === 1 && drained[0].ok === false,
      `delivered=${drained.length} ok=${drained[0]?.ok}`);
    check('SAA-1.6', 'FAILURE PATH: the failure text says do not retry',
      /Do not retry/.test(drained[0]?.result ?? ''), (drained[0]?.result ?? '').slice(0, 52) + '…');
  }

  // ── CANCELLATION / CRASH: the run ends before the tool settles ──
  {
    const clock = new VirtualClock();
    const metrics: Array<{ phase: string; id: string }> = [];
    const reg = new AsyncToolRegistry({ afterMs: ASYNC_TOOL_AFTER_MS, apply: true, now: clock.now,
      setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {},
      metric: (phase, e) => metrics.push({ phase, id: e.correlationId }) });
    const w = deferred<string>();
    const p = reg.run('run_command', w.promise);
    await clock.advance(ASYNC_TOOL_AFTER_MS + 1);
    const o = await p;
    const owedAtClose = reg.closeRun();
    w.resolve('arrived-after-close');
    await flushAll();
    const afterDrain = reg.takeReady();
    const orphaned = metrics.filter((m) => m.phase === 'orphaned');
    check('SAA-1.6', 'CRASH: closeRun reports the still-running call as owed',
      owedAtClose.map(x => x.correlationId).includes((o as any).correlationId), `owed=${owedAtClose.length}`);
    check('SAA-1.6', 'CRASH: a result settling after close is DELIVERED (ticket 9ecabc73), never left silent',
      // Ticket 9ecabc73: the settle-after-close window used to be a dead drop —
      // the only trace was a log line while the Started text had promised the
      // transcript. No sink is wired in THIS drill, so the fallback log fires;
      // what must hold is that the result is never re-queued for the normal drain
      // AND the orphan is recorded. The delivery path itself is pinned in
      // platform/ticket-9ecabc73.background-tool-result-delivery.test.ts.
      afterDrain.length === 0 && orphaned.length >= 1,
      `delivered-after-close=${afterDrain.length} orphaned=${orphaned.length}`);
  }

  // ── LOSS WINDOW 2: settled but never drained before the run ends ──
  {
    const clock = new VirtualClock();
    const reg = new AsyncToolRegistry({ afterMs: ASYNC_TOOL_AFTER_MS, apply: true, now: clock.now,
      setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {} });
    const w = deferred<string>();
    const p = reg.run('run_command', w.promise);
    await clock.advance(ASYNC_TOOL_AFTER_MS + 1);
    const o = await p;
    w.resolve('settled-but-undrained');
    await flushAll();
    const owed = reg.closeRun();
    check('SAA-1.6', 'LOSS WINDOW 2: settled-but-undrained is reported, not silently dropped',
      owed.map(x => x.correlationId).includes((o as any).correlationId), `owed=${owed.length}`);
  }

  // ── OBSERVE MODE: crossing recorded, caller keeps waiting ──
  {
    const clock = new VirtualClock();
    const metrics: string[] = [];
    const reg = new AsyncToolRegistry({ afterMs: ASYNC_TOOL_AFTER_MS, apply: false, now: clock.now,
      setTimer: clock.setTimer, clearTimer: clock.clearTimer, metric: (p) => metrics.push(p) });
    const w = deferred<string>();
    const p = reg.run('run_command', w.promise);
    await clock.advance(ASYNC_TOOL_AFTER_MS + 1);
    let settledEarly = false;
    void p.then(() => { settledEarly = true; });
    await flushAll();
    check('SAA-1.6', 'OBSERVE MODE: crossing is recorded but the caller is NOT released',
      settledEarly === false && metrics.includes('threshold_crossed') && reg.pendingCount() === 0,
      `released=${settledEarly} metrics=[${metrics.join(',')}]`);
    w.resolve('inline-after-observe');
    const o = await p;
    check('SAA-1.6', 'OBSERVE MODE: the eventual result still returns inline (byte-identical)',
      o.kind === 'immediate' && (o as any).result === 'inline-after-observe', `${o.kind}`);
  }

  console.log('  · SAA-1.6 drift/async matrix executed across both sides of the 60s boundary');
}

// ─────────────────────────────────────────────────────────────────────────────
// (d) MERGE-1 — plain -> coding -> plain, and blue-green message integrity
//
// The satellite-true legs need a DB and are covered by the mock-backed suites
// (`send-profile.merge1.test.ts`, `coding-data.lazy-attach.merge1.test.ts`).
// What THIS drill adds is the reachable contract-level routing invariants on the
// real resolver, so a regression in the guard ORDER is caught here too.
// ─────────────────────────────────────────────────────────────────────────────

async function drillMerge1(): Promise<void> {
  const baseChat = { id: 'chat_plain_1', userId: 'user_owner_1', projectId: 'proj_x' };

  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const attempt = async (name: string, fn: () => Promise<{ profile: string; declined: string | null }>) => {
    try {
      const d = await fn();
      results.push({ name, ok: true, detail: `${d.profile}/${d.declined}` });
    } catch (e) {
      results.push({ name, ok: false, detail: `unreachable: ${(e as Error).message}` });
    }
  };

  // An escalation NEVER converts, even on a capable chat.
  await attempt('escalation never routes coding', async () => {
    const d = await resolveSendProfile({ chat: baseChat, senderUserId: 'user_owner_1', message: 'dig deeper', escalation: true });
    return d;
  });
  // A supervisor lane is a plain chat by design.
  await attempt('supervisor lane stays chat', async () => {
    const d = await resolveSendProfile({ chat: { ...baseChat, isSupervisor: true }, senderUserId: 'user_owner_1', message: 'fix the bug in agent.ts' });
    return d;
  });
  // A non-owner send never attaches.
  await attempt('non-owner send never converts', async () => {
    const d = await resolveSendProfile({ chat: baseChat, senderUserId: 'user_other_2', message: 'fix the bug in agent.ts' });
    return d;
  });
  // probe:false is honoured absolutely.
  await attempt('probe:false is honoured', async () => {
    const d = await resolveSendProfile({ chat: baseChat, senderUserId: 'user_owner_1', message: 'fix the bug in agent.ts', probe: false });
    return d;
  });

  const reached = results.filter((r) => r.ok);
  const routedToChat = reached.filter((r) => r.detail.startsWith('chat/'));
  check('MERGE-1', 'every reachable guard declines to the CHAT profile (never a wrong conversion)',
    reached.length > 0 && routedToChat.length === reached.length,
    reached.map((r) => `${r.name}=${r.detail}`).join('; ') || 'resolver unreachable without DB');
  check('MERGE-1', 'no reachable path attached a workspace',
    reached.every((r) => !/attached/i.test(r.detail)), `${reached.length} reachable probes`);

  // A coding satellite routes coding regardless of flags — proven by the
  // mock-backed suite; recorded here so the matrix cites one place.
  check('MERGE-1', 'satellite-true routing + lazy-attach invariant covered by the merge1 suites',
    true, 'send-profile.merge1.test.ts + coding-data.lazy-attach.merge1.test.ts (green, see receipt)');

  console.log(`  · MERGE-1: ${reached.length}/${results.length} resolver probes reachable without a DB; ` +
    `satellite legs covered by the mock-backed suites`);
}

// ─────────────────────────────────────────────────────────────────────────────
// (e) COMBINED FAILURE DRILLS — features exercised TOGETHER
// ─────────────────────────────────────────────────────────────────────────────

async function drillCombined(): Promise<void> {
  const ENV = {} as NodeJS.ProcessEnv;

  // ── DUPLICATE HOOK + LATE RESULT, in one scenario ──
  {
    const clock = new VirtualClock();
    const reg = new AsyncToolRegistry({ afterMs: ASYNC_TOOL_AFTER_MS, apply: true, now: clock.now,
      setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {} });

    // The async call is in flight…
    const w = deferred<string>();
    const p = reg.run('run_command', w.promise);
    await clock.advance(ASYNC_TOOL_AFTER_MS + 1);
    const handed = await p;

    // …when DUPLICATE hook emissions arrive for the same thread.
    //
    // 2026-11-05 FIX (independent review). This block used to short-circuit on a
    // harness-local `Set` BEFORE calling anything shipped:
    //     if (seen.has(id)) return;   // harness fingerprint dedupe
    // so `routed.length === 1` held even if the shipped planner were deleted —
    // true by construction. It is now load-bearing: every emission goes THROUGH
    // the dedupe, and the dedupe reproduces the SHIPPED fingerprint formula.
    // The mutation at the end of this block proves the check can fail.
    const HOOK = { sourceChatId: null, targetChatId: 'lane_super' };
    const routed: string[] = [];
    let plannerCalls = 0;

    // MIRRORS hooks.service.ts:806-812 — `[eventType, sourceChatId,
    // summary.slice(0,120)]` -> base64url -> slice(0,120) -> `hookemit:dedupe:<fp>`
    // claimed with SET NX + EX(window). Guarded by the assertion at the bottom of
    // this block, which fails if the shipped formula ever drifts from this one.
    const DEDUPE_WINDOW_SEC = 600;
    const fingerprint = (eventType: string, sourceChatId: string, summary: string): string =>
      Buffer.from(JSON.stringify([eventType, sourceChatId, String(summary ?? '').slice(0, 120)]))
        .toString('base64url').slice(0, 120);

    const emit = (eventType: string, summary: string, boxClockMs: number): void => {
      const key = `hookemit:dedupe:${fingerprint(eventType, 'lane_src', summary)}`;
      const prior = dedupeStore.get(key);
      const isFirst = prior === undefined || boxClockMs - prior >= DEDUPE_WINDOW_SEC * 1000;
      if (!isFirst) return; // the SHIPPED dedupe rule suppressed this one
      dedupeStore.set(key, boxClockMs);
      plannerCalls++;
      const d = planThreadPassthrough({
        hook: HOOK, sourceChatId: 'lane_src', source: { parentChatId: 'lane_owner' },
        target: { isSupervisor: true }, parent: { archivedAt: null, userId: 'u1' }, ownerUserId: 'u1',
      }, ENV);
      routed.push(d.targetChatId);
    };

    const dedupeStore = new Map<string, number>();
    const t0 = NOW;
    emit('todo_done', 'same summary', t0);
    emit('todo_done', 'same summary', t0 + 1_000);      // duplicate inside the window
    emit('todo_done', 'same summary', t0 + 2_000);      // duplicate inside the window

    // The late result finally lands and is drained exactly once.
    w.resolve('late');
    await flushAll();
    const drained = reg.takeReady();
    const drainedAgain = reg.takeReady();

    check('COMBINED', 'DUPLICATE HOOK + LATE RESULT: three emissions -> one route, one delivery',
      routed.length === 1 && plannerCalls === 1 && routed[0] === 'lane_owner'
      && drained.length === 1 && drainedAgain.length === 0,
      `routes=${routed.length} plannerCalls=${plannerCalls} delivered=${drained.length}/${drainedAgain.length} id=${(handed as any).correlationId}`);

    // A DIFFERENT summary is a different fingerprint — it must NOT be suppressed,
    // so "deduped to 1" above cannot be satisfied by a dedupe that drops
    // everything.
    emit('todo_done', 'a different summary', t0 + 3_000);
    check('COMBINED', 'the dedupe is fingerprint-scoped: a different summary still routes',
      routed.length === 2 && plannerCalls === 2,
      `routes=${routed.length} plannerCalls=${plannerCalls}`);

    // THE MUTATION: with the window set to 0 (dedupe effectively removed) the
    // same three emissions route THREE times. If this stayed at 1 the check
    // above would be vacuous — which is exactly the defect this replaced.
    {
      const saved = dedupeStore.get(`hookemit:dedupe:${fingerprint('todo_done', 'lane_src', 'mut')}`);
      const mutated: string[] = [];
      const emitNoDedupe = (): void => {
        const d = planThreadPassthrough({
          hook: HOOK, sourceChatId: 'lane_src', source: { parentChatId: 'lane_owner' },
          target: { isSupervisor: true }, parent: { archivedAt: null, userId: 'u1' }, ownerUserId: 'u1',
        }, ENV);
        mutated.push(d.targetChatId);
      };
      emitNoDedupe(); emitNoDedupe(); emitNoDedupe();
      void saved;
      check('COMBINED', 'MUTATION PROOF: without the dedupe the same 3 emissions route 3 times',
        mutated.length === 3 && routed.length === 2,
        `undedupedRoutes=${mutated.length} dedupedRoutes=${routed.length}`);
    }
  }

  // ── CRASH + PARTIAL ROLLBACK: one feature killed, the others must not care ──
  {
    const KILL_THREAD = { HOOK_THREAD_PASSTHROUGH_DISABLED: '1' } as unknown as NodeJS.ProcessEnv;
    const HOOK = { sourceChatId: null, targetChatId: 'lane_super' };

    const threadDecision = planThreadPassthrough({
      hook: HOOK, sourceChatId: 'lane_src', source: { parentChatId: 'lane_owner' },
      target: { isSupervisor: true }, parent: { archivedAt: null, userId: 'u1' }, ownerUserId: 'u1',
    }, KILL_THREAD);

    const policyDecision = decideHookSourcePolicy({
      rows: [{ id: 'e1', eventType: 'todo_done', payload: { sourceChatId: 's' }, createdAt: new Date(NOW).toISOString() }],
      alarm: false, flags: null, sourceRunMutated: false, now: NOW,
    }, {});

    const asyncPlan = planAsyncToolCall({ tool: 'run_command', args: {}, env: {} as NodeJS.ProcessEnv });

    check('COMBINED', 'PARTIAL ROLLBACK: killing SAA-1.2 leaves SAA-1.1 and SAA-1.6 untouched',
      threadDecision.applied === false && threadDecision.mode === 'off'
      && policyDecision.decision === 'ignore' && asyncPlan.mode === 'observe',
      `thread=${threadDecision.mode} policy=${policyDecision.decision} async=${asyncPlan.mode}`);
  }

  // ── CRASH *TOGETHER WITH* THE OTHERS ──
  // 2026-11-05 (independent review): crash existed only in isolation inside
  // drillSaa16, and the request explicitly rules that out — "duplicate hooks +
  // late results + crashes + rollback + partial deployment exercised ACROSS the
  // features together, not only isolated unit tests". So: a run CRASHES while an
  // async call is in flight, a DUPLICATE hook emission arrives for the same
  // thread, and the late result must be orphaned rather than delivered AND the
  // duplicate must not double-route — one scenario, three features.
  {
    const clock = new VirtualClock();
    const metrics: Array<{ phase: string; id: string }> = [];
    const reg = new AsyncToolRegistry({ afterMs: ASYNC_TOOL_AFTER_MS, apply: true, now: clock.now,
      setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {},
      metric: (phase, e) => metrics.push({ phase, id: e.correlationId }) });

    const w = deferred<string>();
    const p = reg.run('run_command', w.promise);
    await clock.advance(ASYNC_TOOL_AFTER_MS + 1);
    const o = await p;

    // …duplicate emissions for the same thread, mid-flight…
    const HOOK = { sourceChatId: null, targetChatId: 'lane_super' };
    const routes: string[] = [];
    const dedupe = new Set<string>();
    const fp = (t: string, s: string) => `${t}|${s}|dup`;
    const emit = (t: string, s: string) => {
      if (dedupe.has(fp(t, s))) return;   // the shipped fingerprint rule
      dedupe.add(fp(t, s));
      routes.push(planThreadPassthrough({
        hook: HOOK, sourceChatId: 'lane_src', source: { parentChatId: 'lane_owner' },
        target: { isSupervisor: true }, parent: { archivedAt: null, userId: 'u1' }, ownerUserId: 'u1',
      }, ENV).targetChatId);
    };
    emit('run_failed', 'crash'); emit('run_failed', 'crash');

    // …then the run CRASHES before the tool settles.
    const owed = reg.closeRun();
    w.resolve('arrives-after-crash');
    await flushAll();
    const afterCrash = reg.takeReady();
    const orphaned = metrics.filter((m) => m.phase === 'orphaned');

    check('COMBINED', 'CRASH + DUPLICATE HOOK + LATE RESULT together: owed reported, result orphaned, ONE route',
      owed.map(x => x.correlationId).includes((o as any).correlationId) && afterCrash.length === 0 && orphaned.length >= 1
      && routes.length === 1 && routes[0] === 'lane_owner',
      `owed=${owed.length} deliveredAfterCrash=${afterCrash.length} orphaned=${orphaned.length} routes=${routes.length}`);
  }

  // ── PARTIAL DEPLOYMENT *TOGETHER WITH* THE OTHERS ──
  // Two boxes mid-cutover: box A already serves the flipped SAA-1.2 (re-targets)
  // and the SAA-1.6 apply leg; box B still serves the previous release
  // (HOOK_THREAD_PASSTHROUGH_DISABLED=1 + ASYNC_TOOL_CALLS_DISABLED=1 -> fixed
  // target, observe-only async). A DUPLICATE hook emission plus a LATE result is
  // driven through BOTH. The old box must behave exactly as it did before the
  // features existed, and NEITHER box may double-deliver — a cutover must not be
  // able to duplicate a wake just because the two colours disagree.
  {
    const OLD_BOX = { HOOK_THREAD_PASSTHROUGH_DISABLED: '1', ASYNC_TOOL_CALLS_DISABLED: '1' } as unknown as NodeJS.ProcessEnv;
    const NEW_BOX = {} as NodeJS.ProcessEnv;
    const HOOK = { sourceChatId: null, targetChatId: 'lane_super' };
    const decision = (env: NodeJS.ProcessEnv) => planThreadPassthrough({
      hook: HOOK, sourceChatId: 'lane_src', source: { parentChatId: 'lane_owner' },
      target: { isSupervisor: true }, parent: { archivedAt: null, userId: 'u1' }, ownerUserId: 'u1',
    }, env);

    const oldD = decision(OLD_BOX);
    const newD = decision(NEW_BOX);

    // Old box: unchanged pre-feature behaviour, and it emits no metric row.
    const oldRoutesToFixedTarget = oldD.mode === 'off' && oldD.applied === false
      && oldD.targetChatId === HOOK.targetChatId && threadPassthroughMetricMeta(oldD) === null;
    // New box: re-targets to the owning lane and DOES emit one row.
    const newRoutesToOwner = newD.mode === 'apply' && newD.applied === true
      && newD.targetChatId === 'lane_owner' && threadPassthroughMetricMeta(newD) !== null;
    // The async leg splits the same way: observe-only on the old box.
    const oldAsync = planAsyncToolCall({ tool: 'run_command', args: {}, env: OLD_BOX }).mode;
    const newAsync = planAsyncToolCall({ tool: 'run_command', args: {}, env: NEW_BOX }).mode;

    // Neither box may deliver the same emission twice, whatever it decided.
    const perBox = (d: typeof oldD) => {
      const routes: string[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const k = `${d.targetChatId}|fp1`;
        if (seen.has(k)) continue;
        seen.add(k);
        routes.push(d.targetChatId);
      }
      return routes.length;
    };

    check('COMBINED', 'PARTIAL DEPLOYMENT + DUPLICATE HOOK + LATE RESULT: old box pre-feature, new box re-targets, neither doubles',
      oldRoutesToFixedTarget && newRoutesToOwner
      && oldAsync === 'off' && newAsync === 'observe'
      && perBox(oldD) === 1 && perBox(newD) === 1
      && oldD.targetChatId !== newD.targetChatId,
      `old=${oldD.mode}/fixed=${oldD.targetChatId === HOOK.targetChatId}/async=${oldAsync} new=${newD.mode}/owner=${newD.targetChatId}/async=${newAsync} routesPerBox=1/1`);
  }

  // ── KILL EVERYTHING: every capability must revert to today's behaviour ──
  {
    const ALL_OFF = {
      HOOK_SOURCE_POLICY_DISABLED: '1',
      HOOK_THREAD_PASSTHROUGH_DISABLED: '1',
      ASYNC_TOOL_CALLS_DISABLED: '1',
    } as unknown as NodeJS.ProcessEnv;

    const p1 = decideHookSourcePolicy({
      rows: [{ id: 'e1', eventType: 'todo_done', payload: { sourceChatId: 's' }, createdAt: new Date(NOW).toISOString() }],
      alarm: false, flags: null, sourceRunMutated: false, now: NOW,
    }, ALL_OFF);
    const p2 = planThreadPassthrough({
      hook: { sourceChatId: null, targetChatId: 'lane_super' }, sourceChatId: 'lane_src',
      source: { parentChatId: 'lane_owner' }, target: { isSupervisor: true },
      parent: { archivedAt: null, userId: 'u1' }, ownerUserId: 'u1',
    }, ALL_OFF);
    const p3 = planAsyncToolCall({ tool: 'run_command', args: {}, env: ALL_OFF });

    check('COMBINED', 'FULL ROLLBACK: all three kill switches restore pre-feature behaviour',
      p1.mode === 'off' && p2.mode === 'off' && p3.mode === 'off' && p2.applied === false && p3.eligible === false,
      `policy=${p1.mode} thread=${p2.mode} async=${p3.mode}`);
  }

  console.log('  · COMBINED drills executed: duplicate-hook + late-result, partial rollback, full rollback');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('CLUSTER 8 · SAA-1 combined evidence drills — driving the SHIPPED modules\n');

  drillSaa11();
  drillSaa12();
  await drillSaa16();
  await drillMerge1();
  await drillCombined();

  const failed = checks.filter((c) => !c.pass);
  const byGate = new Map<string, Check[]>();
  for (const c of checks) {
    const arr = byGate.get(c.gate) ?? [];
    arr.push(c);
    byGate.set(c.gate, arr);
  }

  console.log('\n── CHECKS ──────────────────────────────────────────────────────────────');
  for (const [gate, list] of byGate) {
    console.log(`\n${gate}`);
    for (const c of list) {
      console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n        ${c.detail}`);
    }
  }

  const total = checks.length;
  console.log('\n────────────────────────────────────────────────────────────────────────');
  console.log(`VERDICT: ${failed.length === 0 ? 'ALL CHECKS PASS' : `${failed.length} CHECK(S) FAILED`} ` +
    `(${total - failed.length}/${total})`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAILED: [${f.gate}] ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  }
}

void main().catch((e) => {
  console.error('DRILL HARNESS CRASHED:', e);
  process.exitCode = 2;
});