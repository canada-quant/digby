/**
 * Turn continuation — the deterministic detector, the closing rewrite, the
 * round prompt and the arm/cap rules (cohesive-chat wave 2026-09-28).
 *
 * The two owner transcripts are replayed VERBATIM (the iMessage "say the word"
 * hand-back and the deck "confirm the card" hand-back) beside negatives a
 * continuation must never swallow: a credentials ask, an ambiguous target, an
 * either/or the user must pick, a plain clarifying question, and a finished
 * answer. Pure leaf — no prisma, no redis.
 */
import {
  classifyRunEnd, rewriteClosingText, continuationPrompt, parseContinuationRound, nextContinuationRound,
  armTurnContinuation, continuationMaxRounds, planTouchedSince, planUnfinishedCount, planStepCounts, receiptCounts,
  closingText, midTaskEvidence, recoverContinuationFromPrompt, isContinuationPrompt,
  CONTINUATION_LINE, CONTINUATION_CAP_LINE, type ContinuationRun,
} from './turn-continuation';

// ── The owner's two real closings (2026-09-28 evidence) ────────────────────
const OWNER_IMESSAGE = `I pulled the threads before tools cut off this run. Here is what I found in the three most recent conversations:

- Mum (yesterday): asked whether Sunday still works; you have not replied.
- Dave: sent the invoice PDF and a "thanks" — nothing pending.
- The school group: two reminders about the Friday form.

I did not get to her thread — say the word and I will search her thread next.`;

const OWNER_DECK = `I have set up the deck build as a coding session with the brief below (12 slides, the Q3 numbers from the sheet, your brand colours).

Deck build is staged and waiting on your one click — confirm the card and I will start it.`;

describe('classifyRunEnd — the owner transcripts', () => {
  it('the iMessage "say the word" hand-back is a continuation (mid-task at the deadline)', () => {
    const v = classifyRunEnd({ finalText: OWNER_IMESSAGE, deadlineHit: true });
    expect(v).toMatchObject({ kind: 'continue', reason: 'deadline_mid_task' });
    expect((v as any).matched).toMatch(/say the word|tools cut off/i);
  });

  it('the same hand-back WITHOUT the deadline is still a continuation (offer_to_continue)', () => {
    expect(classifyRunEnd({ finalText: OWNER_IMESSAGE })).toMatchObject({ kind: 'continue', reason: 'offer_to_continue' });
  });

  it('the deck "confirm the card" hand-back is a continuation (confirmation_handback)', () => {
    const v = classifyRunEnd({ finalText: OWNER_DECK });
    expect(v).toMatchObject({ kind: 'continue', reason: 'confirmation_handback' });
    expect((v as any).matched).toMatch(/confirm the card|staged and waiting|waiting on your one click/i);
  });
});

describe('classifyRunEnd — offers and plan state', () => {
  const OFFERS = [
    'I have the list ready. Shall I proceed with sending the reminders?',
    'That is the summary. Want me to pull the full thread next?',
    'Next, I will draft the reply — let me know if you want me to continue.',
    'I can search her thread next if you like.',
    'Everything else is in place. Give me the go-ahead and I will run the migration.',
    'The first two are done. Ready when you are for the third.',
  ];
  // audit 2026-10-08 W4-1c: the deadline ALONE no longer corroborates an offer (a forced FINAL TURN usually writes a
  // complete answer); it continues beside an open plan written this run or a mid-task marker.
  it.each(OFFERS)('an offer beside the DEADLINE alone ⇒ done (W4-1c): %s', (text) => {
    expect(classifyRunEnd({ finalText: text, deadlineHit: true })).toEqual({ kind: 'done' });
  });
  it.each(OFFERS)('an offer beside the DEADLINE + an open plan written this run ⇒ continue (deadline_mid_task): %s', (text) => {
    expect(classifyRunEnd({ finalText: text, deadlineHit: true, unfinishedSteps: 1, planTouchedThisRun: true })).toMatchObject({ kind: 'continue', reason: 'deadline_mid_task' });
  });
  it.each(OFFERS)('CONTINUATION_DEADLINE_CORROBORATION_DISABLED=1 restores the deadline alone as evidence: %s', (text) => {
    process.env.CONTINUATION_DEADLINE_CORROBORATION_DISABLED = '1';
    try {
      expect(classifyRunEnd({ finalText: text, deadlineHit: true })).toMatchObject({ kind: 'continue', reason: 'deadline_mid_task' });
    } finally {
      delete process.env.CONTINUATION_DEADLINE_CORROBORATION_DISABLED;
    }
  });
  it.each(OFFERS)('an offer at the closing beside an OPEN PLAN written this run ⇒ continue (offer_to_continue): %s', (text) => {
    expect(classifyRunEnd({ finalText: text, unfinishedSteps: 1, planTouchedThisRun: true })).toMatchObject({ kind: 'continue', reason: 'offer_to_continue' });
  });
  it.each(OFFERS)('an offer with NO incompleteness evidence is the doctrine offer / a sign-off ⇒ done (review fix 1): %s', (text) => {
    expect(classifyRunEnd({ finalText: text })).toEqual({ kind: 'done' });
  });

  // Review fix 1: the doctrine's own "Good" offers and ordinary sign-offs on a
  // COMPLETE answer must never be rewritten to "Still working on this".
  it.each([
    'Bitcoin is at $118,400 this morning, up 2% on the day.\n\nWant me to check this again tomorrow morning and message you on Telegram?',
    'Here are the three sources with the numbers.\n\nWant me to save these sources to the project\'s knowledge base?',
    'That is the weekly summary.\n\nI can turn this into a daily feed.',
    'The capital of Australia is Canberra.\n\nLet me know if you have any other questions.',
    'Want me to draft a reply?',
    'Would you like me to run the same numbers for Q4?',
    'Ready when you are.',
    'Done — the three reminders are sent. Let me know if you want me to send a fourth.',
  ])('a complete answer ending in a proactive offer / sign-off ⇒ done, never rewritten: %s', (text) => {
    expect(classifyRunEnd({ finalText: text })).toEqual({ kind: 'done' });
  });

  it('a mid-task marker in the text is evidence on its own (no deadline, no plan): the cut-off family anywhere, the unfinished family in the closing', () => {
    expect(classifyRunEnd({ finalText: 'I read two of the four reports before tools cut off this run.\n\nWant me to read the other two?' })).toMatchObject({ kind: 'continue', reason: 'offer_to_continue' });
    expect(classifyRunEnd({ finalText: 'Two reports are summarised. I did not get to the other two — say the word and I will read them next.' })).toMatchObject({ kind: 'continue', reason: 'offer_to_continue' });
    expect(classifyRunEnd({ finalText: 'I ran out of time on the last step. Shall I continue?' })).toMatchObject({ kind: 'continue', reason: 'offer_to_continue' });
    expect(midTaskEvidence('all done before lunch', closingText('all done before lunch'))).toBeNull();
    expect(midTaskEvidence('tools cut off this run', '')).toMatch(/cut off/i);
  });

  it('an offer buried mid-answer is NOT a hand-back — only the closing counts', () => {
    const text = 'I could also check the calendar if you want. Anyway, the answer is 42.\n\nThe invoice total is $1,204.50 and it is due on the 14th.';
    expect(classifyRunEnd({ finalText: text })).toEqual({ kind: 'done' });
  });

  it('the deadline over an open plan written THIS run ⇒ deadline_unfinished_plan', () => {
    expect(classifyRunEnd({ finalText: 'Here is what I have so far: two of the four reports are summarised.', deadlineHit: true, unfinishedSteps: 2, planTouchedThisRun: true }))
      .toMatchObject({ kind: 'continue', reason: 'deadline_unfinished_plan' });
  });

  it('an open plan written this run without the deadline ⇒ unfinished_plan; a STALE plan never counts', () => {
    expect(classifyRunEnd({ finalText: 'Two reports summarised.', unfinishedSteps: 2, planTouchedThisRun: true })).toMatchObject({ kind: 'continue', reason: 'unfinished_plan' });
    expect(classifyRunEnd({ finalText: 'Two reports summarised.', unfinishedSteps: 2, planTouchedThisRun: false })).toEqual({ kind: 'done' });
    expect(classifyRunEnd({ finalText: 'Two reports summarised.', deadlineHit: true, unfinishedSteps: 0, planTouchedThisRun: true })).toEqual({ kind: 'done' });
  });
});

describe('classifyRunEnd — questions the user must answer stay questions', () => {
  it('a credentials ask ⇒ waiting_user (credentials)', () => {
    const text = 'I found the Xero account but cannot open the invoices. I need the login credentials for the Xero account before I can pull them — can you share them?';
    expect(classifyRunEnd({ finalText: text, deadlineHit: true })).toMatchObject({ kind: 'waiting_user', reason: 'credentials' });
  });

  it('an ambiguous target ⇒ waiting_user (ambiguous_target) — even beside an offer', () => {
    const a = 'Two repos match. Which repo should I open the PR against — crossmodel or spark-cluster?';
    expect(classifyRunEnd({ finalText: a })).toMatchObject({ kind: 'waiting_user', reason: 'ambiguous_target' });
    const b = 'There are three threads from people called Anna. Which thread do you mean? Say the word and I will search it.';
    expect(classifyRunEnd({ finalText: b })).toMatchObject({ kind: 'waiting_user', reason: 'ambiguous_target' });
  });

  it('an either/or the user must pick ⇒ waiting_user (ambiguous_target)', () => {
    expect(classifyRunEnd({ finalText: 'The outline is ready. Do you want the deck in PDF or Keynote format?' }))
      .toMatchObject({ kind: 'waiting_user', reason: 'ambiguous_target' });
  });

  it('a plain clarifying question ⇒ waiting_user (clarifying_question)', () => {
    expect(classifyRunEnd({ finalText: 'Happy to draft that. How many copies should I print?' }))
      .toMatchObject({ kind: 'waiting_user', reason: 'clarifying_question' });
    expect(classifyRunEnd({ finalText: 'Could you paste the error message you are seeing?' }))
      .toMatchObject({ kind: 'waiting_user', reason: 'clarifying_question' });
  });

  it('a finished answer ⇒ done; empty text ⇒ done', () => {
    expect(classifyRunEnd({ finalText: 'The capital of Australia is Canberra.' })).toEqual({ kind: 'done' });
    expect(classifyRunEnd({ finalText: '' })).toEqual({ kind: 'done' });
    expect(classifyRunEnd({ finalText: 'Done — the three reminders are sent (receipts 1a2b3c4d, 5e6f7a8b, 9c0d1e2f).' })).toEqual({ kind: 'done' });
  });
});

describe('rewriteClosingText — deterministic, never a question back', () => {
  it('drops ONLY the hand-back sentence(s) of the last paragraph and appends the one line', () => {
    const out = rewriteClosingText(OWNER_IMESSAGE);
    expect(out.endsWith(CONTINUATION_LINE)).toBe(true);
    expect(out).not.toMatch(/say the word/i);
    expect(out).toContain('Mum (yesterday): asked whether Sunday still works'); // the partial result is kept
    expect(out).not.toMatch(/I did not get to her thread/); // the cue rides that sentence (em dash, one sentence) — it goes with it
    expect(out.split('\n\n').slice(-1)[0]).toBe(CONTINUATION_LINE);
    expect(out).not.toMatch(/\?\s*\n/); // no question left dangling
  });

  it('the deck closing collapses to the partial + the line', () => {
    const out = rewriteClosingText(OWNER_DECK);
    expect(out).not.toMatch(/confirm the card|staged and waiting/i);
    expect(out).toContain('12 slides');
    expect(out.endsWith(CONTINUATION_LINE)).toBe(true);
  });

  it('a last paragraph that still ends in "?" after the cue sentences go is dropped whole', () => {
    const out = rewriteClosingText('Result: 3 items.\n\nShall I continue? Or is that enough for now?');
    expect(out).toBe(`Result: 3 items.\n\n${CONTINUATION_LINE}`);
  });

  it('is idempotent on the rewritten text and takes an alternative line (the cap)', () => {
    const once = rewriteClosingText(OWNER_IMESSAGE);
    expect(rewriteClosingText(once)).toBe(once);
    expect(rewriteClosingText(OWNER_IMESSAGE, CONTINUATION_CAP_LINE).endsWith(CONTINUATION_CAP_LINE)).toBe(true);
    expect(rewriteClosingText('')).toBe(CONTINUATION_LINE);
  });
});

describe('continuationPrompt + round marker', () => {
  it('carries the round marker, the open plan steps, the ask and the tail of the previous answer', () => {
    const p = continuationPrompt({
      round: 2, maxRounds: 3, reason: 'deadline_mid_task', askText: 'find the thread from Anna about the school trip',
      previousAnswer: OWNER_IMESSAGE,
      plan: { goal: 'g', acceptanceCriteria: [], version: 1, updatedAt: new Date().toISOString(), steps: [
        { id: 1, text: 'pull recent threads', status: 'completed' }, { id: 2, text: "search Anna's thread", status: 'pending' },
      ] },
    });
    expect(p.startsWith('[HARNESS CONTINUATION r2/3] — not typed by the user.')).toBe(true);
    expect(p).toContain("- [pending] #2 search Anna's thread");
    expect(p).not.toContain('#1 pull recent threads');
    expect(p).toContain('Original ask: "find the thread from Anna about the school trip"');
    expect(p).toContain('say the word and I will search her thread next');
    expect(p).toMatch(/will NOT answer a question, confirm a card or "say the word"/);
    expect(parseContinuationRound(p)).toEqual({ round: 2, max: 3 });
    expect(parseContinuationRound('plain')).toBeNull();
  });

  it('the marker carries the stash fields and recoverContinuationFromPrompt rebuilds the stash from the row alone (review fix 4)', () => {
    const stash = { taskId: 'task-9', ofMessageId: 'row-9', reason: 'deadline_mid_task' as const, startedAt: '2026-09-28T01:00:00.000Z', askMessageId: 'ask-9' };
    const p = continuationPrompt({ round: 1, maxRounds: 3, reason: 'deadline_mid_task', askText: 'find the thread from Anna', previousAnswer: OWNER_IMESSAGE, stash });
    expect(p.startsWith('[HARNESS CONTINUATION r1/3 task=task-9 of=row-9 reason=deadline_mid_task since=2026-09-28T01:00:00.000Z ask=ask-9] — not typed by the user.')).toBe(true);
    expect(isContinuationPrompt(p)).toBe(true);
    expect(isContinuationPrompt('hello')).toBe(false);
    expect(parseContinuationRound(p)).toEqual({ round: 1, max: 3, taskId: 'task-9', ofMessageId: 'row-9', reason: 'deadline_mid_task', startedAt: '2026-09-28T01:00:00.000Z', askMessageId: 'ask-9' });
    expect(recoverContinuationFromPrompt(p, { startedAt: new Date('2026-09-28T02:00:00Z') })).toEqual({
      taskId: 'task-9', round: 1, maxRounds: 3, reason: 'deadline_mid_task', ofMessageId: 'row-9', askMessageId: 'ask-9',
      startedAt: '2026-09-28T01:00:00.000Z', askText: 'find the thread from Anna',
    });
    // A pre-fix marker (no fields) is not recoverable — the caller settles the card instead of running a wake.
    const old = '[HARNESS CONTINUATION r2/3] — not typed by the user. Resume.\n\nOriginal ask: "x"';
    expect(parseContinuationRound(old)).toEqual({ round: 2, max: 3 });
    expect(recoverContinuationFromPrompt(old, { startedAt: new Date() })).toBeNull();
    expect(recoverContinuationFromPrompt('plain', { startedAt: new Date() })).toBeNull();
    // A junk reason / since falls back (never throws).
    const junk = '[HARNESS CONTINUATION r1/3 task=t of=o reason=bogus since=not-a-date]';
    expect(recoverContinuationFromPrompt(junk, { startedAt: new Date('2026-09-28T03:00:00Z') })).toMatchObject({ taskId: 't', ofMessageId: 'o', reason: 'unfinished_plan', startedAt: '2026-09-28T03:00:00.000Z', askText: '' });
  });
});

const prev = (over: Partial<ContinuationRun> = {}): ContinuationRun => ({
  taskId: 'task-1', round: 1, maxRounds: 3, reason: 'offer_to_continue', ofMessageId: 'row-1', startedAt: '2026-09-28T00:00:00.000Z', askText: 'ask', ...over,
});

describe('nextContinuationRound — the cap holds', () => {
  it('a continue verdict under the cap ⇒ the next round; at the cap ⇒ stop cap', () => {
    expect(nextContinuationRound(prev({ round: 1 }), { kind: 'continue', reason: 'offer_to_continue' })).toEqual({ round: 2 });
    expect(nextContinuationRound(prev({ round: 2 }), { kind: 'continue', reason: 'offer_to_continue' })).toEqual({ round: 3 });
    expect(nextContinuationRound(prev({ round: 3 }), { kind: 'continue', reason: 'offer_to_continue' })).toEqual({ stop: 'cap' });
  });
  it('ANY confirmation hand-back ⇒ waiting_user (a machine run can never confirm a card — review fix 2)', () => {
    expect(nextContinuationRound(prev({ reason: 'confirmation_handback' }), { kind: 'continue', reason: 'confirmation_handback' })).toEqual({ stop: 'waiting_user' });
    expect(nextContinuationRound(prev({ reason: 'offer_to_continue' }), { kind: 'continue', reason: 'confirmation_handback' })).toEqual({ stop: 'waiting_user' });
    expect(nextContinuationRound(prev({ round: 3, reason: 'offer_to_continue' }), { kind: 'continue', reason: 'confirmation_handback' })).toEqual({ stop: 'waiting_user' });
  });
  it('waiting_user / done verdicts stop', () => {
    expect(nextContinuationRound(prev(), { kind: 'waiting_user', reason: 'credentials' })).toEqual({ stop: 'waiting_user' });
    expect(nextContinuationRound(prev(), { kind: 'done' })).toEqual({ stop: 'done' });
  });
});

describe('armTurnContinuation — the queued one-shot', () => {
  const env = process.env;
  afterEach(() => { delete process.env.TURN_CONTINUATION_DISABLED; delete process.env.CONTINUATION_MAX_ROUNDS; process.env = env; });

  it('round 1 mints a task, enqueues a schedule-source row with the stash and the r1/3 prompt', async () => {
    const enqueue = jest.fn(async (_a: any) => ({ id: 'pend-1' }));
    const stash = await armTurnContinuation({ chatId: 'c1', userId: 'u1', mode: 'thinking', reason: 'offer_to_continue', askText: 'the ask', previousAnswer: OWNER_IMESSAGE, ofMessageId: 'row-1' }, { enqueue, now: () => new Date('2026-09-28T01:00:00Z') });
    expect(stash).toMatchObject({ round: 1, maxRounds: 3, reason: 'offer_to_continue', ofMessageId: 'row-1', startedAt: '2026-09-28T01:00:00.000Z', askText: 'the ask' });
    expect(stash!.taskId).toMatch(/^[0-9a-f-]{36}$/);
    const call = enqueue.mock.calls[0][0] as any;
    expect(call).toMatchObject({ chatId: 'c1', userId: 'u1', mode: 'thinking', source: 'schedule', origin: { kind: 'schedule', continuation: stash } });
    expect(call.content.startsWith(`[HARNESS CONTINUATION r1/3 task=${stash!.taskId} of=row-1 reason=offer_to_continue since=2026-09-28T01:00:00.000Z]`)).toBe(true);
    expect(recoverContinuationFromPrompt(call.content, { startedAt: new Date() })).toEqual(stash); // the row alone rebuilds the stash
  });

  it('a later round keeps the taskId / ofMessageId / startedAt / askText and bumps the round; the cap refuses', async () => {
    const enqueue = jest.fn(async (_a: any) => ({ id: 'pend-2' }));
    const r2 = await armTurnContinuation({ chatId: 'c1', userId: 'u1', mode: 'thinking', reason: 'deadline_mid_task', askText: 'ignored', previousAnswer: 'x', ofMessageId: 'ignored', prev: prev({ round: 1 }) }, { enqueue });
    expect(r2).toMatchObject({ taskId: 'task-1', round: 2, maxRounds: 3, ofMessageId: 'row-1', startedAt: '2026-09-28T00:00:00.000Z', askText: 'ask', reason: 'deadline_mid_task' });
    expect((enqueue.mock.calls[0][0] as any).content.startsWith('[HARNESS CONTINUATION r2/3 task=task-1 of=row-1 reason=deadline_mid_task since=2026-09-28T00:00:00.000Z]')).toBe(true);
    const capped = await armTurnContinuation({ chatId: 'c1', userId: 'u1', mode: 'thinking', reason: 'offer_to_continue', askText: 'a', previousAnswer: 'x', ofMessageId: 'r', prev: prev({ round: 3 }) }, { enqueue });
    expect(capped).toBeNull();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('TURN_CONTINUATION_DISABLED=1 and CONTINUATION_MAX_ROUNDS=0 arm nothing; the env clamps', async () => {
    const enqueue = jest.fn(async () => ({ id: 'p' }));
    process.env.TURN_CONTINUATION_DISABLED = '1';
    expect(await armTurnContinuation({ chatId: 'c', userId: 'u', mode: 'thinking', reason: 'offer_to_continue', askText: 'a', previousAnswer: 'x', ofMessageId: 'r' }, { enqueue })).toBeNull();
    delete process.env.TURN_CONTINUATION_DISABLED;
    process.env.CONTINUATION_MAX_ROUNDS = '0';
    expect(continuationMaxRounds()).toBe(0);
    expect(await armTurnContinuation({ chatId: 'c', userId: 'u', mode: 'thinking', reason: 'offer_to_continue', askText: 'a', previousAnswer: 'x', ofMessageId: 'r' }, { enqueue })).toBeNull();
    process.env.CONTINUATION_MAX_ROUNDS = '99';
    expect(continuationMaxRounds()).toBe(10);
    process.env.CONTINUATION_MAX_ROUNDS = 'abc';
    expect(continuationMaxRounds()).toBe(3);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('an enqueue failure propagates (the caller records arm_failed)', async () => {
    const enqueue = jest.fn(async () => { throw new Error('queue full'); });
    await expect(armTurnContinuation({ chatId: 'c', userId: 'u', mode: 'thinking', reason: 'offer_to_continue', askText: 'a', previousAnswer: 'x', ofMessageId: 'r' }, { enqueue })).rejects.toThrow('queue full');
  });
});

describe('plan / receipt helpers', () => {
  const plan = { goal: 'g', acceptanceCriteria: [], version: 1, updatedAt: '2026-09-28T00:10:00.000Z', steps: [
    { id: 1, text: 'a', status: 'completed' as const }, { id: 2, text: 'b', status: 'in_progress' as const }, { id: 3, text: 'c', status: 'blocked' as const },
  ] };
  it('counts', () => {
    expect(planUnfinishedCount(plan)).toBe(1);
    expect(planStepCounts(plan)).toEqual({ done: 1, total: 3 });
    expect(planStepCounts(null)).toEqual({ done: 0, total: 0 });
    expect(receiptCounts([{ ok: true }, { ok: false }, {}])).toEqual({ ok: 1, total: 3 });
    expect(receiptCounts(undefined)).toEqual({ ok: 0, total: 0 });
  });
  it('planTouchedSince keys on updatedAt vs the run start (1 s tolerance)', () => {
    const t = new Date('2026-09-28T00:10:00.000Z').getTime();
    expect(planTouchedSince(plan, t - 60_000)).toBe(true);
    expect(planTouchedSince(plan, t + 60_000)).toBe(false);
    expect(planTouchedSince(null, t)).toBe(false);
  });
  it('closingText is the last three sentences of the last paragraph', () => {
    expect(closingText('One. Two.\n\nThree. Four. Five. Six.')).toBe('Four. Five. Six.');
  });
});

// ── audit 2026-10-08 W4-1c — REPLAY: the owner's 10-08 16:15Z false continuation ────────────────
// Chat 4246401e (owner, plain chat, canary Standard lane on the Level 1 budget): a COMPLETE answer (the
// riser archetype + an honest caveat + advice) overran 240 s, the forced FINAL TURN closed with a proactive offer,
// and `deadline_mid_task` rewrote it to "Still working on this"; the continuation (on the seat, another model)
// answered a different question and contradicted it. The text below is the delivered tail (the dropped offer
// sentence is reconstructed in the shape the classifier matched: `Want me to pull`).
const FRA_TAIL = `**One honest caveat:** I did not verify a post-FRA tournament result list for Orzhov Lifegain this run — this is theorycraft built on magic.gg's card analysis and Draftsim's FRA rankings plus the deck's pre-FRA core, not a finished Top 8 list. FRA just released, so the field hasn't settled.

Worth doing before you buy in: pull the first post-FRA MTGO/RCQ results and check whether Enlightened Confidant shows up in real top-8s. Want me to pull those once they post?`;

describe('audit 2026-10-08 W4-1c — a deadline-hit COMPLETE answer is never rewritten to "still working"', () => {
  afterEach(() => { delete process.env.CONTINUATION_DEADLINE_CORROBORATION_DISABLED; });
  it('the real 16:15Z shape (deadline hit, no plan, no mid-task marker) ⇒ done', () => {
    expect(classifyRunEnd({ finalText: FRA_TAIL, deadlineHit: true, unfinishedSteps: 0 })).toEqual({ kind: 'done' });
  });
  it('the kill switch reproduces the incident verdict (deadline_mid_task on "Want me to pull")', () => {
    process.env.CONTINUATION_DEADLINE_CORROBORATION_DISABLED = '1';
    expect(classifyRunEnd({ finalText: FRA_TAIL, deadlineHit: true })).toMatchObject({ kind: 'continue', reason: 'deadline_mid_task', matched: 'Want me to pull' });
  });
  it('a genuinely cut answer still continues: the deadline + a mid-task marker in the text', () => {
    const cut = `${FRA_TAIL.split('Want me')[0]}I did not get to the RCQ results before tools cut off — want me to pull them next?`;
    expect(classifyRunEnd({ finalText: cut, deadlineHit: true })).toMatchObject({ kind: 'continue', reason: 'deadline_mid_task' });
  });
});

// build 2026-10-08 A1 (owner-answer-first.ts): the supervisor answer-first follow-through rides the SAME machinery —
// a new reason, the stash's `answerFirst`, the marker's ` af=<resumes>` field and the brief appended to the prompt.
describe('build 2026-10-08 A1 — the answer-first follow-through stash', () => {
  it('round 1 carries answerFirst + askMessageId + the brief; the marker alone rebuilds the stash as answer-first', async () => {
    const enqueue = jest.fn(async (_a: any) => ({ id: 'pend-af' }));
    const stash = await armTurnContinuation({
      chatId: 'c-sup', userId: 'u1', mode: 'thinking', reason: 'answer_first_split', askText: 'message the tt-rd supervisor',
      previousAnswer: 'Not sent yet.\n\nFollow-through: message the tt-rd supervisor', ofMessageId: 'row-af', askMessageId: 'ask-af',
      answerFirst: { resumes: 0, done: ['todo_create→"cams"'], items: 'message the tt-rd supervisor' }, extraNote: 'ANSWER-FIRST FOLLOW-THROUGH: brief',
    }, { enqueue, now: () => new Date('2026-10-08T18:00:00Z') });
    expect(stash).toMatchObject({ reason: 'answer_first_split', askMessageId: 'ask-af', answerFirst: { resumes: 0, done: ['todo_create→"cams"'], items: 'message the tt-rd supervisor' } });
    const content = (enqueue.mock.calls[0][0] as any).content as string;
    expect(content).toContain(' ask=ask-af af=0]');
    expect(content).toContain('the harness answered the owner first at the answer deadline');
    expect(content.trim().endsWith('ANSWER-FIRST FOLLOW-THROUGH: brief')).toBe(true);
    const recovered = recoverContinuationFromPrompt(content, { startedAt: new Date() })!;
    expect(recovered).toMatchObject({ taskId: stash!.taskId, reason: 'answer_first_split', askMessageId: 'ask-af', answerFirst: { resumes: 0 } });
    expect(parseContinuationRound(content.replace(' af=0]', ' af=2]'))!.answerFirstResumes).toBe(2);
  });
  it("a later round keeps prev's answerFirst unless the caller passes the merged one; a plain stash has no af field", async () => {
    const enqueue = jest.fn(async (_a: any) => ({ id: 'p' }));
    const prev = { taskId: 't', round: 1, maxRounds: 3, reason: 'answer_first_split' as const, ofMessageId: 'o', startedAt: '2026-10-08T18:00:00.000Z', askText: 'a', answerFirst: { resumes: 1, done: ['x→1'] } };
    expect((await armTurnContinuation({ chatId: 'c', userId: 'u', mode: 'thinking', reason: 'unfinished_plan', askText: 'a', previousAnswer: '', ofMessageId: 'o', prev }, { enqueue }))!.answerFirst).toEqual({ resumes: 1, done: ['x→1'] });
    expect((await armTurnContinuation({ chatId: 'c', userId: 'u', mode: 'thinking', reason: 'unfinished_plan', askText: 'a', previousAnswer: '', ofMessageId: 'o', prev, answerFirst: { resumes: 1, done: ['x→1', 'y→2'] } }, { enqueue }))!.answerFirst).toEqual({ resumes: 1, done: ['x→1', 'y→2'] });
    const plain = await armTurnContinuation({ chatId: 'c', userId: 'u', mode: 'thinking', reason: 'offer_to_continue', askText: 'a', previousAnswer: '', ofMessageId: 'o' }, { enqueue });
    expect(plain).not.toHaveProperty('answerFirst');
    expect((enqueue.mock.calls[2][0] as any).content).not.toContain(' af=');
    expect(recoverContinuationFromPrompt((enqueue.mock.calls[2][0] as any).content, { startedAt: new Date() })).not.toHaveProperty('answerFirst');
  });
});
