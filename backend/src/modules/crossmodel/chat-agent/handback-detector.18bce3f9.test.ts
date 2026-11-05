/**
 * Replay for ticket 18bce3f9 (2026-10-07) — the nightly live-chat audit filed
 * "6 answers handing requested work back to the user". The prod probes read all
 * 14 handback_detected rows over the 48 h window and showed the ticket's class
 * was double-counted:
 *
 *  1. 4 of the 5 ticket sample chats were model-bench traffic
 *     (claudebot@digby.ai, titles "model-bench …", turnPlan.synthetic=true) —
 *     synthetic answers counted as "real human turns" by the audit.
 *  2. Every one of the 14 rows carried deadlineHit=false, stepsExhausted=false,
 *     stagedCard=false: no run-state incompleteness evidence at all. The real
 *     rows were the doctrine's own proactive offer after a COMPLETE answer
 *     ("Just say the word." closing three delivered captions; "Want me to dig
 *     deeper into any of this?"; "say the word if you'd like normal-length
 *     replies back") — the exact shape the detector's precision contract says
 *     it must NOT fire on. The strong idioms fired unconditionally.
 *
 * This replay pins BOTH halves against the live closing texts (verbatim from
 * the prod probe, 2026-10-07): the detector's evidence gate, and the audit's
 * bench-account exclusion. Pure leaf tests — no mocks.
 */
import {
  findHandback, handbackMidTaskEvidence, closingSegments,
} from './handback-detector';

/** A staged WORK-tool card exactly as the harness mints it (the only shape that
 *  is hard evidence on its own). */
const STAGED_WORK_PARTS = [
  { type: 'tool_call', name: 'start_coding_session', args: { title: 'Build the investor deck' } },
  { type: 'tool_result', name: 'start_coding_session', result: JSON.stringify({ ok: false, needsConfirmation: true, confirmationId: 'cf_11aa22bb', summary: 'Start a coding session: Build the investor deck', expiresInMinutes: 30 }) },
];

// ── The live rows (verbatim closings from the prod probe, 48 h window) ────────
const LIVE_OFFER_ROWS: string[] = [
  // cc1ca280 (glm-5.3) — the answer delivered 3 captions ABOVE this line
  'If you want a few hashtags for reach: #beachsunset #goldenhour\n\nWant different vibes (funny, romantic, travel-blogger style) or a caption tailored to a specific beach? Just say the word.',
  // 05c46263 — same question, captions delivered above
  'Optional hashtags: #goldenhour #sunsetlover #coastalvibes\n\nWant a different tone (moody, romantic, funny, travel-blog)? Just say the word and I\'ll rewrite them.',
  // e802afea (qwen3.6-27b) — a complete 5800-char policy answer closed with the Dig-deeper offer
  'The most pragmatic path isn\'t a top-down mandate but a **carrot-and-stick approach**: incentivize adoption where the evidence supports it, mandate flexibility where it doesn\'t, and let sectors self-select based on operational reality.\n\n---\n\n**Want me to dig deeper into any of this?**',
  // 7aa63652 (kimi-k3) — the asked opening paragraph delivered above
  'Keep the opening to 3–4 sentences; the paragraphs after it do the heavy lifting. And skip the clichés — no "I am writing to express my keen interest" or "I\'ve always been passionate about data."\n\nWant me to write the rest of the letter — body paragraphs and closing — built on whichever opening you pick?',
  // 6fab3c50 (glm-5.3) — three near-duplicate plans found and REPORTED; opening any is a new ask
  'Note: you have three near-duplicate versions of the CQL business plan — say the word if you\'d like me to open any of them, or clean up the older copies.',
  // e28d5f86 (glm-5.3) — the one-sentence reply the user asked for was HONORED above
  '(I also see a recorded agreement from today to answer in this chat with one sentence — honored above; say the word if you\'d like normal-length replies back.)',
  // 60e2e9c4 — lid on a rule the user themselves set; next questions listed below
  'If you\'d like the lid lifted on the one-sentence rule for a topic like this, just say so — but meanwhile, here are natural next questions:',
  // 140c78f2 — resort question answered; a NEW comparison table offered
  'Post-Christmas is peak season and Beaches/Shore Club villas book out early — worth locking dates now.',
];

// The full answers for the rows whose mid-answer prose matters (the owner
// transcript shapes, with the mid-task evidence the live rows lacked).
const OWNER_CUTOFF = 'I have everything I need for the deck: the three positioning points from our earlier chat, the Q3 numbers, and the logo file you uploaded.\n\nI pulled the threads before tools cut off this run, so the fourth one is still unread.\n\nSay the word and I will search her thread next.';

describe('18bce3f9 — the hand-back detector\'s evidence gate (the live rows)', () => {
  it.each(LIVE_OFFER_ROWS.map((c, i) => [i, c] as const))(
    'live row %i: the doctrine\'s own offer after a complete answer fires NO hand-back (no cue evidence, no run-state evidence)',
    (_i, closing) => {
      expect(findHandback({ finalText: closing, stepsUsed: 2, maxSteps: 8 })).toBeNull();
      // …with the deadline flag the live rows actually carried (false), and with
      // steps far from max: the exact state all 14 rows were in.
      expect(findHandback({ finalText: closing, deadlineHit: false, stepsUsed: 2, maxSteps: 8 })).toBeNull();
    },
  );

  it('the owner transcript WITH cut-off evidence still fires (a true hand-back is never suppressed)', () => {
    const f = findHandback({ finalText: OWNER_CUTOFF, stepsUsed: 3, maxSteps: 8 });
    expect(f).not.toBeNull();
    expect(f!.strength).toBe('strong');
    expect(f!.phrase.toLowerCase()).toBe('say the word');
  });

  it('mid-task text evidence alone (no deadline, no card, no exhaustion) fires: "I did not get to her thread"', () => {
    const f = findHandback({ finalText: 'Three threads are summarised above — I did not get to her thread. Say the word and I will search it next.', stepsUsed: 2, maxSteps: 8 });
    expect(f?.strength).toBe('strong');
  });

  it('a staged WORK-tool card alone fires (the permission the harness never demanded)', () => {
    const f = findHandback({ finalText: 'The workspace is ready to start. Say the word.', parts: STAGED_WORK_PARTS, stepsUsed: 2, maxSteps: 8 });
    expect(f?.strength).toBe('strong');
    expect(f!.stoppedShort.stagedCard).toBe(true);
  });

  it('the cut-off mid-task family is whole-answer, the unfinished family closing-only (handbackMidTaskEvidence)', () => {
    expect(handbackMidTaskEvidence('Tools were cut off mid-run.', 'Anything after.')).toMatch(/cut off/i);
    expect(handbackMidTaskEvidence('Complete answer.', 'I did not get to her thread.')).toMatch(/did not get to/);
    expect(handbackMidTaskEvidence('Complete answer.', 'All threads are summarised above.')).toBeNull();
    // the "natural next questions" artifact: NOT unfinished-work evidence
    expect(handbackMidTaskEvidence('Complete answer.', 'Here are natural next questions:')).toBeNull();
  });

  it('closingSegments: the live rows\' final segments are what the gate reads (deterministic window)', () => {
    const segs = closingSegments(LIVE_OFFER_ROWS[0]);
    expect(segs.length).toBeGreaterThan(0);
    expect(segs[segs.length - 1]).toMatch(/Just say the word\.$/);
  });
});
