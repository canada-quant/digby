/**
 * tool-scope.ts — the cause-level fix for the kimi-k3 wrong-tool emission
 * class (owner 2026-09-22). Pins: the name map + aliases, the harness-text
 * rewrite (never applied to tool results), schema renaming, the scope sets,
 * the ticket-work preload heuristic, and every kill switch.
 */
// looksLikeToolFailure lives in learnings-index.service (mocked deps — the
// same scaffold as learnings-index.7c1e5b9f.test.ts); the D5 pin below needs
// the REAL marker list, not a copy of it.
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async () => 1),
  memSearch: jest.fn(async () => []),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { INDEX_SWEPT: 'index_swept' },
}));

import {
  MODEL_FACING_TOOL_NAMES, modelToolName, internalToolName, isLegacyAliasEmission, withModelToolNames,
  applyModelToolNames, offeredNamesBothForms, isTriageTool, isSupervisorOnlyTool, runMentionsTicketWork,
  looksLikePlaceholderId,
  supervisorOnlyRefusal, isSupervisorOnlyRefusal, supervisorOnlyPermaAfter, stateReadFailedRefusal,
} from './tool-scope';
import { looksLikeToolFailure } from './learnings-index.service';

const withEnv = (k: string, v: string | undefined, fn: () => void) => {
  const prev = process.env[k];
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { fn(); } finally { if (prev === undefined) delete process.env[k]; else process.env[k] = prev; }
};

describe('tool-scope — model-facing names', () => {
  it('renames ONLY the two cold update_* admin tools, to names sharing no prefix with any hot tool', () => {
    expect(Object.keys(MODEL_FACING_TOOL_NAMES).sort()).toEqual(['update_feedback', 'update_supervisor_state']);
    for (const v of Object.values(MODEL_FACING_TOOL_NAMES)) {
      expect(v.startsWith('update_')).toBe(false);
      expect(v.startsWith('set_')).toBe(false);   // set_chat_autonomy / set_chat_instructions / goal_premise_set live there
      expect(v.startsWith('get_')).toBe(false);
      expect(v.startsWith('list_')).toBe(false);
    }
    expect(modelToolName('update_feedback')).toBe('triage_ticket');
    expect(modelToolName('update_supervisor_state')).toBe('save_supervisor_state');
    expect(modelToolName('update_plan')).toBe('update_plan');
  });
  it('maps emitted names back to internal names and ALWAYS accepts the legacy alias', () => {
    expect(internalToolName('triage_ticket')).toBe('update_feedback');
    expect(internalToolName('update_feedback')).toBe('update_feedback');
    expect(internalToolName('run_command')).toBe('run_command');
    expect(isLegacyAliasEmission('update_feedback')).toBe(true);
    expect(isLegacyAliasEmission('triage_ticket')).toBe(false);
    expect(isLegacyAliasEmission('update_plan')).toBe(false);
  });
  it('rewrites harness-authored text on word boundaries only', () => {
    expect(withModelToolNames('pair with update_feedback to close; update_feedbacks is not a word; update_plan stays'))
      .toBe('pair with triage_ticket to close; update_feedbacks is not a word; update_plan stays');
    expect(withModelToolNames('')).toBe('');
  });
  it('renames schemas (name + description) and leaves unmapped schemas by reference', () => {
    const plan = { type: 'function', function: { name: 'update_plan', description: 'x' } };
    const fb = { type: 'function', function: { name: 'update_feedback', description: 'ADMIN-ONLY update' } };
    const list = { type: 'function', function: { name: 'list_feedback', description: 'pair with update_feedback' } };
    const out = applyModelToolNames([plan, fb, list]);
    expect(out[0]).toBe(plan);
    expect(out[1].function.name).toBe('triage_ticket');
    expect(fb.function.name).toBe('update_feedback'); // input untouched
    expect(out[2].function.name).toBe('list_feedback');
    expect(out[2].function.description).toBe('pair with triage_ticket');
  });
  it('offeredNamesBothForms carries both spellings for intent detection', () => {
    expect([...offeredNamesBothForms(['grep', 'update_feedback'])].sort()).toEqual(['grep', 'triage_ticket', 'update_feedback']);
  });
});

describe('tool-scope — schema scope', () => {
  it('scope sets', () => {
    expect(isTriageTool('list_feedback') && isTriageTool('update_feedback')).toBe(true);
    expect(isTriageTool('file_feedback')).toBe(false); // filing a ticket stays available everywhere
    for (const n of ['get_supervisor_state', 'update_supervisor_state', 'register_infra_blocker', 'clear_infra_blocker']) expect(isSupervisorOnlyTool(n)).toBe(true);
    expect(isSupervisorOnlyTool('list_infra_blockers')).toBe(false);
  });
  it('runMentionsTicketWork: dispatch briefs, explicit names, user history — never assistant text', () => {
    expect(runMentionsTicketWork({ userMessage: '[TICKET DISPATCH — feedback ticket abc]' })).toBe(true);
    expect(runMentionsTicketWork({ userMessage: '[TICKET BATCH DISPATCH — 3 open feedback tickets, owner-ordered burn-down]' })).toBe(true);
    expect(runMentionsTicketWork({ userMessage: 'triage the feedback tickets in the queue' })).toBe(true);
    expect(runMentionsTicketWork({ userMessage: 'continue', history: [{ role: 'user', content: [{ type: 'text', text: 'run list_feedback and work the top one' }] }] })).toBe(true);
    expect(runMentionsTicketWork({ userMessage: 'continue', schedulerNotice: 'nightly: list_feedback burn-down' })).toBe(true);
    expect(runMentionsTicketWork({ userMessage: 'fix the flaky test in agent.ts', history: [{ role: 'assistant', content: 'I could call update_feedback' }] })).toBe(false);
    expect(runMentionsTicketWork({ userMessage: 'Coordinator watch firing 16: fresh probes, verify the gate-read report' })).toBe(false);
  });
  it('looksLikePlaceholderId classifies the prod slip ids, not real ones', () => {
    for (const v of ['noop', 'noop-not-applicable', 'noop-plan-refresh', 'placeholder', 'nonexistent-placeholder-skip', '', 'x', 'test', '__none__', '__stop__', 'none']) {
      expect(looksLikePlaceholderId(v)).toBe(true);
    }
    expect(looksLikePlaceholderId('02bf673a')).toBe(false);
    expect(looksLikePlaceholderId('02bf673a-6424-4db0-9b1a-5e8314bb304b')).toBe(false);
  });
});

describe('tool-scope — supervisor-only refusal shape (D5, 2026-09-27: worker 28de72e5 burned 90 rounds on a refusal that read as success)', () => {
  const LEGACY = JSON.stringify({ error: 'save_supervisor_state is only available on the Fleet Supervisor chat' });
  it('the envelope is failure-shaped to the derail streak; the legacy {"error"} shape was not', () => {
    const env = supervisorOnlyRefusal('save_supervisor_state', 'save_supervisor_state is only available on the Fleet Supervisor chat');
    expect(looksLikeToolFailure(env)).toBe(true);
    expect(looksLikeToolFailure(LEGACY)).toBe(false); // the prod mechanism — pinned so the parity bug cannot silently return
    const parsed = JSON.parse(env);
    expect(parsed).toEqual({
      ok: false, tool: 'save_supervisor_state', reason: 'supervisor_only',
      error: 'save_supervisor_state is only available on the Fleet Supervisor chat',
      message: 'save_supervisor_state is only available on the Fleet Supervisor chat',
    });
    expect(Object.keys(parsed)[0]).toBe('ok'); // the failure marker anchors on the first key
  });
  it('isSupervisorOnlyRefusal matches the envelope at result head only — never a quote of it, never other ok:false envelopes', () => {
    expect(isSupervisorOnlyRefusal(supervisorOnlyRefusal('get_supervisor_state', 'x'))).toBe(true);
    expect(isSupervisorOnlyRefusal(LEGACY)).toBe(false);
    expect(isSupervisorOnlyRefusal(`read_file result:\n${supervisorOnlyRefusal('get_supervisor_state', 'x')}`)).toBe(false);
    expect(isSupervisorOnlyRefusal(JSON.stringify({ ok: false, tool: 'todo_create', reason: 'tool_not_offered', message: 'x' }, null, 1))).toBe(false);
    expect(isSupervisorOnlyRefusal('')).toBe(false);
  });
  it('stateReadFailedRefusal (review fixer 2026-09-27): failure-shaped, but NOT the supervisor_only shape — a DB error is never "not a supervisor chat"', () => {
    const env = stateReadFailedRefusal('save_supervisor_state');
    expect(looksLikeToolFailure(env)).toBe(true);
    expect(isSupervisorOnlyRefusal(env)).toBe(false);
    const parsed = JSON.parse(env);
    expect(parsed).toMatchObject({ ok: false, tool: 'save_supervisor_state', reason: 'state_read_failed', transient: true });
    expect(Object.keys(parsed)[0]).toBe('ok');
    expect(parsed.message).toMatch(/could not read this chat's supervisor flags/);
    expect(parsed.message).not.toMatch(/only available/);
  });
  it('supervisorOnlyPermaAfter: default 2, env override ≥1', () => {
    withEnv('SUPERVISOR_ONLY_PERMA_AFTER', undefined, () => expect(supervisorOnlyPermaAfter()).toBe(2));
    withEnv('SUPERVISOR_ONLY_PERMA_AFTER', '3', () => expect(supervisorOnlyPermaAfter()).toBe(3));
    withEnv('SUPERVISOR_ONLY_PERMA_AFTER', '0', () => expect(supervisorOnlyPermaAfter()).toBe(2));
    withEnv('SUPERVISOR_ONLY_PERMA_AFTER', 'nope', () => expect(supervisorOnlyPermaAfter()).toBe(2));
  });
});
