/**
 * Ticket 661fb494 (2026-09-18) — REPLAY TEST: cross-project directive
 * contamination (the Nebius / GLM-5.3 incidents).
 *
 * WHAT HAPPENED: owner directives posted in ONE project's chat were applied
 * fleet-wide twice in a day. (1) "the nebius nodes are to stay off… just use
 * hf token to download to run pod" (posted in the INFERENCE project's chat,
 * msg 1fc22db5) was generalized by fleet owner-question triage into "stop the
 * canaries too: all nebius nodes stay off, including the SFT-2 smoke chain"
 * (oq_e18bed76) — CanLaw's SFT-2 chain parked ~18h until the owner corrected
 * ("no no you use nebius for sft2 obviously gogogo", msg 6a2a50dd). (2) "Stop
 * all work on glm5.3 and all future goals and tasks" (posted in the
 * spark-cluster Supervisor chat, msg c4f03839) was applied to the INFERENCE
 * project's GLM-5.3 deployment (oq_545cce84).
 *
 * ROOT CAUSE: owner directives carried NO scope metadata anywhere in the
 * pipeline, and cross-project triage generalized categorical-sounding project
 * messages into fleet rulings.
 *
 * THE FIX pinned here:
 *   - owner-questions.ts CROSS_PROJECT_SCOPE_QUESTION_RE → a lane asking
 *     whether a directive from ANOTHER project applies to its own work routes
 *     straight to the OWNER (route 'owner', reason 'cross_project_scope'),
 *     never to supervisor triage — both incidents' question shapes replayed;
 *   - flagOwnerQuestion: a machine-flagged scope question is NOT triaged (no
 *     'supervisor' triage stamp, the owner DM goes out, no triage wake), and
 *     a control approval question still IS triaged — with the triage wake now
 *     naming the filing chat's project (triageOriginLabel);
 *   - doctrine wiring: the scope rule (core-doctrine.ts CORE_SCOPE_RULE) rides the
 *     fleet prompt, both project-supervisor prompts, and the
 *     answer_owner_question tool contract;
 *   - supervisor-state scope stamps: appendDirective stamps the chat's project
 *     ('fleet' when projectless), appendAnsweredQuestionDirective stamps the
 *     asking chat's scope, applyStateUpdate accepts scope on add + re-stamp,
 *     and formatStateForWake renders "[scope: …]" on every directive line.
 *
 * Scaffolding mirrors owner-questions.triage.2026-09-13.test.ts (the flag/
 * triage legs) and supervisor-state.service.test.ts (the state-doc legs) —
 * ONE combined database mock serves both modules.
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockQuestions = createOwnerQuestionTable();

// ── Combined Prisma mock ─────────────────────────────────────────────────────
const mockChatFindUnique: jest.Mock = jest.fn();
const mockTelegramLinkFindUnique: jest.Mock = jest.fn(async (): Promise<any> => null);
const mockSupervisorStateFindUnique: jest.Mock = jest.fn();
const mockSupervisorStateUpsert: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: {
      ...mockQuestions.crossModelChat,
      findUnique: (...a: any[]) => mockChatFindUnique(...a),
      // The supervisor-ledger probe (appendAnswerToSupervisorLedger) looks the
      // owner's supervisor chat up with findFirst.
      findFirst: jest.fn(async () => ({ id: 'sup-chat' })),
    },
    telegramLink: { findUnique: (...a: any[]) => mockTelegramLinkFindUnique(...a) },
    supervisorState: {
      findUnique: (...a: any[]) => mockSupervisorStateFindUnique(...a),
      upsert: (...a: any[]) => mockSupervisorStateUpsert(...a),
    },
    // supervisor-state.service's fleet-attention block reads these (unused
    // here but referenced at call time — keep the shapes it expects).
    crossModelProject: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
    projectTodo: { findMany: jest.fn(async () => []) },
    chatSchedule: { findMany: jest.fn(async () => []) },
    agentRun: { groupBy: jest.fn(async () => []) },
  },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
const mockDailyCapExceeded: jest.Mock = jest.fn(async (): Promise<number | null> => null);
const mockRefundDailyCapToken: jest.Mock = jest.fn(async () => {});
const mockArmRetry: jest.Mock = jest.fn(async () => ({ ok: true, scheduleId: 'sched-retry-1' }));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: (...a: any[]) => mockDailyCapExceeded(...a),
  refundDailyCapToken: (...a: any[]) => mockRefundDailyCapToken(...a),
  armOwnerAnswerRetrySchedule: (...a: any[]) => mockArmRetry(...a),
  emitScheduleDisabled: jest.fn(async () => undefined),
}));

const mockTelegramSendMessage: jest.Mock = jest.fn(async () => true);
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => true,
  sendMessage: (...a: any[]) => mockTelegramSendMessage(...a),
}));

// goals.service pulls env.ts at import (the answer path imports it
// dynamically) — mock the boundary exactly as the triage suite does.
jest.mock('./goals.service', () => ({
  __esModule: true,
  unblockOwnerGatedItems: jest.fn(async () => ({ unblockedTodos: 0, unblockedGoals: 0 })),
}));

const mockEmitHookEventSafe: jest.Mock = jest.fn(async () => {});
jest.mock('./hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: (...a: any[]) => mockEmitHookEventSafe(...a),
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    OWNER_QUESTION_TRIAGED: 'owner_question_triaged',
    OWNER_QUESTION_SURFACED: 'owner_question_surfaced',
    OWNER_QUESTION_SUPERVISOR_ANSWERED: 'owner_question_supervisor_answered',
  },
}));

// The prompt builders (supervisor.service / project-supervisor.service)
// statically pull autonomy.service → error-handler + crossmodel.service —
// mock those boundaries (env.ts would process.exit the jest worker).
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: jest.fn() },
}));

// supervisor-state.service's applyStateUpdate loads these dynamically for
// write-time citation validation (ticket cfeb1a57) — mirror the state suite.
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));
const mockCitedMessageRowExists = jest.fn(async (_id: string) => true);
const mockCitedScheduleRowExists = jest.fn(async (_id: string) => true);
const mockSamePrefixRealIds = jest.fn(async (_kind: string, _id: string, _userId?: string) => [] as string[]);
jest.mock('./action-verifier', () => {
  const actual = jest.requireActual('./action-verifier');
  return {
    ...actual,
    citedMessageRowExists: (...a: any[]) => (mockCitedMessageRowExists as any)(...a),
    citedScheduleRowExists: (...a: any[]) => (mockCitedScheduleRowExists as any)(...a),
    samePrefixRealIds: (...a: any[]) => (mockSamePrefixRealIds as any)(...a),
  };
});

import {
  OWNER_ONLY_QUESTION_CLASSES,
  classifyOwnerQuestionRouting,
  flagOwnerQuestion,
} from './owner-questions';
import {
  appendAnsweredQuestionDirective,
  appendDirective,
  applyStateUpdate,
  formatStateForWake,
  getSupervisorState,
  SupervisorStateDoc,
} from './supervisor-state.service';
import { buildFleetSupervisorPrompt } from './supervisor.service';
import { buildProjectSupervisorPrompt, buildProjectSupervisorSweepPrompt } from './project-supervisor.service';

const CHAT = 'lane-chat-1';
const UID = 'u1';
const flush = () => new Promise((r) => setTimeout(r, 10)); // fire-and-forget DM / wake / metric

/** In-memory supervisor_states table (chatId → stored state Json). */
let stateTable: Map<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  mockQuestions.reset();
  stateTable = new Map();
  mockSupervisorStateFindUnique.mockImplementation(async ({ where }: any) =>
    stateTable.has(where.chatId) ? { state: stateTable.get(where.chatId) } : null);
  mockSupervisorStateUpsert.mockImplementation(async ({ where, create, update }: any) => {
    stateTable.set(where.chatId, update?.state ?? create?.state);
    return {};
  });
  // Default filing/source chat: a non-supervisor lane chat in the CanLaw
  // project (the incident-1 geometry).
  mockChatFindUnique.mockImplementation(async () => ({
    isSupervisor: false,
    projectId: 'proj-canlaw',
    title: 'CanLaw Path C',
    project: { name: 'CanLaw' },
  }));
  // The owner has a linked Telegram — notifyOwnerOfNewFlag early-returns
  // without one, and the DM assertions below exercise the real path.
  mockTelegramLinkFindUnique.mockImplementation(async () => ({ chatId: 'tg-owner-1' }));
});

// ── 1. The deterministic routing guard (both incidents replayed) ─────────────

describe('classifyOwnerQuestionRouting — cross_project_scope (ticket 661fb494)', () => {
  it('INCIDENT 1 REPLAY (oq_e18bed76): "does the nebius stay-off directive apply to our SFT-2 chain?" routes to the OWNER, never to triage', () => {
    const r = classifyOwnerQuestionRouting(
      'The owner posted in the inference project chat that "the nebius nodes are to stay off — just use hf token to download to run pod". Does that directive apply to our SFT-2 smoke chain, which auto-starts Nebius B300 nodes?',
      'CanLaw SFT-2 pack/re-smoke chain — todo 61452343, Path C.',
    );
    expect(r.route).toBe('owner');
    expect(r.reason).toBe('cross_project_scope');
  });

  it('INCIDENT 2 REPLAY (oq_545cce84): "owner stopped glm5.3 in spark — should we also pause ours?" routes to the OWNER', () => {
    const r = classifyOwnerQuestionRouting(
      'The owner posted "Stop all work on glm5.3 and all future goals and tasks" in the spark-cluster Supervisor chat. Should we also pause the inference GLM-5.3-Flash instance?',
    );
    expect(r.route).toBe('owner');
    expect(r.reason).toBe('cross_project_scope');
  });

  it.each([
    'The owner said nebius nodes stay off — does that apply to its SFT-2 smoke chain?',
    'Is the standing desk policy fleet-wide, or spark-only?',
    'Does the halt from the other project bind us too?',
    'Another project got told to stop; should we also stop our canaries?',
    'Is this directive meant for every project?',
    'Does the GLM stop apply across the fleet?',
    'The spark stop was posted in that project — is it cross-project?',
  ])('scope-asking shape routes owner: %s', (q) => {
    const r = classifyOwnerQuestionRouting(q);
    expect(r.route).toBe('owner');
    expect(r.reason).toBe('cross_project_scope');
  });

  it.each([
    'Approve the staging window for tonight’s deploy?',
    'Proceed with the cross-model eval bench?',
    'Can we burn another 5k GPU hours on the bench run?',
    'Apply the migration to the database now?',
    'Should we renew the $9/mo metrics subscription?',
    'GO on the Path C re-smoke when the pack lands?',
  ])('ordinary approval still routes to supervisor triage: %s', (q) => {
    const r = classifyOwnerQuestionRouting(q);
    expect(r.route).toBe('supervisor');
    expect(r.reason).toBe('machine_lane_approval');
  });

  it('established owner-only classes keep precedence over the scope class', () => {
    const r = classifyOwnerQuestionRouting('Rotate the key for the deploy — and does that apply to all projects?');
    expect(r.route).toBe('owner');
    expect(r.reason).toBe('credentials');
    // …and the class ordering puts cross_project_scope LAST.
    expect(OWNER_ONLY_QUESTION_CLASSES[OWNER_ONLY_QUESTION_CLASSES.length - 1].reason).toBe('cross_project_scope');
  });

  it('context is scanned too (the scope wording often lives in the filed context)', () => {
    const r = classifyOwnerQuestionRouting(
      'Park the canaries?',
      'The inference project’s "nebius nodes stay off" note — checking whether it applies to our chain before acting.',
    );
    expect(r.route).toBe('owner');
    expect(r.reason).toBe('cross_project_scope');
  });
});

// ── 2. The flag path: a scope question is never triaged ─────────────────────

describe('flagOwnerQuestion — scope questions bypass supervisor triage (661fb494)', () => {
  it('a machine-lane scope question is created WITHOUT a supervisor triage stamp, DMs the owner, and never wakes the supervisor', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT,
      userId: UID,
      question: 'The owner said in the inference project that nebius nodes stay off — does that apply to our SFT-2 smoke chain?',
      machineTriggered: true,
    });
    expect(r.kind).toBe('created');
    await flush();
    const row = mockQuestions.rows[mockQuestions.rows.length - 1];
    expect(row.triage ?? null).not.toBe('supervisor');
    expect(mockTelegramSendMessage).toHaveBeenCalled();
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
  });

  it('a control approval question IS still triaged — and the wake names the filing project', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT,
      userId: UID,
      question: 'Approve the staging window for tonight’s deploy?',
      machineTriggered: true,
    });
    expect(r.kind).toBe('created');
    await flush();
    const row = mockQuestions.rows[mockQuestions.rows.length - 1];
    expect(row.triage).toBe('supervisor');
    expect(mockTelegramSendMessage).not.toHaveBeenCalled();
    expect(mockEmitHookEventSafe).toHaveBeenCalledTimes(1);
    const [srcChat, eventType, summary] = mockEmitHookEventSafe.mock.calls[0];
    expect(srcChat).toBe(CHAT);
    expect(eventType).toBe('attention_needed');
    expect(summary).toContain('[OWNER-QUESTION TRIAGE');
    // Ticket 661fb494: the filing chat's project rides the wake body…
    expect(summary).toContain('— filed from chat "CanLaw Path C" (project: CanLaw)');
    // …and the question id still survives as the tail (the answer handle).
    expect(summary).toMatch(/— question id oq_[0-9a-f-]+$/);
  });
});

// ── 3. Doctrine + prompt wiring ──────────────────────────────────────────────

describe('directive scope rule wiring (661fb494)', () => {
  // Layered prompts 2026-09-27: the composed prompts carry the GENERIC scope
  // rule (core-doctrine.ts CORE_SCOPE_RULE, rule id scope.project) — the same
  // substance, no ticket id or project name; the incident lives in
  // docs/FRAMEWORK_LESSONS.md. (The dated DIRECTIVE_SCOPE_RULE constant was
  // deleted with the pre-layering builders, build 2026-10-08 S-2.)
  it('rides the Fleet Supervisor system prompt (+ the triage-section SCOPE bullet)', () => {
    const p = buildFleetSupervisorPrompt();
    expect(p).toContain('## Directive scope — applying rule scope.project');
    expect(p).toContain('SCOPE (rule scope.project)');
    expect(p).toContain('Categorical about X as a class');
    expect(p).not.toContain('661fb494');
  });

  it('rides the project-supervisor SYSTEM prompt; the sweep body is slim (a sweep wake still can never re-derive narrower doctrine)', () => {
    const opts = { projectName: 'CanLaw', projectId: 'proj-canlaw', fleetSupervisorChatId: null };
    expect(buildProjectSupervisorPrompt(opts)).toContain('## Directive scope — applying rule scope.project');
    // Doctrine dedup 2026-09-18 (R&D stream 3 experiment #2): the scope rule
    // no longer duplicates into the STORED sweep body — it reaches every sweep
    // wake via the lane's cached system prompt, and the fire-time
    // trigger-keyed rebuild (sweep-doctrine-rebuild.ts) rebuilds it into the
    // firing message whenever the lane's system prompt lacks it, so NO wake
    // ever runs doctrine-less. Pinned in sweep-doctrine-rebuild.test.ts
    // (trigger-keyed/cold/post-compaction classes).
    expect(buildProjectSupervisorSweepPrompt(opts)).not.toContain('## Directive scope — applying the PROJECT-SCOPED rule above (ticket 661fb494)');
  });
});

// ── 4. Scoped directive records + restatement format ────────────────────────

describe('supervisor-state directive scope stamps (661fb494)', () => {
  const EMPTY: SupervisorStateDoc = { directives: [], archived: [], dispatches: [], projects: [], notes: '', refutations: [], inflightPreemptAt: '' };

  it('appendDirective stamps the chat’s project as the directive scope', async () => {
    await appendDirective(CHAT, UID, 'the nebius nodes are to stay off');
    const doc = await getSupervisorState(CHAT);
    expect(doc.directives).toHaveLength(1);
    expect(doc.directives[0].scope).toBe('CanLaw');
    expect(doc.directives[0].origin).toBe('owner'); // the harness provenance stamp (project-brief owner-origin filter)
  });

  it('appendDirective on a projectless chat stamps scope "fleet"', async () => {
    mockChatFindUnique.mockImplementation(async () => ({ isSupervisor: true, projectId: null, project: null }));
    await appendDirective('fleet-chat', UID, 'use all hardware');
    const doc = await getSupervisorState('fleet-chat');
    expect(doc.directives[0].scope).toBe('fleet');
  });

  it('appendDirective still captures when the scope lookup fails (legacy scopeless form)', async () => {
    mockChatFindUnique.mockImplementation(async () => { throw new Error('db down'); });
    await appendDirective(CHAT, UID, 'keep an eye on the re-smoke');
    const doc = await getSupervisorState(CHAT);
    expect(doc.directives).toHaveLength(1);
    expect(doc.directives[0].scope).toBeUndefined();
  });

  it('appendAnsweredQuestionDirective stamps the asking chat’s scope on the banked ruling', async () => {
    await appendAnsweredQuestionDirective('sup-chat', UID, {
      questionId: 'oq_e18bed76-0000-0000-0000-000000000000',
      question: 'does the nebius stop apply to our SFT-2 chain?',
      answer: 'no no you use nebius for sft2 obviously gogogo',
      scope: 'CanLaw',
    });
    const doc = await getSupervisorState('sup-chat');
    expect(doc.directives).toHaveLength(1);
    expect(doc.directives[0].scope).toBe('CanLaw');
    expect(doc.directives[0].status).toBe('done');
    expect(doc.directives[0].evidence).toContain('oq oq_e18bed76');
    expect(doc.directives[0].origin).toBe('owner_question'); // the harness provenance stamp
  });

  it('formatStateForWake renders [scope: …] on open directive lines (the restatement format)', () => {
    const doc: SupervisorStateDoc = {
      ...EMPTY,
      directives: [
        { id: 'd1', text: 'the nebius nodes are to stay off', at: new Date(Date.now() - 60_000).toISOString(), status: 'open', scope: 'inference' },
        { id: 'd2', text: 'legacy scopeless directive', at: new Date(Date.now() - 120_000).toISOString(), status: 'open' },
      ],
    };
    const block = formatStateForWake(doc);
    expect(block).toContain('[scope: inference] the nebius nodes are to stay off');
    expect(block).toContain('legacy scopeless directive');
    expect(block).not.toContain('[scope: ]');
  });

  it('applyStateUpdate accepts scope on add and re-stamps it on update-by-id', async () => {
    const add = await applyStateUpdate(CHAT, UID, {
      // the model item CLAIMS owner provenance — the merge never stamps it (only the harness capture paths do)
      directives: [{ text: 'stop all work on glm5.3', scope: 'spark-cluster', origin: 'owner' } as any],
    });
    expect(add.errors).toEqual([]);
    let doc = await getSupervisorState(CHAT);
    expect(doc.directives).toHaveLength(1);
    expect(doc.directives[0].scope).toBe('spark-cluster');
    expect(doc.directives[0].origin).toBeUndefined();
    const id = doc.directives[0].id;
    const upd = await applyStateUpdate(CHAT, UID, {
      directives: [{ id, scope: 'inference' }],
    });
    expect(upd.errors).toEqual([]);
    doc = await getSupervisorState(CHAT);
    expect(doc.directives[0].scope).toBe('inference');
  });

  it('the scope survives the stored-doc parse (round trip through parseDoc)', async () => {
    stateTable.set(CHAT, {
      directives: [
        { id: 'd9', text: 'x', at: new Date().toISOString(), status: 'open', scope: 'inference', origin: 'owner' },
        { id: 'd10', text: 'y', at: new Date().toISOString(), status: 'open', scope: 'inference', origin: 'model-claims-owner' },
      ],
      dispatches: [], projects: [], notes: '', refutations: [],
    });
    const doc = await getSupervisorState(CHAT);
    expect(doc.directives[0].scope).toBe('inference');
    expect(doc.directives[0].origin).toBe('owner');   // the harness stamp survives the round trip
    expect(doc.directives[1].origin).toBeUndefined(); // anything but the two literal values is dropped on parse
  });
});
