/**
 * agent-derail-break.closeout-20260920.test.ts — CLOSEOUT CITATION PINS for the
 * 2026-09-20 kimi-k3 placeholder/wrong-tool derail batch: f218735b, e36dff44,
 * 4f3ecab9 (PR #908, merge 740fe816) + c5ad2e56 (PR #911, merge 7181427e).
 *
 * WHY THIS FILE EXISTS (the close-gate lane, closure-evidence.ts): the
 * verified-close gate resolves replayTestPath LOCALLY first and a local hit
 * SHORT-CIRCUITS the origin/main fallback — so citations appended to the
 * PRE-EXISTING ledger files (agent-derail-break.718a04a5.test.ts) cannot
 * verify on a stale instance checkout (three replay_test_unciting refusals on
 * lane b92ef13f, 12:05–12:28Z). A NEW file is a local MISS, which engages the
 * designed origin/main fallback lane ("stale-checkout tolerated" — the
 * d18241b3 close at 12:06:29Z via agent-derail-reanchor.431518a2.test.ts set
 * the precedent).
 *
 * ⚠ UPDATED 2026-09-23 (ticket cc7004a7): the hole described above is FIXED
 * at the cause — a local CITATION miss on a pre-existing file now runs the
 * same origin/main consult as a local file miss, so appended citations
 * verify on a stale checkout too. This file's pins still pass and still
 * serve as close-gate keys; the new-file workaround is no longer REQUIRED,
 * merely harmless. See closure-evidence.cc7004a7.test.ts for the replay. Each test below carries its ticket id prefix in the test
 * name AND asserts the ledger citation exists, so the pins are both
 * close-gate keys and a regression guard against the citations being dropped.
 *
 * The executable mechanism pins (breaker arithmetic, refusal envelopes) live
 * in agent-derail-break.718a04a5.test.ts and agent-derail-break.0aecbe92.test.ts;
 * this file does not duplicate them.
 */
import * as fs from 'fs';
import * as path from 'path';

const LEDGER = path.join(__dirname, 'agent-derail-break.718a04a5.test.ts');
const ledger = () => fs.readFileSync(LEDGER, 'utf8');

describe('closeout citation pins — 2026-09-20 derail batch (evidence-close keys via the origin/main fallback lane)', () => {
  it('f218735b — ledger cites the CanLaw coordinator placeholder-noop occurrence (MODEL verdict)', () => {
    const s = ledger();
    expect(s).toContain('f218735b');
    expect(s).toContain('e083ff2e'); // CanLaw coordinator lane
    expect(s).toContain('ad58d5ef'); // run
    expect(s).toContain('MODEL verdict');
  });

  it('e36dff44 — ledger cites the Path C lane update_feedback ungrounded-id occurrence (MODEL verdict)', () => {
    const s = ledger();
    expect(s).toContain('e36dff44');
    expect(s).toContain('cec340f2'); // "Re-Send Path C Phase 2 Kickoff" lane
    expect(s).toContain('75d8e448'); // run
    expect(s).toContain('observe_resource'); // the tool its reasoning named
  });

  it('4f3ecab9 — ledger cites the Path C lane update_document placeholder-none occurrence (MODEL verdict)', () => {
    const s = ledger();
    expect(s).toContain('4f3ecab9');
    expect(s).toContain('search_memory'); // the tool its reasoning named
    expect(s).toContain("'none'"); // the model-authored placeholder id
  });

  it('c5ad2e56 — ledger cites the update_schedule placeholder-streak occurrence, first on the schedule-mutation family (MODEL verdict)', () => {
    const s = ledger();
    expect(s).toContain('c5ad2e56');
    expect(s).toContain('28de72e5'); // "GLM-5.3 Deployment on Dual Sparks" lane
    expect(s).toContain('update_schedule');
    expect(s).toContain('placeholder-abort'); // the model-authored placeholder ids
    expect(s).toContain('list_chats'); // the tool its reasoning named
  });
});
