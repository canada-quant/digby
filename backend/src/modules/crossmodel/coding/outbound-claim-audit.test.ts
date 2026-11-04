/**
 * P4 v1#25 / spark B3+B4 — outbound arg claim audit: a MACHINE run's outgoing
 * text (send_chat_message / todo/goal notes / ticket descriptions) is
 * claim-audited at dispatch. Completion-report messages with receipt-less
 * claims are REFUSED; notes get inline '[unverified]' annotation. Pure-module
 * tests (leaf — the extractor and matcher are the guard's own).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// run-evidence-guard (the extractor) imports the GitHub token manager, whose
// chain reaches config/env → process.exit in a keyless test env — stub it.
jest.mock('../github/token-manager', () => ({
  __esModule: true,
  getValidToken: jest.fn(async () => 'tok'),
}));

import { auditOutboundArgs, OUTBOUND_UNVERIFIED_MARK, OUTBOUND_MIN_TEXT_CHARS } from './outbound-claim-audit';
import type { ToolReceipt } from './run-receipts';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const receipt = (tool: string, ok: boolean, ids: Record<string, unknown> = {}): ToolReceipt => ({
  id: 'aaaabbbb-cccc-4ddd-8eee-ffff00001111', chatId: 'c1', runId: 'run1', tool, ok, ids,
  inputHash: null, outputHash: null, createdAt: NOW,
});

/** A pure completion report — both lines carry receipt-less completion claims. */
const REPORT = [
  'Status: merged PR #999 and squash-merged PR #998 to main.',
  'Deploy green, health check 200 — all done.',
].join('\n');

describe('auditOutboundArgs — send_chat_message', () => {
  it('REFUSES a completion report whose claims have no receipts (reject-back envelope)', () => {
    const out = auditOutboundArgs({
      tool: 'send_chat_message',
      args: { chatId: 'c2', message: REPORT },
      receipts: [],
      machineTriggered: true,
    });
    expect(out.action).toBe('refused');
    const parsed = JSON.parse(out.refusal!);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('unverified_outbound_claims');
    expect(parsed.message).toContain('NOT sent');
    expect(out.kinds).toEqual(expect.arrayContaining(['pr_merged', 'deploy']));
  });

  it('a receipted completion report dispatches clean', () => {
    const out = auditOutboundArgs({
      tool: 'send_chat_message',
      args: { chatId: 'c2', message: 'Update from this run: merged PR #999 after the checks went green on the branch.' },
      receipts: [receipt('open_pull_request', true, { prNumber: 999 })],
      machineTriggered: true,
    });
    expect(out.action).toBe('clean');
  });

  it('a MIXED message (claims a minority of lines) is ANNOTATED, not blocked', () => {
    const msg = [
      'Here is the full triage picture for tonight, with context and next steps.',
      'Two lanes are idle and one is mid-run; details below.',
      'Merged PR #999 to main.',
      'Next steps: watch the canary and re-check in an hour.',
    ].join('\n');
    const out = auditOutboundArgs({
      tool: 'send_chat_message',
      args: { chatId: 'c2', message: msg },
      receipts: [],
      machineTriggered: true,
    });
    expect(out.action).toBe('annotated');
    expect(out.args.message).toContain(`Merged PR #999 to main.${OUTBOUND_UNVERIFIED_MARK}`);
    expect(out.args.message).toContain('Here is the full triage picture'); // untouched lines survive verbatim
    expect(out.args.chatId).toBe('c2');
  });
});

describe('auditOutboundArgs — notes (annotate-not-block)', () => {
  it('todo_update blockedReason gets convicted lines annotated inline', () => {
    const note = 'Blocked on infra: I already merged PR #999 and deployed green, but the box probe md5 verified nothing yet.';
    const out = auditOutboundArgs({
      tool: 'todo_update',
      args: { todoId: 't1', status: 'blocked', blockedReason: note },
      receipts: [],
      machineTriggered: true,
    });
    expect(out.action).toBe('annotated');
    expect(out.args.blockedReason).toContain(OUTBOUND_UNVERIFIED_MARK);
    expect(out.args.status).toBe('blocked'); // non-text args untouched
  });

  it('file_feedback description is audited too', () => {
    const description = 'While triaging I merged PR #999 and the deploy went green; filing this so the lane records the state.';
    const out = auditOutboundArgs({
      tool: 'file_feedback',
      args: { title: 't', description },
      receipts: [],
      machineTriggered: true,
    });
    expect(out.action).toBe('annotated');
    expect(out.args.description).toContain(OUTBOUND_UNVERIFIED_MARK);
  });
});

describe('bounds + kill-switch', () => {
  it('user-anchored runs are never audited', () => {
    expect(auditOutboundArgs({
      tool: 'send_chat_message', args: { message: REPORT }, receipts: [], machineTriggered: false,
    }).action).toBe('clean');
  });

  it(`texts ≤ ${OUTBOUND_MIN_TEXT_CHARS} chars are never audited`, () => {
    expect(auditOutboundArgs({
      tool: 'send_chat_message', args: { message: 'Merged PR #999.' }, receipts: [], machineTriggered: true,
    }).action).toBe('clean');
  });

  it('unaudited tools pass through', () => {
    expect(auditOutboundArgs({
      tool: 'update_schedule', args: { prompt: REPORT }, receipts: [], machineTriggered: true,
    }).action).toBe('clean');
  });
});
