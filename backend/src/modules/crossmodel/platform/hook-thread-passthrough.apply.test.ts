/**
 * SAA-1.2 PHASE 2 — thread pass-through APPLIES (the flip).
 *
 * Phase 1 ran observe-only and earned its keep: it produced its first production
 * row at 01:10:54Z naming the Fleet Supervisor as the owning lane of a coding
 * session, corroborated independently by the auto-wired child-result hook for
 * that same pair. This file pins what the FLIP must now do, and — more
 * importantly — everything it must refuse to do.
 *
 * The four claims, in order of importance:
 *   1. A wake moves ONLY when the owning lane is a real, deliverable lane.
 *      Every uncertainty (dead edge, archived parent, another account, kill
 *      switch) delivers to the SUBSCRIBED target. The old route is always
 *      correct, only less efficient — a guard failure must never be a gamble.
 *   2. `targetChatId` is ALWAYS non-empty, so the fire site can never be handed
 *      '' and silently no-op.
 *   3. The fire site actually uses the decision (source-pinned), and the kill
 *      switch restores fixed-target delivery from box env with no deploy.
 *   4. The archived/other-account refusals exist because a blind `parentChatId`
 *      re-target would lose wakes: fireScheduleTarget REFUSES an archived chat,
 *      leaving rows pending while the supervisor wake that used to be acted on
 *      is silently skipped.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  HOOK_THREAD_PASSTHROUGH_DISABLED_KILL_TAG,
  planThreadPassthrough,
  threadPassthroughMetricMeta,
  hookThreadPassthroughDisabled,
  distinctGroupSourceChatIds,
  groupSpansMultipleThreads,
  THREAD_PASSTHROUGH_REASONS,
  type ThreadPassthroughDecision,
} from './hook-thread-passthrough';

const SUPERVISOR = { isSupervisor: true, isProjectSupervisor: false };
const PROJECT_SUPERVISOR = { isSupervisor: false, isProjectSupervisor: true };
const PLAIN_LANE = { isSupervisor: false, isProjectSupervisor: false };

const WILDCARD_HOOK = { sourceChatId: null, targetChatId: 'fleet-sup' };
const SPECIFIC_HOOK = { sourceChatId: 'child-1', targetChatId: 'parent-1' };

/** The parent row as the caller reads it: alive, same account, not archived. */
const LIVE_PARENT = { archivedAt: null, userId: 'owner-1' };
const OWNER = 'owner-1';

/** The one shape that moves a wake. Assembled once so each test varies ONE thing. */
function threadInput(over: Record<string, any> = {}) {
  return {
    hook: WILDCARD_HOOK,
    sourceChatId: 'lane-a',
    source: { parentChatId: 'thread-owner' },
    target: SUPERVISOR,
    parent: LIVE_PARENT,
    ownerUserId: OWNER,
    ...over,
  };
}

describe('SAA-1.2 Phase 2 — the wake moves to the owning lane', () => {
  it('delivers to the parent when it is a live, same-account lane', () => {
    const d = planThreadPassthrough(threadInput());
    expect(d.reason).toBe('owner_is_other_lane');
    expect(d.applied).toBe(true);
    expect(d.targetChatId).toBe('thread-owner');
    // wouldTargetChatId is the insight; targetChatId is the instruction. Both agree
    // only on an applied decision — that is the invariant the fire site relies on.
    expect(d.wouldTargetChatId).toBe('thread-owner');
  });

  it('treats a project supervisor target as the interceptable class too', () => {
    const d = planThreadPassthrough(threadInput({ target: PROJECT_SUPERVISOR }));
    expect(d.reason).toBe('owner_is_other_lane');
    expect(d.applied).toBe(true);
    expect(d.targetChatId).toBe('thread-owner');
  });

  it('ALWAYS returns a non-empty targetChatId — the fire site can never get ""', () => {
    const shapes: any[] = [
      threadInput(),
      threadInput({ hook: SPECIFIC_HOOK, sourceChatId: 'child-1' }),
      threadInput({ target: PLAIN_LANE }),
      threadInput({ source: null }),
      threadInput({ parent: null }),
      threadInput({ parent: { archivedAt: new Date(), userId: OWNER } }),
      threadInput({ parent: { archivedAt: null, userId: 'someone-else' } }),
      threadInput({ source: { parentChatId: 'lane-a' } }),
      threadInput({ source: { parentChatId: 'fleet-sup' } }),
    ];
    for (const s of shapes) {
      const d = planThreadPassthrough(s);
      expect(typeof d.targetChatId).toBe('string');
      expect(d.targetChatId.length).toBeGreaterThan(0);
    }
  });
});

describe('SAA-1.2 Phase 2 — everything else is refused, and falls back to the subscribed target', () => {
  it('specific hook: its target is already deliberate, so nothing moves', () => {
    const d = planThreadPassthrough(threadInput({ hook: SPECIFIC_HOOK, sourceChatId: 'child-1' }));
    expect(d.reason).toBe('specific_hook');
    expect(d.applied).toBe(false);
    expect(d.targetChatId).toBe('parent-1');
    expect(threadPassthroughMetricMeta(d)).toBeNull();
  });

  it('a lane target is already the owning lane', () => {
    const d = planThreadPassthrough(threadInput({ target: PLAIN_LANE }));
    expect(d.reason).toBe('target_not_supervisor');
    expect(d.applied).toBe(false);
    expect(d.targetChatId).toBe('fleet-sup');
  });

  it('a root chat has no lineage to walk', () => {
    for (const source of [{ parentChatId: null }, {}, null, undefined]) {
      const d = planThreadPassthrough(threadInput({ source: source as any }));
      expect(d.reason).toBe('no_lineage');
      expect(d.applied).toBe(false);
      expect(d.targetChatId).toBe('fleet-sup');
    }
  });

  it('lineage resolving back to the target means the supervisor already owns it', () => {
    const d = planThreadPassthrough(threadInput({ source: { parentChatId: 'fleet-sup' } }));
    expect(d.reason).toBe('owner_is_target');
    expect(d.applied).toBe(false);
    expect(d.targetChatId).toBe('fleet-sup');
  });

  it('a self-parent edge names the insight but never moves the wake', () => {
    const d = planThreadPassthrough(threadInput({ source: { parentChatId: 'lane-a' } }));
    expect(d.reason).toBe('lineage_unresolved');
    expect(d.applied).toBe(false);
    expect(d.targetChatId).toBe('fleet-sup');
  });
});

describe('SAA-1.2 Phase 2 — THE DELIVERABILITY GUARD (a blind parentChatId re-target loses wakes)', () => {
  it('refuses an ARCHIVED parent: fireScheduleTarget would refuse it and the wake would be lost', () => {
    for (const archivedAt of [new Date(), '2026-11-01T00:00:00.000Z']) {
      const d = planThreadPassthrough(threadInput({ parent: { archivedAt, userId: OWNER } }));
      expect(d.reason).toBe('owner_archived');
      expect(d.applied).toBe(false);
      // The supervisor still gets it — degraded routing, never a dropped wake.
      expect(d.targetChatId).toBe('fleet-sup');
      // The insight is still recorded, so the archived-owner population is visible.
      expect(d.wouldTargetChatId).toBe('thread-owner');
      expect(threadPassthroughMetricMeta(d)).toBeNull();
    }
  });

  it('refuses a parent owned by a DIFFERENT account — a wake must never cross accounts', () => {
    const d = planThreadPassthrough(threadInput({ parent: { archivedAt: null, userId: 'someone-else' } }));
    expect(d.reason).toBe('owner_other_account');
    expect(d.applied).toBe(false);
    expect(d.targetChatId).toBe('fleet-sup');
  });

  it('refuses a parent row that does not exist (a dead lineage edge)', () => {
    for (const parent of [null, undefined]) {
      const d = planThreadPassthrough(threadInput({ parent: parent as any }));
      expect(d.reason).toBe('lineage_unresolved');
      expect(d.applied).toBe(false);
      expect(d.targetChatId).toBe('fleet-sup');
    }
  });

  it('an unknown owner id cannot prove a cross-account move, so it is refused', () => {
    // Fail-closed on identity: without BOTH ids there is no positive proof the
    // parent is ours, and the cheap conservative route is the subscribed target.
    const d = planThreadPassthrough(threadInput({ ownerUserId: null }));
    expect(d.applied).toBe(false);
    expect(d.targetChatId).toBe('fleet-sup');
  });
});

describe('SAA-1.2 thread-key continuity — a group carrying SEVERAL threads is never re-targeted', () => {
  /**
   * WHY THIS SUITE EXISTS. The sweep groups pending rows by `hookId` ALONE
   * (`hooks.service.ts`: `groups.get(row.hookId)`), so a WILDCARD supervisor
   * hook's group routinely fans in from several chats at once — the coalesce
   * contract has to render `Source chat id: multiple (see per-source headers)`
   * precisely because the rows disagree. Routing never learned that fact: the
   * fire site derived ONE source chat from `rows[0]` and let that single
   * thread's owning lane decide the whole group, so a multi-thread wake would
   * hand every other thread's events to that one lane — the opposite of
   * continuity, and unrecoverable once delivered.
   *
   * These cases are written so that REMOVING the guard turns them red.
   */

  it('distinct ids dedupe, drop blanks, and preserve first-seen order', () => {
    expect(distinctGroupSourceChatIds(['b', 'a', 'b', '', null, undefined, '  a  '])).toEqual(['b', 'a']);
    expect(distinctGroupSourceChatIds([])).toEqual([]);
    expect(distinctGroupSourceChatIds(null)).toEqual([]);
  });

  it('a caller that passes no group falls back to the single sourceChatId — never to "many"', () => {
    // Backwards-compatible read: an older caller reads as ONE thread. That is
    // what keeps a normal single-lane wake routable after this change.
    expect(distinctGroupSourceChatIds(null, 'lane-a')).toEqual(['lane-a']);
    expect(groupSpansMultipleThreads(null, 'lane-a')).toBe(false);
  });

  it('one thread is routable; two threads are not', () => {
    expect(groupSpansMultipleThreads(['lane-a', 'lane-a'])).toBe(false);
    expect(groupSpansMultipleThreads(['lane-a', 'lane-b'])).toBe(true);
  });

  it('THE REGRESSION: a two-thread group delivers to the SUBSCRIBED target, not the first thread owner', () => {
    // Without the guard this is exactly the shape that produced a real
    // re-target (`owner_is_other_lane`, targetChatId 'thread-owner') because
    // the first row's lineage resolved to a live same-account parent.
    const d = planThreadPassthrough(threadInput({
      sourceChatId: 'lane-a',
      groupSourceChatIds: ['lane-a', 'lane-b'],
      source: { parentChatId: 'thread-owner' },
    }));
    expect(d.reason).toBe('multi_source_group');
    expect(d.applied).toBe(false);
    expect(d.targetChatId).toBe('fleet-sup'); // lane-b's events must not ride to lane-a's owner
    expect(threadPassthroughMetricMeta(d)).toBeNull(); // no "moved" row for a route that did not move
  });

  it('the refusal holds even when the FIRST thread has a perfect, deliverable owner', () => {
    // The guard is about the GROUP's shape, so no amount of per-thread
    // perfection in the first row can license the move.
    const d = planThreadPassthrough(threadInput({
      groupSourceChatIds: ['lane-a', 'lane-b', 'lane-c'],
      source: { parentChatId: 'thread-owner' },
      parent: { archivedAt: null, userId: OWNER },
      ownerUserId: OWNER,
    }));
    expect(d.applied).toBe(false);
    expect(d.targetChatId).toBe('fleet-sup');
    expect(d.wouldTargetChatId).toBe(''); // it never even named a lane
  });

  it('a single-thread group still re-targets — the guard must not disable SAA-1.2 itself', () => {
    const d = planThreadPassthrough(threadInput({ groupSourceChatIds: ['lane-a'] }));
    expect(d.reason).toBe('owner_is_other_lane');
    expect(d.applied).toBe(true);
    expect(d.targetChatId).toBe('thread-owner');
  });

  it('the kill switch still wins over everything, including a multi-thread group', () => {
    const d = planThreadPassthrough(threadInput({ groupSourceChatIds: ['lane-a', 'lane-b'] }), { HOOK_THREAD_PASSTHROUGH_DISABLED: '1' });
    expect(d.mode).toBe('off');
    expect(d.applied).toBe(false);
    expect(d.targetChatId).toBe('fleet-sup');
    expect(threadPassthroughMetricMeta(d)).toBeNull();
  });

  it('multi_source_group is a DISTINCT reason, so the refusals stay diagnosable', () => {
    expect(THREAD_PASSTHROUGH_REASONS).toContain('multi_source_group');
    expect(THREAD_PASSTHROUGH_REASONS).toContain('owner_is_other_lane');
  });
});

describe('SAA-1.2 Phase 2 — kill switch restores fixed-target delivery verbatim', () => {
  it('mode off, no move, no row — from box env, no deploy', () => {
    for (const v of ['1', 'true', 'on', ' ON ']) {
      const d = planThreadPassthrough(threadInput(), { HOOK_THREAD_PASSTHROUGH_DISABLED: v });
      expect(d.mode).toBe('off');
      expect(d.applied).toBe(false);
      expect(d.targetChatId).toBe('fleet-sup');
      expect(d.wouldTargetChatId).toBe('');
      expect(threadPassthroughMetricMeta(d)).toBeNull();
    }
    for (const v of ['', '0', 'false', 'off', undefined]) {
      expect(hookThreadPassthroughDisabled({ HOOK_THREAD_PASSTHROUGH_DISABLED: v })).toBe(false);
    }
  });
});

describe('SAA-1.2 Phase 2 — the metric records ids only, and only a real move', () => {
  it('uploads ids and counts only — never prose', () => {
    const meta = threadPassthroughMetricMeta(planThreadPassthrough(threadInput()))!;
    expect(Object.keys(meta).sort()).toEqual(['applied', 'hookClass', 'reason', 'sourceChatId', 'wouldTargetChatId']);
    expect(meta.applied).toBe(true);
    for (const v of Object.values(meta)) {
      if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(64);
    }
  });

  it('writes no row when the wake did NOT move', () => {
    expect(threadPassthroughMetricMeta(planThreadPassthrough(threadInput({ target: PLAIN_LANE })))).toBeNull();
    expect(threadPassthroughMetricMeta(planThreadPassthrough(threadInput({ parent: null })))).toBeNull();
  });

  it('pins the reason vocabulary closed (a new reason must opt in)', () => {
    expect([...THREAD_PASSTHROUGH_REASONS].sort()).toEqual([
      'lineage_unresolved', 'multi_source_group', 'no_lineage', 'owner_archived',
      'owner_is_other_lane', 'owner_is_target', 'owner_other_account', 'specific_hook',
      'target_not_supervisor',
    ]);
    expect(typeof HOOK_THREAD_PASSTHROUGH_DISABLED_KILL_TAG).toBe('string');
  });
});

/**
 * SOURCE PINS — the leaf's decision is only real if the delivery path consumes
 * it. These assert the assembled call site, not the pure function above.
 */
describe('SAA-1.2 Phase 2 exit gate — the fire site consumes the decision', () => {
  const src = fs.readFileSync(path.join(__dirname, 'hooks.service.ts'), 'utf8');
  const block = src.slice(src.indexOf('SAA-1.2 PHASE 2'), src.indexOf('const coalesced = coalesce(rows);'));

  it('deliveryChatId defaults to the subscribed target (so every refusal is the old route)', () => {
    expect(src).toContain('let deliveryChatId = hook.targetChatId;');
  });

  it('moves ONLY on an applied decision', () => {
    expect(block).toContain('if (threadDecision.applied) deliveryChatId = threadDecision.targetChatId;');
  });

  it('reads the parent row for the guard (archivedAt + userId)', () => {
    expect(block).toContain('archivedAt: true, userId: true');
    expect(block).toContain('ownerUserId:');
  });

  it('the wake, the depth stamp and the delivered metric all use deliveryChatId', () => {
    expect(src).toContain('sessionId: deliveryChatId, prompt, origin');
    expect(src).toContain('await stampHookDepth(deliveryChatId,');
    expect(src).toContain('kind: LOOP_METRIC_KINDS.WAKE_DELIVERED, sessionId: deliveryChatId');
  });

  it('is guarded, fail-open, and gated to wildcard→supervisor', () => {
    expect(block).toContain('hookThreadPassthroughDisabled()');
    expect(block).toContain('hook.sourceChatId === null');
    expect(block).toContain('catch');
  });

  it('the daily-cap token is NOT re-pointed at the delivery lane', () => {
    // The token is taken against hook.targetChatId upstream; refunding a lane
    // that never held one would corrupt that lane's budget. Routing changes
    // WHO is woken, never WHO pays.
    expect(src).toContain('await refundDailyCapToken(hook.targetChatId);');
    expect(src).not.toContain('refundDailyCapToken(deliveryChatId)');
  });
});

/** Compile-time shape guard: a decision always carries a deliverable target. */
const _shapeGuard: (d: ThreadPassthroughDecision) => string = (d) => d.targetChatId;
void _shapeGuard;