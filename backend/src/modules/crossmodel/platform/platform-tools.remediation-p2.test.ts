/**
 * Remediation P2 — platform-tools wiring:
 *   N3/v1#5  flag_owner_question: options/forChatId/goalId/todoId pass through;
 *            structured multi_decision + previously_answered envelopes;
 *            machineTriggered threads from ctx.userTurnAt
 *   item 8   update_schedule: the directive-conflict guard fires on MACHINE
 *            prompt rewrites only; override args pass through; [DIRECTIVE
 *            CONFLICT] refusals never reach platform.updateSchedule
 *   v1#31    set_chat_autonomy REVOKE on an auto-mode coding chat returns the
 *            honest mode_auto_implies_autonomy envelope (no silent no-op)
 *   S2a      todo_update/goal_update pass blockKind/gateQuestionId through
 */

import { createPendingConfirmationTable } from './pending-confirmations.testkit';
import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockConfirmations = createPendingConfirmationTable();
const mockOwnerQuestions = createOwnerQuestionTable();
const mockChatCodingStateFindUnique: jest.Mock = jest.fn(async (): Promise<any> => null);

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    pendingConfirmation: mockConfirmations.api,
    ownerQuestion: mockOwnerQuestions.api,
    crossModelMessage: mockOwnerQuestions.crossModelMessage,
    crossModelChat: mockOwnerQuestions.crossModelChat,
    telegramLink: { findUnique: async () => null },
    chatCodingState: { findUnique: (...a: any[]) => mockChatCodingStateFindUnique(...a) },
  },
}));

jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => false,
  sendMessage: async () => true,
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));

const svc = {
  listSchedules: jest.fn(async (): Promise<any[]> => []),
  updateSchedule: jest.fn(async (): Promise<any> => ({ ok: true, schedule: { id: 'sched-full-id-1', sessionId: 'lane-1', intervalSec: 3600, nextRunAt: 'soon' } })),
};
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  getFeedbackTicketById: jest.fn(),
  isAdminUser: jest.fn(async () => false),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));

const autonomySvc = {
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule', 'update_schedule'] as const,
  DEFAULT_SCHEDULE_CAP: 48,
  MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(async (): Promise<any> => null),
  setChatAutonomy: jest.fn(async (): Promise<any> => ({ granted: false, chatId: 'c1', allowedTools: [], scheduleCap: null, source: null })),
  auditAutonomousExecution: jest.fn(async () => {}),
  implicitParentAutonomyAllows: jest.fn(async () => false),
};
jest.mock('./autonomy.service', () => ({ __esModule: true, ...autonomySvc }));

// The conflict guard's UNIT semantics live in directive-conflict.test.ts —
// here we pin the WIRING: when/what the dispatcher passes it.
const mockCheckConflict: jest.Mock = jest.fn(async (): Promise<any> => ({ conflict: false }));
jest.mock('./directive-conflict', () => ({
  __esModule: true,
  checkScheduleDirectiveConflict: (...a: any[]) => mockCheckConflict(...a),
}));

// goals.service under todo_update/goal_update — mocked to pin the arg mapping.
const mockUpdateTodo: jest.Mock = jest.fn(async (o: any) => ({ id: o.todoId, ...o }));
const mockUpdateGoal: jest.Mock = jest.fn(async (o: any) => ({ id: o.goalId, ...o }));
jest.mock('./goals.service', () => ({
  __esModule: true,
  updateTodo: (...a: any[]) => mockUpdateTodo(...a),
  updateGoal: (...a: any[]) => mockUpdateGoal(...a),
}));

import { executePlatformTool, PLATFORM_TOOL_SCHEMA } from './platform-tools';
import type { ToolContext } from '../coding/tools';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  return {
    worktree: '/wt', sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    userTurnAt: new Date(),
    requestApproval: async () => 'allow',
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  mockOwnerQuestions.reset();
  mockChatCodingStateFindUnique.mockResolvedValue(null);
  mockCheckConflict.mockResolvedValue({ conflict: false });
  svc.listSchedules.mockResolvedValue([
    { id: 'sched-full-id-1', sessionId: 'lane-1', prompt: 'old standing prompt about the Machete cutover', enabled: true, kind: 'recurring' },
  ]);
  svc.updateSchedule.mockResolvedValue({ ok: true, schedule: { id: 'sched-full-id-1', sessionId: 'lane-1', intervalSec: 3600, nextRunAt: 'soon' } });
  autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['update_schedule', 'schedule_message'], scheduleCap: 48, source: 'manual' });
});

// ── N3 / v1#5 / N8 — flag_owner_question ─────────────────────────────────────

describe('flag_owner_question (N3/v1#5/N8 wiring)', () => {
  it('the schema exposes options/forChatId/goalId/todoId', () => {
    const t = PLATFORM_TOOL_SCHEMA.find((x) => x.function.name === 'flag_owner_question')!;
    const props = (t.function.parameters as any).properties;
    expect(props.options).toBeDefined();
    expect(props.forChatId).toBeDefined();
    expect(props.goalId).toBeDefined();
    expect(props.todoId).toBeDefined();
  });

  it('a multi-decision question with no options returns the structured split nudge', async () => {
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'flag_owner_question', {
      question: 'Pick the region? And approve the budget?',
    }));
    expect(out).toMatchObject({ ok: false, reason: 'multi_decision' });
    expect(out.message).toContain('ONE decision per question');
  });

  it('options + linkage ride to the store; the envelope returns the oq id', async () => {
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'flag_owner_question', {
      question: 'GO on the Machete swap?',
      options: [{ id: 'go', label: 'GO' }, { id: 'hold', label: 'Hold' }],
      goalId: 'goal-1', todoId: 'todo-1',
    }));
    expect(out.ok).toBe(true);
    const row = mockOwnerQuestions.rows[0];
    expect(row.options).toEqual([{ id: 'go', label: 'GO' }, { id: 'hold', label: 'Hold' }]);
    expect(row.goalId).toBe('goal-1');
    expect(row.todoId).toBe('todo-1');
  });

  it('a MACHINE run (no userTurnAt) re-asking an answered stop-asking topic gets the previously_answered envelope', async () => {
    // Seed an ANSWERED stop-asking row directly in the store.
    mockOwnerQuestions.rows.push({
      id: 'oq_prior123', chatId: 'sess-1', userId: 'u1', question: 'Which serving engine should the bench use?',
      status: 'answered', answer: 'vLLM — now just proceed and stop asking', context: null,
      createdAt: new Date(Date.now() - 3600e3), resolvedAt: new Date(Date.now() - 1800e3),
    });
    const out = JSON.parse(await executePlatformTool(makeCtx({ userTurnAt: undefined }), 'flag_owner_question', {
      question: 'Which serving engine should the bench use tonight?',
    }));
    expect(out).toMatchObject({ ok: false, reason: 'previously_answered', priorQuestionId: 'oq_prior123' });
    expect(out.message).toContain('stop asking');
  });

  it('OWNER-INTERRUPT-ECONOMY: a MACHINE strict re-ask of an owner-DECIDED question gets the previously_decided envelope', async () => {
    mockOwnerQuestions.rows.push({
      id: 'oq_decided1', chatId: 'sess-1', userId: 'u1', question: 'Use the 8B checkpoint for tonight\'s eval run?',
      status: 'answered', answer: 'Yes — 8B', answeredBy: 'owner', context: null,
      createdAt: new Date(Date.now() - 3 * 86_400_000), resolvedAt: new Date(Date.now() - 2 * 86_400_000),
    });
    const out = JSON.parse(await executePlatformTool(makeCtx({ userTurnAt: undefined }), 'flag_owner_question', {
      question: 'Should we use the 8B checkpoint for tonight\'s eval run?',
    }));
    expect(out).toMatchObject({ ok: false, reason: 'previously_decided', priorQuestionId: 'oq_decided1', priorAnswer: 'Yes — 8B' });
    expect(out.message).toContain('revisitReason');
    // The escape hatch files it, annotated with the prior decision.
    const filed = JSON.parse(await executePlatformTool(makeCtx({ userTurnAt: undefined }), 'flag_owner_question', {
      question: 'Should we use the 8B checkpoint for tonight\'s eval run?',
      revisitReason: 'The 14B run finished and beats it.',
      urgent: true,
    }));
    expect(filed.ok).toBe(true);
    expect(filed.priorDecision).toMatchObject({ questionId: 'oq_decided1', strict: true });
    expect(filed.delivery).toBe('immediate');
  });

  it('flag_owner_question exposes the economy params (urgent / reversible / recommendedDefault / revisitReason)', () => {
    const tool = (PLATFORM_TOOL_SCHEMA as any[]).find((t) => t.function?.name === 'flag_owner_question');
    const props = tool.function.parameters.properties;
    expect(props.urgent.type).toBe('boolean');
    expect(props.reversible.type).toBe('boolean');
    expect(props.recommendedDefault.type).toBe('string');
    expect(props.revisitReason.type).toBe('string');
  });

  it('a USER-anchored run skips the N8 preflight (same re-ask flags fresh)', async () => {
    mockOwnerQuestions.rows.push({
      id: 'oq_prior123', chatId: 'sess-1', userId: 'u1', question: 'Which serving engine should the bench use?',
      status: 'answered', answer: 'vLLM — now just proceed and stop asking', context: null,
      createdAt: new Date(Date.now() - 3600e3), resolvedAt: new Date(Date.now() - 1800e3),
    });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'flag_owner_question', {
      question: 'Which serving engine should the bench use tonight?',
    }));
    expect(out.ok).toBe(true);
  });
});

// ── item 8 — update_schedule conflict-guard wiring ───────────────────────────

describe('update_schedule directive-conflict guard (item 8 wiring)', () => {
  it('a MACHINE prompt rewrite consults the guard with old/new prompts and the resolved row', async () => {
    await executePlatformTool(makeCtx({ userTurnAt: undefined }), 'update_schedule', {
      id: 'sched-full-id-1', prompt: 'Monitor only. No decision pending.',
    });
    expect(mockCheckConflict).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', scheduleId: 'sched-full-id-1', sessionId: 'lane-1',
      oldPrompt: 'old standing prompt about the Machete cutover',
      newPrompt: 'Monitor only. No decision pending.',
      override: false,
    }));
    expect(svc.updateSchedule).toHaveBeenCalled(); // guard said no conflict
  });

  // Gate flip 2026-09-11 (owner: full steam): a conflict verdict is OBSERVED —
  // the rewrite APPLIES and the findings ride the success envelope as a
  // [DIRECTIVE NOTICE] (6/6 refusals since 09-09 were term-overlap on owner
  // STATUS QUESTIONS; one refused rewrite let a stale prompt fire and exhaust).
  // Opt-in DIRECTIVE_CONFLICT_ENFORCE=1 restores the [DIRECTIVE CONFLICT] refusal.
  it('a conflict verdict is APPLIED (observe-only): updateSchedule runs and the result carries a [DIRECTIVE NOTICE] with the findings, not the refusal framing', async () => {
    mockCheckConflict.mockResolvedValue({
      conflict: true,
      message: '[DIRECTIVE CONFLICT] update_schedule NOT applied — this machine-authored prompt rewrite contradicts open owner decision(s): ' +
        'the rewrite DROPS the key terms of OPEN owner directive [dir-16-1] "Swap the bench lane to Machete" (the stored prompt carried 80% of its terms; the new prompt retains 20%). ' +
        'Resolve the open decision first (answer/close it), or — if this rewrite is genuinely deliberate — re-call update_schedule with override:true AND overrideReason:"<why>". The override is metered and audited.',
    });
    const out = await executePlatformTool(makeCtx({ userTurnAt: undefined }), 'update_schedule', {
      id: 'sched-full-id-1', prompt: 'Monitor only. No decision pending.',
    });
    expect(svc.updateSchedule).toHaveBeenCalledWith(expect.objectContaining({
      id: 'sched-full-id-1', prompt: 'Monitor only. No decision pending.', promptSetBy: 'machine',
    }));
    expect(out).toContain('[DIRECTIVE NOTICE]');
    expect(out).toContain('was APPLIED');
    expect(out).toContain('DROPS the key terms of OPEN owner directive [dir-16-1]');
    expect(out).toContain('Updated schedule sched-full-id-1');
    expect(out).not.toContain('[DIRECTIVE CONFLICT]');
    expect(out).not.toContain('NOT applied');
    expect(out).not.toContain('override:true');
  });

  it('opt-in DIRECTIVE_CONFLICT_ENFORCE=1 restores the refusal: the guard message returns and updateSchedule is never reached', async () => {
    process.env.DIRECTIVE_CONFLICT_ENFORCE = '1';
    try {
      mockCheckConflict.mockResolvedValue({ conflict: true, message: '[DIRECTIVE CONFLICT] refused — open directive dir-16-11' });
      const out = await executePlatformTool(makeCtx({ userTurnAt: undefined }), 'update_schedule', {
        id: 'sched-full-id-1', prompt: 'Monitor only. No decision pending.',
      });
      expect(out).toContain('[DIRECTIVE CONFLICT]');
      expect(svc.updateSchedule).not.toHaveBeenCalled();
    } finally {
      delete process.env.DIRECTIVE_CONFLICT_ENFORCE;
    }
  });

  it('a no-conflict verdict carries NO notice line', async () => {
    const out = await executePlatformTool(makeCtx({ userTurnAt: undefined }), 'update_schedule', {
      id: 'sched-full-id-1', prompt: 'Keep watching the Machete cutover.',
    });
    expect(out).not.toContain('[DIRECTIVE NOTICE]');
    expect(out).toContain('Updated schedule sched-full-id-1');
  });

  it('override:true + overrideReason thread through to the guard', async () => {
    await executePlatformTool(makeCtx({ userTurnAt: undefined }), 'update_schedule', {
      id: 'sched-full-id-1', prompt: 'new prompt', override: true, overrideReason: 'owner superseded it',
    });
    expect(mockCheckConflict).toHaveBeenCalledWith(expect.objectContaining({ override: true, overrideReason: 'owner superseded it' }));
  });

  it('USER-anchored rewrites and interval-only updates never consult the guard', async () => {
    await executePlatformTool(makeCtx(), 'update_schedule', { id: 'sched-full-id-1', prompt: 'user rewrite' });
    await executePlatformTool(makeCtx({ userTurnAt: undefined }), 'update_schedule', { id: 'sched-full-id-1', intervalMinutes: 30 });
    expect(mockCheckConflict).not.toHaveBeenCalled();
  });

  it('the schema exposes override/overrideReason', () => {
    const t = PLATFORM_TOOL_SCHEMA.find((x) => x.function.name === 'update_schedule')!;
    const props = (t.function.parameters as any).properties;
    expect(props.override).toBeDefined();
    expect(props.overrideReason).toBeDefined();
  });
});

// ── v1#31 — set_chat_autonomy revoke honesty ─────────────────────────────────

describe('set_chat_autonomy REVOKE on an auto-mode coding chat (v1#31)', () => {
  /** Drive the two-step confirmation flow (set_chat_autonomy is NEVER autonomous). */
  async function confirmedRevoke(chatId: string): Promise<string> {
    const ctx = makeCtx();
    const first = JSON.parse(await executePlatformTool(ctx, 'set_chat_autonomy', { chatId, allowedTools: [] }));
    expect(first).toMatchObject({ ok: false, needsConfirmation: true });
    return executePlatformTool(
      makeCtx({ userTurnAt: new Date(Date.now() + 60_000) }),
      'set_chat_autonomy',
      { chatId, allowedTools: [], confirmationId: first.confirmationId },
    );
  }

  it('an AUTO-mode coding chat gets the honest mode_auto_implies_autonomy envelope — the row is NOT touched', async () => {
    mockChatCodingStateFindUnique.mockResolvedValue({ permissionMode: 'auto' });
    const out = JSON.parse(await confirmedRevoke('coding-auto-1'));
    expect(out).toMatchObject({ ok: false, reason: 'mode_auto_implies_autonomy', chatId: 'coding-auto-1' });
    expect(out.message).toContain('Agent mode AUTO');
    expect(out.message).toContain('change its Agent mode');
    expect(autonomySvc.setChatAutonomy).not.toHaveBeenCalled();
  });

  it('a NON-auto coding chat (and a plain chat) revokes as before', async () => {
    mockChatCodingStateFindUnique.mockResolvedValue({ permissionMode: 'plan' });
    const out = await confirmedRevoke('coding-plan-1');
    expect(out).toContain('Autonomy revoked');
    expect(autonomySvc.setChatAutonomy).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'coding-plan-1', allowedTools: [] }));
  });

  it('a coding-state lookup failure fails OPEN into the plain revoke', async () => {
    mockChatCodingStateFindUnique.mockRejectedValue(new Error('db down'));
    const out = await confirmedRevoke('coding-x-1');
    expect(out).toContain('Autonomy revoked');
  });

  it('a NON-empty grant on an auto chat is untouched by the new gate (only revokes are intercepted)', async () => {
    mockChatCodingStateFindUnique.mockResolvedValue({ permissionMode: 'auto' });
    autonomySvc.setChatAutonomy.mockResolvedValue({ granted: true, chatId: 'coding-auto-1', allowedTools: ['schedule_message'], scheduleCap: 48, source: 'manual' });
    const ctx = makeCtx();
    const first = JSON.parse(await executePlatformTool(ctx, 'set_chat_autonomy', { chatId: 'coding-auto-1', allowedTools: ['schedule_message'] }));
    const out = await executePlatformTool(
      makeCtx({ userTurnAt: new Date(Date.now() + 60_000) }),
      'set_chat_autonomy',
      { chatId: 'coding-auto-1', allowedTools: ['schedule_message'], confirmationId: first.confirmationId },
    );
    expect(out).toContain('Autonomy granted');
  });
});

// ── S2a — blockKind/gateQuestionId pass-through ──────────────────────────────

describe('todo_update / goal_update blockKind + gateQuestionId (S2a wiring)', () => {
  it('todo_update passes blockKind + gateQuestionId through (null clears)', async () => {
    await executePlatformTool(makeCtx(), 'todo_update', {
      todoId: 't1', status: 'blocked', blockedReason: 'Awaiting owner decision',
      blockKind: 'owner', gateQuestionId: 'oq_gate1234',
    });
    expect(mockUpdateTodo).toHaveBeenCalledWith(expect.objectContaining({
      todoId: 't1', blockKind: 'owner', gateQuestionId: 'oq_gate1234',
    }));
    await executePlatformTool(makeCtx(), 'todo_update', { todoId: 't1', gateQuestionId: null });
    expect(mockUpdateTodo).toHaveBeenLastCalledWith(expect.objectContaining({ gateQuestionId: null }));
  });

  it('goal_update passes them too, and omits them when absent', async () => {
    await executePlatformTool(makeCtx(), 'goal_update', { goalId: 'g1', blockKind: 'external' });
    expect(mockUpdateGoal).toHaveBeenCalledWith(expect.objectContaining({ goalId: 'g1', blockKind: 'external' }));
    await executePlatformTool(makeCtx(), 'goal_update', { goalId: 'g1', title: 'x' });
    const last = mockUpdateGoal.mock.calls.at(-1)![0];
    expect('blockKind' in last).toBe(false);
    expect('gateQuestionId' in last).toBe(false);
  });

  it('the schemas expose the new fields with the owner-wait guidance', () => {
    for (const name of ['todo_update', 'goal_update']) {
      const t = PLATFORM_TOOL_SCHEMA.find((x) => x.function.name === name)!;
      const props = (t.function.parameters as any).properties;
      expect(props.blockKind.enum).toEqual(['deps', 'owner', 'agent', 'external']);
      expect(props.gateQuestionId).toBeDefined();
    }
  });
});
