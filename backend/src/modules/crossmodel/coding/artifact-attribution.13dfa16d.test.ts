/**
 * ARTIFACT ATTRIBUTION (todo 13dfa16d, framework-audit monitor lesson 7) —
 * the regression pin for the slowly-changing-dimension trap.
 *
 * THE MISHAP (2026-10-16, 13:53–16:47Z): board artifacts were labelled with
 * the LANE'S CURRENT TITLE TODO, not the work item they served. Specimens:
 *  - PR #1590 — branch block-escalation-27c215d6, body "Todo 27c215d6",
 *    squash c5f4fd6c (commits 4c68aa20 15:21Z + efb6be10 15:48Z) — served
 *    todo 27c215d6 but was labelled with lane title todo 908f48a7 after the
 *    lane's title switched at 14:14:53Z; the Fleet digest printed "Lesson-5
 *    contract merged (PR #1590)" and the crossmodel Supervisor printed
 *    "27c215d6 done … PR #1590 (owner-status contract) merged".
 *  - lane 5f90c628 labelled PR #1587 + push d0d2ab07 with todo 36fe141e,
 *    which was DONE before dawn.
 * Baseline: 7 of 24 checkable artifact labels wrong (29%), all from the 2
 * lanes whose title todo differed from the work in hand; 6 false
 * "merged/pushed on" sentences in 3 h.
 *
 * THE FIX (event-sourcing rule: an event carries its context when written):
 * the three artifact tool results append "— serves todo|ticket <8-hex>" at
 * event time (fixed order: branch / PR body / commit message → the run's
 * in-progress plan step → unattributed, printed, never guessed); the receipt
 * stores ids.todoId/ticketId; the wake ledger renders THAT stamp. This file
 * pins every leg of that pipeline against the verbatim specimens, plus the
 * observe-only artifact_attribution_mismatch cross-check (the 6f8b52b7 /
 * PR #1548 ladder).
 */
import { extractReceipt } from './run-receipts';
import {
  attributionClaimSentences, attributionMismatches, attributionOfReceiptIds, attributionOfStampText,
  attributeArtifact, attributionFromArtifact, attributionFromPlan, workItemIdsInText,
} from './artifact-attribution';

const NOW = new Date('2026-10-16T15:48:00Z');

// The verbatim specimen shapes (todo 13dfa16d's FINDING).
const TODO_27C215D6 = '27c215d6-1111-4222-8333-444455556666';
const TODO_908F48A7 = '908f48a7-1111-4222-8333-444455556666';
const TODO_36FE141E = '36fe141e-1111-4222-8333-444455556666';
const TICKET_2C203DAC = '2c203dac-1111-4222-8333-444455556666';

describe('artifact attribution — pure decision legs (the fixed order)', () => {
  it('leg (a) branch: the #1590 specimen — block-escalation-27c215d6 names todo 27c215d6, NOT the lane title todo', () => {
    const a = attributionFromArtifact({ branch: 'block-escalation-27c215d6' });
    expect(a).toEqual({ workItem: `todo 27c215d6`, prefix: '27c215d6', source: 'branch' });
    // The lane's title todo (908f48a7, post-14:14:53Z switch) appears NOWHERE
    // in the artifact — the SCD trap never had event-time evidence.
    expect(workItemIdsInText('block-escalation-27c215d6')).not.toContain(TODO_908F48A7);
  });

  it('leg (a) body: a PR body "Todo 27c215d6" attributes to that todo; a ticket-labelled body attributes to the ticket', () => {
    expect(attributionFromArtifact({ body: 'Todo 27c215d6 — open-ended block-streak escalation' })?.prefix).toBe('27c215d6');
    const t = attributionFromArtifact({ body: `Ticket ${TICKET_2C203DAC} — live lane board` });
    expect(t).toEqual({ workItem: 'ticket 2c203dac', prefix: '2c203dac', source: 'body' });
  });

  it('leg (a) commit: a commit message trailer names its todo (the 4c68aa20 / efb6be10 shape: "Todo 27c215d6" in the squash commits)', () => {
    const a = attributionFromArtifact({ commitMessage: 'Escalation ladder for open block streaks\n\nTodo 27c215d6' });
    expect(a).toEqual({ workItem: 'todo 27c215d6', prefix: '27c215d6', source: 'commit' });
  });

  it('leg (a) order is branch → body → commit (the branch is the work\'s own identity)', () => {
    const a = attributionFromArtifact({ branch: 'fix-36fe141e', body: 'Todo 27c215d6', commitMessage: 'Todo 908f48a7' });
    expect(a?.prefix).toBe('36fe141e');
    expect(a?.source).toBe('branch');
  });

  it('short hex runs never vouch — a branch like "fix-27" is not todo 27', () => {
    expect(attributionFromArtifact({ branch: 'fix-27' })).toBeNull();
    expect(attributionFromArtifact({ branch: 'main' })).toBeNull();
  });

  it('leg (b) plan: the run\'s in-progress step names the todo when the artifact carries none', () => {
    const plan = { steps: [
      { text: 'Explore the ledger seam', status: 'completed' },
      { text: 'Land the block-streak escalation (todo 27c215d6)', status: 'in_progress' },
      { text: 'Docs + verify', status: 'pending' },
    ] };
    expect(attributionFromPlan(plan, [])?.prefix).toBe('27c215d6');
  });

  it('leg (b) falls back to a known todo TITLE match on the in-progress step (≥3 words — no single-word false hits)', () => {
    const plan = { steps: [{ text: 'Ship the open-ended block-streak escalation fix', status: 'in_progress' }] };
    const known = [{ id: TODO_27C215D6, title: 'Open-ended block-streak escalation' }];
    expect(attributionFromPlan(plan, known)?.prefix).toBe('27c215d6');
    expect(attributionFromPlan(plan, [{ id: TODO_908F48A7, title: 'escalation' }])).toBeNull(); // 1-word title — too weak
  });

  it('leg (c): no branch, no body, no plan hint ⇒ unattributed — printed, never guessed', () => {
    expect(attributeArtifact({}, { steps: [{ text: 'Do the thing', status: 'in_progress' }] }, [])).toEqual(
      { workItem: 'unattributed', prefix: 'unattributed', source: 'none' },
    );
  });
});

describe('artifact attribution — the receipt ids (the event-time stamp)', () => {
  it('extractReceipt parses the stamp off a git_push result into ids.todoId + workItemSource', () => {
    const r = extractReceipt('git_push', {}, `Pushed block-escalation-27c215d6 to GitHub (https://github.com/o/r) — sha d0d2ab071234 — serves todo 27c215d6. — published refs: refs/heads/block-escalation-27c215d6.`, NOW);
    expect(r?.ok).toBe(true);
    expect((r?.ids as any).todoId).toBe('27c215d6');
    expect((r?.ids as any).workItemSource).toBe('stamp');
    expect((r?.ids as any).branch).toBe('block-escalation-27c215d6');
    expect((r?.ids as any).refs).toEqual(['refs/heads/block-escalation-27c215d6']);
  });

  it('extractReceipt parses the stamp off open_pull_request (PR #1590) and merge_pull_request results', () => {
    const open = extractReceipt('open_pull_request', {}, `Opened PR #1590: https://github.com/o/r/pull/1590 — serves todo 27c215d6`, NOW);
    expect((open?.ids as any).prNumber).toBe(1590);
    expect((open?.ids as any).todoId).toBe('27c215d6');
    const merge = extractReceipt('merge_pull_request', {}, `MERGED o/r#1590 (squash sha c5f4fd6c334455667788) — confirmed merged:true by follow-up GET. — serves todo 27c215d6\nGate evidence:\n- ok`, NOW);
    expect((merge?.ids as any).prNumber).toBe(1590);
    expect((merge?.ids as any).mergeSha).toBe('c5f4fd6c334455667788');
    expect((merge?.ids as any).todoId).toBe('27c215d6');
  });

  it('a ticket stamp stores ticketId (the 2c203dac class), never a todoId', () => {
    const r = extractReceipt('open_pull_request', {}, `Opened PR #1591: https://github.com/o/r/pull/1591 — serves ticket 2c203dac`, NOW);
    expect((r?.ids as any).ticketId).toBe('2c203dac');
    expect((r?.ids as any).todoId).toBeUndefined();
  });

  it('legacy results (no stamp) keep their ids untouched — the render side prints unattributed', () => {
    const r = extractReceipt('git_push', {}, `Pushed some-branch to GitHub (https://github.com/o/r) — sha abcdef123456. — published refs: refs/heads/some-branch.`, NOW);
    expect((r?.ids as any).todoId).toBeUndefined();
    expect((r?.ids as any).ticketId).toBeUndefined();
    expect(attributionOfReceiptIds(r?.ids)).toBeNull();
  });

  it('attributionOfStampText reads the stamp back off the raw result string', () => {
    expect(attributionOfStampText('Pushed x to GitHub — serves todo 27c215d6.')).toEqual({ workItem: 'todo 27c215d6', prefix: '27c215d6' });
    expect(attributionOfStampText('MERGED o/r#1 (squash sha abc) — confirmed. — serves ticket 2c203dac')).toEqual({ workItem: 'ticket 2c203dac', prefix: '2c203dac' });
    expect(attributionOfStampText('no stamp here')).toBeNull();
  });

  it('attributionOfReceiptIds reads the ids back ("todo 27c215d6" / "ticket 2c203dac")', () => {
    expect(attributionOfReceiptIds({ todoId: TODO_27C215D6 })).toEqual({ workItem: 'todo 27c215d6', prefix: '27c215d6' });
    expect(attributionOfReceiptIds({ ticketId: TICKET_2C203DAC })).toEqual({ workItem: 'ticket 2c203dac', prefix: '2c203dac' });
    expect(attributionOfReceiptIds({ prNumber: 1590 })).toBeNull();
    expect(attributionOfReceiptIds(null)).toBeNull();
  });
});

describe('artifact attribution — the observe-only cross-check (the #1548 ladder)', () => {
  it('mines "<todo> merged/landed/shipped" sentences — the c1b4e589 specimen class', () => {
    const claims = attributionClaimSentences('PR #1590 (owner-status contract) merged, closing todo 908f48a7.');
    expect(claims).toHaveLength(1);
    expect(claims[0].prefix).toBe('908f48a7');
    expect(claims[0].verb).toBe('merged');
    const reversed = attributionClaimSentences('todo 27c215d6 landed via PR #1590.');
    expect(reversed[0].prefix).toBe('27c215d6');
    expect(reversed[0].verb).toBe('landed');
  });

  it('sentences without a mapped verb judge nothing (fail-open) — the 1419506a "learnings note" never strikes', () => {
    expect(attributionClaimSentences('Filed a learnings note about PR #1583 and the owner-status work.')).toHaveLength(0);
    expect(attributionClaimSentences('')).toHaveLength(0);
  });

  it('flags the todo row that is not done (status leg)', () => {
    const claims = attributionClaimSentences('todo 908f48a7 merged — the owner-status contract landed.');
    const rows = [{ id: TODO_908F48A7, status: 'in_progress', evidence: null }];
    const mm = attributionMismatches(claims, rows, []);
    expect(mm).toHaveLength(1);
    expect(mm[0].todoStatus).toBe('in_progress');
    expect(mm[0].prefix).toBe('908f48a7');
  });

  it('flags done-without-PR-evidence (evidence leg)', () => {
    const claims = attributionClaimSentences('todo 36fe141e merged.');
    const rows = [{ id: TODO_36FE141E, status: 'done', evidence: 'note only, no PR' }];
    expect(attributionMismatches(claims, rows, [])).toHaveLength(1);
  });

  it('flags the STAMP disagreement — the #1590 specimen: sentence says 908f48a7, the PR receipt serves 27c215d6', () => {
    const claims = attributionClaimSentences('PR #1590 merged — todo 908f48a7 done.');
    const rows = [{ id: TODO_908F48A7, status: 'done', evidence: 'PR #1590' }];
    const stamped = [{ prNumber: 1590, workItem: 'todo 27c215d6' }];
    const mm = attributionMismatches(claims, rows, stamped);
    expect(mm).toHaveLength(1);
    expect(mm[0].stampedWorkItem).toBe('todo 27c215d6');
    expect(mm[0].claimedWorkItem).toBe('todo 908f48a7');
  });

  it('an honest sentence strikes NOTHING — row done, evidence names the PR, stamps agree', () => {
    const claims = attributionClaimSentences('todo 27c215d6 merged via PR #1590.');
    const rows = [{ id: TODO_27C215D6, status: 'done', evidence: 'PR #1590 (squash c5f4fd6c)' }];
    const stamped = [{ prNumber: 1590, workItem: 'todo 27c215d6' }];
    expect(attributionMismatches(claims, rows, stamped)).toHaveLength(0);
  });

  it('a claim naming a todo with NO row is the phantom lane\'s business — never an attribution mismatch', () => {
    const claims = attributionClaimSentences('todo deadbeef merged.');
    expect(attributionMismatches(claims, [], [])).toHaveLength(0);
  });
});

describe('artifact attribution — the kill switch', () => {
  afterEach(() => { delete process.env.ARTIFACT_ATTRIBUTION_DISABLED; });

  it('ARTIFACT_ATTRIBUTION_DISABLED=1 drops the ids stamp fields (the result text keeps its stamp; extraction stays tolerant)', () => {
    process.env.ARTIFACT_ATTRIBUTION_DISABLED = '1';
    const r = extractReceipt('open_pull_request', {}, `Opened PR #1590: https://github.com/o/r/pull/1590 — serves todo 27c215d6`, NOW);
    expect((r?.ids as any).todoId).toBeUndefined();
    expect((r?.ids as any).workItemSource).toBeUndefined();
  });
});
