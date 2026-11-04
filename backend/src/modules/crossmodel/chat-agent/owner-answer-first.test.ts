/**
 * build 2026-10-08 A1 — answer-first on OWNER turns in supervisor chats (owner-answer-first.ts): the switch, the
 * observer (shadow / act), the "Follow-through:" contract, the verdict, the duplicate-dispatch accounting — with
 * replays of REAL owner turns from the audit (architecture.md item D; q4 owner-turn tool sequences, 2026-09-28).
 */
// unbacked-claim.ts (the W1 detector replayed below) imports config/database → config/env (process.exit when keyless).
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
import {
  ownerAnswerFirstConfig, resolveOwnerAnswerFirst, createAnswerFirstObserver, answerFirstSplitNotice, answerFirstDoctrineLine,
  parseFollowThrough, followThroughContinuationLine, ownerAnswerFirstVerdict, mutatingCallSignatures, duplicateSignatures,
  answerFirstContinuationNote, ANSWER_FIRST_NOT_A_WAKE_LINE, ownerAnswerFirstMetricMeta, isMutatingToolName, ANSWER_FIRST_DEADLINE_MS,
  OWNER_ANSWER_FIRST_DEFAULT_CANARY, isAnswerFirstFollowThrough, followThroughQuietZeroDisabled,
} from './owner-answer-first';
import { CONTINUATION_LINE, rewriteClosingText, classifyRunEnd, continuationPrompt, recoverContinuationFromPrompt, type ContinuationRun, type RunEndVerdict } from './turn-continuation';
import { unbackedActionClaims } from './unbacked-claim';

const env = (v?: string) => (v == null ? {} : { SUPERVISOR_OWNER_ANSWER_FIRST: v });
const SCHOOLTIME = '41bd202a-0000-4000-8000-000000000001';
const STANNE = '99e63f86-ecd3-4d6d-b5fb-a3e199a1ebfa';
const CANLAW = '7dc031fb-0000-4000-8000-000000000003';

describe('the switch — SUPERVISOR_OWNER_ANSWER_FIRST', () => {
  it("unset / blank ⇒ canary on the default list (ticket 4f7263e4: the shadow stage ran, 18 would-splits, the owner still waited p90 239 s); compose delivers the value as '' and that reads the default too", () => {
    expect(ownerAnswerFirstConfig(env())).toEqual({ setting: 'canary', canaryChats: [...OWNER_ANSWER_FIRST_DEFAULT_CANARY] });
    expect(ownerAnswerFirstConfig({ SUPERVISOR_OWNER_ANSWER_FIRST: '' })).toEqual({ setting: 'canary', canaryChats: [...OWNER_ANSWER_FIRST_DEFAULT_CANARY] });
    expect(ownerAnswerFirstConfig({ SUPERVISOR_OWNER_ANSWER_FIRST: '   ' })).toEqual({ setting: 'canary', canaryChats: [...OWNER_ANSWER_FIRST_DEFAULT_CANARY] });
    // the default canary list contains the observed tail chats — StAnne 99e63f86 acts, an unlisted chat records only
    expect(resolveOwnerAnswerFirst(STANNE, env())).toEqual({ mode: 'act', canary: true, setting: 'canary' });
    expect(resolveOwnerAnswerFirst(CANLAW, env())).toEqual({ mode: 'shadow', canary: false, setting: 'canary' });
  });
  it('any OTHER unrecognized value fails SAFE to shadow (review F1: a typo\'d rollback — "shaddow", trailing garbage, a case variant — must never silently keep answer-first ACT while the operator believes it is off)', () => {
    for (const v of ['banana', 'shaddow', 'shadow ', ' shadow', 'SHADOW', '0x1', 'on-off']) {
      expect(ownerAnswerFirstConfig(env(v))).toEqual({ setting: 'shadow', canaryChats: [] });
    }
    // the exact fat-fingered rollback the review named, end-to-end through the resolver: records only, no act
    expect(resolveOwnerAnswerFirst(STANNE, env('shaddow'))).toEqual({ mode: 'shadow', canary: false, setting: 'shadow' });
    // and the real rollback value still restores the previous behavior everywhere
    expect(resolveOwnerAnswerFirst(STANNE, env('shadow'))).toEqual({ mode: 'shadow', canary: false, setting: 'shadow' });
  });
  it("off / 0 ⇒ off; act / 1 ⇒ act on every supervisor chat", () => {
    expect(resolveOwnerAnswerFirst(STANNE, env('off')).mode).toBe('off');
    expect(resolveOwnerAnswerFirst(STANNE, env('0')).mode).toBe('off');
    expect(resolveOwnerAnswerFirst(CANLAW, env('act'))).toEqual({ mode: 'act', canary: false, setting: 'act' });
    expect(resolveOwnerAnswerFirst(CANLAW, env('1')).mode).toBe('act');
  });
  it("bare 'canary' acts on the report's two busiest project supervisors only", () => {
    expect(OWNER_ANSWER_FIRST_DEFAULT_CANARY).toEqual(['41bd202a', '99e63f86']);
    expect(resolveOwnerAnswerFirst(SCHOOLTIME, env('canary'))).toEqual({ mode: 'act', canary: true, setting: 'canary' });
    expect(resolveOwnerAnswerFirst(STANNE, env('canary')).mode).toBe('act');
    expect(resolveOwnerAnswerFirst(CANLAW, env('canary'))).toEqual({ mode: 'shadow', canary: false, setting: 'canary' });
  });
  it("'canary:<id8,…>' overrides the list; short / non-hex prefixes are ignored (never a broad match)", () => {
    expect(ownerAnswerFirstConfig(env('canary:7dc031fb, ab, zzzzzzzz'))).toEqual({ setting: 'canary', canaryChats: ['7dc031fb'] });
    expect(resolveOwnerAnswerFirst(CANLAW, env('canary:7dc031fb')).mode).toBe('act');
    expect(resolveOwnerAnswerFirst(STANNE, env('canary:7dc031fb')).mode).toBe('shadow');
    expect(resolveOwnerAnswerFirst(STANNE, env('CANARY:99E63F86')).mode).toBe('act');
  });
  it('an act verdict is held at shadow when the follow-through cannot run (turn continuation off)', () => {
    expect(resolveOwnerAnswerFirst(STANNE, env('act'), { continuationAvailable: false })).toEqual({ mode: 'shadow', canary: false, setting: 'act', degraded: 'continuation_off' });
    expect(resolveOwnerAnswerFirst(STANNE, env('canary'), { continuationAvailable: false })).toMatchObject({ mode: 'shadow', canary: true, degraded: 'continuation_off' });
    expect(resolveOwnerAnswerFirst(CANLAW, env('canary'), { continuationAvailable: false })).toEqual({ mode: 'shadow', canary: false, setting: 'canary' });
    expect(resolveOwnerAnswerFirst(STANNE, env('act'), { continuationAvailable: true }).mode).toBe('act');
  });
});

/** Drive the observer like the agent loop does: a poll at the top of every step, tool calls emitted inside it. */
function replay(observer: ReturnType<typeof createAnswerFirstObserver>, clock: { t: number }, steps: Array<{ ms: number; tools: string[] }>) {
  const hook = observer.hook();
  const notices: Array<string | null> = [];
  for (const s of steps) {
    const n = hook();
    notices.push(n);
    if (n) return { notices, collapsedAt: notices.length - 1 };
    for (const name of s.tools) observer.observe('tool_call', { name, args: {} });
    clock.t += s.ms;
  }
  return { notices, collapsedAt: -1 };
}

/** A real owner turn from the audit (q4: ttft + the tool sequence): one tool per step, the wait spread evenly. */
function auditShape(ttftMs: number, names: string[]): Array<{ ms: number; tools: string[] }> {
  const per = ttftMs / (names.length + 1);
  return [...names.map((n) => ({ ms: per, tools: [n] })), { ms: per, tools: [] }];
}

describe('the observer — shadow records, act collapses (replays of real owner turns, 2026-09-28)', () => {
  const ED36 = 'search_memory,list_chats,search_memory,search_memory,list_knowledge_documents,goal_create,register_watched_resource,todo_create,todo_create,todo_create,todo_create,todo_create,todo_update,todo_update,todo_update,todo_update,topology_check,start_coding_session,todo_update,todo_update,todo_update,todo_update,todo_update,todo_list,todo_update,todo_update,todo_update,todo_update,search_memory,search_memory,send_chat_message,goal_premise_set,update_supervisor_state,goal_premise_set'.split(',');

  it('ed36f191 (406 s, 34 calls) — shadow never collapses but marks the split after 4 reads; the mutating work after it is what act moves to the follow-through', () => {
    const clock = { t: 0 };
    const o = createAnswerFirstObserver({ act: false, turnStartedAt: 0, now: () => clock.t });
    const r = replay(o, clock, auditShape(406_368, ED36));
    expect(r.notices.every((n) => n === null)).toBe(true);
    const split = o.split()!;
    expect(split.toolsBefore).toBe(4);
    expect(split.mutationsBefore).toBe(0);
    expect(split.atMs).toBeGreaterThan(ANSWER_FIRST_DEADLINE_MS);
    expect(split.atMs).toBeLessThan(60_000);
    const meta = ownerAnswerFirstMetricMeta({ chatId: STANNE, scope: 'project', resolution: { mode: 'shadow', canary: false, setting: 'canary' }, observer: o, ttftMs: 406_368, completionMs: 410_000, followThrough: null, verdict: 'none', armed: false });
    expect(meta).toMatchObject({ mode: 'shadow', split: true, wouldSplitAtMs: split.atMs, toolsBeforeSplit: 4, mutationsBeforeSplit: 0, totalTools: 34 });
    expect(meta.mutationsAfterSplit).toBe(ED36.slice(4).filter(isMutatingToolName).length);
    expect(meta.mutationsAfterSplit).toBeGreaterThanOrEqual(20);
    expect(meta).not.toHaveProperty('splitAtMs');
  });

  it('the same turn under act collapses at that step boundary with the FINAL-TURN answer-first notice', () => {
    const clock = { t: 0 };
    const o = createAnswerFirstObserver({ act: true, turnStartedAt: 0, now: () => clock.t });
    const r = replay(o, clock, auditShape(406_368, ED36));
    expect(r.collapsedAt).toBe(4);
    const notice = r.notices[4]!;
    expect(notice.startsWith('[HARNESS NOTICE — not typed by the user] FINAL TURN:')).toBe(true); // agent.ts grantToolRound splices this prefix
    expect(notice).toContain('Follow-through:');
    expect(notice).toContain('the owner has waited 46 s');
    expect(o.toolNames()).toEqual(ED36.slice(0, 4));
  });

  it('fast turns never split: fa761209 (15.6 s, 0 tools), 8ff9f715 (49.6 s, 2 reads), 56b579eb (70.5 s, one send)', () => {
    for (const [ttft, names] of [[15_573, []], [49_632, ['get_chat_status', 'get_chat_messages']], [70_497, ['send_chat_message']]] as Array<[number, string[]]>) {
      const clock = { t: 0 };
      const o = createAnswerFirstObserver({ act: true, turnStartedAt: 0, now: () => clock.t });
      const r = replay(o, clock, auditShape(ttft, names));
      expect(r.collapsedAt).toBe(-1);
      expect(o.split()).toBeNull();
    }
  });

  it('the first poll of EVERY invocation is exempt — an empty / unbacked-claim retry that starts past the deadline still gets one tool round', () => {
    const clock = { t: 120_000 };
    const o = createAnswerFirstObserver({ act: true, turnStartedAt: 0, now: () => clock.t });
    const retryHook = o.hook();
    expect(retryHook()).toBeNull();
    clock.t += 10_000;
    expect(retryHook()).toContain('FINAL TURN: ANSWER FIRST');
    expect(o.split()!.atMs).toBe(130_000);
  });

  // REPLAY (ticket 4f7263e4, probe-f/g box A 2026-10-10) — the three 99e63f86 owner turns that
  // were 3 of the 10 over-240 s first-word tail turns while the switch sat at shadow:
  //   06:21Z ttft 391,495 ms, wouldSplitAtMs 56,747, 11 tool calls (tool time 13.7 s — all wait);
  //   17:00Z ttft 283,104 ms, wouldSplitAtMs 52,542, 18 tool calls (tool time 14.1 s);
  //   17:21Z ttft 524,747 ms, wouldSplitAtMs 426,792 (bound by one in-flight computer_task
  //   346 s — the deadline cannot fire mid-tool, by design the tool finishes first).
  // Under the canary default these two unbound turns answer at the split (~53-57 s), inside
  // the module's own ≤ 90 s bar.
  it('REPLAY 4f7263e4: the tail owner turns — act answers at the step boundary past the deadline; shadow is what answered at 391 s / 283 s', () => {
    for (const [ttftMs, tools, splitAt] of [[391_495, 11, 56_747], [283_104, 18, 52_542]] as Array<[number, number, number]>) {
      // shadow (what prod did): no collapse anywhere in the turn
      const shadowClock = { t: 0 };
      const shadow = createAnswerFirstObserver({ act: false, turnStartedAt: 0, now: () => shadowClock.t });
      const shadowRun = replay(shadow, shadowClock, auditShape(ttftMs, Array.from({ length: tools }, (_, i) => `tool_${i}`)));
      expect(shadowRun.collapsedAt).toBe(-1);
      expect(shadow.split()).not.toBeNull();
      expect(shadow.split()!.atMs).toBeGreaterThan(ANSWER_FIRST_DEADLINE_MS);
      // act (the canary default now): the first step boundary past 45 s collapses the turn
      const actClock = { t: 0 };
      const act = createAnswerFirstObserver({ act: true, turnStartedAt: 0, now: () => actClock.t });
      const actRun = replay(act, actClock, auditShape(ttftMs, Array.from({ length: tools }, (_, i) => `tool_${i}`)));
      expect(actRun.collapsedAt).toBeGreaterThan(0); // a real mid-turn collapse (index)
      expect(act.split()).not.toBeNull();
      expect(act.split()!.atMs).toBeGreaterThan(ANSWER_FIRST_DEADLINE_MS);
      expect(act.split()!.atMs).toBeLessThanOrEqual(splitAt + 60_000); // within a step of the observed would-split
      expect(act.split()!.atMs).toBeLessThanOrEqual(120_000); // the ≤ 90 s bar, one step of slack
    }
  });

  it('only tool_call events count; the split is recorded once', () => {
    const clock = { t: 0 };
    const o = createAnswerFirstObserver({ act: false, turnStartedAt: 0, now: () => clock.t });
    o.observe('tool_result', { name: 'send_chat_message' });
    o.observe('chunk', { content: 'x' });
    o.observe('tool_call', { name: 'send_chat_message' });
    const h = o.hook();
    h(); clock.t = 50_000; h(); clock.t = 90_000; h();
    expect(o.split()).toEqual({ atMs: 50_000, toolsBefore: 1, mutationsBefore: 1 });
  });

  it('the doctrine row replaces the 45-min budget line', () => {
    const line = answerFirstDoctrineLine();
    expect(line.startsWith('- ANSWER FIRST')).toBe(true);
    expect(line).toContain('[SUPERVISOR STATE]');
    expect(line).toContain('About 45 s');
    expect(answerFirstSplitNotice(61_400)).toContain('waited 61 s');
  });
});

describe('the Follow-through line', () => {
  it('parses the LAST line in its common shapes and strips it', () => {
    const t = 'Lane 9df1 is green; PR #1352 merged.\n\nFollow-through: message the tt-rd supervisor (d1d0b346) with the camera plan; verify the reply.';
    const f = parseFollowThrough(t);
    expect(f).toMatchObject({ found: true, none: false, items: 'message the tt-rd supervisor (d1d0b346) with the camera plan; verify the reply' });
    expect(f.stripped).toBe('Lane 9df1 is green; PR #1352 merged.');
    expect(parseFollowThrough('x\n**Follow-through:** dispatch the todo').items).toBe('dispatch the todo');
    expect(parseFollowThrough('x\n- Follow-through (running now): re-run the bench').items).toBe('re-run the bench');
    expect(parseFollowThrough('x\nFollow through: a\nmore\nFollow-through: b').items).toBe('b');
  });
  it('none / nothing / a dash read as none; no line reads as missing', () => {
    for (const v of ['none', 'None.', 'nothing left', 'none — everything above is done', 'n/a', '—', 'no further action']) {
      expect(parseFollowThrough(`answer\n\nFollow-through: ${v}`)).toMatchObject({ found: true, none: true, items: null });
    }
    expect(parseFollowThrough('answer only')).toEqual({ found: false, none: false, items: null, stripped: 'answer only' });
    expect(parseFollowThrough('Follow-through: none of the lanes need a steer; check PR #12').none).toBe(false);
  });
  it('the continuation line names what is still running and is never a question; the rewrite keeps the partial byte-identical', () => {
    expect(followThroughContinuationLine(null)).toBe(CONTINUATION_LINE);
    const line = followThroughContinuationLine('message the tt-rd supervisor; verify the reply.');
    expect(line).toBe('Still working on this in the background — message the tt-rd supervisor; verify the reply. I will post the result here.');
    const answer = 'Schooltime: 3 of 4 cameras recording since 15:47Z.\n\nWant me to check the fourth?\n\nFollow-through: restart camera 4 on the Hue recorder';
    const f = parseFollowThrough(answer);
    const out = rewriteClosingText(f.stripped, followThroughContinuationLine(f.items));
    expect(out).toBe('Schooltime: 3 of 4 cameras recording since 15:47Z.\n\nStill working on this in the background — restart camera 4 on the Hue recorder. I will post the result here.');
    expect(out).not.toMatch(/\?\s*$/);
  });
  it('REPLAY 10-08 17:51Z (StAnne 99e63f86, "message the tt-rd supervisor"): the split answer names the send as follow-through — the W1 unbacked-claim detector does not read it as a claim', () => {
    const split = "The tt-rd supervisor (d1d0b346) has not been messaged yet — nothing went out in this answer.\n\nFollow-through: message the tt-rd supervisor (d1d0b346) with your camera plan; read back its reply";
    expect(unbackedActionClaims(split, [])).toEqual([]);
    const f = parseFollowThrough(split);
    expect(unbackedActionClaims(rewriteClosingText(f.stripped, followThroughContinuationLine(f.items)), [])).toEqual([]);
  });
});

describe('the verdict (an ACTING owner turn)', () => {
  const ft = (t: string) => parseFollowThrough(t);
  const base = (t: string, extra: Partial<Parameters<typeof classifyRunEnd>[0]> = {}) => classifyRunEnd({ finalText: ft(t).stripped, ...extra });
  it('a split with items, or with no line at all (mid-loop by construction), continues as answer_first_split', () => {
    const t = 'Here is where it stands.\n\nFollow-through: dispatch todo 536d5d52';
    expect(ownerAnswerFirstVerdict({ split: true, followThrough: ft(t), base: base(t) })).toEqual({ kind: 'continue', reason: 'answer_first_split', matched: 'dispatch todo 536d5d52' });
    const bare = 'Here is where it stands; I was still reading the lanes.';
    expect(ownerAnswerFirstVerdict({ split: true, followThrough: ft(bare), base: base(bare) })).toEqual({ kind: 'continue', reason: 'answer_first_split' });
  });
  it('"Follow-through: none" is done; a question only the owner can answer is waiting_user', () => {
    const none = 'All four cameras are recording.\n\nFollow-through: none';
    expect(ownerAnswerFirstVerdict({ split: true, followThrough: ft(none), base: base(none) })).toEqual({ kind: 'done' });
    const which = 'Two lanes can take it. Which one should run it — tt-rd or CanLaw?\n\nFollow-through: dispatch it';
    expect(ownerAnswerFirstVerdict({ split: true, followThrough: ft(which), base: base(which) })).toMatchObject({ kind: 'waiting_user', reason: 'ambiguous_target' });
    const q = 'What budget should the run use?';
    expect(ownerAnswerFirstVerdict({ split: true, followThrough: ft(q), base: base(q) })).toMatchObject({ kind: 'waiting_user', reason: 'clarifying_question' });
  });
  it('no split: only an open plan written this run continues — the doctrine offer and card hand-backs stay as they were', () => {
    const offer = 'Done — PR #1352 is merged. Want me to check the deploy next?';
    expect(ownerAnswerFirstVerdict({ split: false, followThrough: ft(''), base: base(offer) })).toEqual({ kind: 'done' });
    const card: RunEndVerdict = { kind: 'continue', reason: 'confirmation_handback', matched: 'confirm the card' };
    expect(ownerAnswerFirstVerdict({ split: false, followThrough: ft(''), base: card })).toEqual({ kind: 'done' });
    const plan = base('Working through the plan.', { unfinishedSteps: 2, planTouchedThisRun: true });
    expect(ownerAnswerFirstVerdict({ split: false, followThrough: ft(''), base: plan })).toEqual({ kind: 'continue', reason: 'unfinished_plan' });
  });
});

describe('duplicate-dispatch accounting + the follow-through brief', () => {
  const parts = [
    { type: 'tool_call', name: 'get_chat_status', args: { chatId: 'd1d0b346-aaaa' } },
    { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'd1d0b346-aaaa', content: 'go' } },
    { type: 'tool_call', name: 'todo_create', args: { title: 'Record all 4 cameras for 30 min', goalId: undefined } },
    { type: 'tool_call', name: 'update_supervisor_state', args: { notes: 'x' } },
    { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'd1d0b346-aaaa', content: 'again' } },
  ];
  it('signs mutating calls by tool + target (todo / goal creates by title); reads and the idempotent ledger merge never count', () => {
    expect(mutatingCallSignatures(parts)).toEqual(['send_chat_message→d1d0b346', 'todo_create→"record all 4 cameras for 30 min"']);
  });
  it('a round that repeats a send to the same lane is a duplicate; a fresh target is not; unknown targets never count', () => {
    const done = mutatingCallSignatures(parts);
    expect(duplicateSignatures(done, ['send_chat_message→d1d0b346', 'start_coding_session→7af0e536'])).toEqual(['send_chat_message→d1d0b346']);
    expect(duplicateSignatures(['notify_user→?'], ['notify_user→?'])).toEqual([]);
  });
  it('the brief lists what is done, what remains and that the owner\'s newest words govern', () => {
    const note = answerFirstContinuationNote({ items: 'verify the reply', done: ['send_chat_message→d1d0b346'] });
    expect(note).toContain('ANSWER-FIRST FOLLOW-THROUGH');
    expect(note).toContain('It named: verify the reply.');
    expect(note).toContain('do NOT repeat: send_chat_message→d1d0b346');
    expect(note).toContain("newest message governs");
    expect(answerFirstContinuationNote({ items: null, done: [] })).toContain('nothing that changes state');
  });
  it("2026-10-22 minors: the brief tells the round it finishes the owner's answer — never a WAKE: no-op close; the follow-through switch drops the sentence", () => {
    const note = answerFirstContinuationNote({ items: 'verify the reply', done: [] }, {});
    expect(note).toContain(ANSWER_FIRST_NOT_A_WAKE_LINE);
    expect(ANSWER_FIRST_NOT_A_WAKE_LINE).toBe("This message finishes the owner's answer, not a wake — never close it with WAKE: no-op.");
    expect(note.split('\n').pop()).toBe(ANSWER_FIRST_NOT_A_WAKE_LINE);
    const off = answerFirstContinuationNote({ items: 'verify the reply', done: [] }, { SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED: '1' });
    expect(off).not.toContain('not a wake');
    expect(off.split('\n').pop()).toBe('LEAD the result with what you did (ids, links) — this message is the follow-through result the owner was promised.');
  });
});

// 2026-10-22: the follow-through round's harness record — the chat-agent finalize gives a round this predicate marks
// the owner-ask reply's neutral 'Harness record:' line instead of 'WAKE: no-op (harness: 0 lane actions)'.
describe('isAnswerFirstFollowThrough — the follow-through round, read from the stash marks (never the text)', () => {
  const base = { taskId: 't-1', round: 1, maxRounds: 3, ofMessageId: 'row-1', startedAt: '2026-10-22T10:00:00.000Z', askText: 'where are we?' };
  const run = (over: Partial<ContinuationRun> & Pick<ContinuationRun, 'reason'>): ContinuationRun => ({ ...base, ...over });
  it('round 1 (reason answer_first_split + answerFirst), a later round (any reason, answerFirst carried) and a bare answer_first_split reason are follow-throughs', () => {
    expect(isAnswerFirstFollowThrough(run({ reason: 'answer_first_split', answerFirst: { resumes: 0, done: [], items: 'x' } }))).toBe(true);
    expect(isAnswerFirstFollowThrough(run({ round: 2, reason: 'unfinished_plan', answerFirst: { resumes: 1 } }))).toBe(true);
    expect(isAnswerFirstFollowThrough(run({ reason: 'answer_first_split' }))).toBe(true);
  });
  it('a lost Redis stash rebuilt from the prompt marker (` af=<n>`) still reads as a follow-through; a plain continuation marker does not', () => {
    const af = continuationPrompt({ round: 1, maxRounds: 3, reason: 'answer_first_split', askText: 'where are we?', previousAnswer: 'partial', stash: { ...base, reason: 'answer_first_split', answerFirst: { resumes: 0 } } });
    expect(isAnswerFirstFollowThrough(recoverContinuationFromPrompt(af, { startedAt: new Date() }))).toBe(true);
    const plain = continuationPrompt({ round: 1, maxRounds: 3, reason: 'offer_to_continue', askText: 'build the deck', previousAnswer: 'say the word', stash: { ...base, reason: 'offer_to_continue' } });
    expect(isAnswerFirstFollowThrough(recoverContinuationFromPrompt(plain, { startedAt: new Date() }))).toBe(false);
  });
  it('a plain continuation (a human chat\'s offer / unfinished plan) and no continuation at all are not', () => {
    expect(isAnswerFirstFollowThrough(run({ reason: 'offer_to_continue' }))).toBe(false);
    expect(isAnswerFirstFollowThrough(run({ reason: 'deadline_unfinished_plan' }))).toBe(false);
    expect(isAnswerFirstFollowThrough(undefined)).toBe(false);
    expect(isAnswerFirstFollowThrough(null)).toBe(false);
  });
  it('kill switch SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED reads 1 / true / on (case-insensitive); unset / 0 / other keep the fix on', () => {
    for (const v of ['1', 'true', 'ON', ' on ']) expect(followThroughQuietZeroDisabled({ SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED: v })).toBe(true);
    for (const v of [undefined, '', '0', 'false', 'off']) expect(followThroughQuietZeroDisabled({ SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED: v })).toBe(false);
  });
});
