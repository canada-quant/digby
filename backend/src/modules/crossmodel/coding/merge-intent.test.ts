/**
 * MERGE-INTENT-AWAIT (2026-10-20) — the pure leaf (merge-intent.ts): what may
 * be queued, the exact-head rule (adopt the update-branch merge commit, retire
 * any other move), TTL / due ordering, and the texts the lane reads.
 */
import {
  queueableWaitKind, newIntent, intentDue, intentExpired, classifyHeadMove, orderDueIntents, intentKey,
  renderMergeQueuedText, renderMergedWake, renderBlockedWake, renderMergeBackstopWake, mergeIntentQueueDisabled, selfMergeAutoUpdateBranchDisabled,
  mergeIntentGateBackoffMs, sameSha,
  MERGE_INTENT_TTL_MS, MERGE_INTENT_INTERVAL_SEC, MERGE_INTENT_GATE_BACKOFF_MAX_MS, UPDATE_BRANCH_ADOPT_SKEW_MS,
} from './merge-intent';

const HEAD = 'a'.repeat(40);
const NOW = new Date('2026-10-20T12:00:00Z');

describe('queueableWaitKind — only timing classes with the head they were judged on', () => {
  it('a transient gate failure with a hex head queues; red CI / no head / a non-hex head never does', () => {
    expect(queueableWaitKind({ failure: { transient: 'ci_pending', headSha: HEAD } })).toBe('ci_pending');
    expect(queueableWaitKind({ failure: { transient: 'server_5xx', headSha: HEAD } })).toBe('server_5xx');
    expect(queueableWaitKind({ failure: { headSha: HEAD } })).toBeNull(); // red CI / conflict / secret — a work item
    expect(queueableWaitKind({ failure: { transient: 'ci_pending' } })).toBeNull();
    expect(queueableWaitKind({ failure: { transient: 'ci_pending', headSha: 'not-a-sha' } })).toBeNull();
    expect(queueableWaitKind({ failure: { headSha: HEAD }, apiKind: 'merge_in_progress' })).toBe('merge_in_progress');
  });
  it('review fix: the CI DISPATCH GAP (transient for WAIT-ONCE, but nothing dispatches CI for it) is never queued — the lane gets the gate fix', () => {
    expect(queueableWaitKind({ failure: { transient: 'ci_pending', headSha: HEAD, dispatchGap: true } })).toBeNull();
  });
});

describe('sameSha + the full-gate backoff', () => {
  it('sameSha accepts an abbreviation either way, case-insensitively, and never two non-shas', () => {
    expect(sameSha(HEAD, HEAD.slice(0, 12).toUpperCase())).toBe(true);
    expect(sameSha(HEAD, 'b'.repeat(40))).toBe(false);
    expect(sameSha('', '')).toBe(false);
    expect(sameSha(null, HEAD)).toBe(false);
  });
  it('doubles from the interval per repeated timing verdict and caps at 30 min', () => {
    const base = MERGE_INTENT_INTERVAL_SEC * 1000;
    expect(mergeIntentGateBackoffMs(0)).toBe(base);
    expect(mergeIntentGateBackoffMs(1)).toBe(base);
    expect(mergeIntentGateBackoffMs(2)).toBe(2 * base);
    expect(mergeIntentGateBackoffMs(3)).toBe(4 * base);
    expect(mergeIntentGateBackoffMs(50)).toBe(MERGE_INTENT_GATE_BACKOFF_MAX_MS);
  });
});

describe('the intent row', () => {
  const rec = newIntent({ owner: 'O', repo: 'R', pullNumber: 7, headSha: HEAD, chatId: 'lane', userId: 'u', waitKind: 'ci_pending', gate: 'ci', cause: 'CI still running', mergeMethod: 'bogus' }, NOW);

  it('keys case-insensitively, defaults the merge method, and is due one interval later', () => {
    expect(rec.key).toBe(intentKey('o', 'r', 7));
    expect(rec.key).toBe('o/r#7');
    expect(rec.mergeMethod).toBe('squash');
    expect(intentDue(rec, NOW)).toBe(false);
    expect(intentDue(rec, new Date(NOW.getTime() + MERGE_INTENT_INTERVAL_SEC * 1000))).toBe(true);
    expect(rec.updateBranchFrom).toBeNull();
  });

  it('expires TTL after the FIRST queue', () => {
    expect(intentExpired(rec, new Date(NOW.getTime() + MERGE_INTENT_TTL_MS - 1))).toBe(false);
    expect(intentExpired(rec, new Date(NOW.getTime() + MERGE_INTENT_TTL_MS + 1))).toBe(true);
  });

  it('orders due intents oldest-due first', () => {
    const a = { ...rec, key: 'a', nextCheckAt: '2026-10-20T12:05:00Z' };
    const b = { ...rec, key: 'b', nextCheckAt: '2026-10-20T12:01:00Z' };
    expect(orderDueIntents([a, b]).map((r) => r.key)).toEqual(['b', 'a']);
  });
});

describe('classifyHeadMove — the exact-head rule', () => {
  const NEW = 'b'.repeat(40);
  const BASE = 'c'.repeat(40);
  const ASKED = NOW.toISOString();
  const AFTER = NOW.getTime() + 30_000;
  it('same head (abbreviated or full) is the same', () => {
    expect(classifyHeadMove({ headSha: HEAD, updateBranchFrom: null, updateBranchAt: null }, HEAD.slice(0, 12), null)).toBe('same');
  });
  it('the update-branch merge commit the harness asked for (two parents, first = the updated head, written AFTER the request) is ADOPTED', () => {
    expect(classifyHeadMove({ headSha: HEAD, updateBranchFrom: HEAD, updateBranchAt: ASKED }, NEW, [HEAD, BASE], AFTER)).toBe('adopt');
    // clock skew inside the tolerance still adopts
    expect(classifyHeadMove({ headSha: HEAD, updateBranchFrom: HEAD, updateBranchAt: ASKED }, NEW, [HEAD, BASE], NOW.getTime() - UPDATE_BRANCH_ADOPT_SKEW_MS + 1)).toBe('adopt');
  });
  it('any other move — a push on top, no update requested, or a merge commit OLDER than the request (the lane’s own merge) — retires the intent', () => {
    expect(classifyHeadMove({ headSha: HEAD, updateBranchFrom: HEAD, updateBranchAt: ASKED }, NEW, [HEAD], AFTER)).toBe('superseded'); // one parent: a push
    expect(classifyHeadMove({ headSha: HEAD, updateBranchFrom: null, updateBranchAt: null }, NEW, [HEAD, BASE], AFTER)).toBe('superseded');
    expect(classifyHeadMove({ headSha: HEAD, updateBranchFrom: HEAD, updateBranchAt: ASKED }, NEW, [BASE, HEAD], AFTER)).toBe('superseded');
    expect(classifyHeadMove({ headSha: HEAD, updateBranchFrom: HEAD, updateBranchAt: ASKED }, NEW, null, AFTER)).toBe('superseded');
    // review fix: a two-parent commit on that head written BEFORE the harness asked is the lane's own merge
    expect(classifyHeadMove({ headSha: HEAD, updateBranchFrom: HEAD, updateBranchAt: ASKED }, NEW, [HEAD, BASE], NOW.getTime() - UPDATE_BRANCH_ADOPT_SKEW_MS - 60_000)).toBe('superseded');
    // an unknown commit time never adopts
    expect(classifyHeadMove({ headSha: HEAD, updateBranchFrom: HEAD, updateBranchAt: ASKED }, NEW, [HEAD, BASE], null)).toBe('superseded');
  });
});

describe('texts', () => {
  const rec = newIntent({ owner: 'o', repo: 'r', pullNumber: 7, headSha: HEAD, chatId: 'lane', userId: 'u', waitKind: 'ci_pending' }, NOW);
  it('the queued answer says the harness holds the intent and never asks for a retry', () => {
    const t = renderMergeQueuedText({ slug: 'o/r', pullNumber: 7, headSha: HEAD, gate: 'ci', cause: 'CI still running on the head sha', updateBranchFrom: HEAD, headBranch: 'lane/x' });
    expect(t).toMatch(/^MERGE QUEUED \(gate ci: CI still running/);
    expect(t).toContain('now holds a merge intent for o/r#7 on head aaaaaaaaaaaa');
    expect(t).toContain('Do NOT poll or retry merge_pull_request');
    expect(t).toContain('update-branch from aaaaaaaaaaaa');
    expect(t).toContain('Pull origin/lane/x');
    expect(t).not.toMatch(/MERGE BLOCKED/);
    expect(t).toContain('wakes this chat ONCE');
  });
  it('review fix: a chat that only refreshed ANOTHER chat’s intent is never promised a wake — it is pointed at await_condition', () => {
    const t = renderMergeQueuedText({ slug: 'o/r', pullNumber: 7, headSha: HEAD, gate: 'ci', cause: 'x', refreshed: true, heldByOtherChat: 'otherlane123' });
    const [first, second] = t.split('\n');
    expect(first).toContain('session otherlan already holds the harness merge intent for o/r#7');
    expect(first).toContain('wakes THAT session (not this chat)');
    expect(first).not.toContain('wakes this chat');
    expect(second).toContain('This chat is NOT woken');
    expect(second).toContain('await_condition condition:"pr_merged" pullNumber:7');
    expect(t).not.toContain('the harness wakes this chat")');
  });
  it('the backstop names the PR, the head and the horizon and says to ignore it after an outcome', () => {
    const w = renderMergeBackstopWake({ slug: 'o/r', pullNumber: 7, headSha: HEAD }, NOW, new Date(NOW.getTime() + MERGE_INTENT_TTL_MS));
    expect(w).toMatch(/^\[MERGE INTENT — BACKSTOP o\/r#7\]/);
    expect(w).toContain('head aaaaaaaaaaaa at 12:00Z');
    expect(w).toContain('by 18:00Z');
    expect(w).toContain('ignore this one');
  });
  it('the merged wake names the exact head, the merge sha and the receipt; already-merged says someone else', () => {
    const later = new Date(NOW.getTime() + 14 * 60_000);
    const w = renderMergedWake(rec, { mergeSha: 'd'.repeat(40), receiptId: 'abcdef1234' }, later);
    expect(w).toMatch(/^\[MERGE INTENT — MERGED o\/r#7\]/);
    expect(w).toContain('exact head aaaaaaaaaaaa');
    expect(w).toContain('squash sha dddddddddddd');
    expect(w).toContain('queued 14 min ago');
    expect(w).toContain('receipt abcdef12');
    expect(w).toContain('await_condition condition:"deploy"');
    expect(renderMergedWake(rec, { mergeSha: 'd'.repeat(40), alreadyMerged: true }, later)).toContain('merged by someone else');
  });
  it('the blocked wake carries the gate, cause, evidence and fix — and says how to resume', () => {
    const w = renderBlockedWake(rec, { outcome: 'blocked', gate: 'ci', cause: 'CI is RED on the head sha', evidence: 'Backend tests: completed/failure', fix: 'fix and push' });
    expect(w).toMatch(/^\[MERGE INTENT — BLOCKED o\/r#7\]/);
    expect(w).toContain('gate ci failed on that exact head — CI is RED');
    expect(w).toContain('evidence: Backend tests');
    expect(w).toContain('fix: fix and push');
    expect(w).toContain('call merge_pull_request again');
    expect(renderBlockedWake(rec, { outcome: 'superseded', newHead: 'e'.repeat(40) })).toContain('moved to eeeeeeeeeeee by a push');
    const handed = renderBlockedWake(rec, { outcome: 'superseded', newHead: 'e'.repeat(40), requeuedByChat: 'lane-two-123' });
    expect(handed).toContain('session lane-two queued the merge on that new head');
    expect(handed).toContain('await_condition condition:"pr_merged" pullNumber:7');
    expect(renderBlockedWake(rec, { outcome: 'superseded', newHead: 'e'.repeat(40), branchUpdatedFrom: 'e'.repeat(40) })).toContain('pull the PR branch');
    expect(renderBlockedWake(rec, { outcome: 'expired' })).toContain('within 6 h');
    expect(renderBlockedWake(rec, { outcome: 'policy_off', cause: 'source: owner' })).toContain('ask the owner to merge PR #7');
  });
});

describe('switches', () => {
  it('read the env per call', () => {
    expect(mergeIntentQueueDisabled({})).toBe(false);
    expect(mergeIntentQueueDisabled({ MERGE_INTENT_QUEUE_DISABLED: '1' })).toBe(true);
    expect(selfMergeAutoUpdateBranchDisabled({ SELF_MERGE_AUTO_UPDATE_BRANCH_DISABLED: 'true' })).toBe(true);
    expect(selfMergeAutoUpdateBranchDisabled({})).toBe(false);
  });
});
