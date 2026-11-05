/**
 * REPLAY — ticket cffd0d0a. A CALL REJECTED AT DISPATCH MUST NOT COST A TOOL
 * FOR THE REST OF THE RUN.
 *
 * THE INCIDENT (chat 99e63f86, ctrl.cql.ca project supervisor, 2026-11-03).
 * A `goal_update` writing an owner-HALT marker after an owner halt was severed
 * in transport 3-4 consecutive times across two wakes. The harness then
 * loop-broke the tool and the write NEVER landed: the goal row still read
 * `active` while the hold existed only in side-channel notes.
 *
 * THE LIVE STRIKE ROWS this file replays (read THIS run from `guard_strike`,
 * `get_fleet_telemetry view 'metrics' kind 'guard_strike' chat 99e63f86`):
 *
 *   2026-11-03T20:23:09.441Z  chat 99e63f86  run chat-2b4
 *     {"seam":"tool_repeat_break","tool":"goal_update","trips":1,"rounds":1,
 *      "model":"llm-cql:api-optimize-xiaomi-mimo-v2.6-pro","profile":"chat"}
 *   2026-11-03T20:28:07.699Z  chat 99e63f86  run chat-395
 *     {"seam":"tool_repeat_break","tool":"goal_update","trips":1,"rounds":1, …}
 *
 * THE MECHANISM. `toolArgumentRejection` classifies a cut as
 * `severed-in-transit` when the provider declared the turn complete
 * (`fr=tool_calls`) and every byte it sent was appended (`recv == acc`, nothing
 * dropped/buffered/unread/skipped/parse-failed). That classification says the
 * call NEVER EXECUTED — "NOTHING was executed", in the rejection text's own
 * words — and the same text tells the model that re-sending identical bytes
 * "will very likely be cut at the same position".
 *
 * The repeat ladder then hashes `tc.name:tc.arguments`. But a cut re-cuts a
 * re-sent payload AT THE SAME BYTE (5/5 measured on the reporting seat), so the
 * arguments are byte-identical across turns BY CONSTRUCTION. The exact leg saw
 * "the IDENTICAL call 3 turns in a row", escalated 1 round → 3 rounds →
 * `permaWithheld`, and REMOVED `goal_update` from the schema for the rest of the
 * run. A transient dispatch fault became a PERMANENT capability loss — which is
 * exactly why the write could never land.
 *
 * THE FIX UNDER TEST: cap the escalation, not the streak.
 * A turn containing a dispatch-severed call still trips the breaker (the model
 * is still interrupted, still told, still loses the tool for 1 then 3 rounds —
 * repeatedly), but the PERMANENT rung is unreachable, so the tool is always
 * re-offered and a reshaped retry can land the write.
 *
 * WHY NOT EXEMPT THE TURN OUTRIGHT — this is the review's blocking finding and
 * the reason this file pins a CAP. `severed-in-transit` is NOT proof the wire
 * is at fault: a model that simply stops mid-object is byte-for-byte
 * indistinguishable from a gateway cut, and `classifyToolCallLoss` only proves
 * the gateway forwarded faithfully, never that it forwarded EVERYTHING the model
 * emitted. An outright exemption would leave a model that never closes its JSON
 * with NO breaker at all, and the supervisor/chat profiles that hit this are the
 * ones whose `runDeadlineMs` is the only outer bound. Capping keeps both
 * properties: the bounded rungs always fire, and the tool is never lost.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  isTransportSeveredRejection,
  classifyToolCallLoss,
  parseToolArguments,
  toolArgumentRejection,
} from './tool-arguments';

// `learnings-index.service` transitively imports the Prisma/env bootstrap, which
// calls process.exit(1) when the test env lacks prod secrets. Stub the two
// config modules at the root of that chain (the same pattern the derail-break
// suites use), keeping the REAL `looksLikeToolFailure` under test.
jest.mock('../../../config/env', () => ({ env: { NODE_ENV: 'test' } }));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('./learnings-index.service', () => ({
  ...jest.requireActual('./learnings-index.service'),
  buildLearningsBlock: jest.fn(async () => ''),
  kickLearningsIndexSync: jest.fn(),
  sliceLearningsForInjection: jest.fn((s: string) => s),
  createFailureLearningNudger: jest.fn(() => async () => ''),
}));

// eslint-disable-next-line
import { looksLikeToolFailure } from './learnings-index.service';

/**
 * The cut a `goal_update` produced on the reporting seat: the payload dies
 * INSIDE the goalId uuid. The stored rows for this class read `argLen:39`
 * (`dispatch_reject`, `ec:"siv"`).
 */
const SEVERED_GOAL_UPDATE = '{"goalId":"278ec6f4-9a6e-4b1c-8f2';

/** The turn's own arithmetic on such a row: recv == acc, nothing ours, completion declared. */
const LIVE_ROW_EVIDENCE = {
  finishReason: 'tool_calls',
  receivedBytes: 39,
  accumulatedBytes: 39,
  droppedBytes: 0,
  undrainedBufferBytes: 0,
  unreadArgBytes: 0,
  skippedRawLines: 0,
  multilineDataEvents: 0,
  parseFailLines: 0,
  parseFailToolCalls: 0,
} as const;

describe('cffd0d0a — isTransportSeveredRejection: was this call rejected at dispatch?', () => {
  it('the incident payload never executed', () => {
    // Guard the fixture itself: it must be a genuine mid-structure cut, or this
    // file would pin a payload rejected for some other reason.
    const parsed = parseToolArguments(SEVERED_GOAL_UPDATE);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? null : parsed.shape).toBe('truncated');
    expect(classifyToolCallLoss(parsed as any, LIVE_ROW_EVIDENCE)).toBe('severed-in-transit');

    expect(isTransportSeveredRejection(SEVERED_GOAL_UPDATE, LIVE_ROW_EVIDENCE)).toBe(true);
  });

  it('length-independent: the class holds at every observed cut point on this family', () => {
    // Observed cut points span 17 → 1743 chars; the predicate must not key on a
    // byte length. Extend with uuid hex so each payload is still a mid-string cut.
    for (const argLen of [17, 25, 39, 41, 64, 92, 134, 1743]) {
      const base = SEVERED_GOAL_UPDATE;
      const cut = base.length >= argLen ? base.slice(0, argLen) : base + 'a'.repeat(argLen - base.length);
      const evidence = { ...LIVE_ROW_EVIDENCE, receivedBytes: cut.length, accumulatedBytes: cut.length };
      expect([argLen, isTransportSeveredRejection(cut, evidence)]).toEqual([argLen, true]);
    }
  });

  it('a call that EVER executed is never flagged', () => {
    // An empty payload means no arguments ({}) and the tool runs.
    expect(isTransportSeveredRejection('', LIVE_ROW_EVIDENCE)).toBe(false);
    // An already-parsed object from a gateway: it executed.
    expect(isTransportSeveredRejection({ goalId: '278ec6f4' }, LIVE_ROW_EVIDENCE)).toBe(false);
    // A COMPLETE, valid payload: it executed.
    expect(isTransportSeveredRejection('{"goalId":"278ec6f4"}', LIVE_ROW_EVIDENCE)).toBe(false);
  });

  it('a complete-but-MALFORMED payload is NOT flagged — retrying those bytes IS the loop', () => {
    // Ticket aa59535b's other class: every byte arrived and it is invalid JSON.
    // The model genuinely mis-formatted it, so the identical-call breaker is
    // doing its job and this predicate must not soften it.
    const malformed = '{"goalId": "278ec6f4",}'; // trailing comma, complete
    const parsed = parseToolArguments(malformed);
    expect(parsed.ok).toBe(false);
    expect(classifyToolCallLoss(parsed as any, LIVE_ROW_EVIDENCE)).toBe('malformed');
    expect(isTransportSeveredRejection(malformed, LIVE_ROW_EVIDENCE)).toBe(false);
  });

  it('every ours-side counter VOIDS the verdict, exactly as it voids the class', () => {
    // If bytes WE received were dropped, unparsed, unread or skipped the cut is
    // not provably a dispatch rejection — so the ladder keeps its full escalation.
    // This is the discipline that stopped the aa59535b / 9b2b3798 misdiagnoses.
    const voiding: Array<[string, Record<string, number>]> = [
      ['droppedBytes', { droppedBytes: 7 }],
      ['undrainedBufferBytes', { undrainedBufferBytes: 12 }],
      ['unreadArgBytes', { unreadArgBytes: 5 }],
      ['skippedRawLines', { skippedRawLines: 1 }],
      ['multilineDataEvents', { multilineDataEvents: 2 }],
      ['parseFailLines', { parseFailLines: 1 }],
      ['parseFailToolCalls', { parseFailToolCalls: 1 }],
    ];
    for (const [key, patch] of voiding) {
      expect([key, isTransportSeveredRejection(SEVERED_GOAL_UPDATE, { ...LIVE_ROW_EVIDENCE, ...patch })])
        .toEqual([key, false]);
    }
  });

  it('a missing measurement or a non-tool_calls finish_reason is NOT proof', () => {
    expect(isTransportSeveredRejection(SEVERED_GOAL_UPDATE, undefined)).toBe(false);
    // `length` is an output-cap cut — a different, already-handled class.
    expect(isTransportSeveredRejection(SEVERED_GOAL_UPDATE, { ...LIVE_ROW_EVIDENCE, finishReason: 'length' })).toBe(false);
    expect(isTransportSeveredRejection(SEVERED_GOAL_UPDATE, { ...LIVE_ROW_EVIDENCE, finishReason: null })).toBe(false);
    // Unmeasured halves: recv/acc absent means the arithmetic means nothing.
    expect(isTransportSeveredRejection(SEVERED_GOAL_UPDATE, { finishReason: 'tool_calls' })).toBe(false);
    // recv != acc: bytes were lost on OUR side, so it is not a dispatch rejection.
    expect(isTransportSeveredRejection(SEVERED_GOAL_UPDATE, { ...LIVE_ROW_EVIDENCE, accumulatedBytes: 30 })).toBe(false);
  });
});

describe('cffd0d0a — the DERALL ladder never sees this class (it perma-withholds too)', () => {
  it('the dispatch-rejection text is NOT failure-shaped', () => {
    // The fix deliberately does not route severance into the derail breaker,
    // because that ladder's escalation ALSO ends in permaWithheld — it would
    // re-create the harm through another door. This is the behavioural pin: if
    // the rejection text ever became failure-shaped, the derail ladder would
    // start perma-withholding a tool whose calls never executed.
    const parsed = parseToolArguments(SEVERED_GOAL_UPDATE);
    expect(parsed.ok).toBe(false);
    const text = toolArgumentRejection('goal_update', parsed as any, LIVE_ROW_EVIDENCE);
    // Sanity: this IS the severed-in-transit text the model reads.
    expect(text).toContain('SEVERED IN TRANSIT');
    expect(looksLikeToolFailure(text)).toBe(false);
  });
});

describe('cffd0d0a — the CAP is wired into the repeat ladder (source-pinned)', () => {
  const agentSrc = fs.readFileSync(path.join(__dirname, 'agent.ts'), 'utf8');

  it('the predicate is imported and computed once per turn', () => {
    expect(agentSrc).toContain('isTransportSeveredRejection');
    expect(agentSrc).toMatch(/const sevThisTurn = turn\.toolCalls\.some\(\(tc\) => isTransportSeveredRejection\(tc\.arguments, turnEvidenceOf\(ctx\)\)\)/);
  });

  it('the PERMANENT rung is unreachable for a dispatch-severed turn', () => {
    // The whole fix in one expression. If this inverts, the incident returns:
    // a never-executed call would again cost the tool for the rest of the run.
    expect(agentSrc).toMatch(/const repeatPerma = repeatTrips >= 3 && !sevThisTurn;/);
    // …and the capped state is named, so the notice/metric can tell the model
    // the truth (nothing executed) instead of "the result is already in your context".
    expect(agentSrc).toMatch(/const severanceCapped = repeatTrips >= 3 && sevThisTurn;/);
    expect(agentSrc).toMatch(/severanceCapped \? \{ severanceCapped: true \}/);
  });

  it('the STREAK arithmetic is untouched — a wedge is still bounded', () => {
    // Capping the last rung must not dissolve the bounded ones. rungs 1 and 2
    // must still withhold 1 then 3 rounds for a severed turn, and the streak
    // must keep counting (an outright exemption was rejected in review).
    expect(agentSrc).toMatch(/const repeatTrips = \(repeatTripCounts\.get\(loopTool\) \?\? 0\) \+ 1;/);
    expect(agentSrc).toMatch(/const withholdRounds = repeatTrips === 1 \? 1 : 3;/);
    // The signature must NOT be zeroed for a severed turn (that was the rejected design).
    expect(agentSrc).toMatch(/const sig = turn\.toolCalls\.map\(tc => `\$\{tc\.name\}:\$\{tc\.arguments\}`\)\.join\('\|'\);/);
    expect(agentSrc).not.toMatch(/severedThisTurn \? '' :/);
  });

  it('the capped trip TELLS the model nothing executed (the actionable half)', () => {
    // The original harm was also epistemic: the notice said the result "is
    // already in your context" for a call that produced no result at all. A
    // capped trip must correct that and say how to make the write land.
    expect(agentSrc).toContain('those calls were rejected at DISPATCH');
    expect(agentSrc).toContain('SHORTER argument values');
  });

  it('one shared evidence builder feeds the text, the telemetry and the breaker', () => {
    // "Two writers, one fact": the cut classified severed-in-transit for the
    // MODEL must be the same cut capped for the BREAKER, from the same fields.
    expect(agentSrc).toMatch(/function turnEvidenceOf\(ctx: ToolContext\): ToolCallTurnEvidence/);
    expect(agentSrc).toMatch(/const turnEvidence = turnEvidenceOf\(ctx\)/);
    // The old inline literal must not come back (a second copy could drift).
    expect(agentSrc).not.toMatch(/const turnEvidence = \{\s*finishReason: ctx\.turnFinishReason/);
  });
});