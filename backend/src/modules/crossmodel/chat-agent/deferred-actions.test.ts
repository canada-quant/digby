/**
 * Remediation P2 spark G8 — deferred-action detectors (pure halves). The
 * finalize wiring is pinned in chat-agent.service.test.ts ('spark G8 —
 * deferred-action receipts'). Gate flip 2026-09-11 (owner: full steam): the
 * detector STAYS (this file), but the consumer is observe-only — a
 * `supervisor_deferral_unarmed` loop metric + a transcript note, no auto-armed
 * schedule. `deferredActionPrompt` is kept exported for forensics / a revert.
 */

import {
  findDeferralLine,
  detectUnarmedDeferral,
  runArmedSchedule,
  runSentLaneMessage,
  deferredActionPrompt,
  DEFERRED_ACTION_MARKER,
  DEFERRAL_IDIOM_RE,
  findDeferralClause,
  deferralNotePrecisionDisabled,
  textDefers,
  citedScheduleIds,
  deferralCadenceExemptDisabled,
} from './deferred-actions';

describe('findDeferralLine', () => {
  it('finds the 21:00Z incident shape ("the swap runs next wake")', () => {
    const note = '**Bench done — Machete wins.**\nThe winning swap runs next wake; nothing needs the owner.';
    expect(findDeferralLine(note)).toContain('runs next wake');
  });

  it('matches the doctrine idioms: will verify / re-arm after / check back / after the bench', () => {
    for (const line of [
      'Will verify the deploy on the next sweep.',
      'Re-arm after the cap resets.',
      'Checking back tomorrow on the PR.',
      'Dispatch the swap after the bench completes.',
    ]) {
      expect(DEFERRAL_IDIOM_RE.test(line)).toBe(true);
    }
  });

  it('does NOT trip on completed-work reporting or harness chrome', () => {
    expect(findDeferralLine('Verified the deploy and closed ticket ab12cd34.')).toBeNull();
    expect(findDeferralLine('[HARNESS NOTE] will verify next wake')).toBeNull(); // bracketed chrome skipped
    expect(findDeferralLine('SWEEP: no-op (nothing changed)')).toBeNull();
  });

  it('clips a very long deferral line', () => {
    const line = `The cutover runs next wake ${'x'.repeat(400)}`;
    expect(findDeferralLine(line)!.length).toBeLessThanOrEqual(240);
  });
});

describe('tool-call detectors', () => {
  it('runArmedSchedule sees schedule_message / schedule_self calls', () => {
    expect(runArmedSchedule([{ type: 'tool_call', name: 'schedule_message', args: { kind: 'once' } }])).toBe(true);
    expect(runArmedSchedule([{ type: 'tool_call', name: 'schedule_self' }])).toBe(true);
    expect(runArmedSchedule([{ type: 'tool_call', name: 'get_chat_status' }])).toBe(false);
    expect(runArmedSchedule(undefined)).toBe(false);
  });

  it('runSentLaneMessage sees send_chat_message / send_to_instance / start_coding_session', () => {
    expect(runSentLaneMessage([{ type: 'tool_call', name: 'send_chat_message' }])).toBe(true);
    expect(runSentLaneMessage([{ type: 'tool_call', name: 'start_coding_session' }])).toBe(true);
    expect(runSentLaneMessage([{ type: 'text', text: 'send_chat_message' }])).toBe(false);
  });
});

describe('detectUnarmedDeferral', () => {
  const NOTE = 'Bench complete. The winning swap runs next wake.';

  it('the incident shape: deferral + no arm + no send → needs a receipt', () => {
    expect(detectUnarmedDeferral(NOTE, []).deferralLine).toContain('runs next wake');
  });

  it('an armed schedule or a lane message clears it', () => {
    expect(detectUnarmedDeferral(NOTE, [{ type: 'tool_call', name: 'schedule_message' }]).deferralLine).toBeNull();
    expect(detectUnarmedDeferral(NOTE, [{ type: 'tool_call', name: 'send_chat_message' }]).deferralLine).toBeNull();
  });
});

describe('deferredActionPrompt', () => {
  it('leads with the marker and quotes the deferred line', () => {
    const p = deferredActionPrompt('The swap runs next wake');
    expect(p.startsWith(DEFERRED_ACTION_MARKER)).toBe(true);
    expect(p).toContain('The swap runs next wake');
    expect(p).toContain('STANDING DOWN');
  });
});

// audit 2026-10-06 T8-9: the note quotes the deferral CLAUSE (the line head "Fresh probe at 22:56Z…" told the
// model nothing about what it deferred).
describe('findDeferralClause (audit 2026-10-06 T8-9)', () => {
  afterEach(() => { delete process.env.DEFERRAL_NOTE_PRECISION_DISABLED; });

  it('returns the sentence / clause carrying the idiom, not the line head', () => {
    expect(findDeferralClause('Fresh probe at 22:56Z: shard 4 healthy. My next sweep re-checks the mirror.')).toBe('My next sweep re-checks the mirror.');
    expect(findDeferralClause('Bench complete: Machete config won. The winning swap runs next wake — no action needed from the owner.')).toBe('The winning swap runs next wake');
    expect(findDeferralClause('PR #12 merged; will verify after the deploy | shard 3 fine')).toBe('will verify after the deploy');
  });

  it('clips long clauses and answers null when nothing defers', () => {
    expect(findDeferralClause('Verified the deploy.')).toBeNull();
    expect(findDeferralClause('')).toBeNull();
    const long = `will verify ${'x '.repeat(200)}`;
    expect(findDeferralClause(long)!.length).toBeLessThanOrEqual(160);
  });

  it('detectUnarmedDeferral carries the clause beside the line', () => {
    const v = detectUnarmedDeferral('Fresh probe at 22:56Z: shard 4 healthy. My next sweep re-checks the mirror.', []);
    expect(v.deferralLine).toContain('Fresh probe');
    expect(v.deferralClause).toBe('My next sweep re-checks the mirror.');
  });

  it('kill switch reader', () => {
    expect(deferralNotePrecisionDisabled()).toBe(false);
    process.env.DEFERRAL_NOTE_PRECISION_DISABLED = '1';
    expect(deferralNotePrecisionDisabled()).toBe(true);
  });
});

// Ticket fcee0741 (2026-10-06, lane-filed): ~100% false positives on routine armed-cadence lines. A line citing a
// schedule id is ARMED by the citation; a bare "next sweep/wake/run" noun phrase (label / time announcement / cell /
// heading / another actor's cadence) is not a deferral. Every pre-fcee0741 must-trip case above stays green.
describe('fcee0741 — cadence announcements and cited schedules are not unarmed deferrals', () => {
  afterEach(() => { delete process.env.DEFERRAL_CADENCE_EXEMPT_DISABLED; });

  // The ticket's three quoted lines, verbatim from the prod notes (2026-10-06 19:08Z / 18:33Z / 20:15Z).
  const TICKET_LINES = [
    '**Next sweep:** 21:47Z (schedule 53f68b62).',
    '**Unchanged:** Drive watch 1c2b28d6 — 18:08Z tick (firing 14/500, sched d72b394a): no classroom audio in the tutor folder, expected; next wake 19:09Z future. Board: 0 active/blocked goals · 4 done · 0 open todos · 0 open owner questions — nothing waiting on the owner.',
    '**Open threads for next sweep:** (1) real-dB validation fire with journal evidence (2) backlog child session spawn (3) fresh signed-in emulator snapshot.',
  ];

  it("the ticket's three quoted lines do NOT trip (must-NOT-trip)", () => {
    for (const line of TICKET_LINES) {
      expect(detectUnarmedDeferral(`Sweep done.\n${line}`, []).deferralLine).toBeNull();
    }
  });

  it('…and the pre-fcee0741 detector DID trip on each of them (the regression the ticket measured)', () => {
    process.env.DEFERRAL_CADENCE_EXEMPT_DISABLED = '1';
    expect(deferralCadenceExemptDisabled()).toBe(true);
    for (const line of TICKET_LINES) {
      expect(detectUnarmedDeferral(`Sweep done.\n${line}`, []).deferralLine).toBe(line.length <= 240 ? line : `${line.slice(0, 239)}…`);
    }
  });

  it("more prod cadence shapes are noun phrases: a bare table cell, a heading, another lane's cadence, a status-until, a time announcement, a short label", () => {
    for (const line of [
      '| crossmodel | Framework Operator mid-firing; PR #1259 merge unverified by my own read | next wake |',
      '| crossmodel (platform) | Not re-read this wake; ticket-row verification carried | Next sweep |',
      '## Next (my next wake)',
      "- MiMo key: the lane's next run should act on your ruling — I could not verify it landed this wake.",
      '**Research watch 6ef785c3**: idle until next wake 17:54Z future.',
      '- **Main lane ddd26be0**: idle, no error, no pending input, plan 5/5 complete; next wake 23:43Z future.',
      '- **Board (01:03Z ledger):** goal b3f240e4 active (9/11); FO next wake 02:32Z future; research watch idle.',
      '**Watching next sweep:** (1) real-dB validation fire within ~1h — first audible capture still pending.',
      '- Next sweep: audit the 6 machine-written schedule prompts flagged by the fleet check (not reached this run).',
      '**Carried for next sweep — not verified this run**',
    ]) {
      expect({ line, defers: textDefers(line) }).toEqual({ line, defers: false });
      expect(detectUnarmedDeferral(line, []).deferralLine).toBeNull();
    }
  });

  it('commitments still trip (must-trip): a verb on the cadence, first person, a governed queue, a dangling ", next sweep"', () => {
    for (const line of [
      'Bench complete. The winning swap runs next wake.', // the 2026-09-08 G8 incident shape
      'Fresh probe at 22:56Z: shard 4 healthy. My next sweep re-checks the mirror.',
      'Will verify the deploy on the next sweep.',
      "Next sweep: I'll retire the lane once its run finalizes.",
      'Queued for the next sweep: the cutover.',
      'The swap runs next wake at 22:00Z.',
      'next wake 22:00Z, then the swap runs',
      '| crossmodel | AGX rebuild | re-verify next wake |',
      '**Next** — reconcile the Path C PoC goal: PLANNED — NOT EXECUTED, next sweep.',
      '- Watchdog decision lands ~07:45Z (12:45 AM PDT) — outcome read on the next sweep.',
      "It's next wake.",
      'Swap next wake 22:00Z.',
      'The swap runs next wake: Machete config, cut over at once.',
      '- Re-check two quiet lanes next sweep: tt-qwen repoint, tt-rd supervisor.',
    ]) {
      expect({ line, defers: textDefers(line) }).toEqual({ line, defers: true });
      expect(detectUnarmedDeferral(line, []).deferralLine).not.toBeNull();
    }
  });

  it('citedScheduleIds: "schedule|sched <8+ hex>" (id prefix, lowercased, deduped) — never schedule_message / "scheduled"', () => {
    expect(citedScheduleIds('**Next sweep:** 21:47Z (schedule 53f68b62).')).toEqual(['53f68b62']);
    expect(citedScheduleIds('(firing 14/500, sched d72b394a)')).toEqual(['d72b394a']);
    expect(citedScheduleIds('armed schedule id: 53F68B62-1111-4222-8333-444455556666')).toEqual(['53f68b62']);
    expect(citedScheduleIds('schedule `0a1b2c3d` and sched 0a1b2c3d')).toEqual(['0a1b2c3d']);
    expect(citedScheduleIds('called schedule_message 53f68b62')).toEqual([]);
    expect(citedScheduleIds('scheduled 53f68b62')).toEqual([]);
    expect(citedScheduleIds('schedule 53f6')).toEqual([]);
  });

  it('a commitment line that cites a schedule id is ARMED by the citation — reported as citedLine, never deferralLine', () => {
    const v = detectUnarmedDeferral('Bench complete.\nThe swap runs next wake (schedule 1a2b3c4d armed for it).', []);
    expect(v.deferralLine).toBeNull();
    expect(v.citedLine).toBe('The swap runs next wake (schedule 1a2b3c4d armed for it).');
    expect(v.citedScheduleIds).toEqual(['1a2b3c4d']);
  });

  it('a cited line does not hide a LATER uncited commitment; the clause is found on the unclipped line', () => {
    const v = detectUnarmedDeferral('Will verify the PR next wake (sched 1a2b3c4d).\nThe cutover runs next wake.', []);
    expect(v.deferralLine).toBe('The cutover runs next wake.');
    expect(v.citedScheduleIds).toEqual(['1a2b3c4d']);
    const w = detectUnarmedDeferral(`${'x'.repeat(260)}. The cutover runs next wake.`, []);
    expect(w.deferralLine!.length).toBeLessThanOrEqual(240);
    expect(w.deferralClause).toBe('The cutover runs next wake.');
  });

  it('a run that armed a schedule or messaged a lane still clears everything (no citedLine either)', () => {
    expect(detectUnarmedDeferral('The swap runs next wake (schedule 1a2b3c4d).', [{ type: 'tool_call', name: 'schedule_message' }])).toEqual({ deferralLine: null });
  });

  it('findDeferralClause prefers the commitment clause over a cadence label in the same line', () => {
    expect(findDeferralClause('**Next sweep:** 21:47Z. The cutover runs next wake.')).toBe('The cutover runs next wake.');
  });

  it('DEFERRAL_CADENCE_EXEMPT_DISABLED=1: the pre-fcee0741 detector byte-for-byte (no exemption, no citation)', () => {
    process.env.DEFERRAL_CADENCE_EXEMPT_DISABLED = '1';
    expect(textDefers('**Next sweep:** 21:47Z (schedule 53f68b62).')).toBe(true);
    expect(detectUnarmedDeferral('The swap runs next wake (schedule 1a2b3c4d).', [])).toEqual({
      deferralLine: 'The swap runs next wake (schedule 1a2b3c4d).',
      deferralClause: 'The swap runs next wake (schedule 1a2b3c4d).',
    });
    expect(findDeferralLine('| crossmodel | ok | next wake |')).toBe('| crossmodel | ok | next wake |');
  });
});
