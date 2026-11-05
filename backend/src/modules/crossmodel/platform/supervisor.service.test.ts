/**
 * Fleet Supervisor — supervisor.service unit tests with mocked Prisma.
 * Pins: lazy creation of the ONE global supervisor (ungrouped chat +
 * full-autonomy grant + sweep schedule + WILDCARD hook), idempotency (second
 * call returns the existing chat and self-heals MISSING pieces only), the
 * child-account guard, the P2002 create-race convergence (one supervisor per
 * OWNER via the partial unique index), and the NEVER-throws contract (prisma
 * failures degrade to a log line + null, never an exception).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  user: { findUnique: jest.fn() },
  crossModelChat: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(async () => ({})) },
  chatAutonomy: { findUnique: jest.fn(), upsert: jest.fn(async () => ({})), update: jest.fn(async () => ({})) },
  chatSchedule: { findMany: jest.fn(), findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})), deleteMany: jest.fn(async () => ({ count: 0 })), update: jest.fn(async () => ({})) },
  eventHook: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(async () => ({})), update: jest.fn(async () => ({})) },
  activity: { create: jest.fn(async () => ({})) },
  // Supervisor OFF switch (owner 2026-09-26): null = no row = ON (every
  // pre-existing test untouched); the switch suite at the end sets '0'.
  systemSetting: { findUnique: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
// config/redis is loaded LAZILY by supervisor-switch's skip counter on an OFF
// path only — the real module pulls config/env (process.exit without env vars).
const mockRedisIncr: jest.Mock = jest.fn(async () => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), incr: (...a: any[]) => mockRedisIncr(...a), del: jest.fn(async () => 1) },
}));

// error-handler imports config/env, which calls process.exit(1) without env vars
// and kills the whole jest worker at import time — mock AppError (same shape).
// (Pulled in via autonomy.service, which supervisor.service imports for the
// grantable-tools constants.)
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

// autonomy.service's static import of crossmodel.service drags the model
// integrations + DB/env chains — mock the boundary (supervisor.service never
// calls it; it only needs autonomy.service's constants).
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: jest.fn() },
}));

// coding/schedule.service is only reached via a DYNAMIC import inside the
// sweep-dedupe branch (bd954d27 audit seam) — mock just that export so the
// real module's hooks/redis import chain never loads in this suite.
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  emitScheduleDisabled: jest.fn(async () => undefined),
}));

import logger from '../../../utils/logger';
import {
  SUPERVISOR_PROMPT_OPENER,
  SUPERVISOR_TITLE,
  SUPERVISOR_NOOP_MAX_CHARS,
  SUPERVISOR_HOOK_DEBOUNCE_SEC,
  buildFleetSupervisorPrompt,
  buildFleetSweepPrompt,
  classifySupervisorNote,
  disableOrphanWildcardHooks,
  ensureFleetSupervisor,
  healSupervisorStockPrompt,
  healSupervisorWildcardHook, scheduleRefsInTemplate, rewriteStaleScheduleRefs } from './supervisor.service';
import { AUTONOMY_GRANTABLE_TOOLS, MAX_SCHEDULE_CAP } from './autonomy.service';
import { emitScheduleDisabled } from '../coding/schedule.service';
import { buildFleetSweepPrompt as stockSweepPrompt } from './supervisor.service';
// Layered prompts 2026-09-27: the wake-close contract the composed prompt
// carries is the GENERIC core one (no ticket id).
import { coreWakeCloseContract as wakeCloseContract } from './core-doctrine';
// sup/integration 2026-09-27: the composed fleet prompt carries the GENERIC audit-churn rule (role-profiles.ts).
import { ROLE_AUDIT_CHURN_RULE } from './role-profiles';

const UID = 'u1';
const SUP = { id: 'sup1', userId: UID, projectId: null, title: SUPERVISOR_TITLE, isSupervisor: true };
const HOOK_TYPES = ['run_completed', 'run_failed', 'attention_needed', 'goal_blocked', 'schedule_cap_skipped', 'schedule_disabled', 'schedule_near_cap'];

/** Fresh-owner mock state: adult user, no supervisor/hook/sweep yet. */
function mockFreshOwner() {
  mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
  mockPrisma.crossModelChat.findFirst.mockResolvedValue(null); // no existing supervisor
  mockPrisma.crossModelChat.create.mockImplementation(async ({ data }: any) => ({
    id: 'sup1', userId: UID, projectId: null, ...data,
  }));
  mockPrisma.chatAutonomy.findUnique.mockResolvedValue(null);
  mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
  mockPrisma.eventHook.findFirst.mockResolvedValue(null);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('buildFleetSupervisorPrompt', () => {
  // tt-rd audit 2026-09-27 (finding upward-chatter-2): 946 agent-origin turns
  // in 14 d drained on the Fleet Supervisor — more than its 828 hook wakes —
  // because the prompt legitimised every report-up and gave it no rule to push back.
  it('project-supervisor status chatter gets NO reply and never feeds an owner note; the second one in a day gets ONE steer', () => {
    const p = buildFleetSupervisorPrompt();
    expect(p).toContain('Project supervisors message you ONLY with a goal STATE CHANGE (with artifact id) or an ASK the fleet must carry');
    expect(p).toContain('gets NO reply and is never folded into an owner note');
    expect(p).toContain('"message your lanes, not me — state changes or asks only"');
    expect(p).toContain('Your owner notes come from goal_list/todo_list and the [BOARD], never from report-up prose');
    expect(p).not.toContain('project supervisors report progress UP to you via send_chat_message; you fold their reports into your owner notes');
  });

  it('is fleet-wide (no project name) and names the granted autonomy tools + loop', () => {
    const p = buildFleetSupervisorPrompt();
    expect(p).toContain('Fleet Supervisor');
    expect(p).not.toContain('folderId');
    for (const t of AUTONOMY_GRANTABLE_TOOLS) expect(p).toContain(t);
    expect(p).toContain('ALREADY GRANTED');
    expect(p).toContain('goal_list');
    expect(p).toContain('list_chats');
    expect(p).toContain('start_coding_session');
  });

  it('carries the Boundaries section — never creates/renames/moves org artifacts', () => {
    const p = buildFleetSupervisorPrompt();
    expect(p).toContain('## Boundaries');
    expect(p).toContain('NEVER create, rename, move, or delete projects/folders');
    expect(p).toContain('NEVER move or rename chats');
    expect(p).toContain('create_project');
    expect(p).toContain('delete_project');
    expect(p).toContain('Fleet HQ'); // the runtime artifact this guard exists to prevent
  });

  it('carries the deferred-action rule (2026-08-30 Post-CPT incident: a state-doc-only re-arm was compacted away)', () => {
    const p = buildFleetSupervisorPrompt();
    expect(p).toContain('DEFERRED action');
    expect(p).toContain("kind 'once'");
    expect(p).toContain('only an armed schedule actually fires');
  });

  it('carries the OWNER-FACING NUMBERS + PRODUCTION STATE rules in the core Evidence rules (supervisor doctrine audit D1, 2026-09-27; generic — review fix: the live prompt is LAYERED, the bullets live in core-doctrine.ts)', () => {
    const p = buildFleetSupervisorPrompt();
    const at = p.indexOf('## Evidence rules');
    expect(at).toBeGreaterThan(-1);
    const evidence = p.slice(at, p.indexOf('\n## ', at + 1));
    expect(evidence).toContain('OWNER-FACING NUMBERS');
    expect(evidence).toContain('NEWEST board/lane result by its message id + clock');
    expect(evidence).toContain('WORST leg since the owner\'s last message');
    expect(evidence).toContain('a later better run never replaces the awaited verdict');
    expect(evidence).toContain('PRODUCTION STATE');
    expect(evidence).toContain('THIS-WAKE read receipt');
    expect(evidence).toContain('"not read this wake" in the same sentence');
    expect(evidence).toContain('production_state_unread');
    expect(evidence).toContain('the note still delivers');
    // The rules sit with the receipt doctrine, right after WORLD-FACTS vs FLEET-STATE, ahead of the role profile's CLAIMS WITH RECEIPTS.
    expect(evidence.indexOf('WORLD-FACTS vs FLEET-STATE')).toBeLessThan(evidence.indexOf('OWNER-FACING NUMBERS'));
    expect(p.indexOf('OWNER-FACING NUMBERS')).toBeLessThan(p.indexOf('CLAIMS WITH RECEIPTS'));
    // Only tools this seat HAS (a supervisor chat cannot run_command — review fix); generic text (no incident, project, date or owner-quote marker).
    expect(evidence.slice(evidence.indexOf('- PRODUCTION STATE'))).not.toContain('run_command');
    for (const forbidden of ['s2v12r6', 'NVFP4', '(owner 2026', '2026-09-27', 'CanLaw', 'spark']) expect(evidence).not.toContain(forbidden);
  });

  it('carries the world-facts vs fleet-state doctrine + the typed claims-block contract (owner 2026-09-03)', () => {
    const p = buildFleetSupervisorPrompt();
    // World-facts may be verified by DELEGATING an independent researcher…
    expect(p).toContain('WORLD-FACTS vs FLEET-STATE');
    expect(p).toContain("cross_checker");
    expect(p).toContain('web_researcher');
    expect(p).toContain('2 delegation slots');
    // …fleet-state claims must cite tool receipts and never come from memory.
    expect(p).toContain('FLEET STATE');
    expect(p).toContain('NEVER comes from memory');
    // Claims-with-receipts: the fenced block contract the chat-finalize lane
    // (chat-agent.service claims lane) verifies against run receipts.
    expect(p).toContain('CLAIMS WITH RECEIPTS');
    expect(p).toContain('```claims');
    expect(p).toContain('message_sent');
    // ticket 6d7b379f: the type list carries the finish_run vocabulary
    // (commit, schedule_armed, email_sent, state_update), and the miss
    // wording matches the actual notice ("CLAIMS BLOCK UNVERIFIED" — the
    // unverifiable tier makes "struck as fabricated" inaccurate).
    expect(p).toContain('commit, ticket_update');
    expect(p).toContain('schedule_armed');
    expect(p).toContain('marked UNVERIFIED');
  });

  it('carries the Owner-question triage doctrine — supervisor-first responder (review 2026-09-13 issue 11)', () => {
    const p = buildFleetSupervisorPrompt();
    expect(p).toContain('## Owner-question triage');
    expect(p).toContain('FIRST RESPONDER');
    // the alarm-lane event shape the triage arrives as, carrying the question id
    expect(p).toContain("'[OWNER-QUESTION TRIAGE — answer under standing directives or leave for the owner]");
    expect(p).toContain('question id oq_');
    // answer it yourself, same wake, citing the standing directive
    expect(p).toContain('answer_owner_question');
    expect(p).toContain('SAME wake');
    // Layered prompts 2026-09-27: the grant is cited generically (rule money.grant) — no project name.
    expect(p).toContain("the project's standing grant");
    expect(p).not.toContain('CanLaw');
    expect(p).toContain('clear gates always on my behalf');
    expect(p).toContain('stop asking me so much, figure it out autonomously');
    // the owner-only allowlist that surfaces to the owner after the SLA
    // 2026-09-14: money is NOT owner-only (budgets pre-approved) — the prompt must not name it as a card class
    expect(p).not.toContain('money beyond an approved cap');
    expect(p).toContain('Standing owner directives');
    expect(p).toContain('OWNER DIRECTIVES win over everything');
    expect(p).toContain('irreversible/destructive');
    expect(p).toContain('external send');
    expect(p).toContain('credentials');
    expect(p).toContain('physically-human');
    expect(p).toContain('surface to the owner automatically after the SLA');
    expect(p).toContain('triaged:true');
  });

  it('carries the Wake economy contract (2026-09-02 value upgrade: no-op one-liners, 6h owner-item dedupe, the stuck rule)', () => {
    const p = buildFleetSupervisorPrompt();
    expect(p).toContain('## Wake economy');
    // no-op wakes end in one line — the marker the harness classifier keys on
    expect(p).toContain("'WAKE: no-op");
    expect(p).toContain('unchanged since last note');
    // owner-item dedupe: once per 6h unless state changed
    expect(p).toContain('ONCE per 6 hours');
    expect(p).toContain('flag_owner_question');
    // stuck rule: 3+ identical wakes → act (with receipt) or ONE ticket, then stand down
    expect(p).toContain('STUCK RULE');
    expect(p).toContain('3+ times in a row');
    expect(p).toContain('file_feedback');
    // the deterministic backstop's nudge is binding, like [ACTION VERIFIER]
    expect(p).toContain("'[WATCHDOG]'");
    expect(p).toContain('STANDING DOWN');
  });

  // Hardening review 2026-09-14: the system prompt (= every HOOK wake) mandated
  // only 'WAKE: no-op'; 'ACTIONS TAKEN' lived solely in the sweep prompt, so an
  // acting hook wake closed in prose and classifySupervisorNote filed it as a
  // plain note. The shared doctrine contract now mandates both markers here,
  // identically to the project-supervisor prompt (one instrument, two lanes).
  it('mandates BOTH wake-close markers via the shared doctrine contract (WAKE: no-op / ACTIONS TAKEN) in §Wake economy', () => {
    const p = buildFleetSupervisorPrompt();
    const wakeEconomy = p.slice(p.indexOf('## Wake economy'), p.indexOf('## Style'));
    expect(wakeEconomy).toContain(wakeCloseContract('on any project'));
    expect(wakeEconomy).toContain('ACTIONS TAKEN');
    // tt-rd audit 2026-09-27 (self-audit-churn-3c): the AUDIT CHURN rule rides
    // §Wake economy — audit-only firings are no-ops, steer the lane, never escalate.
    // Layered prompts (sup/integration 2026-09-27): the GENERIC statement of the rule (role-profiles.ts).
    expect(wakeEconomy).toContain(ROLE_AUDIT_CHURN_RULE);
    expect(wakeEconomy).not.toContain('AUDIT CHURN (2026-09-27)'); // never the dated pre-layering wording
    expect(wakeEconomy).toContain('A project supervisor that reports audit-only firings as movement');
    // Fixer 2026-09-27 (finding 1): the fleet seat does not edit an owner-armed cadence either.
    expect(wakeEconomy).toContain('an OWNER-ARMED cadence (armed by: user) it may not edit');
    expect(ROLE_AUDIT_CHURN_RULE).toContain('ONLY when the schedule is machine-armed');
    expect(wakeEconomy).toContain("'WAKE: no-op — nothing moved on any project since the previous wake'");
    // 2026-09-24 (owner): the line used to end in a model-filled '<time>' that
    // read "since 6:46 PM" when posted at 6:46 PM — no clock placeholder
    // survives anywhere in the fleet prompt, and the contract bans a typed clock.
    expect(p).not.toContain('<time>');
    expect(wakeEconomy).toContain('NO clock appended');
    expect(wakeEconomy).toContain('never both, never paraphrased');
    // The exact regex classifySupervisorNote keys on matches the mandated token.
    expect(/\bACTIONS?\s+TAKEN\b/i.test(wakeEconomy)).toBe(true);
  });

  it('leads with per-project GOAL PROGRESS + ETAs, demoting machine state (owner directive 2026-09-13, feedback ed04c9b2)', () => {
    const p = buildFleetSupervisorPrompt();
    // The content mandate: per-project plain-English progress tied to goals…
    expect(p).toContain('LEAD WITH GOAL PROGRESS, NEVER MACHINE STATE');
    expect(p).toContain('PER-PROJECT');
    expect(p).toContain('is my work progressing, and when will it finish');
    // …with an honest ETA or an explicit absence, never machine liveness as the summary
    expect(p).toContain('no ETA yet');
    expect(p).toContain('NEVER substitute machine liveness');
    // project/goal names the owner recognizes — not lane ids or firing counts
    expect(p).toContain('NEVER lane ids, chat prefixes, schedule ids, or firing counts');
    // technical evidence demoted to a single closing Receipts line…
    expect(p).toContain("'Receipts:' line");
    expect(p).toContain('must NEVER be the headline, the table cells, or the project text');
    // …and jargon only with a plain-English gloss when a decision rides on it
    expect(p).toContain('one-line plain-English gloss');
    // the no-change wake stays one line but goal-framed (marker preserved for the classifier)
    expect(p).toContain("'WAKE: no-op — nothing moved on any project since the previous wake'");
    // the old machine-state exemplars survive only as BANNED shapes
    expect(p).toContain('never "all lanes green, one steer dispatched"');
    // Layered prompts 2026-09-27: the incident lineage (feedback ed04c9b2) lives
    // in docs/FRAMEWORK_LESSONS.md — the prompt carries the rule, never the id.
    expect(p).not.toContain('ed04c9b2');
    expect(p).toContain('LEAD WITH GOAL PROGRESS, NEVER MACHINE STATE');
  });
});

describe('buildFleetSweepPrompt', () => {
  it('is a standalone fleet-wide sweep instruction', () => {
    const p = buildFleetSweepPrompt();
    expect(p).toContain('Fleet Supervisor sweep');
    expect(p).toContain('list_chats');
    expect(p).toContain('get_chat_status');
    expect(p).toContain('update_schedule');
  });

  it('is a GOAL LEDGER diff contract, not a status bulletin (2026-09-02 value upgrade)', () => {
    const p = buildFleetSweepPrompt();
    // (a) pull the ledger: goals + each watched lane's last outcome
    expect(p).toContain('GOAL LEDGER');
    expect(p).toContain('goal_list');
    // (b) deltas only — toward/away/stuck/needs-action, never re-narration
    expect(p).toContain('ONLY DELTAS');
    expect(p).toContain('TOWARD a goal');
    expect(p).toContain('2+ consecutive sweeps');
    expect(p).toContain('unchanged since last sweep');
    // (c) the closing contract: explicit one-line goal-framed no-op OR 1-3 receipted actions
    expect(p).toContain("'SWEEP: no-op — nothing moved on any project since last sweep'");
    expect(p).toContain('ACTIONS TAKEN');
    expect(p).toContain('receipt id');
    expect(p).toContain('NEVER post a full-fleet status table when nothing changed');
  });

  it('closes with per-project goal progress + Receipts guidance (owner directive 2026-09-13, feedback ed04c9b2)', () => {
    const p = buildFleetSweepPrompt();
    expect(p).toContain('PER-PROJECT goal progress with ETAs in plain English first');
    expect(p).toContain('Receipts line');
  });

  it('keeps the board-reconciliation duty (2026-08-30: verify a stalled todo before escalating)', () => {
    const p = buildFleetSweepPrompt();
    expect(p).toContain('RECONCILE before escalating or re-dispatching any stalled todo');
    expect(p).toContain('todo_update');
  });

  it('carries the schedule-health duty (overnight forensics fix 3c)', () => {
    const p = buildFleetSweepPrompt();
    expect(p).toContain('check schedule health');
    expect(p).toContain('cadence stopped or is overdue needs a nudge or an owner flag');
  });

  it('carries the deaf-lane re-arm duty (2026-08-30 Post-CPT incident)', () => {
    const p = buildFleetSweepPrompt();
    expect(p).toContain('NO enabled schedules');
    expect(p).toContain('DEAF');
    expect(p).toContain('schedule_message');
  });
});

describe('classifySupervisorNote (harness-written telemetry — never model-claimed)', () => {
  const LONG_PAD = ' Detail line about lanes and goals that pads the note well past the one-liner threshold. '.repeat(5);

  it("an explicit 'SWEEP: no-op' marker classifies noop regardless of length", () => {
    expect(classifySupervisorNote('SWEEP: no-op (nothing changed)')).toBe('supervisor_noop');
    // Rollout watch 2026-09-14: the spark project supervisor's receipt-count header shape counts as an action.
    expect(classifySupervisorNote('WAKE #1 complete — online and acting.\n**Actions (2, with receipts):** 1. online note → Fleet receipt 572994d8 2. state recorded')).toBe('supervisor_action');
    expect(classifySupervisorNote('ACTION TAKEN — nudged lane 28de72e5 (receipt 1a2b3c4d)')).toBe('supervisor_action');
    // the no-op marker still wins outright over a stray receipt-count phrase
    expect(classifySupervisorNote('SWEEP: no-op — nothing moved (Actions (0) this sweep)')).toBe('supervisor_noop');
    expect(classifySupervisorNote(`SWEEP: no-op (nothing changed)${LONG_PAD}`)).toBe('supervisor_noop');
  });

  it("an explicit 'WAKE: no-op' marker classifies noop (hook-wake variant, case-insensitive)", () => {
    expect(classifySupervisorNote('WAKE: no-op (run 1a2b3c4d, nothing changed)')).toBe('supervisor_noop');
    expect(classifySupervisorNote('wake: NO-OP — routine completion')).toBe('supervisor_noop');
  });

  it("an 'ACTIONS TAKEN' receipt marker classifies action — even on a short note (marker beats the length heuristic)", () => {
    expect(classifySupervisorNote('ACTIONS TAKEN\n- steered lane Benchmarks — msg ab12cd34')).toBe('supervisor_action');
    expect(classifySupervisorNote(`**Sweep — 2 deltas**${LONG_PAD}\nACTIONS TAKEN\n- dispatched session 1a2b3c4d`)).toBe('supervisor_action');
  });

  it('a markerless one-liner (≤200 chars) is a noop; longer markerless narration is a plain note', () => {
    expect(classifySupervisorNote('All lanes green, nothing to do.')).toBe('supervisor_noop');
    expect(classifySupervisorNote('x'.repeat(SUPERVISOR_NOOP_MAX_CHARS))).toBe('supervisor_noop');
    expect(classifySupervisorNote('x'.repeat(SUPERVISOR_NOOP_MAX_CHARS + 1))).toBe('supervisor_note');
    expect(classifySupervisorNote(`**Fleet sweep — 2:04 PM**\n\n| Lane | Status |\n|---|---|\n| A | ✅ |${LONG_PAD}`)).toBe('supervisor_note');
  });

  it("the no-op marker beats the action marker (a note that says no-op IS a no-op)", () => {
    expect(classifySupervisorNote(`SWEEP: no-op (nothing changed) — no ACTIONS TAKEN this sweep${LONG_PAD}`)).toBe('supervisor_noop');
  });

  // fixer 2026-09-27 (tt-rd audit, finding upward-chatter-4): the project
  // supervisor's THIRD close — a goal moved, reported up, no lane action — is
  // a plain NOTE even as a one-liner: never the ≤200-char no-op fall-through
  // (a goal moved), never an action (a report-up is not the qualifying action).
  it("a 'WAKE: reported' / 'SWEEP: reported' close is a plain note — not a no-op, not an action; the no-op and action markers still win over it", () => {
    expect(classifySupervisorNote('WAKE: reported — goal G2 moved to done (PR #281) sent to the Fleet Supervisor; no lane action')).toBe('supervisor_note');
    expect(classifySupervisorNote('SWEEP: reported — 5.08 → 7.1 tok/s (msg 871d203b) sent to the Fleet Supervisor; no lane action')).toBe('supervisor_note');
    expect(classifySupervisorNote('sweep: REPORTED — short')).toBe('supervisor_note');
    expect(classifySupervisorNote('WAKE: no-op — nothing moved; WAKE: reported')).toBe('supervisor_noop');
    expect(classifySupervisorNote('ACTIONS TAKEN\n- steered lane (msg ab12cd34)\nSWEEP: reported — also sent up')).toBe('supervisor_action');
  });

  it('is total: empty/garbage input degrades to noop, never throws', () => {
    expect(classifySupervisorNote('')).toBe('supervisor_noop');
    expect(classifySupervisorNote('   ')).toBe('supervisor_noop');
    expect(classifySupervisorNote(null)).toBe('supervisor_noop');
    expect(classifySupervisorNote(undefined)).toBe('supervisor_noop');
    expect(classifySupervisorNote(42 as unknown as string)).toBe('supervisor_noop');
  });

  // HARNESS-RECEIPTS-AND-CLAIMS (supervisor SOTA round 3, 2026-10-20): a HARNESS line wins over the
  // model's own markers — the finalize strips every model-typed copy, so it is the harness record.
  it('a harness line wins over the model markers; the kill switch restores markers-only', () => {
    const contradictory = 'WAKE: no-op — nothing moved on any project since the previous wake\n\nACTIONS TAKEN (harness):\n- send_chat_message → chat 1a2b3c4d · receipt 5e6f7a8b';
    expect(classifySupervisorNote(contradictory)).toBe('supervisor_action');
    expect(classifySupervisorNote(`${'Narration of the fleet. '.repeat(20)}\n\nWAKE: no-op (harness: 0 lane actions)`)).toBe('supervisor_noop');
    expect(classifySupervisorNote('Goal moved.\n\nWAKE: reported (harness: 0 lane actions; 1 report-up to the Fleet Supervisor — send_chat_message → chat f1ee7000)')).toBe('supervisor_note');
    process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED = '1';
    try {
      expect(classifySupervisorNote(contradictory)).toBe('supervisor_noop');
    } finally {
      delete process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED;
    }
  });

  // Follow-through minors (2026-10-22): a short answer-first follow-through result closes with the harness's neutral
  // 'Harness record:' line (mode 'record') — it used to fall through to the ≤200-char rule and file as a no-op, which
  // sweep-triage fed to the sweep_triage gate as previous_sweep_note.class.
  it("a note ending with the neutral 'Harness record:' line is a plain note (never the ≤200-char no-op); a real wake no-op stays a no-op; the switch restores", () => {
    const followThrough = 'Read back the reply: plan accepted.\n\nHarness record: 0 lane actions this wake.';
    expect(followThrough.length).toBeLessThanOrEqual(SUPERVISOR_NOOP_MAX_CHARS);
    expect(classifySupervisorNote(followThrough)).toBe('supervisor_note');
    // genuine machine-wake no-ops: the harness no-op line (mode 'noop') or the model's own marker (mode 'noop_present')
    expect(classifySupervisorNote('All lanes look healthy; nothing to steer.\n\nWAKE: no-op (harness: 0 lane actions)')).toBe('supervisor_noop');
    expect(classifySupervisorNote('WAKE: no-op — nothing moved on any project since the previous wake')).toBe('supervisor_noop');
    expect(classifySupervisorNote('All lanes look healthy.')).toBe('supervisor_noop');
    process.env.SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED = '1';
    try {
      expect(classifySupervisorNote(followThrough)).toBe('supervisor_noop');
    } finally {
      delete process.env.SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED;
    }
  });

  it('the sweep prompt asks for what moved and why — the harness writes the receipts (model-typed contract under the kill switch)', () => {
    expect(buildFleetSweepPrompt()).toContain("the harness appends 'ACTIONS TAKEN (harness):'");
    expect(buildFleetSweepPrompt()).not.toContain('each ONE line with its receipt id');
    process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED = '1';
    try {
      expect(buildFleetSweepPrompt()).toContain("OR 'ACTIONS TAKEN' — 1-3 actions, each ONE line with its receipt id.");
    } finally {
      delete process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED;
    }
  });

  it('the markers it keys on are the exact ones the prompts mandate (contract pin)', () => {
    // If the prompt wording for the markers ever drifts, the classifier (and
    // the loop_metrics ratios built on it) silently mismeasure — pin them.
    expect(buildFleetSweepPrompt()).toContain('SWEEP: no-op');
    expect(buildFleetSweepPrompt()).toContain('ACTIONS TAKEN');
    expect(buildFleetSupervisorPrompt()).toContain('WAKE: no-op');
    // Hardening review 2026-09-14: the ACTION marker is mandated on hook wakes too.
    expect(buildFleetSupervisorPrompt()).toContain('ACTIONS TAKEN');
  });

  it('the goal-framed no-op lines the prompts NOW mandate still classify as noop (ed04c9b2)', () => {
    // The 2026-09-13 owner directive re-phrased the mandated no-op lines from
    // machine refs to goal movement — the 'WAKE/SWEEP: no-op' marker prefix
    // must keep matching the classifier regex or every quiet wake mismeasures.
    expect(classifySupervisorNote('WAKE: no-op — nothing moved on any project since 1:30 AM')).toBe('supervisor_noop');
    expect(classifySupervisorNote('SWEEP: no-op — nothing moved on any project since last sweep')).toBe('supervisor_noop');
  });
});

describe('ensureFleetSupervisor — first creation', () => {
  it('creates the pinned UNGROUPED chat with full autonomy + sweep + ONE wildcard hook', async () => {
    mockFreshOwner();
    const chat = await ensureFleetSupervisor(UID);

    // The chat row: global (NO project connect), titled, pinned, prompted.
    const createData = mockPrisma.crossModelChat.create.mock.calls[0][0].data;
    expect(createData.title).toBe('Fleet Supervisor');
    expect(createData.mode).toBe('auto'); // owner 2026-09-26: supervisors default to Auto (the compute policy decides per wake; the L2 preset is the fallback)
    expect(createData.isSupervisor).toBe(true);
    expect(createData.systemPrompt).toBe(buildFleetSupervisorPrompt());
    expect(createData.user).toEqual({ connect: { id: UID } });
    expect(createData.project).toBeUndefined();
    expect(chat.id).toBe('sup1');

    // Full autonomy: EVERY grantable tool, max cap, keyed on the chat PK.
    const up = mockPrisma.chatAutonomy.upsert.mock.calls[0][0];
    expect(up.where).toEqual({ chatId: 'sup1' });
    expect(up.create.allowedTools).toEqual([...AUTONOMY_GRANTABLE_TOOLS]);
    expect(up.create.scheduleCap).toBe(MAX_SCHEDULE_CAP);
    expect(up.update.allowedTools).toEqual([...AUTONOMY_GRANTABLE_TOOLS]);

    // ONE recurring sweep schedule (2h, maxRuns 500, mirrors schedule.service's shape).
    const sched = mockPrisma.chatSchedule.create.mock.calls[0][0].data;
    expect(sched.sessionId).toBe('sup1');
    expect(sched.userId).toBe(UID);
    expect(sched.kind).toBe('recurring');
    expect(sched.intervalSec).toBe(120 * 60);
    expect(sched.maxRuns).toBe(500);
    expect(sched.enabled).toBe(true);
    expect(sched.prompt).toBe(buildFleetSweepPrompt());

    // ONE WILDCARD hook: sourceChatId NULL + all six supervisor event types —
    // every chat the owner has (present and future) emits to the supervisor.
    const hook = mockPrisma.eventHook.create.mock.calls[0][0].data;
    expect(hook.userId).toBe(UID);
    expect(hook.sourceChatId).toBeNull();
    expect(hook.targetChatId).toBe('sup1');
    expect(hook.eventTypes).toEqual(HOOK_TYPES);
  });

  it('audits the wildcard-hook auto-provision (feedback be89b75d — this exact hook\'s silent loss motivated the trail)', async () => {
    mockFreshOwner();
    mockPrisma.eventHook.create.mockResolvedValue({ id: 'h-new' });

    await ensureFleetSupervisor(UID);

    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: UID,
        action: 'hook.auto_provision',
        resource: 'platform',
        metadata: expect.objectContaining({ hookId: 'h-new', targetChatId: 'sup1' }),
      }),
    });
  });
});

describe('ensureFleetSupervisor — idempotent self-heal', () => {
  it('returns the existing supervisor and creates NOTHING when all pieces are in place', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
    // The healthy steady state: current stock prompt (Boundaries included),
    // current wildcard event set, current stock sweep prompt.
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ ...SUP, systemPrompt: buildFleetSupervisorPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'sup1' }); // grant present
    mockPrisma.eventHook.findFirst.mockResolvedValue({ id: 'h1', eventTypes: [...HOOK_TYPES] }); // wildcard hook current
    mockPrisma.chatSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: buildFleetSweepPrompt() }]); // sweep current

    const chat = await ensureFleetSupervisor(UID);

    expect(chat.id).toBe('sup1');
    expect(mockPrisma.crossModelChat.create).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled(); // no title/project drift + a current prompt → no heal write
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled(); // a present grant is NEVER clobbered
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled(); // current event set → no heal write
    expect(mockPrisma.chatSchedule.create).not.toHaveBeenCalled();
    expect(mockPrisma.chatSchedule.update).not.toHaveBeenCalled(); // current sweep prompt → no heal write
  });

  it('heals title/project drift on an existing supervisor (fixed label, always ungrouped)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({
      ...SUP, title: 'Unanswered Test Question', projectId: 'proj-9', // drifted
      // Fixture updated 2026-09-14 (hardening review): a NULL prompt now heals to
      // stock (a second update) — this pin is about the title/project write only.
      systemPrompt: buildFleetSupervisorPrompt(),
    });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'sup1' });
    mockPrisma.eventHook.findFirst.mockResolvedValue({ id: 'h1' });
    mockPrisma.chatSchedule.findMany.mockResolvedValue([{ id: 'sch1' }]);

    const chat = await ensureFleetSupervisor(UID);

    expect(chat.id).toBe('sup1');
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({
      where: { id: 'sup1' },
      data: { title: 'Fleet Supervisor', project: { disconnect: true } },
    });
    expect(mockPrisma.crossModelChat.create).not.toHaveBeenCalled();
  });

  it('heals a title-only drift WITHOUT a project disconnect (already ungrouped)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ ...SUP, title: 'Sweep Status Note' });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'sup1' });
    mockPrisma.eventHook.findFirst.mockResolvedValue({ id: 'h1' });
    mockPrisma.chatSchedule.findMany.mockResolvedValue([{ id: 'sch1' }]);

    await ensureFleetSupervisor(UID);

    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({
      where: { id: 'sup1' },
      data: { title: 'Fleet Supervisor' },
    });
  });

  it('fixer 2026-09-27: the heal KEEPS the harness step half ("Fleet Supervisor · sweep") and never touches a human-pinned title (the project disconnect still heals)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'sup1' });
    mockPrisma.eventHook.findFirst.mockResolvedValue({ id: 'h1', eventTypes: [...HOOK_TYPES] });
    mockPrisma.chatSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: buildFleetSweepPrompt() }]);
    // the wake step written by setSupervisorStep is not drift
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ ...SUP, title: 'Fleet Supervisor · sweep', systemPrompt: buildFleetSupervisorPrompt() });
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
    // a pinned rename is the owner's — no title write, even when it differs from the label
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ ...SUP, title: 'My Fleet Boss', titlePinned: true, systemPrompt: buildFleetSupervisorPrompt() });
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
    // pinned + grouped: only the project disconnect is written
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ ...SUP, title: 'My Fleet Boss', titlePinned: true, projectId: 'proj-9', systemPrompt: buildFleetSupervisorPrompt() });
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({ where: { id: 'sup1' }, data: { project: { disconnect: true } } });
    // a drifted title with a stray step half heals to the bare label (the step was never the harness's)
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'sup1' });
    mockPrisma.eventHook.findFirst.mockResolvedValue({ id: 'h1', eventTypes: [...HOOK_TYPES] });
    mockPrisma.chatSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: buildFleetSweepPrompt() }]);
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ ...SUP, title: 'Sweep Notes · draft', systemPrompt: buildFleetSupervisorPrompt() });
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({ where: { id: 'sup1' }, data: { title: 'Fleet Supervisor' } });
  });

  it('self-heals a MISSING autonomy grant / wildcard hook / sweep on an existing supervisor', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
    mockPrisma.crossModelChat.findFirst.mockResolvedValue(SUP);
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue(null); // grant missing → re-granted
    mockPrisma.eventHook.findFirst.mockResolvedValue(null); // hook missing → recreated
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]); // sweep dead → recreated

    const chat = await ensureFleetSupervisor(UID);

    expect(chat.id).toBe('sup1');
    expect(mockPrisma.crossModelChat.create).not.toHaveBeenCalled();
    expect(mockPrisma.chatAutonomy.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.eventHook.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.chatSchedule.create).toHaveBeenCalledTimes(1);
  });

  it('unions a NEWLY_ADDED grantable tool into a pre-2026-08-22 grant (dispatch heal — 7705fec2 deferred / f1cb73ff)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ ...SUP, systemPrompt: buildFleetSupervisorPrompt() });
    // A grant provisioned before dispatch_platform_task existed.
    const OLD_GRANT = ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule', 'update_schedule'];
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'sup1', allowedTools: [...OLD_GRANT] });
    mockPrisma.eventHook.findFirst.mockResolvedValue({ id: 'h1', eventTypes: [...HOOK_TYPES] });
    mockPrisma.chatSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: buildFleetSweepPrompt() }]);

    await ensureFleetSupervisor(UID);

    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled(); // never a full re-grant on an existing row
    expect(mockPrisma.chatAutonomy.update).toHaveBeenCalledWith({
      where: { chatId: 'sup1' },
      // dispatch_platform_task (2026-08-22) AND send_to_instance (Phase 5,
      // 2026-08-30) both heal into the pre-existing grant.
      // + the T3b trio (2026-09-24) and the control-tool quintet (2026-09-24,
      // actually unioned only from 62365255 / 2026-10-02) — the union-heal
      // list grew with them.
      data: { allowedTools: [...OLD_GRANT, 'dispatch_platform_task', 'send_to_instance', 'set_chat_instructions', 'configure_workspace', 'import_repo',
        'stop_run', 'answer_chat_question', 'approve_request', 'pause_schedule', 'resume_schedule'] },
    });
  });

  // Ticket 62365255 (2026-10-02): both prod supervisor rows predate the
  // 2026-09-24 control-tool addition and kept a 10-tool grant, so a machine
  // stop_run of a NON-child lane (no implicit-parent scope) hit the
  // confirmation gate and staged an owner card 3×/day. The union-heal must
  // converge those rows so the card never stages again.
  it('unions the control tools into the 10-tool pre-2026-09-24 prod grant (stop_run card class — 62365255)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ ...SUP, systemPrompt: buildFleetSupervisorPrompt() });
    // The exact prod shape: the original five + dispatch + send_to_instance +
    // the T3b trio — everything grantable BEFORE the control-tool addition.
    const PRE_CONTROL_GRANT = ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule', 'update_schedule',
      'dispatch_platform_task', 'send_to_instance', 'set_chat_instructions', 'configure_workspace', 'import_repo'];
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'sup1', allowedTools: [...PRE_CONTROL_GRANT] });
    mockPrisma.eventHook.findFirst.mockResolvedValue({ id: 'h1', eventTypes: [...HOOK_TYPES] });
    mockPrisma.chatSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: buildFleetSweepPrompt() }]);

    await ensureFleetSupervisor(UID);

    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled(); // union only — the narrowed row is never clobbered wholesale
    expect(mockPrisma.chatAutonomy.update).toHaveBeenCalledTimes(1);
    const updateArg = mockPrisma.chatAutonomy.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ chatId: 'sup1' });
    // everything the row already had is preserved…
    for (const t of PRE_CONTROL_GRANT) expect(updateArg.data.allowedTools).toContain(t);
    // …and exactly the five control tools are added — stop_run FIRST among
    // them (CONTROL_TOOL_NAMES order), the tool the 3 cards were staged for.
    expect(updateArg.data.allowedTools.slice(-5)).toEqual(['stop_run', 'answer_chat_question', 'approve_request', 'pause_schedule', 'resume_schedule']);
  });

  it('leaves a complete grant untouched (heal is union-only, no rewrite when nothing is missing)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ ...SUP, systemPrompt: buildFleetSupervisorPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({
      chatId: 'sup1',
      // owner-narrowed but has EVERY post-provisioning tool (incl. the T3b
      // trio and the control-tool quintet)
      allowedTools: ['send_chat_message', 'dispatch_platform_task', 'send_to_instance', 'set_chat_instructions', 'configure_workspace', 'import_repo',
        'stop_run', 'answer_chat_question', 'approve_request', 'pause_schedule', 'resume_schedule'],
    });
    mockPrisma.eventHook.findFirst.mockResolvedValue({ id: 'h1', eventTypes: [...HOOK_TYPES] });
    mockPrisma.chatSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: buildFleetSweepPrompt() }]);

    await ensureFleetSupervisor(UID);

    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.chatAutonomy.update).not.toHaveBeenCalled();
  });
});

describe('ensureFleetSupervisor — stock-prompt heal', () => {
  /** The pre-Boundaries stock prompt: stock opener, no '## Boundaries'. */
  const OLD_STOCK =
    'You are the Fleet Supervisor — an autonomous supervisor chat that watches over EVERY chat and coding session the owner has.\n\n## Style\n- Be brief.';

  /** Existing supervisor with a given stored prompt; all other pieces healthy. */
  function mockExistingWithPrompt(systemPrompt: string | null) {
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ ...SUP, systemPrompt });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'sup1' });
    mockPrisma.eventHook.findFirst.mockResolvedValue({ id: 'h1' });
    mockPrisma.chatSchedule.findMany.mockResolvedValue([{ id: 'sch1' }]);
  }

  it('rewrites an OLD STOCK prompt (stock opener, no Boundaries) to the current stock prompt', async () => {
    mockExistingWithPrompt(OLD_STOCK);
    const chat = await ensureFleetSupervisor(UID);
    expect(chat.id).toBe('sup1');
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({
      where: { id: 'sup1' },
      data: { systemPrompt: buildFleetSupervisorPrompt() },
    });
  });

  it('leaves a CURRENT stock prompt alone (Boundaries already present)', async () => {
    mockExistingWithPrompt(buildFleetSupervisorPrompt());
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });

  it('heals a MID-VINTAGE stock prompt (has [ACTION VERIFIER] but predates newer sections) — prompt updates must STICK (feedback 4959bb1c)', async () => {
    // The pre-4959bb1c repair was a one-shot '[ACTION VERIFIER]' marker check:
    // a supervisor provisioned after that marker landed but before the Status
    // note format section kept the stale prompt forever. Full-text compare now
    // refreshes ANY non-current stock prompt.
    const midVintage = `${SUPERVISOR_PROMPT_OPENER} — an autonomous supervisor chat…\n\n## Style\n- Be brief.\n\nAn [ACTION VERIFIER] message audits your claims.\n\n## Boundaries\n- Stay in your lane.`;
    mockExistingWithPrompt(midVintage);
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({
      where: { id: 'sup1' },
      data: { systemPrompt: buildFleetSupervisorPrompt() },
    });
  });

  // Rollout watch 2026-09-15 (tick 12): the fleet's stock prompt heals on the
  // 15-min watchdog sweep, not only on a UI ensure — same non-clobber rule.
  describe('healSupervisorStockPrompt — the watchdog-sweep heal', () => {
    const current = () => buildFleetSupervisorPrompt();
    it('rewrites a STALE stock prompt (stock opener, older body) to the current stock prompt and reports true', async () => {
      mockPrisma.crossModelChat.update.mockClear();
      mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: 'sup-1', isSupervisor: true, systemPrompt: `${SUPERVISOR_PROMPT_OPENER} — an older stock body without the newest doctrine bullets.` });
      expect(await healSupervisorStockPrompt('sup-1')).toBe(true);
      expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'sup-1' }, data: { systemPrompt: current() } }));
    });
    it('leaves a CURRENT stock prompt alone (false, no write)', async () => {
      mockPrisma.crossModelChat.update.mockClear();
      mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: 'sup-1', isSupervisor: true, systemPrompt: current() });
      expect(await healSupervisorStockPrompt('sup-1')).toBe(false);
      expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
    });
    it('NEVER touches a customized prompt (no stock opener) and ignores non-supervisor rows', async () => {
      mockPrisma.crossModelChat.update.mockClear();
      mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: 'sup-1', isSupervisor: true, systemPrompt: 'You are Paul\'s custom fleet brain. Do exactly this…' });
      expect(await healSupervisorStockPrompt('sup-1')).toBe(false);
      mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: 'lane-1', isSupervisor: false, systemPrompt: `${SUPERVISOR_PROMPT_OPENER} copied into a lane` });
      expect(await healSupervisorStockPrompt('lane-1')).toBe(false);
      mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
      expect(await healSupervisorStockPrompt('missing')).toBe(false);
      expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
    });
  });

  it('the current stock prompt carries the Status note format contract (feedback 4959bb1c)', () => {
    const p = buildFleetSupervisorPrompt();
    expect(p).toContain('## Status note format');
    // fdd85bb3: the example moved OUT of the inline sentence (the model was
    // imitating the inline placement and emitting collapsed one-line tables)
    // into a multi-line block with an explicit newline mandate.
    expect(p).toContain('NEWLINES ARE MANDATORY');
    // ed04c9b2 (2026-09-13 owner directive): the exemplar table is per-PROJECT
    // goal progress with ETAs — the old lane-telemetry example was the exact
    // machine-state style the owner reported.
    expect(p).toContain('| Project | Progress toward its goal | ETA |');
    expect(p).not.toContain('| Lane | Status | Detail |');
    expect(p).toContain('|---|---|---|');
    // 44204e09 (third report): the model still dropped the separator row /
    // pipes / row newlines on terse "no change" notes, and flattened lists
    // onto one line — the anti-compression rules name both failure shapes.
    expect(p).toContain('NEVER compress a table');
    expect(p).toContain('ONE ITEM PER LINE');
    // b8e1b0a3: sessions/chats must be TAP-THROUGH links with the full id.
    expect(p).toContain('Link every chat/session you mention');
    expect(p).toContain('/crossmodel?chatId=');
    const sweep = buildFleetSweepPrompt();
    expect(sweep).toContain('Status note format');
    expect(sweep).not.toContain('one-paragraph');
  });

  it('NEVER touches a CUSTOMIZED prompt (no stock opener)', async () => {
    mockExistingWithPrompt('You are my fleet bot. Watch the Acme project only and stay quiet.');
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });

  // Pin flipped 2026-09-14 (hardening review, parity with the project lane): a
  // NULL/empty prompt is a supervisor with NO doctrine, not a customization —
  // it heals back to stock. (The old pin encoded the "nothing to heal" gap.)
  it.each([['null', null], ['empty string', '']])('heals a %s prompt back to the CURRENT stock prompt (prompt-less is damage, never a customization)', async (_label, prompt) => {
    mockExistingWithPrompt(prompt as any);
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({
      where: { id: 'sup1' },
      data: { systemPrompt: buildFleetSupervisorPrompt() },
    });
  });
});

describe('ensureFleetSupervisor — wildcard-hook event-set heal (forensics fix 2)', () => {
  /** Existing supervisor with a wildcard hook carrying `eventTypes`; other pieces healthy. */
  function mockExistingWithHookTypes(eventTypes: string[] | undefined) {
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ ...SUP, systemPrompt: buildFleetSupervisorPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'sup1' });
    mockPrisma.eventHook.findFirst.mockResolvedValue({ id: 'h1', eventTypes });
    mockPrisma.chatSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: buildFleetSweepPrompt() }]);
  }

  it('heals a LEGACY STOCK event set to the current one (schedule_disabled reaches existing supervisors)', async () => {
    mockExistingWithHookTypes(['run_completed', 'run_failed', 'attention_needed', 'goal_blocked', 'schedule_cap_skipped']);
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({
      where: { id: 'h1' },
      data: { eventTypes: HOOK_TYPES },
    });
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
  });

  it('order-insensitive: a shuffled legacy stock set still heals', async () => {
    mockExistingWithHookTypes(['goal_blocked', 'run_completed', 'attention_needed', 'run_failed', 'schedule_cap_skipped']);
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.eventHook.update).toHaveBeenCalledTimes(1);
  });

  it('a NARROWED stock set gains ONLY the newly-added safety types (never restores removed ones)', async () => {
    // 2026-08-24 heal-miss lesson: exact-match healing left every prod variant
    // (narrowed / todo_done-era sets) without schedule_disabled. Subset-union
    // semantics: stock-universe sets get the new safety type; deliberately
    // removed types (run_completed here) stay removed.
    mockExistingWithHookTypes(['run_failed']); // deliberately narrowed
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { eventTypes: ['run_failed', 'schedule_disabled', 'schedule_near_cap'] },
    }));
  });

  it('NEVER touches a set containing a CUSTOM (non-stock-universe) event type', async () => {
    mockExistingWithHookTypes(['run_failed', 'my_custom_webhook_event']);
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();
  });

  it('a stock-universe set that already has the new types is left alone (idempotent)', async () => {
    mockExistingWithHookTypes(['run_failed', 'schedule_disabled', 'schedule_near_cap']);
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();
  });

  it('a heal failure degrades to a warn — ensure still returns the supervisor', async () => {
    mockExistingWithHookTypes(['run_completed', 'run_failed', 'attention_needed', 'goal_blocked']);
    mockPrisma.eventHook.update.mockRejectedValue(new Error('db down'));
    const chat = await ensureFleetSupervisor(UID);
    expect(chat.id).toBe('sup1');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('event-set heal failed'));
  });
});

describe('ensureFleetSupervisor — wildcard-hook wake-economy debounce (owner 2026-09-04)', () => {
  // The 02:13/02:15/02:23/02:26Z wake storm: quiet run_completed ticks at the
  // 60s schema default woke the supervisor into a full evidence-cited note
  // every few minutes — the fabrication surface the CV0904 fix shrinks.
  beforeEach(() => {
    // clearAllMocks keeps implementations — the event-set heal-failure test
    // above leaves eventHook.update permanently rejecting. Restore it.
    mockPrisma.eventHook.update.mockImplementation(async () => ({}));
  });

  function mockExistingWithHookDebounce(debounceSec: number | undefined) {
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ ...SUP, systemPrompt: buildFleetSupervisorPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'sup1' });
    mockPrisma.eventHook.findFirst.mockResolvedValue({ id: 'h1', eventTypes: [...HOOK_TYPES], debounceSec });
    mockPrisma.chatSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: buildFleetSweepPrompt() }]);
  }

  it('creates the wildcard hook with debounceSec 0 — instant hooks (owner 2026-09-14); coalescing happens only while the chat is busy', async () => {
    mockFreshOwner();
    await ensureFleetSupervisor(UID);
    const hook = mockPrisma.eventHook.create.mock.calls[0][0].data;
    expect(SUPERVISOR_HOOK_DEBOUNCE_SEC).toBe(0);
    expect(hook.debounceSec).toBe(0);
  });

  it.each([60, 3600])('heals an existing hook on a former stock window (%s s) → 0, with an audit row', async (stock) => {
    mockExistingWithHookDebounce(stock);
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({
      where: { id: 'h1' },
      data: { debounceSec: 0 },
    });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'hook.update',
        metadata: expect.objectContaining({ hookId: 'h1', debounceSec: 0 }),
      }),
    });
  });

  it('NEVER touches a customized debounce window (only the exact legacy 60 heals)', async () => {
    mockExistingWithHookDebounce(1800);
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();
  });

  it('an already-healed hook (0) is left alone (idempotent)', async () => {
    mockExistingWithHookDebounce(0);
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();
  });

  it('a debounce-heal failure degrades to a warn — ensure still returns the supervisor', async () => {
    mockExistingWithHookDebounce(60);
    // Once, not persistent — a lasting rejection would bleed into later describes.
    mockPrisma.eventHook.update.mockRejectedValueOnce(new Error('db down'));
    const chat = await ensureFleetSupervisor(UID);
    expect(chat.id).toBe('sup1');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('debounce heal failed'));
  });
});

describe('ensureFleetSupervisor — stock sweep-prompt heal (forensics fix 3c)', () => {
  const OLD_SWEEP =
    'Fleet Supervisor sweep: list_chats → check running/attention via get_chat_status → ' +
    'review goals/todos via goal_list/todo_list across active projects → nudge or dispatch where useful → ' +
    'post a one-paragraph plain-English status note here. Adjust your own cadence with update_schedule if needed.';

  function mockExistingWithSweepPrompt(prompt: string | undefined) {
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ ...SUP, systemPrompt: buildFleetSupervisorPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'sup1' });
    mockPrisma.eventHook.findFirst.mockResolvedValue({ id: 'h1', eventTypes: [...HOOK_TYPES] });
    mockPrisma.chatSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt }]);
  }

  it('rewrites an OLD STOCK sweep prompt to the current one (schedule-health duty reaches existing sweeps)', async () => {
    mockExistingWithSweepPrompt(OLD_SWEEP);
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.chatSchedule.update).toHaveBeenCalledWith({
      where: { id: 'sch1' },
      // promptSetBy 'system': the heal is a framework write (drift surfacing, 2026-08-30).
      data: { prompt: buildFleetSweepPrompt(), promptSetBy: 'system' },
    });
    expect(mockPrisma.chatSchedule.create).not.toHaveBeenCalled();
  });

  it('NEVER touches a customized sweep prompt (no stock opener)', async () => {
    mockExistingWithSweepPrompt('Check on the Acme migration hourly and report.');
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.chatSchedule.update).not.toHaveBeenCalled();
  });
});

describe('ensureFleetSupervisor — guards + races', () => {
  it('skips child accounts entirely (no autonomous fleet agents for kids)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: true });
    const chat = await ensureFleetSupervisor(UID);
    expect(chat).toBeNull();
    expect(mockPrisma.crossModelChat.create).not.toHaveBeenCalled();
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
  });

  it('returns null for a blank userId', async () => {
    expect(await ensureFleetSupervisor('')).toBeNull();
    expect(mockPrisma.crossModelChat.create).not.toHaveBeenCalled();
  });

  it('converges on the winner when the create races the one-per-owner unique index (P2002)', async () => {
    mockFreshOwner();
    mockPrisma.crossModelChat.create.mockRejectedValueOnce({ code: 'P2002' });
    // The re-fetch after P2002 finds the winner's row.
    mockPrisma.crossModelChat.findFirst
      .mockResolvedValueOnce(null) // initial existence check
      .mockResolvedValueOnce(SUP); // winner re-fetch
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'sup1' });
    mockPrisma.eventHook.findFirst.mockResolvedValue({ id: 'h1' });
    mockPrisma.chatSchedule.findMany.mockResolvedValue([{ id: 'sch1' }]);

    const chat = await ensureFleetSupervisor(UID);
    expect(chat.id).toBe('sup1');
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled(); // winner already fully provisioned
  });

  it('converges on P2002 when a concurrent ensure races the wildcard-hook create', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
    mockPrisma.crossModelChat.findFirst.mockResolvedValue(SUP);
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'sup1' });
    mockPrisma.eventHook.findFirst.mockResolvedValue(null); // hook looks missing…
    mockPrisma.eventHook.create.mockRejectedValue({ code: 'P2002' }); // …but a twin ensure won the create
    mockPrisma.chatSchedule.findMany.mockResolvedValue([{ id: 'sch1' }]);

    const chat = await ensureFleetSupervisor(UID); // must NOT throw — the winner's row is identical
    expect(chat.id).toBe('sup1');
    expect(mockPrisma.eventHook.create).toHaveBeenCalledTimes(1);
  });

  it('dedupes a duplicated sweep schedule (keeps the earliest enabled row)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
    mockPrisma.crossModelChat.findFirst.mockResolvedValue(SUP);
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'sup1' });
    mockPrisma.eventHook.findFirst.mockResolvedValue({ id: 'h1' });
    // Fixture updated 2026-09-14 (hardening review): these model STOCK duplicates
    // from the create race — the dedupe now keys on the stock opener, so the
    // rows must carry it (prompt-less rows are never deleted).
    const stock = buildFleetSweepPrompt();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: stock }, { id: 'sch2', prompt: stock }, { id: 'sch3', prompt: stock }]);

    const chat = await ensureFleetSupervisor(UID);
    expect(chat.id).toBe('sup1');
    expect(mockPrisma.chatSchedule.create).not.toHaveBeenCalled();
    expect(mockPrisma.chatSchedule.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['sch2', 'sch3'] } },
    });
  });

  it('emits ONE schedule_disabled audit event per doomed sweep row BEFORE the delete (bd954d27)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
    mockPrisma.crossModelChat.findFirst.mockResolvedValue(SUP);
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'sup1' });
    mockPrisma.eventHook.findFirst.mockResolvedValue({ id: 'h1' });
    // Fixture updated 2026-09-14 (hardening review): stock duplicates carry the opener.
    const stock = buildFleetSweepPrompt();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([
      { id: 'sch1', kind: 'recurring', runsCount: 10, prompt: stock },
      { id: 'sch2', kind: 'recurring', runsCount: 4, prompt: stock },
      { id: 'sch3', kind: 'recurring', runsCount: 0, prompt: stock },
    ]);

    await ensureFleetSupervisor(UID);
    expect(emitScheduleDisabled).toHaveBeenCalledTimes(2);
    expect(emitScheduleDisabled).toHaveBeenCalledWith(
      { id: 'sch2', sessionId: 'sup1', kind: 'recurring' }, 'obsolete', 4,
    );
    expect(emitScheduleDisabled).toHaveBeenCalledWith(
      { id: 'sch3', sessionId: 'sup1', kind: 'recurring' }, 'obsolete', 0,
    );
    // And the audit precedes the delete: both emissions resolved before deleteMany ran.
    const emitOrder = (emitScheduleDisabled as jest.Mock).mock.invocationCallOrder;
    const deleteOrder = mockPrisma.chatSchedule.deleteMany.mock.invocationCallOrder;
    expect(Math.max(...emitOrder)).toBeLessThan(Math.min(...deleteOrder));
    // Finding 2: PLUS a durable, owner-visible Activity audit row per doomed row
    // (the hook event's source is the supervisor chat itself — self-loop
    // suppression drops it, so the event alone has no consumer).
    expect(mockPrisma.activity.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: UID, action: 'schedule_hard_deleted', resource: 'platform',
        metadata: expect.objectContaining({ scheduleId: 'sch2', sessionId: 'sup1', reason: 'obsolete', source: 'sweep-dedupe' }),
      }),
    });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: UID, action: 'schedule_hard_deleted',
        metadata: expect.objectContaining({ scheduleId: 'sch3' }),
      }),
    });
  });

  it('NEVER throws: a prisma failure degrades to a warn log + null', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
    mockPrisma.crossModelChat.findFirst.mockRejectedValue(new Error('db down'));

    const chat = await ensureFleetSupervisor(UID);
    expect(chat).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ensure failed'));
  });
});

/* ====================================================================
 * Hardening review 2026-09-14 — the sweep ensure dedupes/heals ONLY stock
 * rows (opener match). The supervisor's own machine-armed recurring rows are
 * never deleted or rewritten and never mask a dead stock sweep; an OWNER-
 * customized recurring row (c0e22e36's shape) IS the cadence — no stock sweep
 * is armed beside it. Mirrors the project-supervisor suite.
 * ==================================================================== */
describe('ensureSweepSchedule — stock-partitioned dedupe (hardening review 2026-09-14)', () => {
  function mockSupervisorWithSweeps(rows: any[]) {
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ ...SUP, systemPrompt: buildFleetSupervisorPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'sup1' });
    mockPrisma.eventHook.findFirst.mockResolvedValue({ id: 'h1', eventTypes: [...HOOK_TYPES] });
    mockPrisma.chatSchedule.findMany.mockResolvedValue(rows);
  }
  const STOCK = (id: string, over: any = {}) => ({ id, prompt: buildFleetSweepPrompt(), kind: 'recurring', runsCount: 3, promptSetBy: 'system', ...over });
  const MACHINE = (id: string, over: any = {}) => ({ id, prompt: 'poll the Post-CPT lane every 30 min', kind: 'recurring', runsCount: 5, promptSetBy: 'machine', ...over });

  it('THE BUG (prod b96b381e, 2026-09-03): the stock sweep + a machine-armed recurring row → nothing deleted, nothing emitted, nothing created', async () => {
    mockSupervisorWithSweeps([STOCK('sweep1'), MACHINE('mon1')]);
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.chatSchedule.deleteMany).not.toHaveBeenCalled();
    expect(emitScheduleDisabled).not.toHaveBeenCalled();
    expect(mockPrisma.chatSchedule.create).not.toHaveBeenCalled();
    expect(mockPrisma.chatSchedule.update).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).not.toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'schedule_hard_deleted' }) });
  });

  it('a machine-armed recurring row ALONE does not mask a dead stock sweep → the stock sweep is created; the machine row is untouched', async () => {
    mockSupervisorWithSweeps([MACHINE('mon1')]);
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.chatSchedule.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.chatSchedule.create.mock.calls[0][0].data.prompt).toBe(buildFleetSweepPrompt());
    expect(mockPrisma.chatSchedule.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.chatSchedule.update).not.toHaveBeenCalled();
  });

  it('the owner\'s CUSTOMIZED sweep (promptSetBy user, no opener — the live c0e22e36 shape) ALONE is the cadence → no create, no update, no delete', async () => {
    mockSupervisorWithSweeps([{ id: '04e2e041', prompt: 'Check on the Acme migration hourly and report.', kind: 'recurring', runsCount: 383, promptSetBy: 'user' }]);
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.chatSchedule.create).not.toHaveBeenCalled();
    expect(mockPrisma.chatSchedule.update).not.toHaveBeenCalled();
    expect(mockPrisma.chatSchedule.deleteMany).not.toHaveBeenCalled();
  });

  it('a legacy prompt-less row (promptSetBy NULL — predates the column) is treated as owner-authored: no create beside it, never deleted', async () => {
    mockSupervisorWithSweeps([{ id: 'legacy1', prompt: 'hourly check', kind: 'recurring', runsCount: 40, promptSetBy: null }]);
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.chatSchedule.create).not.toHaveBeenCalled();
    expect(mockPrisma.chatSchedule.deleteMany).not.toHaveBeenCalled();
  });

  it('two stock rows + a machine row → ONLY the newer stock duplicate is emitted/audited/deleted', async () => {
    mockSupervisorWithSweeps([STOCK('sweep1', { runsCount: 10 }), MACHINE('mon1'), STOCK('sweep2', { runsCount: 0 })]);
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.chatSchedule.deleteMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.chatSchedule.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['sweep2'] } } });
    expect(emitScheduleDisabled).toHaveBeenCalledTimes(1);
    expect(emitScheduleDisabled).toHaveBeenCalledWith({ id: 'sweep2', sessionId: 'sup1', kind: 'recurring' }, 'obsolete', 0);
    expect(mockPrisma.activity.create).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ metadata: expect.objectContaining({ scheduleId: 'mon1' }) }),
    });
    expect(mockPrisma.chatSchedule.create).not.toHaveBeenCalled();
  });

  it('a renewOnExhaustion successor (opener, promptSetBy system) NEWER than an older machine row is the keeper — the old predicate deleted the successor and left the lane deaf', async () => {
    mockSupervisorWithSweeps([MACHINE('mon1'), STOCK('successor', { runsCount: 0 })]);
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.chatSchedule.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.chatSchedule.create).not.toHaveBeenCalled();
    expect(mockPrisma.chatSchedule.update).not.toHaveBeenCalled();
  });

  it('the stale-prompt heal rewrites ONLY the stock keeper — a machine row is never rewritten', async () => {
    mockSupervisorWithSweeps([STOCK('sweep1', { prompt: 'Fleet Supervisor sweep — OLD VERSION' }), MACHINE('mon1')]);
    await ensureFleetSupervisor(UID);
    expect(mockPrisma.chatSchedule.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.chatSchedule.update).toHaveBeenCalledWith({
      where: { id: 'sweep1' },
      data: { prompt: buildFleetSweepPrompt(), promptSetBy: 'system' },
    });
  });
});

describe('disableOrphanWildcardHooks (ticket a507e650)', () => {
  // A target chat that WAS once a supervisor carries the system-written
  // prompt opener (no user-facing endpoint edits a chat's systemPrompt).
  const FORMER_SUP = (id: string) => ({ id, systemPrompt: `${SUPERVISOR_PROMPT_OPENER}\n\nlegacy stock prompt` });
  const PLAIN_CHAT = (id: string) => ({ id, systemPrompt: null });
  /** An enabled wildcard row as the DB returns it; STOCK-looking by default. */
  const hook = (id: string, targetChatId: string, over: Record<string, any> = {}) => ({
    id, targetChatId, promptTemplate: '', eventTypes: [...HOOK_TYPES], ...over,
  });
  /**
   * Pin BOTH crossModelChat.findMany reads in one mock: the isSupervisor
   * lookup (current supervisors) and the by-id target-chat opener lookup.
   */
  function mockChatReads(supervisors: any[], targets: any[]) {
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) =>
      args?.where?.isSupervisor === true ? supervisors : targets,
    );
  }

  beforeEach(() => {
    // The event-set heal suite above leaves eventHook.update REJECTED with a
    // non-once mock ('a heal failure degrades to a warn') and clearAllMocks
    // keeps implementations — re-pin a working default for this suite.
    mockPrisma.eventHook.update.mockResolvedValue({});
  });

  it('scopes the reads correctly: current supervisors + the user\'s ENABLED WILDCARD hooks (with the stock-check fields)', async () => {
    // The where clauses ARE the non-wildcard (c) and already-disabled (d)
    // guards: both classes are excluded at the DB, never reaching the filter.
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'sup1' }]);
    mockPrisma.eventHook.findMany.mockResolvedValue([]);

    const n = await disableOrphanWildcardHooks(UID);

    // No candidates → the target-chat opener fetch never runs.
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledWith({
      where: { userId: UID, isSupervisor: true },
      select: { id: true },
    });
    expect(mockPrisma.eventHook.findMany).toHaveBeenCalledWith({
      where: { userId: UID, sourceChatId: null, enabled: true },
      select: { id: true, targetChatId: true, promptTemplate: true, eventTypes: true },
    });
    expect(n).toBe(0);
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();
  });

  it('(a) disables a STOCK wildcard on a FORMER-supervisor target + audits hook.orphan_gc + logs', async () => {
    mockChatReads([{ id: 'sup1' }], [FORMER_SUP('old-chat')]);
    mockPrisma.eventHook.findMany.mockResolvedValue([hook('h-orphan', 'old-chat')]);

    const n = await disableOrphanWildcardHooks(UID);

    expect(n).toBe(1);
    // The candidate target chats are fetched in ONE batch, opener included.
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['old-chat'] } },
      select: { id: true, systemPrompt: true },
    });
    expect(mockPrisma.eventHook.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({
      where: { id: 'h-orphan' },
      data: { enabled: false },
    });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: UID,
        action: 'hook.orphan_gc',
        resource: 'platform',
        metadata: expect.objectContaining({
          hookId: 'h-orphan',
          targetChatId: 'old-chat',
          reason: 'stock wildcard hook targets a former supervisor chat (no longer isSupervisor)',
        }),
      }),
    });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('orphan wildcard hook'));
  });

  it('(b) leaves a wildcard targeting a CURRENT supervisor untouched', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'sup1' }]);
    mockPrisma.eventHook.findMany.mockResolvedValue([hook('h-ok', 'sup1')]);

    const n = await disableOrphanWildcardHooks(UID);

    expect(n).toBe(0);
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledTimes(1); // no candidates
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).not.toHaveBeenCalled();
  });

  it('(d) is idempotent: an already-disabled orphan never reaches the filter (enabled:true query) → untouched', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'sup1' }]);
    mockPrisma.eventHook.findMany.mockResolvedValue([]); // the DB honors enabled:true — nothing returned

    const n = await disableOrphanWildcardHooks(UID);

    expect(n).toBe(0);
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).not.toHaveBeenCalled();
  });

  it('(e) zero-supervisor user: only stock wildcards on FORMER-supervisor targets are disabled — a stock wildcard on an ORDINARY chat SURVIVES', async () => {
    // The old over-broad predicate disabled BOTH of these; the narrowed one
    // recognizes chat-b as a user-deliberate target (no system-written
    // supervisor opener) and never touches it.
    mockChatReads([], [FORMER_SUP('chat-a'), PLAIN_CHAT('chat-b')]);
    mockPrisma.eventHook.findMany.mockResolvedValue([
      hook('h-1', 'chat-a'),
      hook('h-2', 'chat-b'),
    ]);

    const n = await disableOrphanWildcardHooks(UID);

    expect(n).toBe(1);
    expect(mockPrisma.eventHook.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({ where: { id: 'h-1' }, data: { enabled: false } });
    expect(mockPrisma.activity.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'hook.orphan_gc',
        metadata: expect.objectContaining({ hookId: 'h-1' }),
      }),
    });
  });

  it('a CUSTOM-promptTemplate wildcard on a former-supervisor target is user-deliberate → untouched', async () => {
    // Wildcard→any-target is a shipped feature (subscribeHook): a custom
    // template proves user authorship even when the target was a supervisor.
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'sup1' }]);
    mockPrisma.eventHook.findMany.mockResolvedValue([
      hook('h-custom', 'old-sup', { promptTemplate: 'Tell me about {{eventType}} in {{sourceChatTitle}}' }),
    ]);

    const n = await disableOrphanWildcardHooks(UID);

    expect(n).toBe(0);
    // The template check rejects it BEFORE the target-chat fetch ever runs.
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).not.toHaveBeenCalled();
  });

  it('a NARROWED-BUT-STOCK event set stays GC-eligible (stock-looking); the same with a custom template does NOT', async () => {
    // A type OUTSIDE the stock universe can't occur via validated writes
    // (subscribeHook rejects non-HOOK_EVENT_TYPES), so the event-axis pin is:
    // subsets of the stock universe are stock — the template differentiates.
    mockChatReads([{ id: 'sup1' }], [FORMER_SUP('old-1'), FORMER_SUP('old-2')]);
    mockPrisma.eventHook.findMany.mockResolvedValue([
      hook('h-narrow-stock', 'old-1', { eventTypes: ['run_failed'] }),
      hook('h-narrow-custom', 'old-2', { eventTypes: ['run_failed'], promptTemplate: 'custom' }),
    ]);

    const n = await disableOrphanWildcardHooks(UID);

    expect(n).toBe(1);
    expect(mockPrisma.eventHook.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({ where: { id: 'h-narrow-stock' }, data: { enabled: false } });
    expect(mockPrisma.activity.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'hook.orphan_gc',
        metadata: expect.objectContaining({ hookId: 'h-narrow-stock' }),
      }),
    });
  });

  it('a candidate whose target chat row is MISSING is skipped — no update, no audit (defensive)', async () => {
    mockChatReads([{ id: 'sup1' }], []); // the by-id opener fetch finds nothing
    mockPrisma.eventHook.findMany.mockResolvedValue([hook('h-ghost', 'ghost-chat')]);

    const n = await disableOrphanWildcardHooks(UID);

    expect(n).toBe(0);
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).not.toHaveBeenCalled();
  });

  it('disables only the orphans in a MIXED set (supervisor-targeted wildcard survives)', async () => {
    mockChatReads([{ id: 'sup1' }], [FORMER_SUP('old-chat')]);
    mockPrisma.eventHook.findMany.mockResolvedValue([
      hook('h-ok', 'sup1'),
      hook('h-orphan', 'old-chat'),
    ]);

    const n = await disableOrphanWildcardHooks(UID);

    expect(n).toBe(1);
    expect(mockPrisma.eventHook.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({ where: { id: 'h-orphan' }, data: { enabled: false } });
  });

  it('per-hook isolation: one failing update does not block the rest (warn, count only successes)', async () => {
    mockChatReads([{ id: 'sup1' }], [FORMER_SUP('chat-a'), FORMER_SUP('chat-b')]);
    mockPrisma.eventHook.findMany.mockResolvedValue([
      hook('h-bad', 'chat-a'),
      hook('h-good', 'chat-b'),
    ]);
    mockPrisma.eventHook.update
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({});

    const n = await disableOrphanWildcardHooks(UID);

    expect(n).toBe(1);
    expect(mockPrisma.eventHook.update).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('orphan wildcard-hook GC failed'));
    // Only the successful disable is audited.
    expect(mockPrisma.activity.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'hook.orphan_gc',
        metadata: expect.objectContaining({ hookId: 'h-good' }),
      }),
    });
  });

  it('returns 0 for a blank userId without touching the DB', async () => {
    const n = await disableOrphanWildcardHooks('');
    expect(n).toBe(0);
    expect(mockPrisma.crossModelChat.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.findMany).not.toHaveBeenCalled();
  });
});

describe('fleet sweep ACCOUNT dormancy (autonomy loop #18): park while the account is dormant, resume the parked row when work returns', () => {
  const SUP = { id: 'sup-idle', userId: 'u-idle', title: 'Fleet Supervisor', projectId: null, systemPrompt: null };
  const stockRow = { id: 'sweep-1', prompt: stockSweepPrompt(), kind: 'recurring', runsCount: 88, promptSetBy: 'system' };
  const gate = (o: { runs?: number; goals?: number; sched?: number } = {}) => {
    mockPrisma.crossModelProject = { ...(mockPrisma.crossModelProject ?? {}), findMany: jest.fn(async () => [{ id: 'p1' }]) };
    mockPrisma.agentRun = { ...(mockPrisma.agentRun ?? {}), count: jest.fn(async () => o.runs ?? 0) };
    mockPrisma.projectGoal = { count: jest.fn(async () => o.goals ?? 0) };
    mockPrisma.projectTodo = { count: jest.fn(async () => 0) };
    mockPrisma.watchedResource = { count: jest.fn(async () => 0) };
    mockPrisma.chatSchedule.count = jest.fn(async () => o.sched ?? 0);
    mockPrisma.chatSchedule.findFirst = jest.fn(async () => null);
  };
  beforeEach(() => {
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ ...SUP });
    mockPrisma.chatSchedule.update.mockClear();
    mockPrisma.chatSchedule.create.mockClear();
    (emitScheduleDisabled as jest.Mock).mockClear();
  });

  it('a DORMANT account (no run in 7 d, nothing live) PARKS the enabled stock sweep: enabled:false + parked:dormant, schedule_disabled(parked_dormant), no create', async () => {
    gate();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([stockRow]);
    await ensureFleetSupervisor('u-idle');
    expect(mockPrisma.chatSchedule.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'sweep-1' },
      data: expect.objectContaining({ enabled: false, lastStatus: 'parked:dormant', cancelledBy: 'machine' }),
    }));
    expect(emitScheduleDisabled).toHaveBeenCalledWith(expect.objectContaining({ id: 'sweep-1', sessionId: 'sup-idle' }), 'parked_dormant', 88, expect.objectContaining({ detail: expect.stringContaining('dormant') }));
    expect(mockPrisma.chatSchedule.create).not.toHaveBeenCalled();
  });

  it('a LIVE account with a parked row RESUMES it (enabled:true, lastStatus resumed, fresh nextRunAt/expiresAt, stock prompt) instead of creating a second sweep', async () => {
    gate({ runs: 3 });
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]); // nothing enabled
    mockPrisma.chatSchedule.findFirst = jest.fn(async () => ({ id: 'sweep-1', runsCount: 88 }));
    await ensureFleetSupervisor('u-idle');
    expect(mockPrisma.chatSchedule.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: 'sup-idle', kind: 'recurring', enabled: false, lastStatus: 'parked:dormant' },
    }));
    expect(mockPrisma.chatSchedule.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'sweep-1' },
      data: expect.objectContaining({ enabled: true, lastStatus: 'resumed', cancelledBy: null, disabledAt: null, promptSetBy: 'system', prompt: stockSweepPrompt() }),
    }));
    expect(mockPrisma.chatSchedule.create).not.toHaveBeenCalled();
  });

  it('a LIVE account with an enabled stock sweep is untouched by the gate (heal path as before)', async () => {
    gate({ runs: 1 });
    mockPrisma.chatSchedule.findMany.mockResolvedValue([stockRow]);
    await ensureFleetSupervisor('u-idle');
    expect(mockPrisma.chatSchedule.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastStatus: 'parked:dormant' }) }));
  });
});

// ── Supervisor OFF switch (owner 2026-09-26; platform/supervisor-switch.ts) ──
// While the Fleet Supervisor is switched off, ensure is READ-ONLY: an existing
// chat comes back untouched (no autonomy/prompt/hook/sweep heal — a dead sweep
// is NOT re-armed) and no chat is created for an owner who has none.
import { invalidateSupervisorSwitchCache, resetSupervisorSwitchMetricWindowForTests } from './supervisor-switch';

describe('supervisor OFF switch × ensureFleetSupervisor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
    mockPrisma.systemSetting.findUnique.mockImplementation(async ({ where }: any) => (where?.key === 'fleet_supervisor_enabled' ? { key: where.key, value: '0', updatedAt: new Date() } : null));
    invalidateSupervisorSwitchCache();
    resetSupervisorSwitchMetricWindowForTests();
  });
  afterAll(() => { mockPrisma.systemSetting.findUnique.mockImplementation(async () => null); invalidateSupervisorSwitchCache(); });

  it('an EXISTING supervisor is returned untouched — no heal, no arm, no wake', async () => {
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ ...SUP, systemPrompt: 'legacy prompt' });
    const chat = await ensureFleetSupervisor(UID);
    expect(chat).toMatchObject({ id: 'sup1' });
    expect(mockPrisma.chatAutonomy.findUnique).not.toHaveBeenCalled(); // no autonomy heal
    expect(mockPrisma.eventHook.findFirst).not.toHaveBeenCalled(); // no wildcard-hook heal
    expect(mockPrisma.chatSchedule.findMany).not.toHaveBeenCalled(); // no sweep heal/arm
    expect(mockPrisma.chatSchedule.create).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled(); // not even the prompt heal
    expect(mockRedisIncr).not.toHaveBeenCalled(); // returning an existing chat is not a skipped wake
  });

  it('an owner with NO supervisor gets none created (null) and one counted skip (source ensure)', async () => {
    mockPrisma.crossModelChat.findFirst.mockResolvedValue(null);
    expect(await ensureFleetSupervisor(UID)).toBeNull();
    expect(mockPrisma.crossModelChat.create).not.toHaveBeenCalled();
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
    await new Promise((r) => setImmediate(r));
    expect(mockRedisIncr).toHaveBeenCalledWith('supervisor_switch:skipped:fleet');
  });

  it('back ON (cache invalidated) the same fresh owner is provisioned as before', async () => {
    mockPrisma.systemSetting.findUnique.mockResolvedValue(null);
    invalidateSupervisorSwitchCache();
    mockFreshOwner();
    const chat = await ensureFleetSupervisor(UID);
    expect(chat).toMatchObject({ id: 'sup1', isSupervisor: true });
    expect(mockPrisma.crossModelChat.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.eventHook.create).toHaveBeenCalledTimes(1);
  });
});


// ── KPI contract + adoption rule in the FLEET prompt (tt-rd audit 2026-09-27) ──
describe('fleet supervisor prompt — MISSION KPI CONTRACT + ADOPTION RULE lines (kpi-honesty-loops)', () => {

  it('the ADOPTION RULE follows the STUCK RULE / WATCHDOG lines and the MISSION KPI CONTRACT follows the PREMISES + FOLLOW-THROUGH bullet', () => {
    const p = buildFleetSupervisorPrompt();
    // Layered prompts (sup/integration 2026-09-27): generic headers.
    expect(p.indexOf('- ADOPTION RULE:')).toBeGreaterThan(p.indexOf('- STUCK RULE:'));
    expect(p.indexOf('- MISSION KPI CONTRACT:')).toBeGreaterThan(p.indexOf('- PREMISES + FOLLOW-THROUGH'));
    expect(p).toContain('A KPI rate in projects[].status or an owner answer is QUOTED from the register');
    expect(p).not.toContain('NEVER type a number into projects[].status'); // fixer follow-up: contradicted VERIFY BEFORE DONE / BOARD FACTS in the same prompt
    expect(p).toContain('never relay a fold as progress to the owner');
  });

  it('the KPI contract and the time-boxing (ADOPTION RULE) lines always render — neither has a switch since build 2026-10-08 S-2', () => {
    const p = buildFleetSupervisorPrompt();
    expect(p).toContain('MISSION KPI CONTRACT');
    expect(p).toContain('ADOPTION RULE');
  });
});

/* audit 2026-10-06 T3-10 (fleet F12): the Fleet's wildcard hook template said
 * "full text in your sweep schedule 04e2e041" weeks after 04e2e041 was cancelled
 * and replaced by b8cee3ad. The ensure / watchdog heal rewrites ONLY a dead
 * schedule id of THIS chat (or one that no longer exists) after the word
 * "schedule" — to the live sweep's id — and leaves everything else verbatim.
 * Kill switch SUPERVISOR_HOOK_TEMPLATE_HEAL_DISABLED=1. */
describe('audit 2026-10-06 T3-10 — stale schedule references in the wildcard hook template', () => {
  const TEMPLATE = 'Fleet event from "{{sourceChatTitle}}": {{summary}} — full text in your sweep schedule 04e2e041; lane watch schedule 77aa66bb stays.';
  const LIVE = 'b8cee3ad-1111-4222-8333-444444444444';
  const route = (referenced: any[]) => {
    mockPrisma.chatSchedule.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.OR) return referenced;
      if (args?.where?.kind === 'recurring' && args?.where?.enabled === true) return [{ id: LIVE, prompt: buildFleetSweepPrompt() }];
      return [];
    });
    mockPrisma.eventHook.findFirst.mockResolvedValue({ id: 'h1', eventTypes: HOOK_TYPES, debounceSec: SUPERVISOR_HOOK_DEBOUNCE_SEC, promptTemplate: TEMPLATE });
  };
  afterEach(() => { delete process.env.SUPERVISOR_HOOK_TEMPLATE_HEAL_DISABLED; });

  it('pure: refs are the 8-hex ids after "schedule"; a rewrite touches only the stale ones', () => {
    expect(scheduleRefsInTemplate(TEMPLATE)).toEqual(['04e2e041', '77aa66bb']);
    expect(rewriteStaleScheduleRefs(TEMPLATE, new Map([['04e2e041', 'b8cee3ad']]))).toBe(TEMPLATE.replace('04e2e041', 'b8cee3ad'));
    expect(rewriteStaleScheduleRefs('see schedule 04e2e041-aaaa-bbbb-cccc-dddddddddddd now', new Map([['04e2e041', null]])))
      .toBe('see schedule (current id: see get_chat_status → schedules) now');
  });

  it('a CANCELLED sweep id of this chat is healed to the live sweep; another chat\'s id is never touched', async () => {
    route([
      { id: '04e2e041-0000-4000-8000-000000000000', enabled: false, sessionId: 'sup1' },
      { id: '77aa66bb-0000-4000-8000-000000000000', enabled: false, sessionId: 'lane-9' },
    ]);
    await healSupervisorWildcardHook('sup1', UID);
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({ where: { id: 'h1' }, data: { promptTemplate: TEMPLATE.replace('04e2e041', 'b8cee3ad') } });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'hook.update' }) }));
  });

  it('live references, an empty (stock) template and the kill switch leave the hook untouched', async () => {
    route([{ id: '04e2e041-0000-4000-8000-000000000000', enabled: true, sessionId: 'sup1' }, { id: '77aa66bb-0000-4000-8000-000000000000', enabled: true, sessionId: 'lane-9' }]);
    await healSupervisorWildcardHook('sup1', UID);
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();

    jest.clearAllMocks();
    route([]);
    mockPrisma.eventHook.findFirst.mockResolvedValue({ id: 'h1', eventTypes: HOOK_TYPES, debounceSec: SUPERVISOR_HOOK_DEBOUNCE_SEC, promptTemplate: '' });
    await healSupervisorWildcardHook('sup1', UID);
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();

    jest.clearAllMocks();
    process.env.SUPERVISOR_HOOK_TEMPLATE_HEAL_DISABLED = '1';
    route([{ id: '04e2e041-0000-4000-8000-000000000000', enabled: false, sessionId: 'sup1' }]);
    await healSupervisorWildcardHook('sup1', UID);
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();
  });
});
