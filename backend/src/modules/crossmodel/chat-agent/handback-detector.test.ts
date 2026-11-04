/**
 * Hand-back detector (chat-agent/handback-detector.ts) — the two owner
 * transcripts of the cohesive-chat program as POSITIVES, genuine clarifying
 * questions, the doctrine's own proactive offer and the doctrine's THIRD
 * lifecycle state (an external-effect tool staged on a card, "not done —
 * confirm it from the card") as NEGATIVES.
 *
 * Pure leaf, no mocks. The finalize wiring (chat-agent.service.ts) is pinned
 * by the read-only source assertions at the bottom, the same way
 * cross-check-scope.test.ts pins its lane wiring.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  findHandback, closingSegments, stripAnswerChrome, stagedCards, hasStagedCard,
  HANDBACK_STRONG_RES, HANDBACK_STRONG_GENERAL_RES, HANDBACK_CONFIRM_CARD_RES, HANDBACK_SOFT_RES,
  HANDBACK_EXTERNAL_EFFECT_TOOLS, HANDBACK_OFFER_CUE_RE,
} from './handback-detector';

/** The harness staging envelope exactly as platform-tools.ts mints it (JSON, indent 1). */
const stagedEnvelope = (summary: string) =>
  JSON.stringify({
    ok: false, needsConfirmation: true, confirmationId: 'cf_11aa22bb', summary, expiresInMinutes: 30,
    instructions: 'This action changes the user\'s account and needs THEIR explicit confirmation. Show the summary to the user in your reply and ask them to confirm — they can also confirm or cancel it from the pending-action card in the app sidebar or on the Management page.',
  }, null, 1);

const stagedDeckParts = [
  { type: 'text', text: 'Let me set that up.' },
  { type: 'tool_call', name: 'start_coding_session', args: { title: 'Build the investor deck' } },
  { type: 'tool_result', name: 'start_coding_session', result: stagedEnvelope('Start a coding session: Build the investor deck') },
];

const stagedShareLinkParts = [
  { type: 'tool_call', name: 'create_share_link', args: { chatId: 'c1' } },
  { type: 'tool_result', name: 'create_share_link', result: stagedEnvelope('Create a public share link for this chat') },
];

const stagedAutonomyParts = [
  { type: 'tool_call', name: 'set_chat_autonomy', args: { chatId: 'c2', tools: ['git_push'] } },
  { type: 'tool_result', name: 'set_chat_autonomy', result: stagedEnvelope('Grant chat c2 autonomy over git_push') },
];

/** A READ tool's result that ECHOES staged rows (run-receipts.ts mints ok:false {staged:true} receipts). */
const receiptsEchoParts = [
  { type: 'tool_call', name: 'get_run_receipts', args: { chatId: 'c3' } },
  {
    type: 'tool_result', name: 'get_run_receipts',
    result: JSON.stringify({ ok: true, receipts: [{ id: 'r1', tool: 'schedule_message', ok: false, ids: { staged: true, confirmationId: 'cf_9' } }], chatTurns: [] }),
  },
];

const OWNER_TRANSCRIPT_1 =
  'I have everything I need for the deck: the three positioning points from our earlier chat, the Q3 numbers, and the logo file you uploaded.\n\n' +
  'Deck build is staged and waiting on your one click — confirm the card and I will start the workspace.';

const OWNER_TRANSCRIPT_2 =
  '## What I found\n\n' +
  '- Three of the four threads are summarised above with the message ids.\n' +
  '- I pulled the threads before tools cut off this run, so the fourth one is still unread.\n\n' +
  'Say the word and I will search her thread next.\n\n' +
  '[FOLLOWUPS]\n- What did the finance thread decide?\n- Summarise the fourth thread\n[/FOLLOWUPS]';

describe('findHandback — POSITIVES (the owner transcripts)', () => {
  it('(1) a start_coding_session confirmation card handed back on a human turn — "staged and waiting on your one click — confirm the card"', () => {
    const f = findHandback({ finalText: OWNER_TRANSCRIPT_1, parts: stagedDeckParts, stepsUsed: 2, maxSteps: 8 });
    expect(f).not.toBeNull();
    expect(f!.strength).toBe('strong');
    expect(f!.phrase.toLowerCase()).toBe('staged and waiting');
    expect(f!.stoppedShort.stagedCard).toBe(true);
    expect(f!.stoppedShort.deadlineHit).toBe(false);
    expect(f!.stoppedShort.stepsExhausted).toBe(false);
    expect(f!.externalCard).toBe(false);
    expect(f!.excerpt).toContain('confirm the card');
  });

  it('(1b) the same card sentence with the idiom order flipped ("confirm the card")', () => {
    const f = findHandback({ finalText: 'The workspace is ready to start. Confirm the card in the sidebar and I will kick it off.', parts: stagedDeckParts });
    expect(f?.strength).toBe('strong');
    expect(f?.phrase.toLowerCase()).toBe('confirm the card');
  });

  it('(2) the per-turn deadline ended the run mid-task and the rest was handed back — "say the word and I will search her thread next"', () => {
    const f = findHandback({ finalText: OWNER_TRANSCRIPT_2, parts: [{ type: 'tool_call', name: 'web_pipe' }, { type: 'tool_result', name: 'web_pipe', result: 'ok' }], deadlineHit: true, stepsUsed: 3, maxSteps: 8 });
    expect(f).not.toBeNull();
    expect(f!.strength).toBe('strong');
    expect(f!.phrase.toLowerCase()).toBe('say the word');
    expect(f!.stoppedShort.deadlineHit).toBe(true);
    expect(f!.continuationCue).toBe(true);
    // the follow-ups block never leaks into the closing window
    expect(f!.excerpt).not.toContain('FOLLOWUPS');
  });

  it('(2b) the same hand-back fires WITHOUT the deadline flag — a strong idiom needs no run-state evidence', () => {
    const f = findHandback({ finalText: OWNER_TRANSCRIPT_2 });
    expect(f?.strength).toBe('strong');
    expect(f?.stoppedShort).toEqual({ deadlineHit: false, stepsExhausted: false, stagedCard: false });
    expect(f?.externalCard).toBe(false);
  });

  // Ticket 18bce3f9 (2026-10-07): strong idioms fire only beside INCOMPLETENESS
  // EVIDENCE — the same gate the soft idioms always had. 13 of 14 live rows over
  // 48 h were the doctrine's own offer after a complete answer ("Just say the
  // word." closing three delivered captions; "Want me to dig deeper into any of
  // this?"; "say the word if you'd like normal-length replies back") with
  // deadlineHit=stepsExhausted=stagedCard=false and no cue — the nightly audit
  // was re-filing its own precision contract as a hand-back regression. Each
  // entry here carries its own evidence (a continuation cue: "the rest", "the
  // other two", "her thread", "the remaining", "keep going"), so each KEEPS
  // firing — the ones that lose their evidence no longer do (see NEGATIVES).
  it.each([
    'Let me know if you want me to continue with the remaining files.',
    'Shall I go ahead and finish the other two threads?',
    'Want me to keep going?',
    'Give me the go-ahead and I will run the migration.',
    'When you are ready, I will build the rest of the deck.',
    'If you want me to proceed, I will start the workspace now.',
    'Once you confirm, I will search her thread.',
  ])('strong idiom + the deadline collapsed the run WITH its continuation cue: %s', (closing) => {
    const f = findHandback({ finalText: `Here is the summary of the first thread.\n\n${closing}`, deadlineHit: true, stepsUsed: 3, maxSteps: 8 });
    expect(f?.strength).toBe('strong');
    expect(f?.continuationCue).toBe(true);
    expect(f?.stoppedShort.deadlineHit).toBe(true);
  });

  it.each([
    'Let me know if you want me to continue with the remaining files.',
    'Shall I go ahead and finish the other two threads?',
    'Want me to keep going?',
    'Give me the go-ahead and I will run the migration.',
  ])('strong idiom + the answer itself says the work was cut short: %s', (closing) => {
    const f = findHandback({ finalText: `I pulled the threads before tools cut off this run, so the fourth one is still unread.\n\n${closing}` });
    expect(f?.strength).toBe('strong');
  });

  it.each([
    // the live false-positives (48 h window, ticket 18bce3f9): a complete
    // answer + the doctrine's own proactive offer, NO cue and NO run-state
    // evidence — these MUST NOT fire.
    'Just say the word.',
    'Want me to dig deeper into any of this?',
    "If you'd like the lid lifted on the one-sentence rule for a topic like this, just say so — but meanwhile, here are natural next questions:",
    "Say the word and I'll put Anguilla, TCI, St Barths, DR and LIR into one January comparison table — rain, humidity, temperature, flight access — so you can decide it on one page.",
    "Say the word and I'll run a deeper look.",
    "Want a different tone (moody, romantic, funny, travel-blog)? Just say the word and I'll rewrite them.",
    'Want me to draft the rest of the letter, or tailor this one to a specific company?',
  ])('18bce3f9 — the doctrine\'s own offer after a COMPLETE answer never fires (no cue, no run-state evidence): %s', (closing) => {
    const f = findHandback({ finalText: `Here is what you asked for — three options above.\n\n${closing}`, stepsUsed: 2, maxSteps: 8 });
    expect(f).toBeNull();
  });

  it('18bce3f9 — a strong idiom WITH run-state evidence fires without a cue (a work tool sat staged behind a card)', () => {
    const f = findHandback({ finalText: 'The workspace is ready. Say the word.', parts: stagedDeckParts, stepsUsed: 2, maxSteps: 8 });
    expect(f?.strength).toBe('strong');
    expect(f?.stoppedShort.stagedCard).toBe(true);
  });

  it('18bce3f9 — a strong idiom WITH step exhaustion fires without a cue', () => {
    const f = findHandback({ finalText: 'Here is what I could gather. Give me the go-ahead.', stepsUsed: 8, maxSteps: 8 });
    expect(f?.strength).toBe('strong');
    expect(f?.stoppedShort.stepsExhausted).toBe(true);
  });

  it('soft idiom + a continuation cue + the answer says the work is unfinished ("the other two are still unread") fires', () => {
    const f = findHandback({ finalText: 'Two threads are summarised above; I could not get to the other two before the run ended. Happy to dig into the other two threads if you\'d like.' });
    expect(f?.strength).toBe('soft');
    expect(f?.continuationCue).toBe(true);
  });

  it('18bce3f9 — a soft idiom with a bare cue and NO incompleteness evidence stays the doctrine\'s offer', () => {
    // the live false-positive shape: 'Want me to draft the rest of the letter, or tailor this one?'
    // — 'the rest' of a letter the user never asked to be written is a FRESH next step, not the
    // unfinished half of the asked work (the asked opening paragraph IS delivered above it).
    expect(findHandback({ finalText: 'Here is the opening paragraph you asked for. Want me to draft the rest of the letter, or tailor this one to a specific company?', stepsUsed: 2, maxSteps: 8 })).toBeNull();
  });

  it('soft idiom + the run stopped short (the REAL step count reached maxSteps) fires', () => {
    // An L2 run: maxSteps 8, the loop used all 8 rounds. Parts are per-call
    // ([call, result, …]) and are NOT the signal — stepsUsed is.
    const parts = Array.from({ length: 20 }, () => [{ type: 'tool_call', name: 'search_engine' }, { type: 'tool_result', name: 'search_engine', result: 'r' }]).flat();
    const f = findHandback({ finalText: 'That is what I could gather so far. Would you like me to look at the pricing page as well?', parts, stepsUsed: 8, maxSteps: 8 });
    expect(f?.strength).toBe('soft');
    expect(f?.stoppedShort.stepsExhausted).toBe(true);
  });

  it('soft idiom + a deadline collapse WITH a continuation cue fires', () => {
    const f = findHandback({ finalText: 'Two of the four threads are summarised above. Want me to pull the other two?', deadlineHit: true, stepsUsed: 3, maxSteps: 8 });
    expect(f?.strength).toBe('soft');
    expect(f?.continuationCue).toBe(true);
    expect(f?.stoppedShort.deadlineHit).toBe(true);
  });

  it('a two-option question ABOUT continuing keeps its hand-back when the run stopped short ("search her thread next, or leave it?")', () => {
    const f = findHandback({ finalText: 'Three threads are done. Shall I search her thread next, or leave it there?', deadlineHit: true, stepsUsed: 6, maxSteps: 6 });
    expect(f?.strength).toBe('soft');
    expect(f?.continuationCue).toBe(true);
    expect(f?.stoppedShort.stepsExhausted).toBe(true);
  });

  it('a run that staged BOTH a work-tool card and an external-effect card keeps the confirm family (the work card is the hand-back)', () => {
    const f = findHandback({ finalText: 'The deck workspace is staged. Confirm the card and I will start it.', parts: [...stagedShareLinkParts, ...stagedDeckParts] });
    expect(f?.strength).toBe('strong');
    expect(f?.phrase.toLowerCase()).toBe('confirm the card');
    expect(f?.stoppedShort.stagedCard).toBe(true);
    expect(f?.externalCard).toBe(true);
  });

  it('a GENERAL strong idiom still fires beside evidence on a run whose only card is an external-effect tool\'s ("say the word" defers the asked work)', () => {
    // deadline + cue: the external-effect card is correctly NOT evidence, but the deadline
    // collapse with a continuation cue is — the general family is scanned there.
    const f = findHandback({ finalText: 'The share link is staged on the card. Say the word and I will search her thread next.', parts: stagedShareLinkParts, deadlineHit: true, stepsUsed: 3, maxSteps: 8 });
    expect(f?.strength).toBe('strong');
    expect(f?.phrase.toLowerCase()).toBe('say the word');
    expect(f?.externalCard).toBe(true);
    expect(f?.stoppedShort.stagedCard).toBe(false);
    expect(f?.stoppedShort.deadlineHit).toBe(true);
  });
});

describe('findHandback — NEGATIVES (real clarifying questions, offers, the third lifecycle state, chrome)', () => {
  it.each([
    'Which Sarah do you mean — Sarah Chen from the design team or Sarah Okafor from finance? I found messages from both.',
    'I need your Slack workspace URL and a user token to read that channel — paste them here and I will pull the thread.',
    'Do you want me to use the personal account or the business account for this?',
    'This needs your 2FA code to sign in — I cannot proceed without it.',
    'The target is ambiguous: two repos are named "deck" — the marketing one or the investor one?',
    'That is your call: the deck can lead with revenue or with the product story. Which do you prefer?',
  ])('a genuine clarifying question never fires, even on a run that stopped short: %s', (closing) => {
    const f = findHandback({ finalText: `Here is what I have so far.\n\n${closing}`, parts: stagedDeckParts, deadlineHit: true, stepsUsed: 8, maxSteps: 8 });
    expect(f).toBeNull();
  });

  const OFFER = 'Bitcoin closed at $91,240 today, up 2.1% on the day, per CoinDesk.\n\nWant me to check this again tomorrow morning and message you on Telegram?';

  it('the doctrine\'s proactive OFFER after a complete answer does not fire (no work evidently left)', () => {
    const f = findHandback({ finalText: OFFER, parts: [{ type: 'tool_call', name: 'search_engine' }, { type: 'tool_result', name: 'search_engine', result: 'r' }], stepsUsed: 2, maxSteps: 8 });
    expect(f).toBeNull();
  });

  it('the same OFFER on a DEADLINE-collapsed run does not fire either — a collapsed run can still end in a complete answer plus an offer', () => {
    expect(findHandback({ finalText: OFFER, deadlineHit: true, stepsUsed: 3, maxSteps: 8 })).toBeNull();
    // and a deadline collapse alone is never evidence for a soft idiom without a continuation cue
    expect(findHandback({ finalText: 'The pricing page lists three tiers, summarised above. Would you like me to compare them against the competitor?', deadlineHit: true, stepsUsed: 3, maxSteps: 8 })).toBeNull();
  });

  it.each([
    'Want me to set up a daily digest of this board?',
    'Shall I keep an eye on this and ping you when it changes?',
    'Would you like me to check again next week?',
    'Let me know if you want a reminder every morning.',
  ])('an offer of a FUTURE / RECURRING step never fires, even when the run stopped short: %s', (closing) => {
    expect(findHandback({ finalText: `The board is summarised above.\n\n${closing}`, parts: stagedDeckParts, deadlineHit: true, stepsUsed: 8, maxSteps: 8 })).toBeNull();
    expect(HANDBACK_OFFER_CUE_RE.test(closing)).toBe(true);
  });

  it('the THIRD lifecycle state — an external-effect tool staged on a card, said the way the envelope instructs — is not a hand-back', () => {
    expect(findHandback({
      finalText: 'The share link for this chat is staged — it is NOT live yet. Confirm it from the card in the sidebar and I will mint the link.',
      parts: stagedShareLinkParts, stepsUsed: 2, maxSteps: 8,
    })).toBeNull();
    expect(findHandback({
      finalText: 'The autonomy grant for chat c2 is staged on a pending-action card and is not in effect. Once you confirm, the grant takes effect.',
      parts: stagedAutonomyParts,
    })).toBeNull();
    expect(findHandback({
      finalText: 'Your message to the finance chat is staged and waiting on your confirmation — nothing has been sent.',
      parts: [{ type: 'tool_result', name: 'send_chat_message', result: stagedEnvelope('Send a message to chat finance') }],
    })).toBeNull();
  });

  it('a READ tool result that echoes staged rows (get_run_receipts) is not a staged card, so a closing offer stays an offer', () => {
    expect(findHandback({ finalText: 'The board has two open lanes, summarised above. Want me to set up a daily digest of this board?', parts: receiptsEchoParts, stepsUsed: 2, maxSteps: 8 })).toBeNull();
    expect(findHandback({ finalText: 'The board has two open lanes, summarised above. Would you like me to look at the pricing page as well?', parts: receiptsEchoParts, stepsUsed: 2, maxSteps: 8 })).toBeNull();
    expect(hasStagedCard(receiptsEchoParts)).toBe(false);
  });

  it('a completed task with a plain closing line does not fire', () => {
    expect(findHandback({ finalText: 'Done — the deck is attached below as deck.pdf (14 slides). The Q3 numbers are on slide 6.', parts: stagedDeckParts, deadlineHit: true })).toBeNull();
  });

  it('an idiom quoted MID-answer (not in the closing window) does not fire', () => {
    const text =
      'The old assistant ended every answer with "shall I continue?" and nothing moved until you replied.\n\n' +
      'This run did the work instead. The three threads are summarised below.\n\n' +
      '1. Design thread — agreed on the new palette (msg 08ae015c).\n' +
      '2. Finance thread — Q3 close moved to the 14th (msg 1c2eb455).\n' +
      '3. Ops thread — the vendor contract renews in March (msg 5a784ec2).';
    expect(findHandback({ finalText: text })).toBeNull();
  });

  it('an action chip inside the [FOLLOWUPS] block and harness chrome lines are never scanned', () => {
    const text = 'The report is attached above.\n\n[harness — deferred-action note] say the word was observed.\n[FOLLOWUPS]\n- Want me to keep going with the rest?\n[/FOLLOWUPS]';
    expect(findHandback({ finalText: text })).toBeNull();
    expect(stripAnswerChrome(text)).not.toContain('FOLLOWUPS');
    expect(stripAnswerChrome(text)).not.toContain('harness');
  });

  it('a soft idiom with the step count BELOW maxSteps and no cue does not fire', () => {
    const parts = Array.from({ length: 12 }, () => [{ type: 'tool_call', name: 'search_engine' }, { type: 'tool_result', name: 'search_engine', result: 'r' }]).flat();
    // 12 per-call pairs in 3 batched rounds — the old burst estimate read this as 12 rounds
    expect(findHandback({ finalText: 'That is what I could gather. Would you like me to look at the pricing page as well?', parts, stepsUsed: 3, maxSteps: 8 })).toBeNull();
  });

  it('empty / bad input is null, never a throw', () => {
    expect(findHandback(null)).toBeNull();
    expect(findHandback(undefined)).toBeNull();
    expect(findHandback({})).toBeNull();
    expect(findHandback({ finalText: '' })).toBeNull();
    // 'Say the word.' alone is the doctrine's offer (18bce3f9): no evidence, no fire —
    // the total-ness contract is that bad input never THROWS, not that it always fires.
    expect(findHandback({ finalText: 'Say the word.', parts: 'not-an-array' as any, maxSteps: NaN, stepsUsed: NaN })).toBeNull();
    expect(findHandback({ finalText: 'Say the word.', parts: stagedDeckParts, maxSteps: NaN, stepsUsed: NaN })).not.toBeNull();
  });
});

describe('helpers', () => {
  it('closingSegments returns the LAST segments after chrome is stripped', () => {
    const segs = closingSegments('First sentence here. Second sentence here. Third sentence here. Fourth sentence here.', 2);
    expect(segs).toEqual(['Third sentence here.', 'Fourth sentence here.']);
  });

  it('stagedCards reads a staged / needsConfirmation TOP-LEVEL envelope by tool NAME, from a string or object result', () => {
    expect(stagedCards(stagedDeckParts)).toEqual([{ tool: 'start_coding_session', external: false }]);
    expect(stagedCards(stagedShareLinkParts)).toEqual([{ tool: 'create_share_link', external: true }]);
    expect(stagedCards([{ type: 'tool_result', name: 'schedule_message', result: { ok: false, staged: true, confirmationId: 'cf_1' } }])).toEqual([{ tool: 'schedule_message', external: false }]);
    expect(hasStagedCard(stagedDeckParts)).toBe(true);
    expect(hasStagedCard(stagedShareLinkParts)).toBe(false);
  });

  it.each([
    ['an ok:true result', { type: 'tool_result', name: 'start_coding_session', result: '{"ok":true,"ids":{"chatId":"x"}}' }],
    ['a nameless part', { type: 'tool_result', result: stagedEnvelope('x') }],
    ['a read tool echoing staged rows', receiptsEchoParts[1]],
    ['get_chat_messages echoing a card', { type: 'tool_result', name: 'get_chat_messages', result: JSON.stringify({ ok: true, messages: [{ text: 'staged and waiting — needsConfirmation' }] }) }],
    ['a nested (not top-level) staged flag', { type: 'tool_result', name: 'schedule_message', result: JSON.stringify({ ok: true, receipt: { ok: false, ids: { staged: true } } }) }],
    ['an unparseable string', { type: 'tool_result', name: 'schedule_message', result: 'needsConfirmation: true — staged and waiting' }],
    ['a non-result part', { type: 'text', name: 'schedule_message', text: stagedEnvelope('x') }],
  ])('stagedCards ignores %s', (_label, part) => {
    expect(stagedCards([part])).toEqual([]);
    expect(stagedCards(undefined)).toEqual([]);
  });

  it('the external-effect set mirrors work-tools.ts EXTERNAL_EFFECT_TOOLS ∪ NEVER_AUTONOMOUS_TOOLS and holds no work tool', () => {
    for (const t of ['send_chat_message', 'set_chat_autonomy', 'create_share_link', 'share_canvas', 'share_project', 'add_project_member', 'remove_project_member', 'create_chat_webhook', 'stop_run', 'answer_chat_question', 'approve_request', 'send_to_instance', 'dispatch_platform_task', 'set_chat_instructions']) {
      expect(HANDBACK_EXTERNAL_EFFECT_TOOLS.has(t)).toBe(true);
    }
    for (const t of ['start_coding_session', 'schedule_message', 'create_feed', 'configure_workspace', 'import_repo', 'pause_schedule', 'resume_schedule']) {
      expect(HANDBACK_EXTERNAL_EFFECT_TOOLS.has(t)).toBe(false);
    }
  });

  it('every idiom regex is case-insensitive; the strong list is the general + confirm families; the two lists do not overlap on the strong phrases', () => {
    for (const re of [...HANDBACK_STRONG_RES, ...HANDBACK_SOFT_RES]) expect(re.flags).toContain('i');
    expect(HANDBACK_STRONG_RES).toEqual([...HANDBACK_STRONG_GENERAL_RES, ...HANDBACK_CONFIRM_CARD_RES]);
    expect(HANDBACK_STRONG_GENERAL_RES.some((re) => re.test('SAY THE WORD'))).toBe(true);
    expect(HANDBACK_CONFIRM_CARD_RES.some((re) => re.test('confirm the card'))).toBe(true);
    expect(HANDBACK_STRONG_GENERAL_RES.some((re) => re.test('confirm the card'))).toBe(false);
  });

});

describe('finalize wiring (chat-agent.service.ts) — read-only source pins', () => {
  const src = fs.readFileSync(path.join(__dirname, 'chat-agent.service.ts'), 'utf8');

  it('imports the leaf and records handback_detected on HUMAN turns only, from the REAL step count', () => {
    expect(src).toContain("from './handback-detector'");
    expect(src).toContain('LOOP_METRIC_KINDS.HANDBACK_DETECTED');
    const at = src.indexOf('LOOP_METRIC_KINDS.HANDBACK_DETECTED');
    const window = src.slice(Math.max(0, at - 2500), at + 900);
    expect(window).toContain('findHandback(');
    expect(window).toContain('stepsUsed:');
    expect(window).toMatch(/machineWake|messageOrigin/);
    expect(window).toContain('phrase:');
    expect(window).toContain('externalCard:');
  });

  it('the agent loop returns its real step count (AgentRunResult.stepsUsed)', () => {
    const agent = fs.readFileSync(path.join(__dirname, '..', 'coding', 'agent.ts'), 'utf8');
    expect(agent).toContain('stepsUsed?: number;');
    expect(agent).toContain('stepsUsed: step,');
  });
});
