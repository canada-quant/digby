/**
 * build 2026-10-08 A1 — the owner ask closes when the answer-first FOLLOW-THROUGH settles, never on the split answer:
 * an armed split row is not the supervisor's reply while its task card runs (or has no card yet); once the card
 * settles (done / failed / waiting_user) the row qualifies again. A follow-through round an owner message preempted
 * (re-queued, partial "(Stopped.)") never answers anything.
 */
import { isSupervisorReplyRow, isPendingAnswerFirstSplit } from './supervisor-reply-row';

const row = (metadata: Record<string, unknown>, content = 'Three of four cameras are recording.') => ({ content, metadata: { engine: 'agent', ...metadata } });

describe('isPendingAnswerFirstSplit / isSupervisorReplyRow (build 2026-10-08 A1)', () => {
  it('an ARMED split answer is not the reply while its card runs or before the card lands', () => {
    expect(isPendingAnswerFirstSplit({ ownerAnswerFirst: { mode: 'act', split: true, armed: true }, task: { status: 'running' } })).toBe(true);
    expect(isSupervisorReplyRow(row({ ownerAnswerFirst: { mode: 'act', split: true, armed: true }, task: { taskId: 't', status: 'running' } }))).toBe(false);
    expect(isSupervisorReplyRow(row({ ownerAnswerFirst: { mode: 'act', split: true, armed: true } }))).toBe(false);
  });
  it('once the follow-through settles the split answer qualifies; shadow / unarmed rows always did', () => {
    for (const status of ['done', 'failed', 'waiting_user']) {
      expect(isSupervisorReplyRow(row({ ownerAnswerFirst: { mode: 'act', split: true, armed: true }, task: { status } }))).toBe(true);
    }
    expect(isSupervisorReplyRow(row({ ownerAnswerFirst: { mode: 'shadow', split: true, armed: false } }))).toBe(true);
    expect(isSupervisorReplyRow(row({ ownerAnswerFirst: { mode: 'act', split: false, armed: false } }))).toBe(true);
    expect(isSupervisorReplyRow(row({}))).toBe(true);
  });
  it('the follow-through result row qualifies; a preempted (re-queued) round does not', () => {
    expect(isSupervisorReplyRow(row({ kind: 'continuation_result', continuation: { taskId: 't' } }, 'Messaged the tt-rd supervisor (receipt 35fcbce8).'))).toBe(true);
    expect(isSupervisorReplyRow(row({ kind: 'continuation_result', preempted: true }, '(Stopped.)'))).toBe(false);
  });
});
